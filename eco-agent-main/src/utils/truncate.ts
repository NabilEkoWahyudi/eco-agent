/**
 * Tool-output limiting.
 *
 * Tool results are inserted verbatim into the conversation context and are
 * re-sent with EVERY subsequent request. A single `npm install` or `npm test`
 * can produce 100+ KB of output — that inflates the prompt, slows down every
 * following round-trip (prefill) and floods the terminal.
 *
 * This module caps tool output to a sane size, keeping the beginning (usually
 * the most relevant part) and the end (usually the error/summary).
 */

export const MAX_TOOL_OUTPUT = 8000
const HEAD_RATIO = 0.6

export interface TruncateResult {
  text: string
  truncated: boolean
  originalLength: number
  removedLines: number
}

/**
 * Truncate a tool result to `max` characters.
 * Keeps the head and the tail, and inserts a marker in between.
 */
export function truncateToolOutput(output: string, max: number = MAX_TOOL_OUTPUT): TruncateResult {
  if (output.length <= max) {
    return { text: output, truncated: false, originalLength: output.length, removedLines: 0 }
  }

  const lines = output.split('\n')
  const headBudget = Math.floor(max * HEAD_RATIO)
  const tailBudget = max - headBudget

  // Take lines from the head until the budget is used
  const headLines: string[] = []
  let headLen = 0
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (headLen + l.length + 1 > headBudget) break
    headLines.push(l)
    headLen += l.length + 1
  }

  // Take lines from the tail until the budget is used
  const tailLines: string[] = []
  let tailLen = 0
  let j = lines.length - 1
  for (; j > i; j--) {
    const l = lines[j]
    if (tailLen + l.length + 1 > tailBudget) break
    tailLines.unshift(l)
    tailLen += l.length + 1
  }

  const removed = j - i
  const marker = `\n... [${removed} line(s) / ~${output.length - headLen - tailLen} chars truncated to keep the context small] ...\n`

  return {
    text: headLines.join('\n') + marker + tailLines.join('\n'),
    truncated: true,
    originalLength: output.length,
    removedLines: removed,
  }
}
