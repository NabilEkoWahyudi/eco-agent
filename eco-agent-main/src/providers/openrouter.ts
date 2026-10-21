import type { Message, LLMResponse, ProviderConfig, Tool } from '../utils/types.js'
import { RateLimiter } from '../utils/security.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines, parseSseData } from '../utils/sse.js'
import { streamOpenAiChat, type ProviderStreamEvent } from './streamShared.js'
import { QuotaGovernor, rpmFromEnv } from '../utils/quota.js'
import { printNotice } from '../utils/console.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export const OPENROUTER_MODELS = [
  // Free models (stable)
  { id: 'deepseek/deepseek-r1:free',                   label: 'DeepSeek R1 (Free)',           desc: 'Free, strong reasoning & coding' },
  { id: 'deepseek/deepseek-chat-v3-0324:free',         label: 'DeepSeek V3 (Free)',           desc: 'Free, fast, great for chat' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free',      label: 'Llama 3.3 70B (Free)',         desc: 'Free, capable, great for coding' },
  { id: 'qwen/qwen3-8b:free',                          label: 'Qwen3 8B (Free)',              desc: 'Free, lightweight, multilingual' },
  { id: 'mistralai/mistral-7b-instruct:free',          label: 'Mistral 7B (Free)',            desc: 'Free, lightweight, fast' },
  // Paid models
  { id: 'openai/gpt-4o',                               label: 'GPT-4o',                       desc: 'OpenAI flagship, very capable' },
  { id: 'openai/gpt-4o-mini',                          label: 'GPT-4o Mini',                  desc: 'Fast & affordable GPT-4 class' },
  { id: 'anthropic/claude-sonnet-4-5',                 label: 'Claude Sonnet',                desc: 'Anthropic, great for coding' },
  { id: 'google/gemini-2.5-pro-preview',               label: 'Gemini 2.5 Pro',               desc: 'Google, strong reasoning' },
  { id: 'meta-llama/llama-3.3-70b-instruct',           label: 'Llama 3.3 70B',               desc: 'Meta, reliable open source' },
]

export class OpenRouterProvider {
  private config: ProviderConfig
  private apiKey: string
  private baseUrl: string
  // Free tier of OpenRouter allows ~20 requests/minute — staying below it
  // avoids HTTP 429s (which count as failed requests on the dashboard).
  private quota = new QuotaGovernor({ rpm: rpmFromEnv(20), minRpm: 5, maxRpm: rpmFromEnv(20) })

  constructor(config: ProviderConfig) {
    this.config = config
    this.apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY ?? ''
    // Honor a custom baseUrl (proxy / tests)
    this.baseUrl = (config.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY not set.')
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    // Stay inside the free-tier quota locally instead of collecting 429s
    for (let attempt = 0; attempt < 3; attempt++) {
      const { allowed, waitMs } = this.quota.reserve()
      if (allowed) break
      printNotice(`\n  ! OpenRouter quota window full (${this.quota.rpm} req/min). Waiting ${Math.ceil(waitMs / 1000)}s locally...`)
      await new Promise(r => setTimeout(r, waitMs))
    }

    const orMessages = messages.map(m => {
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

    const orTools = tools.map(t => ({
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
      messages: orMessages,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens ?? 4096,
    }

    if (orTools.length > 0) {
      body.tools = orTools
      body.tool_choice = 'auto'
    }

    const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/eco-agent',
        'X-Title': 'Eco Agent'
      },
      body: JSON.stringify(body)
    }, { providerName: 'OpenRouter', onResponse: (r) => { if (r.status === 429) this.quota.onRateLimited(); else if (r.ok) this.quota.onSuccess() } })

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`
      try {
        const err = await res.json() as { error?: { message?: string; code?: number } }
        errMsg = err.error?.message ?? errMsg
      } catch { /* ignore */ }

      if (res.status === 429) throw new Error('OpenRouter rate limit reached. Wait a moment and try again.')
      if (res.status === 402) throw new Error('OpenRouter: insufficient credits. Add credits at openrouter.ai/credits')
      if (res.status === 401) throw new Error('OpenRouter: Invalid API Key. Run /config to update it.')
      if (errMsg.includes('Provider returned error')) {
        throw new Error(`Model unavailable: "${this.config.model}" is currently overloaded or unavailable. Try /config to switch to a different model.`)
      }
      throw new Error(`OpenRouter error: ${errMsg}`)
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

    // Bug fix (ported from opencode): guard against empty/undefined choices
    // Happens when model returns no response (overloaded, tool not supported, etc.)
    if (!data.choices || data.choices.length === 0) {
      throw new Error('OpenRouter: Model did not return any choices (choices empty/undefined). The model may be overloaded or does not support tool calling. Try /config to switch models.')
    }
    const choice = data.choices[0]
    if (!choice?.message) {
      throw new Error('OpenRouter: Model returned an invalid choice (no message). Try a different model via /config.')
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
   * Streaming with tool support (text deltas + tool calls).
   */
  async *streamWithTools(messages: Message[], tools: Tool[] = []): AsyncGenerator<ProviderStreamEvent> {
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/eco-agent',
        'X-Title': 'Eco Agent',
      },
      model: this.config.model,
      messages,
      tools,
      providerName: 'OpenRouter',
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    })
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const orMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/eco-agent',
        'X-Title': 'Eco Agent'
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: orMessages,
        temperature: this.config.temperature ?? 0.7,
        stream: true
      })
    }, { providerName: 'OpenRouter', onResponse: (r) => { if (r.status === 429) this.quota.onRateLimited(); else if (r.ok) this.quota.onSuccess() } })

    if (!res.ok || !res.body) throw new Error('OpenRouter stream error')

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

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await fetchWithRetry(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      }, { maxRetries: 2, providerName: 'OpenRouter' })
      const data = await res.json() as { data: Array<{ id: string; name: string }> }
      return data.data ?? []
    } catch {
      return []
    }
  }
}
