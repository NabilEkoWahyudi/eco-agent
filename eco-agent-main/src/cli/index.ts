#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import * as readline from 'readline'
import { createProvider } from '../providers/index.js'
import { AgentLoop } from '../loop/index.js'
import { defaultTools } from '../tools/index.js'
import type { EcoConfig, Tool } from '../utils/types.js'
import { getSavedConfig, saveConfig, clearConfig } from '../utils/configStore.js'
import { runSetupWizard } from '../utils/setupWizard.js'
import { installPlugin, removePlugin, loadAllPlugins, listPlugins, getPluginsDir } from '../plugins/manager.js'
import { saveSession, loadSession, listSessions, deleteSession, renameSession, formatRelativeTime, buildSessionMemory, updateMemoryFile } from '../session/manager.js'
import { Spinner, StatusBar, renderMarkdown, renderToolCall, renderToolResult, renderDivider, renderDiff } from './tui.js'
import { listServers, addServer, removeServer } from '../mcp/registry.js'
import { scanProject, saveProjectContext, loadProjectContext, loadCustomPrompt, buildSystemPromptWithContext, getEcoDir } from '../project/scanner.js'
import { planSwarm, } from '../swarm/planner.js'
import { SwarmOrchestrator } from '../swarm/orchestrator.js'
import type { SwarmEvent } from '../swarm/orchestrator.js'
import { loadMcpTools, disconnectAll } from '../mcp/client.js'
import { pluginSafetyWarning } from '../utils/security.js'

const VERSION = '0.1.0'

const BANNER = `
${chalk.green('███████╗ ██████╗ ██████╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗')}
${chalk.green('██╔════╝██╔════╝██╔═══██╗    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝')}
${chalk.green('█████╗  ██║     ██║   ██║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ')}
${chalk.green('██╔══╝  ██║     ██║   ██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ')}
${chalk.green('███████╗╚██████╗╚██████╔╝    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ')}
${chalk.green('╚══════╝ ╚═════╝ ╚═════╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ')}
${chalk.gray('                                                            v' + VERSION)}
`

function printBanner() { console.log(BANNER) }

function buildEcoConfig(mode: string, apiKey?: string, model?: string, systemPrompt?: string, baseUrl?: string): EcoConfig {
  if (mode === 'mock') {
    return { provider: { type: 'mock' as never, model: 'mock' }, maxIterations: 10, verbose: false }
  }
  const defaultModel = mode === 'openrouter'
    ? 'meta-llama/llama-3.3-70b-instruct:free'
    : mode === 'ollama'
      ? 'llama3.2'
      : 'llama-3.3-70b-versatile'
  return {
    provider: {
      type: mode as EcoConfig['provider']['type'],
      model: model ?? defaultModel,
      apiKey,
      baseUrl
    },
    maxIterations: 10,
    verbose: false,
    systemPrompt
  }
}

async function runREPL(
  config: EcoConfig,
  modeName: string,
  modelName: string,
  tools: Tool[] = defaultTools,
  resumeSessionId?: string,
  pluginCount = 0
) {
  printBanner()

  const statusBar = new StatusBar(modeName, modelName, pluginCount)

  const modeLabel = modeName === 'mock'
    ? chalk.yellow('Mock (testing)')
    : modeName === 'openrouter'
      ? chalk.magenta(`OpenRouter / ${modelName.split('/').pop()}`)
      : modeName === 'ollama'
        ? chalk.blue(`Ollama / ${modelName}`)
        : chalk.cyan(`Groq / ${modelName}`)

  console.log(chalk.gray(`  Mode     : ${modeLabel}`))
  console.log(chalk.gray(`  Tools    : ${chalk.white(tools.map(t => t.name).join(', '))}`))
  console.log(chalk.gray(`  Commands : ${chalk.white('/help /plan /act /swarm /save /sessions /config /exit')}`))
  console.log(chalk.gray(`             ${chalk.white('/tools /clear /history /cd /file /commit /pr /debug')}`))
  console.log()

  // Load cross-session memory (last 3 sessions)
  const sessionMemory = buildSessionMemory(resumeSessionId, 3)
  if (sessionMemory) {
    console.log(chalk.gray(`  Memory   : ${chalk.cyan('3 previous sessions loaded')}`))
  }

  const provider = createProvider(config.provider)
  const agent = new AgentLoop(provider, tools, config, sessionMemory)

  // Plan/Act mode — 'plan' shows thinking only, 'act' executes
  let agentMode: 'plan' | 'act' = 'act'

  // Resume session if provided
  let currentSessionId: string | undefined = resumeSessionId
  if (resumeSessionId) {
    const session = loadSession(resumeSessionId)
    if (session) {
      session.messages.forEach(m => {
        if (m.role === 'user') agent['context'].addUserMessage(m.content)
        else if (m.role === 'assistant') agent['context'].addAssistantMessage(m.content)
      })
      statusBar.update({ sessionId: resumeSessionId, msgCount: session.meta.messageCount })
      console.log(chalk.gray(`  Session  : ${chalk.cyan(session.meta.title)}`))
      console.log(chalk.gray(`  Resumed  : ${chalk.white(session.meta.messageCount + ' messages')}`))
      console.log()
    }
  }

  // Auto-save after every response
  const autoSave = () => {
    const history = agent.getHistory()
    if (history.length === 0) return
    const meta = saveSession(history, config.provider.type, config.provider.model, currentSessionId)
    if (!currentSessionId) currentSessionId = meta.id
    statusBar.update({ sessionId: currentSessionId, msgCount: history.length, tokens: agent.getTotalTokens() })
    // Update memory file so future sessions can recall this one
    updateMemoryFile()
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

  // Smart input reader: detects multi-line paste automatically.
  // Lines arriving within 50ms of each other are collected as a single block.
  // A single-line enter submits immediately after the paste-detection window.
  const readInput = (promptStr: string): Promise<string> => {
    return new Promise((resolve) => {
      process.stdout.write(promptStr)
      const lines: string[] = []
      let timer: ReturnType<typeof setTimeout> | null = null
      let done = false

      const finish = () => {
        if (done) return
        done = true
        rl.removeListener('line', onLine)
        // Remove trailing empty lines from paste
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
        resolve(lines.join('\n'))
      }

      const onLine = (line: string) => {
        if (done) return
        if (timer) clearTimeout(timer)
        lines.push(line)
        // 50ms window: if more lines arrive within 50ms, they're part of a paste
        timer = setTimeout(finish, 50)
      }

      rl.on('line', onLine)
    })
  }

  const prompt = async (): Promise<void> => {
    statusBar.print()
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const shortCwd = process.cwd().startsWith(home)
      ? '~' + process.cwd().slice(home.length)
      : process.cwd()
    const cwdLabel = chalk.dim.yellow(shortCwd)
    const modePrompt = agentMode === 'plan'
      ? `${cwdLabel} ${chalk.yellow('eco [plan] › ')}`
      : `${cwdLabel} ${chalk.green('eco › ')}`
    const input = await readInput(modePrompt)
    let trimmed = input.trim()
    if (!trimmed) return prompt()

      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.split(' ')
        switch (cmd) {

          case '/exit':
          case '/quit':
            autoSave()
            console.log(chalk.gray('\n  Goodbye! 🌿\n'))
            rl.close()
            process.exit(0)
            break

          case '/config':
            rl.close()
            console.log()
            const newSaved = await runSetupWizard(true)
            saveConfig(newSaved)
            const reloadedPlugins = await loadAllPlugins()
            await runREPL(
              buildEcoConfig(newSaved.mode, newSaved.apiKey, newSaved.model, undefined, newSaved.baseUrl),
              newSaved.mode,
              newSaved.model ?? (newSaved.mode === 'ollama' ? 'llama3.2' : 'llama-3.3-70b-versatile'),
              [...defaultTools, ...reloadedPlugins],
              undefined,
              reloadedPlugins.length
            )
            return

          case '/clear':
            agent.resetContext()
            currentSessionId = undefined
            statusBar.update({ sessionId: undefined, msgCount: 0 })
            console.clear()
            printBanner()
            console.log(chalk.gray('  Context cleared.\n'))
            break

          case '/cd': {
            const targetPath = rest.join(' ').trim()
            if (!targetPath) {
              // /cd with no args = go to home
              const home = process.env.HOME || process.env.USERPROFILE || process.cwd()
              process.chdir(home)
            } else if (targetPath === '-') {
              // /cd - = go back (not tracked, just warn)
              console.log(chalk.yellow('\n  ⚠ /cd - (go back) is not supported. Use the full path.\n'))
              return prompt()
            } else {
              const pathModule = await import('path')
              const fsModule = await import('fs')
              const newPath = pathModule.resolve(process.cwd(), targetPath)
              if (!fsModule.existsSync(newPath)) {
                console.log(chalk.red(`\n  ✗ Directory not found: ${newPath}\n`))
                return prompt()
              }
              const stat = fsModule.statSync(newPath)
              if (!stat.isDirectory()) {
                console.log(chalk.red(`\n  ✗ Not a directory: ${newPath}\n`))
                return prompt()
              }
              process.chdir(newPath)
            }
            const cwd = process.cwd()
            statusBar.update({ cwd })
            console.log(chalk.green(`\n  ✓ Now in: ${chalk.white(cwd)}\n`))
            break
          }

          case '/file': {
            // Load content of a file directly as context
            const filePath = rest.join(' ').trim()
            if (!filePath) {
              console.log(chalk.yellow('\n  Usage: /file <path>\n'))
              return prompt()
            }
            try {
              const fs = await import('fs')
              const path = await import('path')
              const abs = path.resolve(filePath)
              if (!fs.existsSync(abs)) {
                console.log(chalk.red(`\n  ✗ File not found: ${abs}\n`))
                return prompt()
              }
              const content = fs.readFileSync(abs, 'utf-8')
              console.log(chalk.cyan(`\n  ✓ Loaded ${abs} (${content.split('\n').length} lines, ${content.length} chars)`))
              console.log(chalk.gray('  Enter your instruction for this file:'))
              console.log()
              const instruction = await new Promise<string>(r => rl.question(chalk.green('  Instruction: '), r))
              trimmed = `File: ${abs}\n\`\`\`\n${content}\n\`\`\`\n\nInstruction: ${instruction.trim() || 'Analyze this file.'}`
            } catch (e) {
              console.log(chalk.red(`\n  ✗ Error reading file: ${(e as Error).message}\n`))
              return prompt()
            }
            break // fall through to agent.run
          }

          case '/history': {
            const history = agent.getHistory()
            if (history.length === 0) {
              console.log(chalk.gray('\n  No history yet.\n'))
            } else {
              console.log()
              console.log(renderDivider('history'))
              history.forEach((m, i) => {
                const roleColor = m.role === 'user' ? chalk.cyan : m.role === 'assistant' ? chalk.green : chalk.yellow
                const preview = m.content.slice(0, 80).replace(/\n/g, ' ')
                console.log(`  ${chalk.gray(String(i + 1).padStart(2))}  ${roleColor(m.role.padEnd(10))} ${preview}${m.content.length > 80 ? '…' : ''}`)
              })
              console.log(renderDivider())
              console.log()
            }
            break
          }

          case '/tools':
            console.log()
            console.log(renderDivider('tools'))
            tools.forEach(t => {
              console.log(`  ${chalk.cyan('⚙')}  ${chalk.bold(t.name.padEnd(22))} ${chalk.gray(t.description)}`)
            })
            console.log(renderDivider())
            console.log()
            break

          case '/save': {
            const history = agent.getHistory()
            if (history.length === 0) {
              console.log(chalk.yellow('\n  No conversation to save yet.\n'))
            } else {
              autoSave()
              const customTitle = rest.join(' ').trim()
              if (customTitle && currentSessionId) renameSession(currentSessionId, customTitle)
              console.log(chalk.green(`\n  ✓ Session saved${currentSessionId ? ` — id: ${chalk.white(currentSessionId)}` : ''}\n`))
            }
            break
          }

          case '/sessions': {
            const sessions = listSessions()
            console.log()
            console.log(renderDivider('sessions'))
            if (sessions.length === 0) {
              console.log(chalk.gray('  No saved sessions.\n'))
              console.log(renderDivider())
              console.log()
              break
            }
            sessions.slice(0, 10).forEach((s, i) => {
              const isCurrent = s.id === currentSessionId
              const prefix = isCurrent ? chalk.green('▶') : chalk.gray(String(i + 1) + '.')
              console.log(`  ${prefix} ${chalk.bold(s.title)}`)
              console.log(`     ${chalk.gray(`${s.messageCount} msgs · ${formatRelativeTime(s.updatedAt)} · ${s.model}`)}`)
              console.log()
            })
            console.log(chalk.gray('  [0] Cancel'))
            console.log(renderDivider())
            console.log()

            const sessionAnswer = await new Promise<string>(resolve => {
              rl.question(chalk.green(`  Open session [1-${Math.min(sessions.length, 10)}] or 0 to cancel: `), resolve)
            })
            const sessionNum = parseInt(sessionAnswer.trim())
            if (!isNaN(sessionNum) && sessionNum >= 1 && sessionNum <= Math.min(sessions.length, 10)) {
              const chosen = sessions[sessionNum - 1]
              // Load chosen session
              const loaded = loadSession(chosen.id)
              if (loaded) {
                agent.resetContext()
                loaded.messages.forEach(m => {
                  if (m.role === 'user') agent['context'].addUserMessage(m.content)
                  else if (m.role === 'assistant') agent['context'].addAssistantMessage(m.content)
                })
                currentSessionId = chosen.id
                statusBar.update({ sessionId: chosen.id, msgCount: loaded.messages.length })
                console.log(chalk.green(`\n  ✓ Resumed: ${chosen.title}\n`))
              }
            } else {
              console.log(chalk.gray('  Cancelled.\n'))
            }
            break
          }

          case '/commit': {
            const child_process = await import('child_process')
            let diff = ''
            try {
              diff = child_process.execSync('git diff --cached', { encoding: 'utf-8' })
              if (!diff) {
                console.log(chalk.yellow('\n  No staged changes found. Please stage files with `git add` first.\n'))
                break
              }
            } catch (e) {
              console.log(chalk.red('\n  ✗ Error reading git diff. Are you in a git repository?\n'))
              break
            }
            
            console.log(chalk.cyan('\n  ⟳ Generating commit message...\n'))
            const promptStr = `Based on the following git diff, generate a concise, descriptive commit message following Conventional Commits format. Output ONLY the commit message without quotes or extra text.\n\nDiff:\n${diff}`
            agentMode = 'act' // Force execution
            trimmed = promptStr
            break // Fall through to agent.run
          }

          case '/pr': {
            const child_process = await import('child_process')
            let log = ''
            try {
              log = child_process.execSync('git log origin/main..HEAD --oneline', { encoding: 'utf-8' })
              if (!log) {
                console.log(chalk.yellow('\n  No new commits found compared to origin/main.\n'))
                break
              }
            } catch (e) {
              try {
                log = child_process.execSync('git log -n 5 --oneline', { encoding: 'utf-8' })
              } catch {
                console.log(chalk.red('\n  ✗ Error reading git log.\n'))
                break
              }
            }
            
            console.log(chalk.cyan('\n  ⟳ Generating Pull Request description...\n'))
            const promptStr = `Based on the following git commits, generate a detailed Pull Request description in Markdown. Include a title, summary, and bullet points of changes.\n\nCommits:\n${log}`
            agentMode = 'act'
            trimmed = promptStr
            break
          }

          case '/debug': {
            const cmdToDebug = rest.join(' ').trim()
            if (!cmdToDebug) {
              console.log(chalk.yellow('\n  Usage: /debug <command>\n'))
              break
            }
            console.log(chalk.cyan(`\n  ⟳ Starting auto-debugger for: ${chalk.white(cmdToDebug)}\n`))
            const promptStr = `I want you to run the following command using your tools. If it fails, read the error, inspect the relevant files, fix the issue, and run the command again. Continue this loop until the command succeeds. Do not stop until it is fixed.\n\nCommand: ${cmdToDebug}`
            agentMode = 'act'
            trimmed = promptStr
            break
          }

          case '/swarm': {
            const goal = rest.join(' ').trim()
            if (!goal) {
              console.log(chalk.yellow('\n  Usage: /swarm <goal description>\n'))
              console.log(chalk.gray('  Example: /swarm audit this codebase and fix any TypeScript errors\n'))
              break
            }
            console.log()
            console.log(renderDivider('swarm'))
            console.log(chalk.cyan(`  ⟳ Planning tasks for: ${chalk.white(goal)}`))
            console.log()

            const swarmProvider = createProvider(config.provider)
            let plan
            try {
              plan = await planSwarm(goal, swarmProvider)
            } catch (e) {
              console.log(chalk.red(`  ✗ Planning failed: ${(e as Error).message}\n`))
              break
            }

            // Show plan
            console.log(chalk.bold(`  Plan: ${plan.tasks.length} tasks\n`))
            plan.tasks.forEach((t, i) => {
              const deps = t.dependsOn?.length ? chalk.gray(` (after: ${t.dependsOn.join(', ')})`) : ''
              console.log(`  ${chalk.cyan(String(i + 1) + '.')} ${chalk.bold(t.title)}${deps}`)
              console.log(`     ${chalk.gray(t.description.slice(0, 80) + (t.description.length > 80 ? '…' : ''))}`)
            })
            console.log()

            // Confirm
            const confirmAnswer = await new Promise<string>(resolve => {
              rl.question(chalk.green('  Start swarm? [Y/n]: '), resolve)
            })
            if (confirmAnswer.trim().toLowerCase() === 'n') {
              console.log(chalk.gray('  Swarm cancelled.\n'))
              break
            }

            console.log()
            console.log(chalk.bold('  Running swarm...\n'))

            const swarmOrch = new SwarmOrchestrator(swarmProvider, tools, { maxWorkers: 3 })

            swarmOrch.on('event', (evt: SwarmEvent) => {
              switch (evt.type) {
                case 'task:start':
                  console.log(`  ${chalk.bgCyan.black(` W${evt.workerIndex + 1} `)} ${chalk.cyan('▸')} ${chalk.bold(evt.task.title)}`)
                  break
                case 'task:done':
                  console.log(`  ${chalk.bgGreen.black(' DONE ')} ${chalk.green('✓')} ${chalk.bold(evt.task.title)}`)
                  if (evt.result) {
                    const preview = evt.result.slice(0, 120).replace(/\n/g, ' ')
                    console.log(`         ${chalk.gray(preview + (evt.result.length > 120 ? '…' : ''))}`)
                  }
                  break
                case 'task:failed':
                  console.log(`  ${chalk.bgRed.black(' FAIL ')} ${chalk.red('✗')} ${chalk.bold(evt.task.title)}`)
                  console.log(`         ${chalk.red(evt.error.slice(0, 100))}`)
                  break
                case 'task:skipped':
                  console.log(`  ${chalk.bgYellow.black(' SKIP ')} ${chalk.yellow('⚠')} ${chalk.bold(evt.task.title)} ${chalk.gray('(dependency failed)')}`)
                  break
                case 'worker:tool':
                  console.log(`         ${chalk.gray('⚙ ' + evt.toolName)}`)
                  break
              }
            })

            const swarmResult = await swarmOrch.run(plan)

            console.log()
            console.log(renderDivider('swarm complete'))
            const durationSec = (swarmResult.duration / 1000).toFixed(1)
            console.log(`  ${chalk.green('✓')} ${swarmResult.succeeded} done  ${chalk.red('✗')} ${swarmResult.failed} failed  ${chalk.yellow('⚠')} ${swarmResult.skipped} skipped  ${chalk.gray(durationSec + 's')}`)
            console.log()
            console.log(chalk.bold('  Summary:'))
            console.log(renderMarkdown(swarmResult.summary))
            console.log(renderDivider())
            console.log()
            break
          }

          case '/plan':
            agentMode = 'plan'
            console.log(chalk.yellow('\n  📋 Plan mode ON — agent will explain its plan before executing.'))
            console.log(chalk.gray('  Use /act to switch back to execute mode.\n'))
            const planTask = rest.join(' ').trim()
            if (!planTask) {
              return prompt()
            }
            trimmed = planTask
            break // Fall through to execution

          case '/act':
            agentMode = 'act'
            console.log(chalk.green('\n  ⚡ Act mode ON — agent will execute directly.'))
            console.log(chalk.gray('  Use /plan to switch to plan mode.\n'))
            const actTask = rest.join(' ').trim()
            if (!actTask) {
              return prompt()
            }
            trimmed = actTask
            break // Fall through to execution

          case '/help':
            console.log()
            console.log(renderDivider('help'))
            console.log(chalk.bold('  ── Input ──────────────────────────────────────'))
            console.log(`  ${chalk.cyan('eco › <message>')}    Type any message (single-line or paste multi-line)`)
            console.log(`  ${chalk.cyan('/file <path>')}      Load a file as context, then add instruction`)
            console.log()
            console.log(chalk.bold('  ── Navigation ──────────────────────────────────'))
            console.log(`  ${chalk.cyan('/cd <path>')}       Change working directory`)
            console.log(`  ${chalk.cyan('/cd ..')}           Go up one directory`)
            console.log(`  ${chalk.cyan('/cd')}              Go to home directory`)
            console.log()
            console.log(chalk.bold('  ── Conversation ────────────────────────────────'))
            console.log(`  ${chalk.cyan('/clear')}           Clear conversation context`)
            console.log(`  ${chalk.cyan('/history')}         Show message history`)
            console.log(`  ${chalk.cyan('/save [title]')}    Save current session`)
            console.log(`  ${chalk.cyan('/sessions')}        Browse & resume saved sessions`)
            console.log()
            console.log(chalk.bold('  ── Modes ───────────────────────────────────────'))
            console.log(`  ${chalk.cyan('/plan')}            Plan mode — agent explains before acting`)
            console.log(`  ${chalk.cyan('/act')}             Act mode — agent executes directly (default)`)
            console.log()
            console.log(chalk.bold('  ── Tools & Automation ──────────────────────────'))
            console.log(`  ${chalk.cyan('/tools')}           List all available tools (incl. file/folder/web)`)
            console.log(`  ${chalk.cyan('/commit')}          Auto-generate git commit message (staged files)`)
            console.log(`  ${chalk.cyan('/pr')}              Auto-generate Pull Request description`)
            console.log(`  ${chalk.cyan('/debug <cmd>')}     Run command & auto-fix errors in a loop`)
            console.log(`  ${chalk.cyan('/swarm <goal>')}    Launch multi-agent swarm`)
            console.log()
            console.log(chalk.bold('  ── Settings ────────────────────────────────────'))
            console.log(`  ${chalk.cyan('/config')}          Switch provider or update API key`)
            console.log(`  ${chalk.cyan('/exit')}            Exit Eco Agent`)
            console.log(renderDivider())
            console.log(chalk.gray('  Tip: Paste multi-line text directly — it is detected automatically.'))
            console.log()
            break

          default:
            console.log(chalk.red(`\n  Unknown command: ${cmd}. Type /help for help.\n`))
        }
        return prompt()
      }

      // ── Run agent ──────────────────────────────────────────────────────────
      console.log()

      // Inject current working directory into prompt so LLM resolves relative paths correctly
      const cwdContext = `[System: Current working directory is ${process.cwd()}]\n\n`
      const baseInput = cwdContext + trimmed

      // In plan mode, prepend instruction to think before acting
      const finalInput = agentMode === 'plan'
        ? `Before doing anything, write a numbered step-by-step plan of what you will do to accomplish this task. Then ask me: "Shall I proceed? (yes/no)". Wait for my response before using any tools.\n\nTask: ${baseInput}`
        : baseInput

      const spinner = new Spinner('Thinking...')

      // Display user prompt before response
      console.log(chalk.dim('  ┌─ you ') + chalk.dim('─'.repeat(Math.max(0, (process.stdout.columns || 80) - 10))))
      trimmed.split('\n').forEach(line => {
        console.log(chalk.dim('  │ ') + chalk.white(line))
      })
      console.log(chalk.dim('  └' + '─'.repeat(Math.max(0, (process.stdout.columns || 80) - 4))))
      console.log()

      spinner.start()

      let responseBuffer = ''
      let firstContent = true
      let streamedLines = 0 // track lines written during streaming

      await agent.run(finalInput, {
        onThinking: () => spinner.update('Thinking...'),

        onContent: (chunk) => {
          if (firstContent) {
            spinner.stop()
            process.stdout.write(renderDivider('response') + '\n')
            firstContent = false
          }
          responseBuffer += chunk
          // Count newlines for later cursor erasure
          streamedLines += (chunk.match(/\n/g) || []).length
          process.stdout.write(chalk.white(chunk))
        },

        onToolCall: (toolName, args) => {
          spinner.stop()
          if (toolName !== 'write_file') {
            console.log(renderToolCall(toolName, args))
          }
          spinner.update(`Running ${toolName}...`)
          spinner.start()
          firstContent = true
        },

        onConfirmTool: async (toolName, args) => {
          if (!['write_file', 'delete_path', 'rename_path'].includes(toolName)) return true
          
          spinner.stop()
          console.log(renderToolCall(toolName, args))
          
          if (toolName === 'write_file') {
            const fs = await import('fs')
            const path = args.path as string
            const content = args.content as string
            let oldContent = ''
            if (fs.existsSync(path)) {
              oldContent = fs.readFileSync(path, 'utf-8')
            }
            console.log(renderDiff(oldContent, content))
          } else if (toolName === 'delete_path') {
            console.log(chalk.red(`  ! WARNING: This will permanently delete: ${args.path}`))
          } else if (toolName === 'rename_path') {
            console.log(chalk.yellow(`  ~ This will rename/move: ${args.oldPath} -> ${args.newPath}`))
          }
          console.log()
          
          const ans = await new Promise<string>(resolve => rl.question(chalk.green('  Apply these changes? [Y/n] '), resolve))
          return ans.trim().toLowerCase() !== 'n'
        },

        onToolResult: (_name, result, error) => {
          spinner.stop()
          console.log(renderToolResult(_name, result, error))
          spinner.update('Thinking...')
          spinner.start()
          firstContent = true
        },

        onError: (err) => {
          spinner.stop()
          console.log(chalk.red(`\n  ✗ Error: ${err.message}`))
          if (err.message.includes('401') || err.message.includes('API')) {
            console.log(chalk.yellow('  → Type /config to update your API key.'))
          }
          firstContent = false
        },

        onDone: () => {
          spinner.stop()
          if (responseBuffer) {
            const termWidth = process.stdout.columns || 80
            // Count actual display lines (accounting for word wrap)
            const rawDisplayLines = responseBuffer.split('\n').reduce((acc, line) => {
              return acc + Math.max(1, Math.ceil((line.length || 1) / termWidth))
            }, 0)
            // Erase: move cursor up past all streamed content + divider header
            const totalLines = rawDisplayLines + 3
            process.stdout.write(`\x1b[${totalLines}A\x1b[0J`)
            // Re-render cleanly with full markdown + syntax highlighting
            console.log(renderDivider('response'))
            console.log(renderMarkdown(responseBuffer))
            console.log(renderDivider())
          }
          console.log()
          responseBuffer = ''
          streamedLines = 0
          autoSave()
        }
      })

      prompt()
  }

  prompt()
}


// ─── Main program ─────────────────────────────────────────────────────────────
const program = new Command()

program
  .name('eco')
  .description('Eco Agent — agentic CLI powered by local & cloud LLMs')
  .version(VERSION)
  .argument('[prompt...]', 'Run a single prompt non-interactively')
  .option('--reset', 'Reset saved configuration')
  .option('--resume [id]', 'Resume last session or a specific session by ID')
  .action(async (promptParts: string[], opts) => {
    const isSubCmd = ['plugin', 'session', 'mcp', 'init', 'swarm'].includes(process.argv[2])
    if (isSubCmd) return

    if (opts.reset) {
      clearConfig()
      console.log(chalk.green('  ✓ Configuration reset.\n'))
    }

    let saved = getSavedConfig()
    if (!saved) {
      printBanner()
      saved = await runSetupWizard(false)
      saveConfig(saved)
    }

    // Load project context if .eco/ exists
    const cwd = process.cwd()
    const projectCtx = loadProjectContext(cwd)
    const customPrompt = loadCustomPrompt(cwd)
    const systemPrompt = projectCtx
      ? buildSystemPromptWithContext(projectCtx, customPrompt)
      : undefined

    if (projectCtx) {
      console.log(chalk.gray(`  Project  : ${chalk.cyan(projectCtx.name)} ${chalk.gray('(' + projectCtx.type.join(', ') + ')')}`))
      if (projectCtx.gitBranch) console.log(chalk.gray(`  Branch   : ${chalk.white(projectCtx.gitBranch)}`))
    }

    // Load plugins
    const pluginTools = await loadAllPlugins()

    // Load MCP server tools
    const mcpServers = listServers()
    const mcpTools = mcpServers.length > 0 ? await loadMcpTools(mcpServers) : []
    if (mcpTools.length > 0) {
      process.on('exit', () => { disconnectAll().catch(() => {}) })
    }

    // Respect model tool support capability
    const supportsTools = saved.supportsTools !== false
    const allTools = supportsTools ? [...defaultTools, ...pluginTools, ...mcpTools] : []

    if (!supportsTools) {
      console.log(chalk.yellow('  ⚠ Text-only mode — this model does not support tools.'))
      console.log(chalk.gray('  Use /config to switch to a tool-capable model.\n'))
    }

    const config = buildEcoConfig(saved.mode, saved.apiKey, saved.model, systemPrompt, saved.baseUrl)
    const modelName = saved.model ?? (saved.mode === 'ollama' ? 'llama3.2' : 'llama-3.3-70b-versatile')
    const promptText = promptParts.join(' ').trim()

    // Resolve --resume
    let resumeId: string | undefined
    if (opts.resume) {
      if (typeof opts.resume === 'string') {
        resumeId = opts.resume
      } else {
        const sessions = listSessions()
        resumeId = sessions[0]?.id
        if (resumeId) console.log(chalk.gray(`  Resuming: ${sessions[0].title}\n`))
        else console.log(chalk.yellow('  No saved sessions found.\n'))
      }
    }

    if (promptText) {
      const provider = createProvider(config.provider)
      const agent = new AgentLoop(provider, allTools, config)
      await agent.run(promptText, {
        onContent: (chunk) => process.stdout.write(chunk),
        onToolCall: (name, args) => process.stderr.write(chalk.yellow(`\n  ⚙ ${name} ${JSON.stringify(args).slice(0, 60)}\n`)),
        onError: (err) => process.stderr.write(chalk.red(`\n  ✗ ${err.message}\n`)),
        onDone: () => process.stdout.write('\n')
      })
      return
    }

    await runREPL(config, saved.mode, modelName, allTools, resumeId, pluginTools.length + mcpTools.length)
  })

// ─── Plugin subcommand ────────────────────────────────────────────────────────
const pluginCmd = program.command('plugin').description('Manage Eco Agent plugins')

pluginCmd
  .command('install <package>')
  .description('Install a plugin from npm or local path')
  .action(async (packageName: string) => {
    console.log()
    console.log(pluginSafetyWarning(packageName))
    console.log()

    // Confirm install
    const { createInterface } = await import('readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => {
      rl.question(chalk.green('  Continue? [y/N]: '), resolve)
    })
    rl.close()

    if (answer.trim().toLowerCase() !== 'y') {
      console.log(chalk.gray('  Plugin install cancelled.\n'))
      return
    }

    console.log(chalk.cyan(`\n  ▸ Installing plugin: ${packageName}...`))
    const result = await installPlugin(packageName)
    if (result.ok) console.log(chalk.green(`  ✓ ${result.message}\n`))
    else { console.log(chalk.red(`  ✗ ${result.message}\n`)); process.exit(1) }
  })

pluginCmd
  .command('remove <package>')
  .description('Remove an installed plugin')
  .action(async (packageName: string) => {
    const result = await removePlugin(packageName)
    if (result.ok) console.log(chalk.green(`\n  ✓ ${result.message}\n`))
    else { console.log(chalk.red(`\n  ✗ ${result.message}\n`)); process.exit(1) }
  })

pluginCmd
  .command('list')
  .description('Show installed plugins')
  .action(() => {
    const plugins = listPlugins()
    console.log()
    if (plugins.length === 0) {
      console.log(chalk.gray('  No plugins installed.'))
      console.log(chalk.gray('  Install one with: eco plugin install <package-name>\n'))
      return
    }
    console.log(chalk.bold(`  Installed plugins (${plugins.length}):\n`))
    plugins.forEach(p => {
      console.log(`  ${chalk.green('●')} ${chalk.bold(p.name)} ${chalk.gray('v' + p.version)}`)
      console.log(`    ${chalk.gray(p.description)}`)
      console.log(`    ${chalk.gray('package: ' + p.packageName)}`)
      console.log()
    })
    console.log(chalk.gray(`  Plugins dir: ${getPluginsDir()}\n`))
  })

pluginCmd
  .command('dir')
  .description('Show plugins directory path')
  .action(() => console.log(chalk.cyan(`\n  ${getPluginsDir()}\n`)))

// ─── Session subcommand ───────────────────────────────────────────────────────
const sessionCmd = program.command('session').description('Manage conversation sessions')

sessionCmd
  .command('list')
  .description('Show all saved sessions')
  .action(() => {
    const sessions = listSessions()
    console.log()
    if (sessions.length === 0) {
      console.log(chalk.gray('  No saved sessions.'))
      console.log(chalk.gray('  Sessions are auto-saved as you chat in the REPL.\n'))
      return
    }
    console.log(chalk.bold(`  Saved sessions (${sessions.length}):\n`))
    sessions.forEach((s, i) => {
      console.log(`  ${chalk.cyan(String(i + 1).padStart(2) + '.')} ${chalk.bold(s.title)}`)
      console.log(`      ${chalk.gray(`${s.messageCount} messages · ${formatRelativeTime(s.updatedAt)} · ${s.provider}/${s.model}`)}`)
      console.log(`      ${chalk.gray('eco --resume ' + s.id)}`)
      console.log()
    })
  })

sessionCmd
  .command('delete <id>')
  .description('Delete a session by ID')
  .action((id: string) => {
    const ok = deleteSession(id)
    if (ok) console.log(chalk.green(`\n  ✓ Session "${id}" deleted.\n`))
    else console.log(chalk.red(`\n  ✗ Session "${id}" not found.\n`))
  })

sessionCmd
  .command('rename <id> <title>')
  .description('Rename a session')
  .action((id: string, title: string) => {
    const ok = renameSession(id, title)
    if (ok) console.log(chalk.green(`\n  ✓ Session renamed to "${title}".\n`))
    else console.log(chalk.red(`\n  ✗ Session "${id}" not found.\n`))
  })


// ─── MCP subcommand ───────────────────────────────────────────────────────────
const mcpCmd = program.command('mcp').description('Manage MCP (Model Context Protocol) servers')

mcpCmd
  .command('add')
  .description('Add an MCP server')
  .option('-n, --name <name>', 'Server name (identifier)')
  .option('--stdio', 'Use stdio transport (local process)')
  .option('--sse', 'Use SSE transport (remote HTTP server)')
  .option('-c, --command <cmd>', 'Command to run (stdio only) e.g. npx')
  .option('-a, --args <args>', 'Comma-separated args e.g. -y,@modelcontextprotocol/server-github')
  .option('-u, --url <url>', 'Server URL (SSE only)')
  .option('-e, --env <pairs>', 'Env vars as KEY=VALUE,KEY2=VALUE2')
  .option('-d, --description <desc>', 'Optional description')
  .action((opts) => {
    if (!opts.name) {
      console.log(chalk.red('\n  ✗ --name is required\n'))
      process.exit(1)
    }

    const type = opts.sse ? 'sse' : 'stdio'

    if (type === 'stdio' && !opts.command) {
      console.log(chalk.red('\n  ✗ --command is required for stdio servers\n'))
      process.exit(1)
    }
    if (type === 'sse' && !opts.url) {
      console.log(chalk.red('\n  ✗ --url is required for SSE servers\n'))
      process.exit(1)
    }

    // Parse env pairs
    const env: Record<string, string> = {}
    if (opts.env) {
      opts.env.split(',').forEach((pair: string) => {
        const [k, ...v] = pair.split('=')
        if (k) env[k.trim()] = v.join('=').trim()
      })
    }

    const result = addServer({
      name: opts.name,
      type,
      command: opts.command,
      args: opts.args ? opts.args.split(',') : undefined,
      url: opts.url,
      env: Object.keys(env).length > 0 ? env : undefined,
      description: opts.description
    })

    if (result.ok) console.log(chalk.green(`\n  ✓ ${result.message}\n`))
    else { console.log(chalk.red(`\n  ✗ ${result.message}\n`)); process.exit(1) }
  })

mcpCmd
  .command('remove <name>')
  .description('Remove an MCP server')
  .action((name: string) => {
    const result = removeServer(name)
    if (result.ok) console.log(chalk.green(`\n  ✓ ${result.message}\n`))
    else { console.log(chalk.red(`\n  ✗ ${result.message}\n`)); process.exit(1) }
  })

mcpCmd
  .command('list')
  .description('List registered MCP servers')
  .action(() => {
    const servers = listServers()
    console.log()
    if (servers.length === 0) {
      console.log(chalk.gray('  No MCP servers registered.'))
      console.log(chalk.gray('  Add one with: eco mcp add --name <name> [--stdio|--sse] ...\n'))
      return
    }
    console.log(chalk.bold(`  MCP servers (${servers.length}):\n`))
    servers.forEach(s => {
      const typeTag = s.type === 'stdio' ? chalk.bgGreen.black(' STDIO ') : chalk.bgCyan.black(' SSE ')
      console.log(`  ${typeTag} ${chalk.bold(s.name)}`)
      if (s.description) console.log(`    ${chalk.gray(s.description)}`)
      if (s.type === 'stdio') {
        console.log(`    ${chalk.gray('cmd: ' + [s.command, ...(s.args ?? [])].join(' '))}`)
      } else {
        console.log(`    ${chalk.gray('url: ' + s.url)}`)
      }
      console.log(`    ${chalk.gray('added: ' + new Date(s.addedAt).toLocaleDateString())}`)
      console.log()
    })
  })

mcpCmd
  .command('test <name>')
  .description('Test connection to an MCP server and list its tools')
  .action(async (name: string) => {
    const { getServer } = await import('../mcp/registry.js')
    const server = getServer(name)
    if (!server) {
      console.log(chalk.red(`\n  ✗ Server "${name}" not found.\n`))
      process.exit(1)
    }
    console.log(chalk.cyan(`\n  ▸ Connecting to "${name}"...`))
    try {
      const { McpClient } = await import('../mcp/client.js')
      const client = new McpClient(server)
      const tools = await client.getTools()
      console.log(chalk.green(`  ✓ Connected! ${tools.length} tools available:\n`))
      tools.forEach(t => {
        console.log(`  ${chalk.cyan('⚙')}  ${chalk.bold(t.name)}`)
        console.log(`      ${chalk.gray(t.description)}`)
      })
      console.log()
      await client.disconnect()
    } catch (e) {
      console.log(chalk.red(`  ✗ Connection failed: ${(e as Error).message}\n`))
      process.exit(1)
    }
  })


// ─── Init command ─────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize Eco Agent for current project')
  .option('--refresh', 'Re-scan project and update context')
  .option('--show', 'Show current project context')
  .action(async (opts) => {
    const cwd = process.cwd()
    const ecoDir = getEcoDir(cwd)

    if (opts.show) {
      const ctx = loadProjectContext(cwd)
      if (!ctx) {
        console.log(chalk.yellow('\n  No project context found. Run: eco init\n'))
        return
      }
      console.log(chalk.bold('\n  Project context:\n'))
      console.log(chalk.gray('  Name    : ') + chalk.white(ctx.name))
      console.log(chalk.gray('  Type    : ') + chalk.white(ctx.type.join(', ')))
      if (ctx.description) console.log(chalk.gray('  Desc    : ') + chalk.white(ctx.description))
      if (ctx.gitBranch) console.log(chalk.gray('  Branch  : ') + chalk.white(ctx.gitBranch))
      console.log(chalk.gray('  Files   : ') + chalk.white(ctx.keyFiles ? Object.keys(ctx.keyFiles).join(', ') : 'none'))
      console.log(chalk.gray('  Config  : ') + chalk.white(ecoDir))
      console.log()
      return
    }

    const existing = loadProjectContext(cwd)
    if (existing && !opts.refresh) {
      console.log(chalk.yellow(`\n  Project already initialized: ${chalk.white(existing.name)}`))
      console.log(chalk.gray('  Use --refresh to re-scan, or --show to view context.\n'))
      return
    }

    console.log(chalk.cyan('\n  ▸ Scanning project...'))
    const ctx = scanProject(cwd)
    saveProjectContext(cwd, ctx)

    // Create default prompt.md if not exists
    const { join: pathJoin } = await import('path')
    const { existsSync: fsExists, writeFileSync: fsWrite } = await import('fs')
    const customPromptPath = pathJoin(ecoDir, 'prompt.md')
    if (!fsExists(customPromptPath)) {
      const defaultPrompt = `# Custom instructions for ${ctx.name}\n\n<!-- Add any project-specific instructions here. -->\n<!-- This file is read by Eco Agent on every session. -->\n`
      fsWrite(customPromptPath, defaultPrompt, 'utf-8')
    }

    console.log(chalk.green('  ✓ Project context saved!\n'))
    console.log(chalk.bold('  Project summary:\n'))
    console.log(chalk.gray('  Name         : ') + chalk.white(ctx.name))
    console.log(chalk.gray('  Type         : ') + chalk.white(ctx.type.join(', ') || 'unknown'))
    if (ctx.description) console.log(chalk.gray('  Description  : ') + chalk.white(ctx.description))
    if (ctx.gitBranch) console.log(chalk.gray('  Git branch   : ') + chalk.white(ctx.gitBranch))
    console.log(chalk.gray('  Dependencies : ') + chalk.white(ctx.dependencies.length + ' packages'))
    console.log(chalk.gray('  Key files    : ') + chalk.white(Object.keys(ctx.keyFiles).join(', ')))
    console.log(chalk.gray('  Config dir   : ') + chalk.white(ecoDir))
    console.log()
    console.log(chalk.gray('  Edit custom instructions: ') + chalk.cyan(customPromptPath))
    console.log(chalk.gray('  Now run ') + chalk.green('eco') + chalk.gray(' — the agent will know your project automatically.'))
    console.log()
  })


// ─── Swarm subcommand ─────────────────────────────────────────────────────────
program
  .command('swarm <goal>')
  .description('Run a multi-agent swarm to accomplish a complex goal')
  .option('-w, --workers <n>', 'Max parallel workers (default: 3)', '3')
  .option('--plan-only', 'Show plan without executing')
  .action(async (goal: string, opts) => {
    let saved = getSavedConfig()
    if (!saved) {
      console.log(chalk.yellow('\n  No config found. Run: eco\n'))
      process.exit(1)
    }

    const pluginTools = await loadAllPlugins()
    const mcpServers = listServers()
    const mcpTools = mcpServers.length > 0 ? await loadMcpTools(mcpServers) : []
    // Respect model tool support capability
    const supportsTools = saved.supportsTools !== false
    const allTools = supportsTools ? [...defaultTools, ...pluginTools, ...mcpTools] : []

    if (!supportsTools) {
      console.log(chalk.yellow('  ⚠ Text-only mode — this model does not support tools.'))
      console.log(chalk.gray('  Use /config to switch to a tool-capable model.\n'))
    }
    const config = buildEcoConfig(saved.mode, saved.apiKey, saved.model, undefined, saved.baseUrl)
    const provider = createProvider(config.provider)

    console.log()
    console.log(renderDivider('swarm'))
    console.log(chalk.cyan(`  ⟳ Planning: ${chalk.white(goal)}`))
    console.log()

    const plan = await planSwarm(goal, provider)

    console.log(chalk.bold(`  Plan — ${plan.tasks.length} tasks:\n`))
    plan.tasks.forEach((t, i) => {
      const deps = t.dependsOn?.length ? chalk.gray(` → after: ${t.dependsOn.join(', ')}`) : ''
      console.log(`  ${chalk.cyan(String(i + 1) + '.')} ${chalk.bold(t.title)}${deps}`)
      console.log(`     ${chalk.gray(t.description.slice(0, 90) + (t.description.length > 90 ? '…' : ''))}`)
      console.log()
    })

    if (opts.planOnly) {
      console.log(chalk.gray('  Plan-only mode — not executing.\n'))
      return
    }

    console.log(chalk.bold('  Executing swarm...\n'))
    const maxWorkers = parseInt(opts.workers) || 3
    const orch = new SwarmOrchestrator(provider, allTools, { maxWorkers })

    orch.on('event', (evt: SwarmEvent) => {
      switch (evt.type) {
        case 'task:start':
          console.log(`  ${chalk.bgCyan.black(` W${evt.workerIndex + 1} `)} ${chalk.cyan('▸')} ${chalk.bold(evt.task.title)}`)
          break
        case 'task:done':
          console.log(`  ${chalk.bgGreen.black(' DONE ')} ${chalk.green('✓')} ${chalk.bold(evt.task.title)}`)
          if (evt.result) {
            const preview = evt.result.slice(0, 100).replace(/\n/g, ' ')
            console.log(`         ${chalk.gray(preview + (evt.result.length > 100 ? '…' : ''))}`)
          }
          break
        case 'task:failed':
          console.log(`  ${chalk.bgRed.black(' FAIL ')} ${chalk.red('✗')} ${chalk.bold(evt.task.title)}`)
          console.log(`         ${chalk.red(evt.error.slice(0, 100))}`)
          break
        case 'task:skipped':
          console.log(`  ${chalk.bgYellow.black(' SKIP ')} ${chalk.yellow('⚠')} ${chalk.bold(evt.task.title)}`)
          break
        case 'worker:tool':
          console.log(`         ${chalk.gray('⚙ ' + evt.toolName)}`)
          break
      }
    })

    const result = await orch.run(plan)

    console.log()
    console.log(renderDivider('complete'))
    const sec = (result.duration / 1000).toFixed(1)
    console.log(`  ${chalk.green('✓')} ${result.succeeded} done  ${chalk.red('✗')} ${result.failed} failed  ${chalk.yellow('⚠')} ${result.skipped} skipped  ${chalk.gray(sec + 's')}`)
    console.log()
    console.log(chalk.bold('  Summary:'))
    console.log(renderMarkdown(result.summary))
    console.log(renderDivider())
    console.log()
  })

program.parse()
