import type { Message, LLMResponse, ProviderConfig, Tool, ToolCall } from '../utils/types.js'
import { QuotaGovernor, rpmFromEnv } from '../utils/quota.js'
import { printNotice } from '../utils/console.js'
import { fetchWithRetry } from '../utils/fetchHelper.js'
import { sseLines, parseSseData } from '../utils/sse.js'
import type { ProviderStreamEvent } from './streamShared.js'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash',          label: 'Gemini 3.8 Flash',      desc: 'Latest fast model, free-tier' },
  { id: 'gemini-2.5-pro-preview',    label: 'Gemini 2.5 Pro Preview', desc: 'Most capable model' },
  { id: 'gemini-2.5-flash',          label: 'Gemini 2.5 Flash',       desc: 'Affordable, 1M context' },
]

/**
 * Google Gemini provider adapter (Google AI Studio REST API).
 * Handles the unique Gemini payload format:
 *  - `contents: [{ role: 'user'|'model', parts: [...] }]` instead of `messages`
 *  - Tools use `functionDeclarations` inside a `tools` array
 *  - Tool calls returned as `functionCall: { name, args }` content parts
 *  - Tool results sent as `functionResponse` content parts
 *
 * No heavy SDK (@google/generative-ai) — uses native fetch only.
 */
export class GeminiProvider {
  private config: ProviderConfig
  private apiKey: string
  private baseUrl: string
  /**
   * Quota governor.
   *
   * AI Studio enforces RPM / TPM / RPD per project. The old fixed limiter
   * (60 req/min) fired far above the free-tier quota, which produced a lot
   * of HTTP 429s (visible as a low success rate on the AI Studio dashboard)
   * and long retry waits. The governor starts conservative, halves the rate
   * whenever the provider answers 429 and recovers slowly afterwards.
   * Override with ECO_RPM (e.g. 60 for a paid tier).
   */
  private quota = new QuotaGovernor({
    rpm: rpmFromEnv(10),
    minRpm: 2,
    maxRpm: rpmFromEnv(10),
  })

  constructor(config: ProviderConfig) {
    this.config = config
    this.apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? ''
    // Honor a custom baseUrl (proxy / tests)
    this.baseUrl = (config.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '')
    if (!this.apiKey) throw new Error('GEMINI_API_KEY not set. Get one free at aistudio.google.com. Run /config to configure it.')
  }

  /**
   * Build an error that carries the HTTP status.
   * The agent loop uses the status to decide whether a streaming failure may
   * be retried in another mode (4xx = invalid request → surface it).
   */
  private _error(status: number, message: string): Error {
    const err = new Error(message) as Error & { status?: number }
    err.status = status
    return err
  }

  /**
   * Feed the quota governor with the provider's answer:
   * 429 → halve our own rate, success → slowly recover.
   */
  private _onResponse(res: Response): void {
    if (res.status === 429) {
      this.quota.onRateLimited()
    } else if (res.ok) {
      this.quota.onSuccess()
    }
  }

  /**
   * Reserve a slot in the quota window.
   * Returns the number of milliseconds the caller has to wait, or 0.
   */
  private async _reserveQuota(): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { allowed, waitMs } = this.quota.reserve()
      if (allowed) return 0
      // We would exceed the quota — wait locally instead of asking the
      // provider and getting a 429 (which would also count as an error).
      printNotice(
        `\n  ! Gemini quota window full (${this.quota.rpm} req/min). ` +
        `Waiting ${Math.ceil(waitMs / 1000)}s locally instead of hitting the API...`
      )
      await new Promise(r => setTimeout(r, waitMs))
    }
    return 0
  }

  /**
   * Google AI Studio API keys (both classic "AIza..." and newer "AQ...." formats)
   * are always sent as the ?key= query parameter — not as Bearer tokens.
   *
   * Returns { url, headers } ready to use in fetch.
   */
  private _buildAuth(rawUrl: string): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // All Google AI Studio API key formats use the ?key= query param
    //
    // BUG FIX: the key used to be appended with a plain `?key=`, which broke
    // every URL that already had a query parameter:
    //   ...:streamGenerateContent?alt=sse?key=AIza...
    //   → 400 "Invalid value \"sse?key=...\" for query parameter 'alt'"
    // The streaming endpoint therefore ALWAYS failed and the agent fell back
    // to a second (non-streaming) request — doubling the latency and adding
    // a failed request to the provider dashboard.
    try {
      const url = new URL(rawUrl)
      url.searchParams.set('key', this.apiKey)
      return { url: url.toString(), headers }
    } catch {
      // Not an absolute URL — fall back to a plain string (and make sure the
      // key is separated with & when a query string already exists)
      const sep = rawUrl.includes('?') ? '&' : '?'
      return { url: `${rawUrl}${sep}key=${encodeURIComponent(this.apiKey)}`, headers }
    }
  }
  /**
   * Thinking budget (Gemini 3.x).
   *
   * The model spends "thought tokens" before the first visible token — on a
   * busy free tier that alone can take 30-90 seconds for a one-line answer.
   * Set ECO_THINKING_BUDGET to control it:
   *   0  → disable thinking (fastest)
   *   -1 → dynamic thinking (model decides, provider default)
   *   N  → fixed budget of N tokens
   * Not set → provider default (no thinkingConfig sent).
   */
  private _thinkingConfig(): { thinkingBudget: number } | undefined {
    const raw = process.env.ECO_THINKING_BUDGET
    if (raw === undefined || raw === '') return undefined
    const value = parseInt(raw, 10)
    if (!Number.isFinite(value)) return undefined
    return { thinkingBudget: value }
  }

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    // Stay inside the quota window locally (no 429 = no failed request)
    await this._reserveQuota()

    const { contents, systemInstruction } = this._normalizeMessages(messages)

    // Convert tools to Gemini `functionDeclarations` format
    const geminiTools = tools.length > 0 ? [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description }])
          ),
          required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k)
        }
      }))
    }] : undefined

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: this.config.temperature ?? 0.7,
        maxOutputTokens: this.config.maxTokens ?? 4096,
        ...(this._thinkingConfig() ? { thinkingConfig: this._thinkingConfig() } : {}),
      }
    }

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }

    if (geminiTools) body.tools = geminiTools

    const rawUrl = `${this.baseUrl}/${this.config.model}:generateContent`
    const { url, headers } = this._buildAuth(rawUrl)

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, { providerName: 'Gemini', onResponse: (r) => this._onResponse(r) })

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`
      try {
        const err = await res.json() as { error?: { message?: string; status?: string } }
        errMsg = err.error?.message ?? errMsg
      } catch { /* ignore */ }

      if (res.status === 429) throw this._error(res.status,
        'Gemini rate limit reached (HTTP 429). The free tier quota (requests per minute or tokens per minute) is exhausted — ' +
        'wait about a minute, use /clear to shrink the context, or switch provider (/config).'
      )
      if (res.status === 400) throw this._error(res.status, `Gemini bad request: ${errMsg}`)
      if (res.status === 403) throw this._error(res.status, 'Gemini: Invalid API Key or API not enabled. Check aistudio.google.com.')
      if (res.status === 503) throw this._error(res.status, `Gemini is temporarily overloaded (503): ${errMsg}\n  → This is a server-side queue at Google — try again in a minute, use a different model, or switch provider (/config).`)
      throw this._error(res.status, `Gemini error: ${errMsg}`)
    }

    const data = await res.json() as {
      candidates: Array<{
        content: {
          role: string
          parts: Array<
            | { text: string; thoughtSignature?: string }
            | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
          >
        }
        finishReason: string
      }>
      usageMetadata?: {
        promptTokenCount: number
        candidatesTokenCount: number
        totalTokenCount: number
      }
    }

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('Gemini: No candidates returned. The model may have blocked the response or encountered an error.')
    }

    const candidate = data.candidates[0]
    // parts may be missing entirely when the response is blocked by safety
    // filters (finishReason: SAFETY/RECITATION) — guard against a crash
    const parts = candidate.content?.parts ?? []

    // Extract text content
    const textContent = parts
      .filter((p): p is { text: string } => 'text' in p)
      .map(p => p.text)
      .join('')

    // Extract function calls
    const functionCallParts = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string } => 'functionCall' in p
    )

    // Gemini 3.x attaches a "thought signature" to the part that carries the
    // reasoning. It can be attached to a text part or to the functionCall
    // part — keep whichever we find so we can echo it back on the next turn.
    const turnSignature = parts
      .map(p => (p as { thoughtSignature?: string }).thoughtSignature)
      .find((s): s is string => typeof s === 'string' && s.length > 0)

    const toolCalls = functionCallParts.length > 0
      ? functionCallParts.map((p, i) => ({
          id: `gemini_call_${i}_${Date.now()}`,
          name: p.functionCall.name,
          arguments: p.functionCall.args,
          // Gemini 3.x: keep the thought signature so we can echo it back
          thoughtSignature: p.thoughtSignature ?? turnSignature,
        }))
      : undefined

    const usage = data.usageMetadata ? {
      promptTokens: data.usageMetadata.promptTokenCount,
      completionTokens: data.usageMetadata.candidatesTokenCount,
      totalTokens: data.usageMetadata.totalTokenCount
    } : undefined

    const finishReason = candidate.finishReason

    return {
      content: textContent,
      toolCalls,
      finishReason: (finishReason === 'STOP' && toolCalls) ? 'tool_calls' : toolCalls ? 'tool_calls' : 'stop',
      usage
    }
  }

  /**
   * Streaming with tool support (Gemini `streamGenerateContent?alt=sse`).
   *
   * Each SSE event carries `candidates[0].content.parts`, which may contain
   * text and/or functionCall parts (with the Gemini 3.x thoughtSignature).
   * Function calls are collected and emitted as a `tool_calls` event.
   */
  async *streamWithTools(messages: Message[], tools: Tool[] = []): AsyncGenerator<ProviderStreamEvent> {
    await this._reserveQuota()
    const { contents, systemInstruction } = this._normalizeMessages(messages)

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: this.config.temperature ?? 0.7,
        maxOutputTokens: this.config.maxTokens ?? 4096,
        ...(this._thinkingConfig() ? { thinkingConfig: this._thinkingConfig() } : {}),
      },
    }
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] }
    if (tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description }])
            ),
            required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
          },
        })),
      }]
    }

    const rawStreamUrl = `${this.baseUrl}/${this.config.model}:streamGenerateContent?alt=sse`
    const { url, headers } = this._buildAuth(rawStreamUrl)

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, { providerName: 'Gemini', onResponse: (r) => this._onResponse(r) })

    if (!res.ok || !res.body) throw new Error('Gemini stream error')

    // Server answered with a plain JSON body instead of SSE → translate it
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const data = await res.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<
              | { text?: string; thoughtSignature?: string }
              | { functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
            >
          }
        }>
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
      }
      const parts = data.candidates?.[0]?.content?.parts ?? []
      const sig = parts.map(p => (p as { thoughtSignature?: string }).thoughtSignature).find(Boolean)
      const calls: ToolCall[] = []
      for (const part of parts) {
        const p = part as { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
        if (p.text) yield { type: 'text', text: p.text }
        if (p.functionCall) {
          calls.push({
            id: `gemini_call_${calls.length}_${Date.now()}`,
            name: p.functionCall.name,
            arguments: p.functionCall.args ?? {},
            thoughtSignature: p.thoughtSignature ?? sig,
          })
        }
      }
      if (calls.length > 0) yield { type: 'tool_calls', toolCalls: calls }
      if (data.usageMetadata) {
        yield {
          type: 'usage',
          usage: {
            promptTokens: data.usageMetadata.promptTokenCount ?? 0,
            completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          },
        }
      }
      return
    }

    const toolCalls: ToolCall[] = []
    const signatures: string[] = []
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

    for await (const line of sseLines(res)) {
      const json = parseSseData(line)
      if (json === null) continue
      if (json === '[DONE]') break
      try {
        const chunk = JSON.parse(json) as {
          candidates?: Array<{
            content?: {
              parts?: Array<
                | { text?: string; thoughtSignature?: string }
                | { functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
              >
            }
          }>
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
        }

        if (chunk.usageMetadata) {
          usage = {
            promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
          }
        }

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          const p = part as { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
          if (p.thoughtSignature && !signatures.includes(p.thoughtSignature)) {
            signatures.push(p.thoughtSignature)
          }
          if (p.text) yield { type: 'text', text: p.text }
          if (p.functionCall) {
            toolCalls.push({
              id: `gemini_call_${toolCalls.length}_${Date.now()}`,
              name: p.functionCall.name,
              arguments: p.functionCall.args ?? {},
              thoughtSignature: p.thoughtSignature ?? signatures[0],
            })
          }
        }
      } catch { /* skip */ }
    }

    if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls }
    if (usage) yield { type: 'usage', usage }
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    await this._reserveQuota()
    const { contents, systemInstruction } = this._normalizeMessages(messages)

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: this.config.temperature ?? 0.7,
        maxOutputTokens: this.config.maxTokens ?? 4096,
        ...(this._thinkingConfig() ? { thinkingConfig: this._thinkingConfig() } : {}),
      }
    }
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }

    const rawStreamUrl = `${this.baseUrl}/${this.config.model}:streamGenerateContent?alt=sse`
    const { url, headers } = this._buildAuth(rawStreamUrl)

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, { providerName: 'Gemini', onResponse: (r) => this._onResponse(r) })

    if (!res.ok || !res.body) throw new Error('Gemini stream error')

    for await (const line of sseLines(res)) {
      const json = parseSseData(line)
      if (json === null) continue
      if (json === '[DONE]') return
      try {
        const chunk = JSON.parse(json) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> }
          }>
        }
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) yield text
      } catch { /* skip */ }
    }
  }

  /**
   * Normalize eco-agent internal messages to Gemini `contents` format.
   * Key differences:
   *  - `system` messages are extracted to `systemInstruction`
   *  - `tool` messages become `functionResponse` parts inside a `user` content block
   *  - `assistant` role maps to Gemini's `model` role
   */
  private _normalizeMessages(messages: Message[]): {
    contents: Array<Record<string, unknown>>
    systemInstruction: string
  } {
    const systemMessages = messages.filter(m => m.role === 'system')
    const systemInstruction = systemMessages.map(m => m.content).join('\n')

    const nonSystemMessages = messages.filter(m => m.role !== 'system')
    const contents: Array<Record<string, unknown>> = []

    for (const m of nonSystemMessages) {
      if (m.role === 'tool') {
        // Tool results become functionResponse parts in a user content block
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.toolName ?? 'unknown_tool',
              response: { result: m.content }
            }
          }]
        })
      } else {
        // Map eco-agent roles to Gemini roles
        const geminiRole = m.role === 'assistant' ? 'model' : 'user'
        // Assistant messages that announced tool calls must be sent back as
        // model functionCall parts, or Gemini rejects the functionResponse
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const modelParts: Array<Record<string, unknown>> = []
          if (m.content) modelParts.push({ text: m.content })
          // Gemini 3.x requires a thought_signature on functionCall parts.
          // The model returns the signature on (usually) the first function
          // call part; it must be echoed back VERBATIM or the API replies
          //   400 "Function call is missing a thought_signature in functionCall parts"
          const signatures = m.toolCalls.map(tc => tc.thoughtSignature).filter((s): s is string => !!s)
          m.toolCalls.forEach((tc, idx) => {
            const part: Record<string, unknown> = { functionCall: { name: tc.name, args: tc.arguments ?? {} } }
            const sig = tc.thoughtSignature ?? signatures[0]
            if (sig) part.thoughtSignature = sig
            modelParts.push(part)
          })
          contents.push({ role: 'model', parts: modelParts })
          continue
        }
        contents.push({
          role: geminiRole,
          parts: [{ text: m.content }]
        })
      }
    }

    return { contents, systemInstruction }
  }
}
