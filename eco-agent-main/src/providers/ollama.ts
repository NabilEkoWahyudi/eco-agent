import type { Message, LLMResponse, ProviderConfig, Tool } from '../utils/types.js'

export class OllamaProvider {
  private config: ProviderConfig
  private baseUrl: string

  constructor(config: ProviderConfig) {
    this.config = config
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434'
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
          try {
            const text = await res.clone().text()
            errMsg = text || res.statusText
          } catch {
            errMsg = res.statusText
          }
        }

        const retryAfter = res.headers.get('Retry-After')
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delayMs

        console.log(`\n  ⚠ Ollama: ${errMsg} (HTTP ${res.status}). Retrying in ${waitTime / 1000}s... (${retries}/${maxRetries})`)
        await new Promise(r => setTimeout(r, waitTime))
        
        delayMs *= 2
        continue
      }

      return res
    }
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const ollamaMessages = messages.map(m => ({
      role: m.role === 'tool' ? 'tool' : m.role,
      content: m.content
    }))

    const ollamaTools = tools.map(t => ({
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

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature: this.config.temperature ?? 0.7,
        num_predict: this.config.maxTokens ?? 4096
      }
    }

    if (ollamaTools.length > 0) {
      body.tools = ollamaTools
    }

    const res = await this.fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      let errMsg = res.statusText
      try {
        errMsg = await res.text()
      } catch { /* skip */ }
      throw new Error(`Ollama error: ${errMsg}`)
    }

    const data = await res.json() as {
      message: {
        content: string
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> }
        }>
      }
      done_reason: string
    }

    const toolCalls = data.message.tool_calls?.map((tc, i) => ({
      id: `tc_${i}_${Date.now()}`,
      name: tc.function.name,
      arguments: tc.function.arguments
    }))

    return {
      content: data.message.content ?? '',
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop'
    }
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const res = await this.fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: ollamaMessages,
        stream: true,
        options: { temperature: this.config.temperature ?? 0.7 }
      })
    })

    if (!res.ok || !res.body) throw new Error('Ollama stream error')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = decoder.decode(value).split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
          if (chunk.message?.content) yield chunk.message.content
          if (chunk.done) return
        } catch { /* skip malformed */ }
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      const data = await res.json() as { models: Array<{ name: string }> }
      return data.models.map(m => m.name)
    } catch {
      return []
    }
  }
}
