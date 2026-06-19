# 🌿 Eco Agent

> **Lightweight, extensible agentic CLI — powered by local & cloud LLMs.**  
> Plan → Execute → Observe → Repeat. Right in your terminal.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Provider: Groq](https://img.shields.io/badge/provider-Groq-orange)](https://console.groq.com)
[![Provider: Ollama](https://img.shields.io/badge/provider-Ollama-blue)](https://ollama.com)

```
███████╗ ██████╗ ██████╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔════╝██╔════╝██╔═══██╗    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
█████╗  ██║     ██║   ██║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██╔══╝  ██║     ██║   ██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
███████╗╚██████╗╚██████╔╝    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚══════╝ ╚═════╝ ╚═════╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
                                                              v0.1.0
```

---

## 📦 Repository Structure

```
eco-agent/
├── eco-agent-main/        # 🤖 Core CLI agent
│   ├── src/
│   │   ├── cli/           # Entry point, REPL & TUI rendering
│   │   ├── loop/          # Agentic loop (plan → execute → observe)
│   │   ├── providers/     # LLM adapters (Groq, OpenRouter, Ollama, Mock)
│   │   ├── tools/         # Built-in tools (file, shell, search)
│   │   ├── plugins/       # Plugin manager
│   │   ├── mcp/           # Model Context Protocol client & registry
│   │   ├── session/       # Session save / load / resume
│   │   ├── project/       # Project scanner (eco init)
│   │   ├── context/       # Conversation memory
│   │   ├── swarm/         # Multi-agent swarm orchestrator
│   │   └── utils/         # Types, security, config store, setup wizard
│   ├── package.json
│   └── tsconfig.json
│
└── eco-plugin-websearch/  # 🔍 Web search plugin (DuckDuckGo, no API key)
    ├── index.js
    └── package.json
```

---

## ✨ Features

| Feature                  | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| 🤖 **Agentic Loop**      | Plan → Execute → Observe → Repeat automatically                                            |
| 🧠 **Multi-Provider**    | Groq (free & fast), OpenRouter, Ollama (local), Mock (testing)                             |
| 🛠️ **Tool Calling**      | Read/write/delete files & folders, run shell commands, search code, web search             |
| 🛡️ **Interactive Diffs** | Agent asks for confirmation `[Y/n]` before modifying or deleting any files                 |
| ⚡ **Auto-Automation**   | `/commit`, `/pr`, and `/debug` commands to auto-fix code and generate git messages         |
| 📋 **Smart Paste**       | Just paste large context directly, auto-detects multi-line inputs without special commands |
| 🪙 **Token Tracker**     | Live token usage tracking for your API keys in the status bar                              |
| 🗂️ **Project Context**   | `eco init` makes the agent aware of your codebase                                          |
| 💾 **Session Memory**    | Auto-saves conversations, resume anytime                                                   |
| 🔌 **Plugin System**     | Extend with npm packages                                                                   |
| 🔗 **MCP Support**       | Connect to GitHub, Notion, Slack via Model Context Protocol                                |
| 🐝 **Swarm Mode**        | Run multi-agent tasks in parallel with `/swarm`                                            |
| 🖥️ **Rich TUI**          | Spinner, syntax highlighted code, status bar with live CWD                                 |

---

## 🚀 Quick Start

### 1. Install globally

```bash
cd eco-agent-main
npm install
npm run build
npm install -g .
```

To uninstall:

```bash
npm uninstall -g eco-agent
```

### 2. Launch

```bash
eco
```

On the first run, a **setup wizard** will guide you through choosing a provider and entering your API key.

### 3. Choose a provider

| Provider               | Speed        | Cost                  | Requires                                                  |
| ---------------------- | ------------ | --------------------- | --------------------------------------------------------- |
| **Groq** (recommended) | ⚡ Very fast | Free tier             | API key from [console.groq.com](https://console.groq.com) |
| **OpenRouter**         | Fast         | Free models available | API key from [openrouter.ai](https://openrouter.ai)       |
| **Ollama**             | Local        | Free                  | [ollama.com](https://ollama.com) running locally          |
| **Mock**               | Instant      | Free                  | Nothing — great for testing                               |

---

## 🖥️ CLI Commands

```bash
eco                        # Open interactive REPL
eco "fix the bug in app.js"  # One-shot mode (non-interactive)
eco --resume               # Resume last session
eco --resume <id>          # Resume a specific session by ID
eco --reset                # Reset saved configuration

# Project context
eco init                   # Scan project — gives agent codebase awareness
eco init --refresh         # Re-scan after changes
eco init --show            # View current project context

# Sessions
eco session list
eco session delete <id>
eco session rename <id> "My Title"

# Plugins
eco plugin install <package>
eco plugin install ./local-plugin
eco plugin list
eco plugin remove <package>

# MCP (Model Context Protocol) servers
eco mcp add --name github --stdio \
  --command npx --args "-y,@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx"
eco mcp list
eco mcp test <name>
eco mcp remove <name>
```

---

## 💬 REPL Commands

Inside the interactive session:

| Command         | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `/help`         | Show all available commands                                   |
| `/config`       | Switch provider or update API key                             |
| `/cd <path>`    | Change the current working directory                          |
| `/file <path>`  | Load a file directly as context                               |
| `/commit`       | Auto-generate commit message from staged changes              |
| `/pr`           | Auto-generate Pull Request description                        |
| `/debug <cmd>`  | Run a command and let the agent auto-fix any errors in a loop |
| `/plan`         | Switch to **plan mode** — agent explains before acting        |
| `/act`          | Switch to **act mode** — agent executes directly              |
| `/swarm <goal>` | Launch a **multi-agent swarm** for complex tasks              |
| `/save [title]` | Save current conversation session                             |
| `/sessions`     | Browse and resume saved sessions                              |
| `/clear`        | Clear conversation context                                    |
| `/history`      | View message history                                          |
| `/tools`        | List all available tools                                      |
| `/exit`         | Exit Eco Agent                                                |

---

## 🌟 Feature Examples

### 1. Smart Paste (Long Context)

Just paste your long text directly into the prompt. Eco Agent auto-detects multi-line inputs:

```bash
eco › [Ctrl+V paste your 100-line code here]
      It will automatically wait for you to finish pasting!
```

### 2. Auto-Debugger

Got an error building your project? Let Eco Agent fix it automatically:

```bash
eco › /debug npm run build
  ⟳ Starting auto-debugger for: npm run build
  # Agent will run it, read the TS errors, open the files, fix them, and retry until it succeeds!
```

### 3. Interactive File Diff & Approval

Before Eco Agent writes, renames, or deletes a file, it will show you a visual diff and ask for permission, keeping your codebase safe:

```bash
  ~ File will be overwritten. Preview of new contents:
  ~ + function hello() { ...
  Apply these changes? [Y/n]
```

### 4. Auto Git Automation

Stage your files with `git add .`, then type:

```bash
eco › /commit
eco › /pr
```

Eco Agent will read your staged changes and generate perfect git messages automatically.

---

## 🐝 Swarm Mode

Run multiple specialized agents in parallel:

```
eco › /swarm audit this codebase and fix all TypeScript errors
```

Eco will:

1. 📋 Plan a set of tasks with dependencies
2. ✅ Show you the plan and ask for confirmation
3. 🚀 Run up to 3 parallel worker agents
4. 📊 Report per-task results in real time

---

## 🔌 Plugin System

### Install a plugin

```bash
# Web search (included in this repo)
eco plugin install ./eco-plugin-websearch

# From npm
eco plugin install eco-plugin-websearch
```

### Write your own plugin

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

```bash
eco plugin install ./my-eco-plugin
```

---

## 🔗 MCP Support

Connect to hundreds of existing MCP servers:

```bash
# GitHub
eco mcp add --name github --stdio \
  --command npx --args "-y,@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx"

# Filesystem
eco mcp add --name fs --stdio \
  --command npx --args "-y,@modelcontextprotocol/server-filesystem,/path/to/dir"

# Remote SSE server
eco mcp add --name remote --sse --url https://my-mcp-server.com/mcp
```

---

## 🗂️ Project Context (`eco init`)

```bash
cd my-project
eco init      # Scans your project structure, dependencies, scripts, git status
eco           # Agent now has full awareness of your codebase
```

Customize behavior per-project by editing `.eco/prompt.md` — this file is read on every session.

---

## 🔒 Security Notes

- **API keys are stored locally** using the OS secure config store (via `conf`). They are never hardcoded or committed to version control.
- **Plugins display a safety warning** before installation — always review third-party plugins before installing.
- **Rate limiting** is built in to prevent accidental API overuse.
- **Shell tool** requires explicit user confirmation for destructive commands.

---

## 🛠️ Development

```bash
git clone https://github.com/NabilEkoWahyudi/eco-agent.git
cd eco-agent/eco-agent-main

npm install
npm run dev         # Run from source with tsx
npm run build       # Compile TypeScript → dist/
npm run build:watch # Watch mode
```

---

## 🌐 Providers Detail

### Groq (Recommended — Free)

1. Sign up at [console.groq.com](https://console.groq.com)
2. Create an API key
3. Run `eco` and choose **Groq** when prompted

Available models:

- `llama-3.3-70b-versatile` ← default
- `llama-3.1-8b-instant`
- `qwen-qwq-32b`
- `gemma2-9b-it`
- `mixtral-8x7b-32768`

### OpenRouter

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Many **free models** available (e.g. `meta-llama/llama-3.3-70b-instruct:free`)
3. Run `eco` and choose **OpenRouter** when prompted

### Ollama (Local, No Internet)

```bash
# Install Ollama: https://ollama.com
ollama pull llama3.2
eco   # select Ollama and enter the model name
```

---

## 📋 Requirements

- **Node.js** >= 18.0.0
- **npm** >= 8

---
