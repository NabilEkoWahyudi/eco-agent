/**
 * Adaptive quota governor.
 *
 * Providers on a free tier (Google AI Studio, Groq free, OpenRouter free)
 * enforce limits per PROJECT:
 *   - RPM  requests per minute
 *   - TPM  input tokens per minute
 *   - RPD  requests per day
 * Exceeding any of them answers with HTTP 429.
 *
 * A client that fires requests as fast as it can therefore burns quota and
 * then gets throttled — which shows up as slow answers and a low success
 * rate on the provider dashboard (every retry counts as a failed request).
 *
 * This governor keeps the client *below* the quota:
 *   - it starts at a conservative request rate
 *   - it slows down automatically when the provider answers 429
 *   - it recovers slowly once the provider is calm again
 */

export interface GovernorOptions {
  /** Initial requests per minute. */
  rpm?: number
  /** Lowest requests per minute we will drop to. */
  minRpm?: number
  /** Highest requests per minute we will climb back to. */
  maxRpm?: number
  /** Window used for the sliding rate window. */
  windowMs?: number
}

export class QuotaGovernor {
  private requests: number[] = []
  private windowMs: number
  private minRpm: number
  private maxRpm: number
  private currentRpm: number
  /** Consecutive 429s — used to decide whether to keep retrying. */
  private consecutive429 = 0

  constructor(opts: GovernorOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000
    this.minRpm = opts.minRpm ?? 2
    this.maxRpm = opts.maxRpm ?? opts.rpm ?? 10
    this.currentRpm = opts.rpm ?? this.maxRpm
  }

  /** Requests per minute we currently allow. */
  get rpm(): number {
    return this.currentRpm
  }

  /** How many 429s we saw in a row. */
  get throttled(): number {
    return this.consecutive429
  }

  /**
   * Register a request.
   * Returns the wait time in ms when the caller has to slow down.
   */
  reserve(): { allowed: boolean; waitMs: number } {
    const now = Date.now()
    this.requests = this.requests.filter(t => now - t < this.windowMs)

    // Allow a burst proportional to the current rate
    if (this.requests.length >= this.currentRpm) {
      const oldest = this.requests[0] ?? now
      return { allowed: false, waitMs: Math.max(1000, this.windowMs - (now - oldest)) }
    }

    this.requests.push(now)
    return { allowed: true, waitMs: 0 }
  }

  /** The provider answered 429 — halve the rate and remember it. */
  onRateLimited(): void {
    this.consecutive429++
    this.currentRpm = Math.max(this.minRpm, Math.floor(this.currentRpm / 2))
    this.requests = []
  }

  /** The provider answered fine — slowly climb back to the maximum. */
  onSuccess(): void {
    this.consecutive429 = 0
    if (this.currentRpm < this.maxRpm) {
      this.currentRpm = Math.min(this.maxRpm, this.currentRpm + 1)
    }
  }
}

/**
 * Read the request rate from the environment.
 * ECO_RPM overrides the default (useful for paid tiers with a higher quota).
 */
export function rpmFromEnv(defaultRpm: number): number {
  const raw = process.env.ECO_RPM
  if (!raw) return defaultRpm
  const value = parseInt(raw, 10)
  if (Number.isFinite(value) && value > 0) return value
  return defaultRpm
}
