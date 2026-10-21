import type { Message, LLMResponse, ProviderConfig, Tool, ToolCall } from '../utils/types.js'
import { RateLimiter } from '../utils/security.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines, parseSseData } from '../utils/sse.js'
import type { ProviderStreamEvent } from './streamShared.js'

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'

export const ANTHROPIC_MODELS = [
  { id: 'claude-3-5-sonnet-latest',  label: 'Claude 3.5 Sonnet',  desc: 'Best balance — coding & instruction following' },
  { id: 'claude-3-5-haiku-latest',   label: 'Claude 3.5 Haiku',   desc: 'Fast & affordable' },
  { id: 'claude-opus-4-5',           label: 'Claude Opus 4.5',    desc: 'Most powerful Claude model' },
  { id: 'claude-sonnet-4-5',         label: 'Claude Sonnet 4.5',  desc: 'Latest Sonnet, strong performance' },
]

/**
 * Anthropic (Claude) provider adapter.
 * Handles the unique Claude Messages API format:
 *  - system prompt is a top-level field (not inside messages[])
 *  - tool definitions use `input_schema` instead of `parameters`
 *  - tool call responses are `tool_use` content blocks
 *  - tool results are sent as `tool_result` content blocks with role=user
 *
 * No heavy SDK (@anthropic-ai/sdk) — uses native fetch only.
 */
export class AnthropicProvider {
  private config: ProviderConfig
  private apiKey: string
  private baseUrl: string
  private rateLimiter = new RateLimiter(50, 60000) // 50 req/min

  constructor(config: ProviderConfig) {
    this.config = config
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ''
    // Honor a custom baseUrl (self-hosted gateway / proxy / tests)
    this.baseUrl = (config.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY not set. Get one at console.anthropic.com. Run /config to configure it.')
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    const rl = this.rateLimiter.check()
    if (!rl.allowed) {
      const waitSec = Math.ceil((rl.retryAfterMs ?? 5000) / 1000)
      throw new Error(`Rate limit reached. Please wait ${waitSec}s.`)
    }

    // Extract system prompt — Claude requires it as a top-level field
    const systemMessages = messages.filter(m => m.role === 'system')
    const systemPrompt = systemMessages.map(m => m.content).join('\n')

    // Build Claude-format messages (no system role in array)
    const claudeMessages = this._normalizeMessages(messages.filter(m => m.role !== 'system'))

    // Convert tools to Anthropic format: `input_schema` instead of `parameters`
    const claudeTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
        ),
        required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k)
      }
    }))

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 4096,
      messages: claudeMessages,
    }

    if (systemPrompt) body.system = systemPrompt
    if (claudeTools.length > 0) {
      body.tools = claudeTools
      body.tool_choice = { type: 'auto' }
    }

    const res = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body)
    }, { providerName: 'Anthropic' })

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`
      try {
        const err = await res.json() as { error?: { message?: string; type?: string } }
        errMsg = err.error?.message ?? errMsg
      } catch { /* ignore */ }

      if (res.status === 429) throw new Error('Anthropic rate limit reached. Please wait a moment.')
      if (res.status === 401) throw new Error('Anthropic: Invalid API Key. Run /config to update it.')
      if (res.status === 400) throw new Error(`Anthropic bad request: ${errMsg}`)
      throw new Error(`Anthropic error: ${errMsg}`)
    }

    const data = await res.json() as {
      id: string
      type: string
      role: string
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }

    // Gather text content
    const textContent = data.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    // Gather tool calls from tool_use blocks
    const toolUseBlocks = data.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use'
    )

    const toolCalls = toolUseBlocks.length > 0
      ? toolUseBlocks.map(b => ({ id: b.id, name: b.name, arguments: b.input }))
      : undefined

    const usage = {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: data.usage.input_tokens + data.usage.output_tokens
    }

    return {
      content: textContent,
      toolCalls,
      finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      usage
    }
  }

  /**
   * Streaming with tool support.
   *
   * Claude streams typed events: `content_block_start` (text / tool_use),
   * `content_block_delta` (text_delta / input_json_delta) and `message_delta`
   * (stop_reason + usage). Tool inputs arrive as JSON fragments, so they are
   * accumulated per block index and parsed at the end.
   */
  async *streamWithTools(messages: Message[], tools: Tool[] = []): AsyncGenerator<ProviderStreamEvent> {
    const systemMessages = messages.filter(m => m.role === 'system')
    const systemPrompt = systemMessages.map(m => m.content).join('\n')
    const claudeMessages = this._normalizeMessages(messages.filter(m => m.role !== 'system'))

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 4096,
      messages: claudeMessages,
      stream: true,
    }
    if (systemPrompt) body.system = systemPrompt
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
          ),
          required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
        },
      }))
    }

    const res = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    }, { providerName: 'Anthropic' })

    if (!res.ok || !res.body) throw new Error('Anthropic stream error')

    // Server answered with a plain JSON body instead of SSE → translate it
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const data = await res.json() as {
        content?: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        >
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const calls: ToolCall[] = []
      for (const block of data.content ?? []) {
        if (block.type === 'text') yield { type: 'text', text: block.text }
        else if (block.type === 'tool_use') {
          calls.push({ id: block.id, name: block.name, arguments: block.input ?? {} })
        }
      }
      if (calls.length > 0) yield { type: 'tool_calls', toolCalls: calls }
      if (data.usage) {
        const inTok = data.usage.input_tokens ?? 0
        const outTok = data.usage.output_tokens ?? 0
        yield { type: 'usage', usage: { promptTokens: inTok, completionTokens: outTok, totalTokens: inTok + outTok } }
      }
      return
    }

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

    for await (const line of sseLines(res)) {
      const json = parseSseData(line)
      if (json === null) continue
      let chunk: {
        type: string
        index?: number
        content_block?: { type: string; id?: string; name?: string; text?: string }
        delta?: { type?: string; text?: string; partial_json?: string }
        usage?: { input_tokens?: number; output_tokens?: number }
        message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      }
      try { chunk = JSON.parse(json) } catch { continue }

      if (chunk.type === 'message_start' && chunk.message?.usage) {
        usage = {
          promptTokens: chunk.message.usage.input_tokens ?? 0,
          completionTokens: chunk.message.usage.output_tokens ?? 0,
          totalTokens: (chunk.message.usage.input_tokens ?? 0) + (chunk.message.usage.output_tokens ?? 0),
        }
      }

      if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
        toolBlocks.set(chunk.index ?? 0, {
          id: chunk.content_block.id ?? `toolu_${chunk.index ?? 0}`,
          name: chunk.content_block.name ?? 'unknown',
          json: '',
        })
      }

      if (chunk.type === 'content_block_delta') {
        if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
          yield { type: 'text', text: chunk.delta.text }
        } else if (chunk.delta?.type === 'input_json_delta' && chunk.delta.partial_json) {
          const idx = chunk.index ?? 0
          const cur = toolBlocks.get(idx) ?? { id: `toolu_${idx}`, name: 'unknown', json: '' }
          cur.json += chunk.delta.partial_json
          toolBlocks.set(idx, cur)
        }
      }

      if (chunk.type === 'message_delta' && chunk.usage) {
        const inTok = chunk.usage.input_tokens ?? usage?.promptTokens ?? 0
        const outTok = chunk.usage.output_tokens ?? usage?.completionTokens ?? 0
        usage = { promptTokens: inTok, completionTokens: outTok, totalTokens: inTok + outTok }
      }
    }

    if (toolBlocks.size > 0) {
      const toolCalls: ToolCall[] = [...toolBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(b.json || '{}') as Record<string, unknown> } catch { /* keep empty */ }
          return { id: b.id, name: b.name, arguments: args }
        })
      yield { type: 'tool_calls', toolCalls }
    }

    if (usage) yield { type: 'usage', usage }
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const systemMessages = messages.filter(m => m.role === 'system')
    const systemPrompt = systemMessages.map(m => m.content).join('\n')
    const claudeMessages = this._normalizeMessages(messages.filter(m => m.role !== 'system'))

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 4096,
      messages: claudeMessages,
      stream: true,
    }
    if (systemPrompt) body.system = systemPrompt

    const res = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body)
    }, { providerName: 'Anthropic' })

    if (!res.ok || !res.body) throw new Error('Anthropic stream error')

    for await (const line of sseLines(res)) {
      const json = parseSseData(line)
      if (json === null) continue
      try {
        const chunk = JSON.parse(json) as {
          type: string
          delta?: { type?: string; text?: string }
        }
        // Claude streaming uses content_block_delta events
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          const text = chunk.delta.text
          if (text) yield text
        }
      } catch { /* skip */ }
    }
  }

  /**
   * Normalize eco-agent internal messages to Claude Messages format.
   * Key differences:
   *  - tool role messages → `tool_result` blocks grouped into a SINGLE user
   *    message (Claude requires all results of one turn in one user message)
   *  - assistant tool calls are sent as `tool_use` content blocks (required by
   *    Claude to accept the following tool_result blocks)
   *  - consecutive same-role messages are merged (Claude requires strict
   *    user/assistant alternation)
   */
  private _normalizeMessages(messages: Message[]): Array<Record<string, unknown>> {
    // Pass 1 — group consecutive tool results into one user message and
    // materialise assistant toolCalls as tool_use blocks.
    const grouped: Array<{ role: string; content: unknown }> = []
    let pendingToolResults: unknown[] = []

    const flushToolResults = () => {
      if (pendingToolResults.length > 0) {
        grouped.push({ role: 'user', content: pendingToolResults })
        pendingToolResults = []
      }
    }

    for (const m of messages) {
      if (m.role === 'tool') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? 'unknown',
          content: m.content
        })
        continue
      }
      flushToolResults()
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const blocks: unknown[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} })
        }
        grouped.push({ role: 'assistant', content: blocks })
      } else {
        grouped.push({ role: m.role, content: m.content })
      }
    }
    flushToolResults()

    // Pass 2 — merge consecutive same-role messages (Claude requires
    // alternating user/assistant roles).
    const merged: Array<Record<string, unknown>> = []
    for (const msg of grouped) {
      const last = merged[merged.length - 1]
      if (last && last.role === msg.role) {
        const prev = Array.isArray(last.content)
          ? last.content
          : (last.content ? [{ type: 'text', text: last.content }] : [])
        const cur = Array.isArray(msg.content)
          ? (msg.content as unknown[])
          : (msg.content ? [{ type: 'text', text: msg.content }] : [])
        last.content = [...prev, ...cur]
      } else {
        merged.push({ ...msg })
      }
    }
    return merged
  }
}
