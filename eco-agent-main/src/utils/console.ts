/**
 * Console output helpers.
 *
 * Two problems are solved here:
 *
 * 1. The spinner paints on the current line with `\r` + ESC[2K (erase line).
 *    When the model streams text, that text has NO trailing newline — so the
 *    spinner's erase wiped the model's answer (it "disappeared"). We now track
 *    whether the cursor sits at the start of a line and make sure the spinner
 *    (and tool boxes) always start on a fresh line.
 *
 * 2. Notices printed from other modules (retry warnings) were erased by the
 *    spinner. The spinner registers a hook so notices can clear the spinner
 *    line first.
 */

type NoticeHook = (() => void) | null

let noticeHook: NoticeHook = null
let atLineStart = true

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Does the written text end at the beginning of a line? */
function endsAtLineStart(text: string): boolean {
  const idx = text.lastIndexOf('\n')
  if (idx === -1) return false
  const tail = text.slice(idx + 1).replace(ANSI_RE, '')
  return tail.length === 0
}

/**
 * Track the cursor position by wrapping stdout.write once. console.log() and
 * every direct write go through it, so the tracker stays accurate.
 */
function installStdoutTracker(): void {
  const original = process.stdout.write.bind(process.stdout)
  const patched = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    if (typeof chunk === 'string') {
      atLineStart = endsAtLineStart(chunk)
    } else {
      atLineStart = false
    }
    return original(chunk as never, encoding as never, callback as never)
  }) as typeof process.stdout.write
  process.stdout.write = patched
}

installStdoutTracker()

/** Called by the spinner (or any owner of the current line). */
export function setNoticeHook(fn: NoticeHook): void {
  noticeHook = fn
}

/** Print a notice without corrupting an active spinner line. */
export function printNotice(message: string): void {
  if (noticeHook) {
    noticeHook()
    console.log(message)
  } else {
    console.log(message)
  }
}

/** True when the cursor is at the start of a line (nothing printed on it). */
export function isAtLineStart(): boolean {
  return atLineStart
}

/**
 * Make sure the next output starts on its own line.
 * Prevents the spinner or a tool box from overwriting text that was streamed
 * without a trailing newline.
 */
export function ensureLineStart(): void {
  if (!atLineStart) {
    process.stdout.write('\n')
    atLineStart = true
  }
}

/** Mark the current line as cleared (used after erasing a spinner line). */
export function markLineCleared(): void {
  atLineStart = true
}
