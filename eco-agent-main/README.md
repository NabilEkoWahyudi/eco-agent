# 🌿 Eco Agent

> Lightweight, extensible agentic CLI — powered by local & cloud LLMs.

[![npm version](https://img.shields.io/npm/v/eco-agent.svg)](https://www.npmjs.com/package/eco-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Ponytail](https://img.shields.io/badge/ponytail-fidelity%20100%25-brightgreen)](benchmarks/README.md)

```
███████╗ ██████╗ ██████╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔════╝██╔════╝██╔═══██╗    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
█████╗  ██║     ██║   ██║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██╔══╝  ██║     ██║   ██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
███████╗╚██████╗╚██████╔╝    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚══════╝ ╚═════╝ ╚═════╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
```

## Install

```bash
npm install -g eco-agent
```

Then just type:

```bash
eco
```

## Features

- **Multi-provider** — OpenRouter, Groq (free, fast), Ollama (local)
- **Tool calling** — read/write/rename/delete files & folders, run shell commands, search code
- **Web Search** — Built-in DuckDuckGo web search capability
- **Agentic loop** — Plan → Execute → Observe → Repeat automatically
- **Interactive Diffs** — Agent asks for confirmation `[Y/n]` before modifying or deleting any files
- **Auto-Automation** — `/commit`, `/pr`, and `/debug` commands to auto-fix code and auto-generate git messages
- **Multi-line Smart Paste** — Just paste large context directly, auto-detects multi-line inputs
- **Token Tracker** — Live token usage tracking for your API keys
- **Ponytail Anti-Overengineering** — Minimalist coding ruleset at ~100% fidelity to the original ([`/ponytail`](#5-ponytail-anti-overengineering))
- **Ponytail Benchmark** — Built-in benchmark runner to measure real LOC/token/cost/time gains ([`benchmarks/`](benchmarks/README.md))
- **Project context** — `eco init` makes the agent aware of your codebase
- **Session memory** — auto-saves conversations, resume anytime
- **Plugin system** — extend with npm packages
- **MCP support** — connect to GitHub, Notion, Slack via Model Context Protocol
- **TUI** — syntax highlighted code, spinner, status bar with live CWD

## Quick Start

```bash
# Install globally
npm install -g eco-agent

# Launch — setup wizard appears on first run
eco

# Choose: Mock (no API key) or Groq (free at console.groq.com)
```

## Commands

```bash
eco                    # open interactive REPL
eco "fix the bug"      # one-shot mode
eco --resume           # resume last session
eco --resume <id>      # resume specific session
eco --reset            # reset configuration

# Project context
eco init               # scan project, make agent aware of codebase
eco init --refresh     # re-scan after changes
eco init --show        # view current context

# Sessions
eco session list
eco session delete <id>
eco session rename <id> "title"

# Plugins
eco plugin install <package>
eco plugin list
eco plugin remove <package>

# MCP servers
eco mcp add --name github --stdio --command npx \
  --args "-y,@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx"
eco mcp list
eco mcp test <name>
eco mcp remove <name>
```

## Inside the REPL

| Command              | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `/help`              | Show all commands                                                  |
| `/config`            | Switch provider or API key                                         |
| `/cd <path>`         | Change the current working directory                               |
| `/file <path>`       | Load a file directly as context                                    |
| `/commit`            | Auto-generate commit message from staged changes                   |
| `/pr`                | Auto-generate Pull Request description                             |
| `/debug <cmd>`       | Run a command and let the agent auto-fix any errors in a loop      |
| `/plan`              | Switch to plan mode (agent asks permission before executing)       |
| `/act`               | Switch to act mode (agent executes directly)                       |
| `/ponytail`          | Show / set minimalist coding ruleset mode                          |
| `/ponytail-review`   | Review current git diff for over-engineering (LLM)                |
| `/ponytail-audit`    | Audit entire codebase for over-engineering (LLM)                   |
| `/ponytail-debt`     | Scan repo for `// ponytail:` and `# ponytail:` debt markers (local)|
| `/ponytail-gain`     | Show benchmark scoreboard from `.eco/ponytail-gain.json` (local)   |
| `stop ponytail`      | Instantly deactivate Ponytail via natural language                 |
| `/save [title]`      | Save current session                                               |
| `/sessions`          | Browse and resume saved sessions                                   |
| `/clear`             | Clear conversation context                                         |
| `/history`           | Show message history                                               |
| `/tools`             | List available tools                                               |
| `/exit`              | Exit Eco Agent                                                     |

### Tab Autocomplete

The REPL has built-in TAB completion — no setup needed:

| Keystroke                 | Result                                              |
| ------------------------- | --------------------------------------------------- |
| `/he<TAB>`                | Completes to `/help`, double-TAB lists all commands |
| `/ponytail <TAB>`         | Cycles through `off`, `lite`, `full`, `ultra`       |
| `/snapshot <TAB>`         | Cycles through `list`, `diff`, `restore`            |
| `/cd <TAB>` / `/file <TAB>` | Lists real files & folders in the current directory (folders with a trailing `/`) |

For shell-level (non-interactive) completion of the `eco` CLI itself, generate a
script for your shell:

```bash
# bash / zsh
eco completion bash >> ~/.bashrc && source ~/.bashrc

# fish
eco completion fish > ~/.config/fish/completions/eco.fish

# PowerShell
eco completion powershell >> $PROFILE
```

### Feature Examples

**1. Smart Paste (Long Context)**
Just paste your long text directly into the prompt. Eco Agent auto-detects multi-line inputs:

```bash
eco › [Ctrl+V paste your 100-line code here]
      It will automatically wait for you to finish pasting!
```

**2. Auto-Debugger**
Got an error building your project? Let Eco Agent fix it automatically:

```bash
eco › /debug npm run build
  ⟳ Starting auto-debugger for: npm run build
  # Agent will run it, read the TS errors, open the files, fix them, and retry until it succeeds!
```

**3. Interactive File Diff & Approval**
Before Eco Agent writes, patches, creates, renames, or deletes a file — or runs a
shell command — it shows the context and asks for permission, keeping your codebase safe:

```bash
  ~ File will be overwritten. Preview of new contents:
  ~ + function hello() { ...
  Proceed? [Y]es once · [n]o · [a]lways allow write_file · [v]never allow
```

Choices:

| Answer | Effect                                                        |
| ------ | ------------------------------------------------------------- |
| `Y` / Enter | Allow **once** (cached per session)                       |
| `n`         | Deny this tool call — the agent is told it was cancelled  |
| `a`         | **Always allow** this action — saved to `~/.eco-agent/permissions.json` |
| `v`         | **Never allow** — saved as a persistent deny rule         |

Read-only tools (`read_file`, `list_directory`, `search_files`, …) never prompt.
Non-interactive runs (`eco "prompt"`) honor persistent deny rules and auto-allow
the rest.

**4. Auto Git — `/commit` & `/pr`**

```bash
eco › /commit   # inspects staged diffs → Conventional-Commits message → 'y' copies it to clipboard
eco › /pr       # reads recent commits vs origin/main → Markdown PR title + summary + bullets
```

Both run **without tool definitions** sent to the LLM — saving ~800–1,200 tokens per call. `/pr` falls back to the last 5 commits when no `origin/main` exists.

**5. Ponytail (Anti-Overengineering)**

Keep your codebase lean. The Ponytail ruleset instructs the agent to aggressively
favor stdlib, existing code, and one-liners over writing new complex code.

#### Modes

| Mode    | Behaviour                                                          | Token cost |
| ------- | ------------------------------------------------------------------ | ---------- |
| `off`   | Ruleset disabled                                                   | +0         |
| `lite`  | Quick 3-step check; mentions simpler option, then proceeds as asked | ~35/req   |
| `full`  | Full 7-step ladder + root-cause + no-abstraction rules             | ~110/req   |
| `ultra` | Full ladder + active dead-code hunt + debt tagging                 | ~140/req   |

> **`lite` is advisory**, not enforcement — the agent notes a simpler alternative
> in one line, then does what you actually asked.

#### Commands

```bash
eco › /ponytail            # Show current mode & token cost
eco › /ponytail full       # Activate 7-step minimalist ladder
eco › /ponytail-review     # Review git diff for over-engineering (LLM)
eco › /ponytail-audit      # Audit full codebase for over-engineering (LLM)
eco › /ponytail-debt       # Scan for // ponytail: and # ponytail: debt markers
eco › /ponytail-gain       # Show benchmark scoreboard (local, no LLM)
eco › stop ponytail        # Instantly disable via natural language
```

#### Debt markers

Tag intentional shortcuts in **any language** and they will be detected by `/ponytail-debt`:

```ts
// ponytail: manual date format, upgrade if timezone support needed
```
```python
# ponytail: regex-only parser, upgrade if nested structures appear
```

Markers without an upgrade trigger are flagged `[no-trigger]` as a reminder.

## Project Context (`eco init`)

Run `eco init` inside any project to give the agent full awareness:

```bash
cd my-project
eco init
eco   # agent now knows your project structure, deps, scripts, git status
```

Customize per-project behavior by editing `.eco/prompt.md`.

## Plugin System

```bash
# Install web search plugin (no API key needed)
eco plugin install eco-plugin-websearch

# Now the agent can search the web!
eco
> search for the latest Node.js release notes

eco plugin list        # what is installed
eco plugin remove <name>
```

> ⚠ Plugins execute **their code inside the agent process**. Eco Agent shows a
> safety warning and asks for confirmation before installing anything — review
> unknown packages before agreeing. Installing from a local path also works:
> `eco plugin install ./my-plugin` (Windows `C:\…`, UNC and `~/…` paths included).

## MCP Support

Connect to hundreds of existing MCP servers:

```bash
# GitHub
eco mcp add --name github --stdio \
  --command npx --args "-y,@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx"

# Filesystem
eco mcp add --name fs --stdio \
  --command npx --args "-y,@modelcontextprotocol/server-filesystem,/path/to/dir"

# Any SSE server
eco mcp add --name remote --sse --url https://my-mcp.com/mcp

# Remote server with authentication headers (sent with every request)
eco mcp add --name remote_auth --streamable --url https://my-mcp.com/mcp \
  --header "Authorization=Bearer ghp_xxx" --header "X-Org=my-org"
```

## Writing a Plugin

```js
// my-eco-plugin/index.js
module.exports = {
  name: "my-plugin",
  version: "1.0.0",
  description: "My custom tool",
  tools: [
    {
      name: "my_tool",
      description: "Does something useful",
      parameters: {
        input: { type: "string", description: "Input value", required: true },
      },
      async execute(args) {
        return `Result: ${args.input}`;
      },
    },
  ],
};
```

Then install it:

```bash
eco plugin install ./my-eco-plugin
# or publish to npm and:
eco plugin install my-eco-plugin
```

## Providers

### OpenRouter (Recommended)

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create API key
3. Run `eco` and select OpenRouter
4. It supports thousands of models, including completely free models (`:free`)!

### Groq (Ultra Fast)

1. Sign up at [console.groq.com](https://console.groq.com)
2. Create API key
3. Run `eco` and select Groq when prompted

### Ollama (Local & Private)

1. Install Ollama: https://ollama.com
2. Pull a model: `ollama pull llama3.2`
3. Run `eco`, select Ollama, and type `llama3.2` as the model. No API key needed.

## Performance Guide

Eco Agent streams responses token-by-token, so you see the first words while the
model is still generating. Every REPL turn ends with a timing line:

```
  ↳ done in 6.4s, first token 1.2s
```

| Symptom                                  | Cause & fix                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `first token` takes many seconds         | Provider queue / free-tier capacity. Switch provider (`/config`) — Groq paid, OpenRouter paid or Ollama local are fastest. |
| `HTTP 503 … high demand`                 | The provider's queue is full. Eco Agent retries automatically (up to 3×, honouring the provider's `retryDelay`) and tells you it is a server-side queue. |
| Response feels slow **after** the first words | Large context. Run `/clear` to reset the conversation, or `/save` and start a new session. |
| Tool output floods the screen            | Tool output is capped at 8 KB (head + tail kept); the full text is never sent to the model. |
| Long pauses between tool calls           | Each tool call is a fresh model round-trip. Fewer, bigger steps are faster. |
| `! connection interrupted` in the log     | Network hiccup — the request is retried up to 3× with backoff. A VPN/proxy/firewall usually causes it. |

### Gemini thinking budget

Gemini 3.x spends "thought tokens" **before** the first visible token. On a busy
free tier that alone can take 30–90 seconds for a one-line answer. Control it
with an environment variable:

```bash
# Windows (PowerShell / cmd)
set ECO_THINKING_BUDGET=0     # disable thinking → fastest answers
set ECO_THINKING_BUDGET=-1    # dynamic thinking (provider default)

# macOS / Linux
export ECO_THINKING_BUDGET=0
```

Not set → provider default. A fixed budget (e.g. `512`) is a good middle ground
for complex tasks.

### Tips

- `/clear` between unrelated tasks — it keeps the prompt small and the answers fast.
- Prefer a fast model for exploration (Groq/Llama), a strong model for the final edit.
- Local models (Ollama) remove network latency entirely.
- Watch the timing line: a large gap between "first token" and "done" means the
  model is generating slowly; a large "first token" means the provider is slow
  to start.

## Ponytail Benchmark

Eco Agent ships a benchmark infrastructure to measure the real-world impact of the
Ponytail ruleset on your agent's output (LOC, tokens, cost, time).

```bash
# 1. Run each task WITHOUT Ponytail (baseline)
npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode off
npm run benchmark:run -- --task benchmarks/tasks/task-02-http-fetch.md --mode off
npm run benchmark:run -- --task benchmarks/tasks/task-03-file-walk.md  --mode off
npm run benchmark:run -- --task benchmarks/tasks/task-04-str-util.md   --mode off

# 2. Run the same tasks WITH Ponytail
npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode full
npm run benchmark:run -- --task benchmarks/tasks/task-02-http-fetch.md --mode full
npm run benchmark:run -- --task benchmarks/tasks/task-03-file-walk.md  --mode full
npm run benchmark:run -- --task benchmarks/tasks/task-04-str-util.md   --mode full

# 3. Compare & write scoreboard to .eco/ponytail-gain.json
npm run benchmark:compare -- --auto

# 4. View scoreboard inside eco
eco
/ponytail-gain
```

See [`benchmarks/README.md`](benchmarks/README.md) for the full methodology,
validity criteria (n ≥ 4), and how to add custom tasks.

## Project Structure

```
src/
├── cli/          Entry point, REPL, TUI rendering
├── loop/         Agentic loop (plan → execute → observe)
├── providers/    LLM adapters (Groq, Ollama, Mock)
├── tools/        Built-in tools (file, shell, search)
├── plugins/      Plugin manager
├── mcp/          MCP client & registry
├── session/      Session save/load
├── project/      Project scanner (eco init)
├── context/      Conversation memory
└── rulesets/     Coding rulesets (Ponytail)

benchmarks/
├── runner.ts     CLI: run a task, record LOC/token/cost/time
├── compare.ts    CLI: diff two runs, write .eco/ponytail-gain.json
├── types.ts      Type definitions for all benchmark data
├── tasks/        4 sample benchmark tasks (real-world coding scenarios)
└── results/      Per-run JSON results (git-tracked)
```

## License

MIT © Eco Agent Contributors
