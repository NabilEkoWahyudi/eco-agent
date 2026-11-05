# Contributing to Eco Agent

**The license is the philosophy.** Eco Agent is [GPL-3.0](LICENSE) — you may
use it, study it, modify it, fork it, and ship your own version. Contributions
come from anywhere and anyone; the one requirement is that what you contribute
(and anything built on it) stays free software under the same GPL.

## Project layout

| Path | What it is |
| ---- | ---------- |
| `eco-agent-main/` | The project itself: TypeScript sources in `src/`, built into `dist/`, docs in `eco-agent-main/README.md` |
| `eco-plugin-websearch/` | Example plugin that shows the plugin API (tools can be added without touching the core) |
| `README.md` (root) | Quick start for users |

## Getting started

Node **>= 18**. No API key is needed for local Ollama; free tiers of
OpenRouter/AI Studio work fine for development.

```bash
git clone https://github.com/NabilEkoWahyudi/eco-agent.git
cd eco-agent/eco-agent-main
npm ci
npm run build
npm link                       # installs the global `eco` command
eco                            # then run /config to pick a provider & model
```

Run without linking: `node dist/cli/index.js`.

## Ground rules (the part we keep)

These are design fundamentals — open an issue first if you want to change them.

1. **Eco Agent never switches models automatically.** The model chosen in
   `/config` is the only one the agent may call. Different APIs and different
   LLMs are different models — no silent substitution behind the user's back.
2. **Retries target the SAME model only** (bounded: streaming retry →
   non-streaming attempt). A timeout or HTTP 503 is reported, not worked
   around by another model.
3. **Never execute a truncated tool call.** A `write_file` that arrives with
   only half its arguments is an upstream error to retry — not data to act on.
4. **No secrets in the repo.** API keys come from env vars or the user's local
   config store (`~/.eco-agent`). Never hardcode, never commit fixtures with
   real keys.

## Code style

- TypeScript, strict mode, ESM. Runs on Node 18+ via `tsc` → `dist/`.
- Import paths use explicit `.js` extensions (required by ESM).
- Comments and error messages in English, concise, and honest about *why*.
- Shared dialect code (e.g. the OpenAI-compatible streaming parser) lives in
  one place (`src/providers/streamShared.ts`) and is reused by all providers.
- Error messages should say what happened **and** what the user can do next.

## Commit messages

Subject line, Conventional-Commits style — matching the history you see:

```
fix: never switch models and retry truncated tool calls safely
feat: show per-turn token usage, /usage totals, and exact quota reset times
perf(gemini): avoid long waits on Flash models
```

## Testing

The maintainers keep a private regression suite that is intentionally **not**
published in this repository — a fresh clone contains no test files.
For that reason:

- Your PR **should describe how you verified the change** (the command, the
  provider/model used, and the before/after behavior).
- You are encouraged to write your own local regression test
  (`eco-agent-main/tests/*.test.mjs`) before opening the PR — the runner is
  shipped, so `npm test` picks up any file you add locally.
- Security-sensitive areas (SSRF guard in `web_fetch`, permission gate,
  path traversal in file tools) deserve a test even if it never leaves your
  machine.

## Pull requests

1. Discuss big changes in an issue first (a short "here's the problem + my
   approach" beats a 600-line surprise).
2. One topic per PR. Keep diffs reviewable.
3. `npm run build` must pass; write out the exact steps you ran.
4. Describe the *user-visible* effect of the change.

## Bug reports

Please include:

- OS, Node version, and how the CLI was installed (`npm install -g`, `npm link`)
- The provider and model used (`/config` shows it)
- The terminal output (redact your API key!)
- What you expected vs what happened

## Security issues

Report privately via GitHub *Security advisories* (New security policy →
Private vulnerability reporting), not in public issues. Supply-chain and
 SSRF reports (`web_fetch`, MCP servers, plugins) are extra appreciated.

## Licensing note

By contributing you agree that your work is submitted under the project's
GPL-3.0 license. No CLA, no copyright transfer — you keep the copyright on
your files, like everyone else here.
