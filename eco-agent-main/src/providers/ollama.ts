import type { Message, LLMResponse, ProviderConfig, Tool, ToolCall } from '../utils/types.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines } from '../utils/sse.js'
import type { ProviderStreamEvent } from './streamShared.js'

export class OllamaProvider {
  private config: ProviderConfig
  private baseUrl: string

  constructor(config: ProviderConfig) {
    this.config = config
    // Normalize the base URL so a trailing slash doesn't produce "//api/chat"
    this.baseUrl = (config.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const ollamaMessages = messages.map(m => {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map(tc => ({
            function: { name: tc.name, arguments: tc.arguments ?? {} }
          }))
        }
      }
      return {
        role: m.role === 'tool' ? 'tool' : m.role,
        content: m.content
      }
    })

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

    const res = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { providerName: 'Ollama' })

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
      prompt_eval_count?: number
      eval_count?: number
    }

    const toolCalls = data.message.tool_calls?.map((tc, i) => ({
      id: `tc_${i}_${Date.now()}`,
      name: tc.function.name,
      arguments: tc.function.arguments
    }))

    const usage = data.prompt_eval_count !== undefined && data.eval_count !== undefined ? {
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count,
      totalTokens: data.prompt_eval_count + data.eval_count
    } : undefined

    return {
      content: data.message.content ?? '',
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage
    }
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const res = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: this.config.temperature ?? 0.7,
          num_predict: this.config.maxTokens ?? 4096
        }
      })
    }, { providerName: 'Ollama' })

    if (!res.ok || !res.body) throw new Error('Ollama stream error')

    // Ollama streams NDJSON (one JSON object per line), not SSE — the shared
    // line reader still works because it just yields complete lines.
    for await (const line of sseLines(res)) {
      if (!line.trim()) continue
      try {
        const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
        if (chunk.message?.content) yield chunk.message.content
        if (chunk.done) return
      } catch { /* skip malformed */ }
    }
  }

  /**
   * Streaming with tool support (Ollama NDJSON stream).
   */
  async *streamWithTools(messages: Message[], tools: Tool[] = []): AsyncGenerator<ProviderStreamEvent> {
    const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature: this.config.temperature ?? 0.7,
        num_predict: this.config.maxTokens ?? 4096,
      },
    }
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
            ),
            required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
          },
        },
      }))
    }

    const res = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { providerName: 'Ollama' })

    if (!res.ok || !res.body) throw new Error('Ollama stream error')

    const toolCalls: ToolCall[] = []
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

    for await (const line of sseLines(res)) {
      if (!line.trim()) continue
      try {
        const chunk = JSON.parse(line) as {
          message?: {
            content?: string
            tool_calls?: Array<{ function?: { name: string; arguments: Record<string, unknown> | string } }>
          }
          done?: boolean
          prompt_eval_count?: number
          eval_count?: number
        }
        if (chunk.message?.content) yield { type: 'text', text: chunk.message.content }
        for (const tc of chunk.message?.tool_calls ?? []) {
          if (!tc.function?.name) continue
          let args: Record<string, unknown> = {}
          if (typeof tc.function.arguments === 'string') {
            try { args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown> } catch { /* keep empty */ }
          } else if (tc.function.arguments) {
            args = tc.function.arguments
          }
          toolCalls.push({ id: `tc_${toolCalls.length}_${Date.now()}`, name: tc.function.name, arguments: args })
        }
        if (chunk.prompt_eval_count !== undefined && chunk.eval_count !== undefined) {
          usage = {
            promptTokens: chunk.prompt_eval_count,
            completionTokens: chunk.eval_count,
            totalTokens: chunk.prompt_eval_count + chunk.eval_count,
          }
        }
        if (chunk.done) break
      } catch { /* skip malformed */ }
    }

    if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls }
    if (usage) yield { type: 'usage', usage }
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
