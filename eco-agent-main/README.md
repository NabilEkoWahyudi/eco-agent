# 🌿 Eco Agent

> Lightweight, extensible agentic CLI — powered by local & cloud LLMs.

[![npm version](https://img.shields.io/npm/v/eco-agent.svg)](https://www.npmjs.com/package/eco-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

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

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/config` | Switch provider or API key |
| `/cd <path>` | Change the current working directory |
| `/file <path>`| Load a file directly as context |
| `/commit` | Auto-generate commit message from staged changes |
| `/pr` | Auto-generate Pull Request description |
| `/debug <cmd>`| Run a command and let the agent auto-fix any errors in a loop |
| `/plan` | Switch to plan mode (agent asks permission before executing) |
| `/act` | Switch to act mode (agent executes directly) |
| `/save [title]` | Save current session |
| `/sessions` | Browse and resume saved sessions |
| `/clear` | Clear conversation context |
| `/history` | Show message history |
| `/tools` | List available tools |
| `/exit` | Exit Eco Agent |

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
Before Eco Agent writes, renames, or deletes a file, it will show you a visual diff and ask for permission, keeping your codebase safe:
```bash
  ~ File will be overwritten. Preview of new contents:
  ~ + function hello() { ...
  Apply these changes? [Y/n]
```

**4. Auto Git**
Stage your files with `git add .`, then:
```bash
eco › /commit
eco › /pr
```

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
```

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
```

## Writing a Plugin

```js
// my-eco-plugin/index.js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'My custom tool',
  tools: [{
    name: 'my_tool',
    description: 'Does something useful',
    parameters: {
      input: { type: 'string', description: 'Input value', required: true }
    },
    async execute(args) {
      return `Result: ${args.input}`
    }
  }]
}
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
└── context/      Conversation memory
```

## License

MIT © Eco Agent Contributors
