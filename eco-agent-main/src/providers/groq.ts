import type { Message, LLMResponse, ProviderConfig, Tool } from '../utils/types.js'
import { RateLimiter } from '../utils/security.js'

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

  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
    let retries = 0
    let delayMs = 2000

    while (true) {
      const res = await fetch(url, options)

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

        console.log(`\n  ⚠ Groq: ${errMsg} (HTTP ${res.status}). Retrying in ${waitTime / 1000}s... (${retries}/${maxRetries})`)
        await new Promise(r => setTimeout(r, waitTime))
        
        delayMs *= 2
        continue
      }

      return res
    }
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const groqMessages = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? 'unknown' }
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

    const res = await this.fetchWithRetry(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    })

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
    }

    const choice = data.choices[0]
    const toolCalls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>
    }))

    return {
      content: choice.message.content ?? '',
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop'
    }
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const groqMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const res = await this.fetchWithRetry(`${GROQ_BASE_URL}/chat/completions`, {
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
    })

    if (!res.ok || !res.body) throw new Error('Groq stream error')

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
}
