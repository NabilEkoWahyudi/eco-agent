import type { Message, LLMResponse, ProviderConfig, Tool } from '../utils/types.js'
import { RateLimiter } from '../utils/security.js'

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
  private rateLimiter = new RateLimiter(60, 60000) // 60 req/min

  constructor(config: ProviderConfig) {
    this.config = config
    this.apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY ?? ''
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY not set.')
  }

  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
    let retries = 0
    let delayMs = 2000

    while (true) {
      const res = await fetch(url, options)

      // If it's a rate limit (429) or server error (502, 503) and we have retries left
      if ((res.status === 429 || res.status >= 500) && retries < maxRetries) {
        retries++
        
        let errMsg = ''
        try {
          const clone = res.clone()
          const errData = await clone.json() as any
          errMsg = errData?.error?.message || res.statusText
        } catch {
          errMsg = res.statusText
        }

        const retryAfter = res.headers.get('Retry-After')
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delayMs

        console.log(`\n  ⚠ OpenRouter: ${errMsg} (HTTP ${res.status}). Retrying in ${waitTime / 1000}s... (${retries}/${maxRetries})`)
        await new Promise(r => setTimeout(r, waitTime))
        
        delayMs *= 2 // Exponential backoff
        continue
      }

      return res
    }
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const rl = this.rateLimiter.check()
    if (!rl.allowed) {
      const waitSec = Math.ceil((rl.retryAfterMs ?? 5000) / 1000)
      throw new Error(`Rate limit reached. Please wait ${waitSec}s.`)
    }

    const orMessages = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? 'unknown' }
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

    const res = await this.fetchWithRetry(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/eco-agent',
        'X-Title': 'Eco Agent'
      },
      body: JSON.stringify(body)
    })

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
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      usage
    }
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const orMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const res = await this.fetchWithRetry(`${OPENROUTER_BASE_URL}/chat/completions`, {
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
    })

    if (!res.ok || !res.body) throw new Error('OpenRouter stream error')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = decoder.decode(value).split('\n')
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6)
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

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this.fetchWithRetry(`${OPENROUTER_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      }, 2)
      const data = await res.json() as { data: Array<{ id: string; name: string }> }
      return data.data ?? []
    } catch {
      return []
    }
  }
}
