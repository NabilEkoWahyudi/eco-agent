/**
 * Shared fetch retry helper for all LLM providers.
 * Extracted to eliminate code duplication across groq.ts, openrouter.ts, ollama.ts.
 */

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  /** Provider name shown in retry warning messages */
  providerName?: string
}

/**
 * Fetch with exponential backoff retry on 429 and 5xx errors.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOpts: RetryOptions = {}
): Promise<Response> {
  const { maxRetries = 5, initialDelayMs = 2000, providerName = 'API' } = retryOpts

  let retries = 0
  let delayMs = initialDelayMs

  while (true) {
    const res = await fetch(url, options)

    if ((res.status === 429 || res.status >= 500) && retries < maxRetries) {
      retries++

      let errMsg = res.statusText
      try {
        const clone = res.clone()
        const errData = await clone.json() as { error?: { message?: string } }
        errMsg = errData?.error?.message || res.statusText
      } catch {
        try {
          const text = await res.clone().text()
          errMsg = text || res.statusText
        } catch {
          // keep statusText
        }
      }

      const retryAfter = res.headers.get('Retry-After')
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delayMs

      console.log(
        `\n  ⚠ ${providerName}: ${errMsg} (HTTP ${res.status}). ` +
        `Retrying in ${waitTime / 1000}s... (${retries}/${maxRetries})`
      )
      await new Promise(r => setTimeout(r, waitTime))

      delayMs *= 2 // exponential backoff
      continue
    }

    return res
  }
}
