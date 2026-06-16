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
import { saveSession, loadSession, listSessions, deleteSession, renameSession, formatRelativeTime } from '../session/manager.js'
import { Spinner, StatusBar, renderMarkdown, renderToolCall, renderToolResult, renderDivider } from './tui.js'
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

function buildEcoConfig(mode: string, apiKey?: string, model?: string, systemPrompt?: string): EcoConfig {
  if (mode === 'mock') {
    return { provider: { type: 'mock' as never, model: 'mock' }, maxIterations: 10, verbose: false }
  }
  const defaultModel = mode === 'openrouter'
    ? 'meta-llama/llama-3.3-70b-instruct:free'
    : 'llama-3.3-70b-versatile'
  return {
    provider: {
      type: mode as EcoConfig['provider']['type'],
      model: model ?? defaultModel,
      apiKey
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
      : chalk.cyan(`Groq / ${modelName}`)

  console.log(chalk.gray(`  Mode     : ${modeLabel}`))
  console.log(chalk.gray(`  Tools    : ${chalk.white(tools.map(t => t.name).join(', '))}`))
  console.log(chalk.gray(`  Commands : ${chalk.white('/help  /plan  /act  /swarm  /save  /sessions  /config  /exit')}`))
  console.log()

  const provider = createProvider(config.provider)
  const agent = new AgentLoop(provider, tools, config)

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
    statusBar.update({ sessionId: currentSessionId, msgCount: history.length })
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

  const prompt = () => {
    statusBar.print()
    const modePrompt = agentMode === 'plan'
      ? chalk.yellow('eco [plan] › ')
      : chalk.green('eco › ')
    rl.question(modePrompt, async (input) => {
      const trimmed = input.trim()
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
              buildEcoConfig(newSaved.mode, newSaved.apiKey, newSaved.model),
              newSaved.mode,
              newSaved.model ?? 'llama-3.3-70b-versatile',
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
            break

          case '/act':
            agentMode = 'act'
            console.log(chalk.green('\n  ⚡ Act mode ON — agent will execute directly.'))
            console.log(chalk.gray('  Use /plan to switch to plan mode.\n'))
            break

          case '/help':
            console.log()
            console.log(renderDivider('help'))
            console.log(`  ${chalk.cyan('/config')}          Switch mode or API key`)
            console.log(`  ${chalk.cyan('/clear')}           Clear conversation context`)
            console.log(`  ${chalk.cyan('/history')}         Show message history`)
            console.log(`  ${chalk.cyan('/tools')}           List available tools`)
            console.log(`  ${chalk.cyan('/plan')}            Switch to plan mode (preview before execute)`)
            console.log(`  ${chalk.cyan('/act')}             Switch to act mode (execute directly)`)
            console.log(`  ${chalk.cyan('/swarm <goal>')}   Run multi-agent swarm`)
            console.log(`  ${chalk.cyan('/save [title]')}    Save current session`)
            console.log(`  ${chalk.cyan('/sessions')}        List saved sessions`)
            console.log(`  ${chalk.cyan('/exit')}            Exit Eco Agent`)
            console.log(renderDivider())
            console.log()
            break

          default:
            console.log(chalk.red(`\n  Unknown command: ${cmd}. Type /help for help.\n`))
        }
        return prompt()
      }

      // ── Run agent ──────────────────────────────────────────────────────────
      console.log()

      // In plan mode, prepend instruction to think before acting
      const finalInput = agentMode === 'plan'
        ? `Before doing anything, write a numbered step-by-step plan of what you will do to accomplish this task. Then ask me: "Shall I proceed? (yes/no)". Wait for my response before using any tools.\n\nTask: ${trimmed}`
        : trimmed

      const spinner = new Spinner('Thinking...')
      spinner.start()

      let responseBuffer = ''
      let firstContent = true

      await agent.run(finalInput, {
        onThinking: () => spinner.update('Thinking...'),

        onContent: (chunk) => {
          if (firstContent) {
            spinner.stop()
            console.log(renderDivider('response'))
            firstContent = false
          }
          responseBuffer += chunk
          process.stdout.write(chalk.white(chunk))
        },

        onToolCall: (toolName, args) => {
          spinner.stop()
          console.log(renderToolCall(toolName, args))
          spinner.update(`Running ${toolName}...`)
          spinner.start()
          firstContent = true
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
            // Re-render the full response as markdown
            process.stdout.write('\r' + ' '.repeat(process.stdout.columns || 80) + '\r')
            const rendered = renderMarkdown(responseBuffer)
            console.log(rendered)
            console.log(renderDivider())
          }
          console.log()
          responseBuffer = ''
          autoSave()
        }
      })

      prompt()
    })
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

    const config = buildEcoConfig(saved.mode, saved.apiKey, saved.model, systemPrompt)
    const modelName = saved.model ?? 'llama-3.3-70b-versatile'
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
    const config = buildEcoConfig(saved.mode, saved.apiKey, saved.model)
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
