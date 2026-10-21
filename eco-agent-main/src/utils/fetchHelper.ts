/**
 * Shared fetch retry helper for all LLM providers.
 * Extracted to eliminate code duplication across groq.ts, openrouter.ts, ollama.ts.
 */
import { printNotice } from './console.js'

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  /** Provider name shown in retry warning messages */
  providerName?: string
  /**
   * Called for every response the provider returns (before a retry).
   * Used to feed the quota governor (429 = slow down, 200 = recover).
   */
  onResponse?: (res: Response) => void
  /**
   * Stop retrying after this many consecutive 429 responses.
   * A repeated 429 means the quota is exhausted — retrying only makes the
   * dashboard success rate worse and wastes the user's time.
   */
  maxConsecutive429?: number
}

/**
 * Read a provider supplied retry delay.
 * Google (Gemini) returns `retryDelay: "27s"` inside the error payload when a
 * model is overloaded ("high demand") — waiting exactly that long is much
 * more likely to succeed than a fixed backoff.
 */
function extractRetryDelay(body: unknown): number | undefined {
  try {
    const err = (body as { error?: { details?: Array<Record<string, unknown>> } })?.error
    const detail = err?.details?.find(d => typeof d.retryDelay === 'string')
    const raw = detail?.retryDelay as string | undefined
    if (!raw) return undefined
    const seconds = parseInt(raw, 10)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  } catch { /* ignore */ }
  return undefined
}

/**
 * Fetch with exponential backoff retry on 429 and 5xx errors.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOpts: RetryOptions = {}
): Promise<Response> {
  const { maxRetries = 3, initialDelayMs = 1000, providerName = 'API', onResponse, maxConsecutive429 = 2 } = retryOpts

  let retries = 0
  let delayMs = initialDelayMs
  let consecutive429 = 0

  while (true) {
    let res: Response
    try {
      res = await fetch(url, options)
    } catch (networkErr: unknown) {
      const err = networkErr as Error & { cause?: unknown }
      if (retries < maxRetries) {
        retries++
        const causeMsg = (err.cause as Error)?.message || (typeof err.cause === 'string' ? err.cause : '') || err.message
        printNotice(
          `\n  ! ${providerName} network connection interrupted (${causeMsg}). ` +
          `Retrying in ${delayMs / 1000}s... (${retries}/${maxRetries})`
        )
        await new Promise(r => setTimeout(r, delayMs))
        delayMs *= 2
        continue
      }
      const causeMsg = (err.cause as Error)?.message || (typeof err.cause === 'string' ? err.cause : '') || ''
      const detailed = causeMsg ? `${err.message} (${causeMsg})` : err.message
      const enhanced = new Error(`${providerName}: Connection failed - ${detailed}`)
      ;(enhanced as unknown as { cause: unknown }).cause = err.cause
      throw enhanced
    }

    onResponse?.(res)

    if (res.status === 429) consecutive429++
    else consecutive429 = 0

    // Quota exhausted (repeated 429): stop hammering the API
    if (res.status === 429 && consecutive429 >= maxConsecutive429) {
      let msg = 'rate limit exceeded'
      try {
        const data = await res.clone().json() as { error?: { message?: string } }
        msg = data?.error?.message ?? msg
      } catch { /* keep default */ }
      printNotice(
        `\n  ! ${providerName}: quota exhausted (HTTP 429 x${consecutive429}) — ${msg}` +
        `\n    → The provider's free tier is rate limited. Eco Agent stopped retrying so it does not waste quota.` +
        `\n    → Wait a minute, or switch provider (/config) for an instant, unthrottled answer.`
      )
      return res
    }

    if ((res.status === 429 || res.status >= 500) && retries < maxRetries) {
      retries++

      let errMsg = res.statusText
      let bodyJson: unknown
      try {
        const clone = res.clone()
        bodyJson = await clone.json()
        errMsg = (bodyJson as { error?: { message?: string } })?.error?.message || res.statusText
      } catch {
        try {
          const text = await res.clone().text()
          errMsg = text || res.statusText
        } catch {
          // keep statusText
        }
      }

      const retryAfter = res.headers.get('Retry-After')
      let waitTime: number
      const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN
      // Retry-After can be either seconds (number) or an HTTP-date (e.g.
      // "Wed, 21 Oct 2026 12:00:00 GMT"). parseInt() returns NaN for dates,
      // which would collapse the backoff to ~1ms and hammer the API.
      if (Number.isFinite(seconds) && seconds > 0) {
        waitTime = seconds * 1000
      } else if (retryAfter && isNaN(seconds)) {
        const date = new Date(retryAfter)
        waitTime = Number.isFinite(date.getTime()) ? Math.max(0, date.getTime() - Date.now()) : delayMs
      } else {
        // Provider supplied delay (Google: "high demand" → retryDelay: "27s")
        waitTime = extractRetryDelay(bodyJson) ?? delayMs
      }
      // Cap the wait so a giant Retry-After doesn't freeze the CLI
      const MAX_WAIT = 30000
      if (waitTime > MAX_WAIT) waitTime = MAX_WAIT

      const overloaded = /high demand|overloaded|unavailable|rate limit/i.test(errMsg)
      printNotice(
        `\n  ! ${providerName}: ${errMsg} (HTTP ${res.status}). ` +
        `Retrying in ${waitTime / 1000}s... (${retries}/${maxRetries})` +
        (overloaded
          ? `\n    → The provider is temporarily overloaded or throttling us — this is a server-side queue, not a bug in your setup.`
          : '')
      )
      await new Promise(r => setTimeout(r, waitTime))

      delayMs *= 2 // exponential backoff
      continue
    }

    return res
  }
}
