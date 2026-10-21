import type { Message, LLMResponse, ProviderConfig, Tool } from '../utils/types.js'
import { RateLimiter } from '../utils/security.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines, parseSseData } from '../utils/sse.js'
import { streamOpenAiChat, type ProviderStreamEvent } from './streamShared.js'

/**
 * Universal OpenAI-Compatible provider.
 * Works with any endpoint that follows the OpenAI Chat Completions API standard:
 * - LM Studio (http://localhost:1234/v1)
 * - vLLM      (http://localhost:8000/v1)
 * - LocalAI   (http://localhost:8080/v1)
 * - Together AI, xAI Grok, Perplexity, etc.
 */
export class OpenAICompatibleProvider {
  protected config: ProviderConfig
  private apiKey: string
  private baseUrl: string
  private providerName: string
  private rateLimiter = new RateLimiter(60, 60000) // 60 req/min

  constructor(config: ProviderConfig, providerName = 'OpenAI-Compatible') {
    this.config = config
    this.apiKey = config.apiKey ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? ''
    this.baseUrl = (config.baseUrl ?? 'http://localhost:1234/v1').replace(/\/$/, '')
    this.providerName = providerName
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const rl = this.rateLimiter.check()
    if (!rl.allowed) {
      const waitSec = Math.ceil((rl.retryAfterMs ?? 5000) / 1000)
      throw new Error(`Rate limit reached. Please wait ${waitSec}s.`)
    }

    const normalizedMessages = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? 'unknown' }
      }
      // Assistant message that announced tool calls — required in history, or
      // OpenAI-compatible APIs reject the following tool messages (HTTP 400)
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
          }))
        }
      }
      return { role: m.role, content: m.content }
    })

    const normalizedTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
          ),
          required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k)
        }
      }
    }))

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: normalizedMessages,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens ?? 4096,
    }

    if (normalizedTools.length > 0) {
      body.tools = normalizedTools
      body.tool_choice = 'auto'
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, { providerName: this.providerName })

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`
      try {
        const err = await res.json() as { error?: { message?: string } }
        errMsg = err.error?.message ?? errMsg
      } catch { /* ignore */ }

      if (res.status === 429) throw new Error(`${this.providerName} rate limit reached. Please wait.`)
      if (res.status === 401) throw new Error(`${this.providerName}: Invalid API Key. Run /config to update it.`)
      throw new Error(`${this.providerName} error: ${errMsg}`)
    }

    const data = await res.json() as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
        }
        finish_reason: string
      }>
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
    }

    if (!data.choices || data.choices.length === 0) {
      throw new Error(`${this.providerName}: Model returned no choices. The model may not support tool calling. Try /config to switch models.`)
    }

    const choice = data.choices[0]
    if (!choice?.message) {
      throw new Error(`${this.providerName}: Model returned an invalid response. Try a different model via /config.`)
    }

    let toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined
    if (choice.message.tool_calls) {
      toolCalls = choice.message.tool_calls.map(tc => {
        let parsedArgs: Record<string, unknown> = {}
        try { parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown> } catch { /* keep empty */ }
        return { id: tc.id, name: tc.function.name, arguments: parsedArgs }
      })
    }

    const usage = data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens
    } : undefined

    return {
      content: choice.message.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      usage
    }
  }

  /**
   * Streaming with tool support.
   * Yields text deltas while the model is still generating, then a
   * `tool_calls` event when the model asked for tools.
   */
  async *streamWithTools(messages: Message[], tools: Tool[] = []): AsyncGenerator<ProviderStreamEvent> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers,
      model: this.config.model,
      messages,
      tools,
      providerName: this.providerName,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    })
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const normalizedMessages = messages.map(m => ({ role: m.role, content: m.content }))
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: normalizedMessages,
        temperature: this.config.temperature ?? 0.7,
        stream: true
      })
    }, { providerName: this.providerName })

    if (!res.ok || !res.body) throw new Error(`${this.providerName} stream error`)

    for await (const line of sseLines(res)) {
      const json = parseSseData(line)
      if (json === null) continue
      if (json === '[DONE]') return
      try {
        const chunk = JSON.parse(json) as {
          choices: Array<{ delta: { content?: string }; finish_reason?: string }>
        }
        const content = chunk.choices[0]?.delta?.content
        if (content) yield content
      } catch { /* skip */ }
    }
  }
}
