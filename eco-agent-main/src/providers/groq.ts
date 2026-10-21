import type { Message, LLMResponse, ProviderConfig, Tool } from '../utils/types.js'
import { RateLimiter } from '../utils/security.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines, parseSseData } from '../utils/sse.js'
import { streamOpenAiChat, type ProviderStreamEvent } from './streamShared.js'

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

export class GroqProvider {
  private config: ProviderConfig
  private apiKey: string
  private rateLimiter = new RateLimiter(30, 60000) // 30 req/min

  constructor(config: ProviderConfig) {
    this.config = config
    this.apiKey = config.apiKey ?? process.env.GROQ_API_KEY ?? ''
    if (!this.apiKey) throw new Error('GROQ_API_KEY not set. Run: export GROQ_API_KEY=your_key')
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const groqMessages = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? 'unknown' }
      }
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

    const groqTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
          ),
          required: Object.entries(t.parameters)
            .filter(([, v]) => v.required)
            .map(([k]) => k)
        }
      }
    }))

    // Rate limit check
    const rl = this.rateLimiter.check()
    if (!rl.allowed) {
      const waitSec = Math.ceil((rl.retryAfterMs ?? 5000) / 1000)
      throw new Error(`Rate limit reached. Please wait ${waitSec}s before sending another message.`)
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: groqMessages,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens ?? 4096
    }

    if (groqTools.length > 0) {
      body.tools = groqTools
      body.tool_choice = 'auto'
    }

    const res = await fetchWithRetry(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    }, { providerName: 'Groq' })

    if (!res.ok) {
      let errMsg = res.statusText
      try {
        const err = await res.json() as { error?: { message?: string } }
        errMsg = err.error?.message ?? errMsg
      } catch { /* skip */ }
      throw new Error(`Groq error: ${errMsg}`)
    }

    const data = await res.json() as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
        }
        finish_reason: string
      }>
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
    }

    const choice = data.choices[0]
    const toolCalls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>
    }))

    const usage = data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens
    } : undefined

    return {
      content: choice.message.content ?? '',
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      usage
    }
  }

  /**
   * Streaming with tool support (text deltas + tool calls).
   */
  async *streamWithTools(messages: Message[], tools: Tool[] = []): AsyncGenerator<ProviderStreamEvent> {
    yield* streamOpenAiChat({
      url: `${GROQ_BASE_URL}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      model: this.config.model,
      messages,
      tools,
      providerName: 'Groq',
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    })
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const groqMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const res = await fetchWithRetry(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: groqMessages,
        temperature: this.config.temperature ?? 0.7,
        stream: true
      })
    }, { providerName: 'Groq' })

    if (!res.ok || !res.body) throw new Error('Groq stream error')

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
