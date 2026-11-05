/**
 * Rate-limit parsing and quota-reset display.
 *
 * Why this exists: users on free tiers (OpenRouter :free, Groq free,
 * Google AI Studio) hit quota exhaustions that USED to print only
 * "wait a minute" — but the provider usually states exactly WHEN the
 * quota recovers, and knowing that time is actionable information.
 *
 * Every provider reports the reset differently:
 *   - OpenRouter: `X-RateLimit-Reset` header (epoch ms) and, in error bodies,
 *     also `error.metadata.headers["X-RateLimit-Reset"]` plus a
 *     `limit_source` label like "openrouter_free_tier_daily".
 *   - Groq: `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens`
 *     (time-until-reset), plus `retry-after` seconds.
 *   - Anthropic: `retry-after` seconds.
 *   - Google AI Studio: nothing usable per-request → their free-tier daily
 *     cap renews at midnight Pacific; we compute that instant for the user.
 */

export interface RateLimitInfo {
  /** Absolute epoch ms at which the quota window resets (best available). */
  resetMs?: number
  /**
   * Requests remaining in the current window, when the provider tells us.
   * 0 remaining + a far-future reset = daily cap exhausted — no retry helps
   * until the reset time.
   */
  remaining?: number
  /** Requests allowed in the current window, when reported. */
  limit?: number
  /** Provider label of the exhausted limit, e.g. "openrouter_free_tier_daily". */
  source?: string
}

/** Error that carries rate-limit context for the CLI to display. */
export type RateLimitError = Error & { status?: number; rateLimit?: RateLimitInfo }

/** Attach parsed rate-limit info to an error so the CLI can show the reset time. */
export function withRateLimit(err: Error, info: RateLimitInfo | undefined): Error {
  if (info) (err as RateLimitError).rateLimit = info
  return err
}

/**
 * Accepts the several ways providers express a reset instant:
 *   - epoch milliseconds (>= 1e12)
 *   - epoch seconds      (1e9 .. 1e12)
 *   - relative milliseconds (< 1e9, Groq-style "x-ratelimit-reset: 123000")
 *   - ISO timestamp / HTTP-date strings
 */
function parseTimeValue(value: unknown, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return value
    if (value >= 1e9) return value * 1000
    return now + value
  }
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!s) return undefined
  if (/^\d+$/.test(s)) return parseTimeValue(Number(s), now)
  const d = new Date(s).getTime()
  return Number.isFinite(d) && d > 0 ? d : undefined
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : undefined
}

const RESET_HEADERS = [
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset',
]
const REMAINING_HEADERS = ['x-ratelimit-remaining-requests', 'x-ratelimit-remaining']
const LIMIT_HEADERS = ['x-ratelimit-limit-requests', 'x-ratelimit-limit']

function hasContent(info: RateLimitInfo): boolean {
  return info.resetMs !== undefined || info.remaining !== undefined ||
    info.limit !== undefined || info.source !== undefined
}

/** Read rate-limit headers from any Response (works on Node 18+ undici Headers). */
export function rateLimitFromHeaders(headers: Headers, now = Date.now()): RateLimitInfo | undefined {
  const info: RateLimitInfo = {}
  for (const name of RESET_HEADERS) {
    const v = headers.get(name)
    if (v) {
      const resetMs = parseTimeValue(v, now)
      if (resetMs) { info.resetMs = resetMs; break }
    }
  }
  for (const name of REMAINING_HEADERS) {
    const v = toInt(headers.get(name))
    if (v !== undefined) { info.remaining = v; break }
  }
  for (const name of LIMIT_HEADERS) {
    const v = toInt(headers.get(name))
    if (v !== undefined) { info.limit = v; break }
  }
  const source = headers.get('x-ratelimit-source')
  if (source) info.source = source
  // Plain `Retry-After` (seconds) — Anthropic / generic HTTP-style limit.
  if (info.resetMs === undefined) {
    const retryAfter = headers.get('retry-after')
    if (retryAfter) {
      const sec = parseInt(retryAfter, 10)
      if (Number.isFinite(sec) && sec > 0) info.resetMs = now + sec * 1000
    }
  }
  return hasContent(info) ? info : undefined
}

/**
 * OpenRouter answers 429 with a JSON body that repeats the rate-limit headers
 * inside `error.metadata.headers` and names the window:
 *   { "error": { "message": "Rate limit exceeded: free-models-per-day …",
 *     "code": 429, "metadata": { "headers": { "X-RateLimit-Reset": "1793923200000", … },
 *     "limit_source": "openrouter_free_tier_daily" } } }
 */
export function rateLimitFromBody(body: unknown, now = Date.now()): RateLimitInfo | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const err = (body as { error?: unknown }).error
  if (typeof err !== 'object' || err === null) return undefined
  const meta = (err as { metadata?: unknown }).metadata
  if (typeof meta !== 'object' || meta === null) return undefined

  const info: RateLimitInfo = {}
  const headers = (meta as { headers?: Record<string, unknown> }).headers
  if (typeof headers === 'object' && headers !== null) {
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase()
      if (info.resetMs === undefined && RESET_HEADERS.includes(lower)) {
        info.resetMs = parseTimeValue(value, now)
      } else if (info.remaining === undefined && REMAINING_HEADERS.includes(lower)) {
        info.remaining = toInt(value)
      } else if (info.limit === undefined && LIMIT_HEADERS.includes(lower)) {
        info.limit = toInt(value)
      }
    }
  }
  const source = (meta as { limit_source?: unknown }).limit_source
  if (typeof source === 'string') info.source = source
  return hasContent(info) ? info : undefined
}

/** Merge — first defined value of each field wins. */
export function mergeRateLimit(...parts: Array<RateLimitInfo | undefined>): RateLimitInfo | undefined {
  const merged: RateLimitInfo = {}
  for (const p of parts) {
    if (!p) continue
    if (merged.resetMs === undefined) merged.resetMs = p.resetMs
    if (merged.remaining === undefined) merged.remaining = p.remaining
    if (merged.limit === undefined) merged.limit = p.limit
    if (merged.source === undefined) merged.source = p.source
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Human description of WHEN the quota recovers, in the user's LOCAL time.
 * Returns undefined when the provider gave nothing computable.
 */
export function describeQuotaReset(info: RateLimitInfo | undefined, now = Date.now()): string | undefined {
  if (!info || info.resetMs === undefined) return undefined
  const deltaMs = info.resetMs - now
  if (deltaMs <= 15_000) return 'Quota window has just reset — try again now.'

  const h = Math.floor(deltaMs / 3_600_000)
  const m = Math.floor((deltaMs % 3_600_000) / 60_000)
  const sec = Math.round(deltaMs / 1000)
  const inStr = h > 0
    ? `${h}h ${m}m`
    : deltaMs >= 60_000 ? `${Math.floor(deltaMs / 60_000)} min` : `${sec}s`

  const at = new Date(info.resetMs).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  })
  const qualifier = info.source?.includes('daily') ? 'Free-tier daily quota' : 'Quota'
  return `${qualifier} recovers in ${inStr} — ${at} (local time)`
}

/**
 * Google AI Studio: free-tier daily caps renew at midnight Pacific time.
 * Compute that exact instant (even across DST) and describe it in local time.
 */
export function describeGeminiQuotaReset(now = Date.now()): string {
  const resetMs = nextPacificMidnight(now)
  const localAt = new Date(resetMs).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  })
  const pacificDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(resetMs)
  const h = Math.floor((resetMs - now) / 3_600_000)
  return `Google free-tier daily quota resets at midnight Pacific — in ${h}h, ${localAt} (local time), date ${pacificDate} PT`
}

/** Epoch ms of the NEXT midnight in America/Los_Angeles after `now` (DST-safe). */
function nextPacificMidnight(now: number): number {
  const tz = 'America/Los_Angeles'
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const hourOpt: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', hour12: false }
  const dateStr = dayFmt.format(now)

  // Try 00:00 PST (-08:00) and 00:00 PDT (-07:00) for this and the next date;
  // keep the candidate that really formats back to 00h Pacific and is > now.
  for (const offsetSign of ['-08:00', '-07:00']) {
    for (const addDays of [0, 1]) {
      const date = addDays > 0 ? shiftDate(dateStr) : dateStr
      const ms = Date.parse(`${date}T00:00:00${offsetSign}`)
      if (!Number.isFinite(ms) || ms <= now) continue
      const hour = new Intl.DateTimeFormat('en-US', hourOpt).formatToParts(new Date(ms))
        .find(p => p.type === 'hour')?.value
      const backDate = dayFmt.format(ms)
      if (hour === '00' && backDate === date) return ms
    }
  }
  // Fallback: 08:00 UTC (Pacific winter offset), rounded to the next day.
  return now + (8 * 3_600_000 - (now % (24 * 3_600_000)) + 24 * 3_600_000) % (24 * 3_600_000) || now + 24 * 3_600_000
}

function shiftDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** "4793" → "4.8K"; "40" → "40" — used by the per-turn usage line. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1024) return String(n)
  const k = n / 1024
  return `${k >= 20 ? Math.round(k) : Math.round(k * 10) / 10}K`
}
