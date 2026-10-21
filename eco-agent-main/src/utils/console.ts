/**
 * Console notice helper.
 *
 * The spinner draws on the current line with `\r`, so a plain `console.log`
 * from anywhere else (e.g. the retry warning inside fetchHelper) gets erased
 * by the next spinner frame. The spinner registers itself here, so notices can
 * clear the spinner line, print, and let the spinner redraw on top.
 */

type NoticeHook = (() => void) | null

let noticeHook: NoticeHook = null

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
