/**
 * Shared SSE (Server-Sent Events) line reader.
 *
 * BUG FIX: every provider previously did
 *   `decoder.decode(value).split('\n')`
 * inside the read loop, which breaks in two ways:
 *   1. An SSE line can span two network chunks — splitting per chunk drops
 *      partial JSON lines and silently loses streamed tokens.
 *   2. `decoder.decode(value)` without `{ stream: true }` corrupts multi-byte
 *      UTF-8 characters split across chunks (they become U+FFFD).
 *
 * This helper keeps a buffer across chunks and emits only complete lines.
 */
export async function* sseLines(res: Response): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    // Keep the last (possibly incomplete) line in the buffer
    buf = lines.pop() ?? ''
    for (const line of lines) {
      // Normalize CRLF from some servers
      yield line.endsWith('\r') ? line.slice(0, -1) : line
    }
  }

  // Flush any remaining buffered line
  buf += decoder.decode()
  if (buf) yield buf
}

/**
 * Parse a single `data: <payload>` SSE line, skipping comments/heartbeats.
 * Returns null for non-data lines.
 */
export function parseSseData(line: string): string | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  return payload.length > 0 ? payload : null
}
