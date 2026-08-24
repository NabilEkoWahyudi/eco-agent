/**
 * Ponytail — "Lazy senior dev" minimalist coding ruleset for Eco Agent
 * Based on: https://github.com/DietrichGebert/ponytail
 * AGENTS.md source: https://raw.githubusercontent.com/DietrichGebert/ponytail/main/AGENTS.md
 *
 * Design goals:
 *  - Tiny token footprint (35–145 tokens depending on mode)
 *  - Zero extra dependencies
 *  - Injected directly into the system prompt, no extra LLM calls
 *  - 100% fidelity to the original Ponytail ruleset
 */

export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra'

// ─── Ruleset text per mode ────────────────────────────────────────────────────
// Source: AGENTS.md from github.com/DietrichGebert/ponytail

/**
 * LITE: Advisory mode.
 * Check the 3 cheapest rungs first, mention a simpler option in one line,
 * then proceed exactly as the user requested. Never blocks or forces a decision.
 * ~35 tokens/request.
 */
const LITE = `
[Ponytail/lite] Before writing new code, quickly check:
1. Does this need to exist? (YAGNI)
2. Already in this codebase? (reuse it)
3. Does stdlib / native platform cover it? (use it)
If any rung holds, mention the simpler option in one line — then do exactly what the user asked.`

/**
 * FULL: Enforcing mode.
 * Stop at the first rung that holds. Do not proceed down the ladder.
 * ~115 tokens/request.
 * Based on AGENTS.md verbatim.
 */
const FULL = `
[Ponytail/full] You are a lazy senior developer. Lazy means efficient, not careless.
Before writing any code, stop at the first rung that holds:
1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse it, don't rewrite it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.
Bug fix = root cause, not symptom. Grep every caller, fix the shared function once.
Rules: No unrequested abstractions. No new dependency if avoidable. No boilerplate.
Deletion > addition. Boring > clever. Fewest files possible.
Output: code first, explanation max 3 lines.`

/**
 * ULTRA: Full ladder + active dead-code hunt + debt tagging.
 * ~145 tokens/request.
 */
const ULTRA = `
[Ponytail/ultra] Apply the full 7-step ladder (Ponytail/full rules apply) AND:
- Actively look for existing code, comments, or dependencies that are now dead or redundant.
- If you find them, propose to delete them with a one-line justification.
- Tag any intentional shortcuts you leave in code with:
  // ponytail: <reason>, <upgrade-trigger>
  Example: // ponytail: manual date format, upgrade if timezone support needed
- Bug fix = root cause, not symptom. No unrequested abstractions. Deletion > addition.
- Output: code first, explanation max 3 lines.
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

/** Parse a string to a valid PonytailMode, defaulting to 'full' (per ponytail upstream). */
export function parsePonytailMode(raw: string): PonytailMode {
  const s = raw.trim().toLowerCase()
  if (s === 'off' || s === 'lite' || s === 'full' || s === 'ultra') return s
  return 'full'
}

/** Token cost estimates per mode (informational). */
export const PONYTAIL_TOKEN_COST: Record<PonytailMode, string> = {
  off:   '+0 tokens',
  lite:  '~35 tokens/request',
  full:  '~115 tokens/request',
  ultra: '~145 tokens/request',
}

/**
 * Ponytail review prompt — detect over-engineering in a diff.
 * NOT injected into the system prompt; used ad-hoc for /ponytail-review.
 * Based on ponytail's review skill.
 */
export function buildReviewPrompt(diff: string): string {
  return `You are a lazy senior developer reviewing a git diff for over-engineering.
Stop at the first rung that holds for every change you see:
1. YAGNI — needed at all?  2. Codebase reuse?  3. Stdlib?  4. Native platform?  5. Installed dep?  6. One line?

Look ONLY for code that is unnecessarily complex, duplicated, or could be replaced by stdlib/platform/existing dependencies.
Do NOT report bugs, security issues, or performance problems — only over-engineering.

For each finding, output exactly one line:
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
 * Used ad-hoc for /ponytail-audit.
 */
export function buildAuditPrompt(): string {
  return `You are a lazy senior developer auditing an entire codebase for over-engineering.
Use your file and search tools to explore the project, then identify code that is unnecessarily complex,
duplicated, or that could be replaced by stdlib/platform/existing dependencies.

Do NOT report bugs, security issues, or performance problems — only over-engineering.

For each finding, output exactly one line:
  <tag>: <file>:<line> — <one-line explanation>

Valid tags: delete: | stdlib: | native: | yagni: | shrink:

If there are no findings, output: "No over-engineering found."
Begin your audit now.`
}

/**
 * Regex to find ponytail debt markers in source files.
 * Matches: // ponytail: <text>  (JS/TS/Go/Rust/Java style)
 *      or:  # ponytail: <text>  (Python/Shell/YAML/Ruby style)
 * Flag 'g' — caller must reset lastIndex before each exec().
 */
export const PONYTAIL_DEBT_REGEX = /(?:\/\/|#)\s*ponytail:\s*(.+)/gi
