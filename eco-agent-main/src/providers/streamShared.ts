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

/**
 * Mark an error as safe to retry immediately with the same model. The agent
 * loop uses this for upstream stream failures (finish_reason:"error" or a
 * half-written tool call). Network errors already went through fetchWithRetry,
 * so they are not marked and go straight to the non-streaming attempt.
 */
export function sameModelRetryError(message: string): Error {
  const err = new Error(message) as Error & { retrySameModel?: boolean }
  err.retrySameModel = true
  return err
}

/**
 * Parse tool-call arguments without silently turning a truncated payload into
 * `{}`. A reasoning model can hit an upstream stream error halfway through a
 * large `write_file` call; executing that partial call produces confusing
 * "Missing required parameter 'path'" errors. Throwing here lets the agent
 * retry the SAME model instead of running a half-written tool call.
 */
export function parseToolArguments(
  raw: string,
  providerName: string,
  toolName: string
): Record<string, unknown> {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw sameModelRetryError(
      `${providerName}: the tool call for "${toolName}" was cut off before its arguments were complete.`
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${providerName}: invalid arguments returned for tool "${toolName}".`)
  }
  return parsed as Record<string, unknown>
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
 * Default output budget for OpenAI-compatible providers.
 *
 * 4096 was too small for reasoning models that also emit a large
 * `write_file` tool call: the JSON arguments could be cut off mid-string,
 * which looked like "Missing required parameter 'path'". 8192 leaves room
 * for reasoning + a complete file body. Override with ECO_MAX_TOKENS.
 */
export function defaultMaxTokens(): number {
  const raw = process.env.ECO_MAX_TOKENS
  const value = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(value) && value > 0 ? value : 8192
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
    max_tokens: opts.maxTokens ?? defaultMaxTokens(),
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

  if (!res.ok || !res.body) {
    // Keep the HTTP status on the error so the agent loop can tell a broken
    // request (4xx: bad key, rate limit, invalid parameter) from a transient
    // upstream failure. Repeating a 4xx through the non-streaming endpoint
    // would only waste another request.
    let detail = ''
    try { detail = (await res.clone().text()).slice(0, 300) } catch { /* ignore */ }
    const err = new Error(
      `${opts.providerName} stream error (HTTP ${res.status})${detail ? `: ${detail}` : ''}`
    ) as Error & { status?: number }
    err.status = res.status
    throw err
  }

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
        finish_reason?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const choice = data.choices?.[0]
    const message = choice?.message
    const finishReason = choice?.finish_reason ?? ''
    if (finishReason === 'error') {
      throw sameModelRetryError(`${opts.providerName}: the upstream provider returned an error before completing the response.`)
    }
    if (message?.content) yield { type: 'text', text: message.content }
    if (message?.tool_calls && message.tool_calls.length > 0) {
      if (finishReason === 'length') {
        throw new Error(`${opts.providerName}: the tool call was cut off by the output-token limit.`)
      }
      yield {
        type: 'tool_calls',
        toolCalls: message.tool_calls.map((tc, i) => ({
          id: tc.id ?? `call_${i}_${Date.now()}`,
          name: tc.function?.name ?? 'unknown',
          arguments: parseToolArguments(
            tc.function?.arguments ?? '',
            opts.providerName,
            tc.function?.name ?? 'unknown'
          ),
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
  let finishReason = ''
  let textStarted = false
  let pendingText = ''

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
        finish_reason?: string
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

    const choice = chunk.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta

    // Hold back whitespace-only deltas. Some upstreams send blank lines just
    // before failing; forwarding them makes the CLI draw an empty response
    // block and prevents the agent from retrying the same model.
    if (delta?.content) {
      if (textStarted) {
        yield { type: 'text', text: delta.content }
      } else {
        pendingText += delta.content
        if (pendingText.trim()) {
          yield { type: 'text', text: pendingText }
          pendingText = ''
          textStarted = true
        }
      }
    }

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

  // An upstream provider can end a 200 SSE response with finish_reason:"error"
  // (OpenRouter providers do this). The old code ignored it, parsed the
  // half-written tool arguments as `{}` and ran the tool, producing confusing
  // "Missing required parameter" errors. Fail here so the agent can retry the
  // SAME model instead.
  if (finishReason === 'error') {
    throw sameModelRetryError(
      `${opts.providerName}: the upstream provider returned an error before completing the response.`
    )
  }
  if (finishReason === 'content_filter') {
    throw new Error(`${opts.providerName}: the response was blocked by the provider's content filter.`)
  }
  if (finishReason === 'length') {
    throw new Error(
      `${opts.providerName}: the response was cut off by the output-token limit` +
      (acc.size > 0 ? ' before the tool call was complete.' : '.')
    )
  }

  if (acc.size > 0) {
    const toolCalls: ToolCall[] = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c], i) => ({
        id: c.id || `call_${i}_${Date.now()}`,
        name: c.name,
        arguments: parseToolArguments(c.args, opts.providerName, c.name || 'unknown'),
      }))
    yield { type: 'tool_calls', toolCalls }
  }

  if (usage) yield { type: 'usage', usage }
}
