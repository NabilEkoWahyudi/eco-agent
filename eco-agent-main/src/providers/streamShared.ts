/**
 * Shared streaming helpers.
 *
 * Why this exists: the agent loop used to call `provider.complete()`, which
 * waits for the ENTIRE model response before anything is shown. On slow
 * providers that looks like "the output is stuck". Streaming lets the CLI
 * print tokens as they arrive (time-to-first-token becomes visible).
 *
 * This module implements the OpenAI-compatible chat-completions streaming
 * dialect once; Groq / OpenRouter / OpenAI / DeepSeek / any compatible
 * gateway reuse it.
 */
import type { Message, Tool, ToolCall } from '../utils/types.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines, parseSseData } from '../utils/sse.js'

export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }

/** Map eco-agent messages to the OpenAI chat-completions format. */
export function mapOpenAiMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map(m => {
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
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

/** Map eco-agent tools to the OpenAI `tools` array. */
export function buildOpenAiTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
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

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface OpenAiStreamOptions {
  url: string
  headers: Record<string, string>
  model: string
  messages: Message[]
  tools: Tool[]
  providerName: string
  temperature?: number
  maxTokens?: number
  /** Some OpenAI-compatible servers reject `stream_options` — disable if so. */
  includeUsage?: boolean
}

/**
 * Stream an OpenAI-compatible chat completion.
 * Yields text deltas as they arrive and a final `tool_calls` event when the
 * model asked for tools.
 */
export async function* streamOpenAiChat(opts: OpenAiStreamOptions): AsyncGenerator<ProviderStreamEvent> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: mapOpenAiMessages(opts.messages),
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
  }
  if (opts.includeUsage !== false) body.stream_options = { include_usage: true }
  if (opts.tools.length > 0) {
    body.tools = buildOpenAiTools(opts.tools)
    body.tool_choice = 'auto'
  }

  const res = await fetchWithRetry(opts.url, {
    method: 'POST',
    headers: opts.headers,
    body: JSON.stringify(body),
  }, { providerName: opts.providerName })

  if (!res.ok || !res.body) throw new Error(`${opts.providerName} stream error`)

  // Some servers (or proxies) ignore `stream: true` and answer with a plain
  // JSON completion. Detect that and translate it into stream events instead
  // of returning an empty response.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json() as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
        }
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const message = data.choices?.[0]?.message
    if (message?.content) yield { type: 'text', text: message.content }
    if (message?.tool_calls && message.tool_calls.length > 0) {
      yield {
        type: 'tool_calls',
        toolCalls: message.tool_calls.map((tc, i) => ({
          id: tc.id ?? `call_${i}_${Date.now()}`,
          name: tc.function?.name ?? 'unknown',
          arguments: safeParseArgs(tc.function?.arguments ?? ''),
        })),
      }
    }
    if (data.usage) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        },
      }
    }
    return
  }

  // Tool calls arrive as fragments keyed by index
  const acc = new Map<number, { id: string; name: string; args: string }>()
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

  for await (const line of sseLines(res)) {
    const json = parseSseData(line)
    if (json === null) continue
    if (json === '[DONE]') break

    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    try { chunk = JSON.parse(json) } catch { continue }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      }
    }

    const delta = chunk.choices?.[0]?.delta
    if (delta?.content) yield { type: 'text', text: delta.content }

    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const cur = acc.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        acc.set(idx, cur)
      }
    }
  }

  if (acc.size > 0) {
    const toolCalls: ToolCall[] = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c], i) => ({
        id: c.id || `call_${i}_${Date.now()}`,
        name: c.name,
        arguments: safeParseArgs(c.args),
      }))
    yield { type: 'tool_calls', toolCalls }
  }

  if (usage) yield { type: 'usage', usage }
}
