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

- **Multi-provider** — Groq (free, fast), Ollama (local), more coming
- **Tool calling** — read/write files, run shell commands, search code
- **Agentic loop** — Plan → Execute → Observe → Repeat automatically
- **Project context** — `eco init` makes the agent aware of your codebase
- **Session memory** — auto-saves conversations, resume anytime
- **Plugin system** — extend with npm packages
- **MCP support** — connect to GitHub, Notion, Slack via Model Context Protocol
- **TUI** — spinner, syntax highlighting, status bar, markdown rendering

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
| `/save [title]` | Save current session |
| `/sessions` | List saved sessions |
| `/clear` | Clear conversation context |
| `/history` | Show message history |
| `/tools` | List available tools |
| `/exit` | Exit Eco Agent |

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

### Groq (Recommended — Free)
1. Sign up at [console.groq.com](https://console.groq.com)
2. Create API key
3. Run `eco` and select Groq when prompted

Available models: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `qwen-qwq-32b`, `gemma2-9b-it`, `mixtral-8x7b-32768`

### Ollama (Local)
```bash
# Install Ollama: https://ollama.com
ollama pull llama3.2
eco   # select Mock for now, Ollama support coming soon
```

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
