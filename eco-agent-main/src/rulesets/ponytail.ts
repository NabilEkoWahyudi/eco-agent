/**
 * Ponytail — Minimalist "lazy senior dev" ruleset for Eco Agent
 * Based on: https://github.com/DietrichGebert/ponytail
 *
 * Design goals:
 *  - Tiny token footprint (35–140 tokens depending on mode)
 *  - Zero extra dependencies
 *  - Injected directly into the system prompt, no extra LLM calls
 */

export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra'

// ─── Ruleset text per mode ────────────────────────────────────────────────────

const LITE = `
[Ponytail/lite] Before writing new code, verify:
1. Is this feature actually needed right now? (YAGNI)
2. Does this already exist in the codebase?
3. Does stdlib / built-in platform cover it?
If yes to any → skip or reuse. Write the minimum code that works.`

const FULL = `
[Ponytail/full] Before writing any new code, run this ladder in order:
1. YAGNI — is this feature truly needed right now?
2. Codebase — does an equivalent already exist? Search before writing.
3. Stdlib — does the language standard library provide this?
4. Platform — does the runtime / OS / framework native API cover it?
5. Existing deps — does a dependency already installed in this project solve it?
6. Popular lib — is there a well-maintained, minimal library that fits?
7. Only then — write the minimum code that solves the problem, nothing more.
Prefer delete > shrink > reuse > adapt > write.`

const ULTRA = `
[Ponytail/ultra] Apply the full 7-step ladder (see full mode) AND:
- Actively look for existing code, comments, or dependencies that are now dead / redundant.
- If you find them, propose to delete them with a brief justification.
- Tag any intentional shortcuts you leave in code with:
  // ponytail: <reason>, <upgrade-trigger>
  Example: // ponytail: manual date format, upgrade if timezone support needed
Prefer delete > shrink > reuse > adapt > write.`

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the ruleset snippet to inject into the system prompt.
 * Returns an empty string for 'off' mode (zero token cost).
 */
export function getPonytailPrompt(mode: PonytailMode): string {
  switch (mode) {
    case 'off':   return ''
    case 'lite':  return LITE
    case 'full':  return FULL
    case 'ultra': return ULTRA
  }
}

/** Parse a string to a valid PonytailMode, defaulting to 'lite'. */
export function parsePonytailMode(raw: string): PonytailMode {
  const s = raw.trim().toLowerCase()
  if (s === 'off' || s === 'lite' || s === 'full' || s === 'ultra') return s
  return 'lite'
}

/** Token cost estimates per mode (informational). */
export const PONYTAIL_TOKEN_COST: Record<PonytailMode, string> = {
  off:   '+0 tokens',
  lite:  '~35 tokens/request',
  full:  '~110 tokens/request',
  ultra: '~140 tokens/request',
}

/**
 * Ponytail review prompt — detect over-engineering in a diff.
 * NOT injected into the system prompt; used ad-hoc for /ponytail-review.
 */
export function buildReviewPrompt(diff: string): string {
  return `You are a minimalist senior developer reviewing a git diff for over-engineering.
Look ONLY for code that is unnecessarily complex, duplicated, or could be replaced by stdlib/platform/existing dependencies.
Do NOT report bugs, security issues, or performance problems — only over-engineering.

For each finding, output exactly one line in this format:
  <tag>: <file>:<line> — <one-line explanation>

Valid tags: delete: | stdlib: | native: | yagni: | shrink:

If there are no findings, output: "No over-engineering found."

Git diff:
\`\`\`
${diff}
\`\`\``
}

/**
 * Ponytail audit prompt — same as review but for the full repo.
 */
export function buildAuditPrompt(): string {
  return `You are a minimalist senior developer auditing an entire codebase for over-engineering.
Use your file and search tools to explore the project, then identify code that is unnecessarily complex,
duplicated, or that could be replaced by stdlib/platform/existing dependencies.

Do NOT report bugs, security issues, or performance problems — only over-engineering.

For each finding, output exactly one line in this format:
  <tag>: <file>:<line> — <one-line explanation>

Valid tags: delete: | stdlib: | native: | yagni: | shrink:

If there are no findings, output: "No over-engineering found."
Begin your audit now.`
}

/**
 * Regex to find ponytail debt markers in source files.
 * Matches: // ponytail: <text>
 */
export const PONYTAIL_DEBT_REGEX = /\/\/\s*ponytail:\s*(.+)/gi
