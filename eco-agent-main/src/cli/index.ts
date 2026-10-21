#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { createProvider } from '../providers/index.js'
import { AgentLoop } from '../loop/index.js'
import { defaultTools } from '../tools/index.js'
import { PermissionManager, getToolDangerLevel, evaluatePermission, loadSavedRules } from '../permissions/index.js'
import { ensureLineStart } from '../utils/console.js'
import type { EcoConfig, Tool } from '../utils/types.js'
import { getSavedConfig, saveConfig, clearConfig, getPonytailMode, savePonytailMode } from '../utils/configStore.js'
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
import { parsePonytailMode, buildReviewPrompt, buildAuditPrompt, PONYTAIL_TOKEN_COST, PONYTAIL_DEBT_REGEX } from '../rulesets/ponytail.js'
import type { PonytailMode } from '../rulesets/ponytail.js'
import { captureSnapshot, snapshotRestore, snapshotDiff, listSnapshots, snapshotChangedFiles } from '../snapshot/index.js'
import { loadAllSkills, buildSkillsSystemPrompt } from '../skills/index.js'
import { getAvailableProviders } from '../tools/websearch.js'

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

// ─── Autocomplete ─────────────────────────────────────────────────────────────

const REPL_COMMANDS = [
  '/help', '/config', '/cd', '/file', '/commit', '/pr', '/debug', '/plan', '/act',
  '/ponytail', '/ponytail-review', '/ponytail-audit', '/ponytail-debt', '/ponytail-gain',
  '/save', '/sessions', '/clear', '/history', '/tools', '/snapshot', '/skills',
  '/providers', '/swarm', '/exit', '/quit',
]

const REPL_SUBCOMMANDS: Record<string, string[]> = {
  '/ponytail': ['off', 'lite', 'full', 'ultra'],
  '/snapshot': ['list', 'diff', 'restore'],
  '/debug': [], // placeholder — no static subcommands
}

/**
 * TAB-completion for the interactive REPL.
 *
 * Three levels:
 *   1. Slash commands       — `/he<TAB>` → `/help`
 *   2. Command sub-args     — `/ponytail fu<TAB>` → `/ponytail full`
 *   3. Filesystem paths     — `/cd <TAB>`, `/file <TAB>` list real files/dirs
 *
 * Used by readline via the `completer` option; double-TAB prints candidates.
 * NOTE: must return FULL candidate strings (readline computes the common
 * prefix and replaces the last partial word itself).
 */
function createReplCompleter(): (line: string) => [string[], string] {
  return (line: string) => {
    // ── Path completion for /cd and /file ──
    const pathMatch = line.match(/^(\/cd|\/file)\s+(.*)$/)
    if (pathMatch) {
      const partial = pathMatch[2]
      // Split off any directory part we already typed
      const idx = partial.lastIndexOf('/')
      const baseDir = idx >= 0 ? partial.slice(0, idx + 1) : ''
      const fragment = idx >= 0 ? partial.slice(idx + 1) : partial
      let candidates: Array<{ name: string; isDir: boolean }> = []
      try {
        const target = baseDir ? path.resolve(process.cwd(), baseDir) : process.cwd()
        candidates = fs.readdirSync(target).map(name => {
          let isDir = false
          try { isDir = fs.statSync(path.join(target, name)).isDirectory() } catch { /* skip */ }
          return { name, isDir }
        })
      } catch { /* dir unreadable — no candidates */ }

      const hits = candidates
        .filter(c => c.name.startsWith(fragment))
        .map(c => (baseDir + c.name + (c.isDir ? '/' : '')))
        .slice(0, 50)
      return [hits.length ? hits.map(h => pathMatch[1] + ' ' + h) : [], line]
    }

    // ── Sub-argument completion (/ponytail <mode>, /snapshot <op>) ──
    if (line.includes(' ')) {
      const firstSpace = line.indexOf(' ')
      const cmd = line.slice(0, firstSpace)
      const partial = line.slice(firstSpace + 1)
      const subs = REPL_SUBCOMMANDS[cmd]
      if (subs && !partial.includes(' ')) {
        const hits = subs.filter(s => s.startsWith(partial))
        return [hits.length ? hits.map(h => cmd + ' ' + h) : [], line]
      }
      return [[], line]
    }

    // ── Slash command completion ──
    if (line.startsWith('/')) {
      const hits = REPL_COMMANDS.filter(c => c.startsWith(line))
      return [hits, line]
    }
    return [[], line]
  }
}

function buildEcoConfig(mode: string, apiKey?: string, model?: string, systemPrompt?: string, baseUrl?: string, ponytailMode?: PonytailMode): EcoConfig {
  if (mode === 'mock') {
    return { provider: { type: 'mock' as never, model: 'mock' }, maxIterations: 10, verbose: false, ponytailMode: ponytailMode ?? 'full' }
  }

  // Sensible default models per provider
  const defaultModelMap: Record<string, string> = {
    openrouter:         'meta-llama/llama-3.3-70b-instruct:free',
    ollama:             'llama3.2',
    groq:               'llama-3.3-70b-versatile',
    openai:             'gpt-4o',
    deepseek:           'deepseek-chat',
    anthropic:          'claude-sonnet-4-5',
    gemini:             'gemini-3.8-flash',
    aistudio:           'gemini-3.8-flash',
    'openai-compatible': model ?? 'default',
  }
  const defaultModel = defaultModelMap[mode] ?? 'llama-3.3-70b-versatile'

  return {
    provider: {
      type: mode as EcoConfig['provider']['type'],
      model: model ?? defaultModel,
      apiKey,
      baseUrl
    },
    maxIterations: 10,
    verbose: false,
    systemPrompt,
    ponytailMode: ponytailMode ?? 'full'
  }
}

/**
 * Does this provider mode require an API key?
 * - ollama and mock work fully offline
 * - openai-compatible usually points at a local gateway (LM Studio, vLLM,
 *   LocalAI) and works without a key
 */
function providerNeedsKey(mode: string): boolean {
  return !['ollama', 'mock', 'openai-compatible'].includes(mode)
}

/**
 * createProvider with friendly error handling.
 * Providers throw descriptive errors (e.g. "GEMINI_API_KEY not set") when a
 * key is missing — previously this surfaced as a raw stack trace. Now we show
 * actionable guidance and exit cleanly.
 */
function createProviderSafe(providerConfig: EcoConfig['provider']) {
  try {
    return createProvider(providerConfig)
  } catch (e) {
    console.error(chalk.red(`\n  ✗ ${(e as Error).message}`))
    console.error(chalk.gray('  Fix: run `eco` and complete the setup wizard, or /config inside the REPL.'))
    console.error(chalk.gray('  Or:  eco --reset   to start fresh\n'))
    process.exit(1)
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

  const providerLabelMap: Record<string, string> = {
    mock:               chalk.yellow('Mock (testing)'),
    openrouter:         chalk.magenta(`OpenRouter / ${modelName.split('/').pop()}`),
    ollama:             chalk.blue(`Ollama / ${modelName}`),
    groq:               chalk.cyan(`Groq / ${modelName}`),
    openai:             chalk.white(`OpenAI / ${modelName}`),
    deepseek:           chalk.green(`DeepSeek / ${modelName}`),
    anthropic:          chalk.red(`Anthropic / ${modelName}`),
    gemini:             chalk.blue(`Google Gemini / ${modelName}`),
    aistudio:           chalk.hex('#4285F4')(`AI Studio / ${modelName}`),
    'openai-compatible': chalk.cyan(`OpenAI-Compat / ${modelName}`),
  }
  const modeLabel = providerLabelMap[modeName] ?? chalk.gray(`${modeName} / ${modelName}`)

  console.log(chalk.gray(`  Mode     : ${modeLabel}`))
  console.log(chalk.gray(`  Tools    : ${chalk.white(tools.length + ' tools loaded')}`))
  console.log(chalk.gray(`  Commands : ${chalk.white('/help /plan /act /swarm /save /sessions /config /exit')}`))
  console.log(chalk.gray(`             ${chalk.white('/tools /clear /history /cd /file /commit /pr /debug /ponytail')}`))
  console.log(chalk.gray(`             ${chalk.white('/snapshot /skills /providers')}  ${chalk.dim('(ported from opencode)')}`))
  console.log(chalk.gray(`  ${chalk.dim('Tip: press TAB to autocomplete commands')} ${chalk.dim('—')}`))
  console.log(chalk.gray(`  ${chalk.dim('      /he<TAB> → /help  ·  /ponytail <TAB> → off|lite|full|ultra  ·  /cd <TAB> lists files')}`))
  console.log()

  // Show active skills
  const activeSkills = loadAllSkills()
  if (activeSkills.length > 0) {
    console.log(chalk.gray(`  Skills   : ${chalk.cyan(activeSkills.map(s => s.name).join(', '))}`))
  }

  // Show search providers
  const availableProviders = getAvailableProviders()
  if (availableProviders.length > 1 || availableProviders[0] !== 'duckduckgo') {
    console.log(chalk.gray(`  Search   : ${chalk.cyan(availableProviders[0])} ${chalk.dim('(+ ' + availableProviders.slice(1).join(', ') + ' fallback)')}`))
  }

  // Load cross-session memory (last 3 sessions)
  const sessionMemory = buildSessionMemory(resumeSessionId, 3)
  if (sessionMemory) {
    console.log(chalk.gray(`  Memory   : ${chalk.cyan('3 previous sessions loaded')}`))
  }

  const provider = createProviderSafe(config.provider)
  const agent = new AgentLoop(provider, tools, config, sessionMemory)

  // Plan/Act mode — 'plan' shows thinking only, 'act' executes
  let agentMode: 'plan' | 'act' = 'act'

  // Permission system (previously dead code — now wired into the tool gate).
  // Handles: danger levels, persistent rules in ~/.eco-agent/permissions.json,
  // and per-session "allow for this run" choices.
  const permissions = new PermissionManager(resumeSessionId ?? 'repl')

  // Resume session if provided
  let currentSessionId: string | undefined = resumeSessionId
  if (resumeSessionId) {
    const session = loadSession(resumeSessionId)
    if (session) {
      // Use public loadHistory() API — avoids private field access
      agent.loadHistory(session.messages)
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: createReplCompleter(),
  })

  // Smart input reader with a line queue.
  //
  // BUG FIX: the previous implementation had ONE shared 400ms timer that was
  // reset on every arriving line, so ANY consecutive lines eventually merged
  // into a single input (lines typed 1-2s apart still merged if the process
  // was busy). Now:
  //   - lines that arrive < 80ms apart (true paste) merge into ONE input
  //   - lines that arrive with a human-scale gap finish the pending input and
  //     are queued for the next prompt (nothing is lost or merged)
  //   - a single line still waits 400ms in case a paste follows it
  let inputQueue: string[] = []
  let activeResolver: ((value: string) => void) | null = null
  let buffer: string[] = []
  let bufferTimer: ReturnType<typeof setTimeout> | null = null
  let lastLineTime = 0

  const finishCurrent = () => {
    if (!activeResolver) return
    const resolve = activeResolver
    activeResolver = null
    if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null }
    // Remove trailing empty lines from paste
    while (buffer.length > 0 && buffer[buffer.length - 1].trim() === '') buffer.pop()
    const value = buffer.join('\n')
    buffer = []
    resolve(value)
  }

  rl.on('line', (line: string) => {
    const now = Date.now()
    const gap = now - lastLineTime
    lastLineTime = now
    if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null }

    if (activeResolver) {
      if (buffer.length > 0 && gap > 80) {
        // Human-paced next line: the growing buffer is a complete input
        finishCurrent()
        inputQueue.push(line)
        return
      }
      // Same block (first line or rapid paste continuation)
      buffer.push(line)
      bufferTimer = setTimeout(finishCurrent, buffer.length > 1 ? 150 : 400)
    } else {
      // No prompt pending — queue the line for the next prompt
      inputQueue.push(line)
    }
  })

  const drainQueue = (): string | undefined => {
    const pending = inputQueue.splice(0)
    while (pending.length > 0 && pending[pending.length - 1].trim() === '') pending.pop()
    return pending.length > 0 ? pending.join('\n') : undefined
  }

  const readInput = (promptStr: string): Promise<string> => {
    return new Promise((resolve) => {
      process.stdout.write(promptStr)
      const queued = drainQueue()
      if (queued !== undefined) { resolve(queued); return }
      // New collection begins
      activeResolver = resolve
      buffer = []
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

    // Natural language Ponytail deactivation: detect full message "stop ponytail"
    if (trimmed.toLowerCase() === 'stop ponytail') {
      agent.setPonytailMode('off')
      savePonytailMode('off')
      console.log(chalk.gray('\n  Ponytail ruleset deactivated.\n'))
      return prompt()
    }

    if (trimmed.startsWith('/')) {
      // Split on any whitespace (incl. newlines) so a multi-line paste whose
      // first line is a command still routes correctly: "/ponytail\nfull"
      const [cmd, ...rest] = trimmed.split(/\s+/)
      switch (cmd) {

        case '/exit':
        case '/quit':
          autoSave()
          console.log(chalk.gray('\n  Goodbye! \n'))
          rl.close()
          process.exit(0)
          break

        case '/config':
          rl.close()
          console.log()
          {
            const newSaved = await runSetupWizard(true)
            saveConfig(newSaved)
            const reloadedPlugins = await loadAllPlugins()
            const currentPonytail = agent.getPonytailMode()
            await runREPL(
              buildEcoConfig(newSaved.mode, newSaved.apiKey, newSaved.model, undefined, newSaved.baseUrl, currentPonytail),
              newSaved.mode,
              newSaved.model ?? (newSaved.mode === 'ollama' ? 'llama3.2' : 'llama-3.3-70b-versatile'),
              [...defaultTools, ...reloadedPlugins],
              undefined,
              reloadedPlugins.length
            )
          }
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
            console.log(chalk.yellow('\n  ! /cd - (go back) is not supported. Use the full path.\n'))
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
            console.log(`  ${chalk.cyan('>')}  ${chalk.bold(t.name.padEnd(22))} ${chalk.gray(t.description)}`)
          })
          console.log(renderDivider())
          console.log()
          break

        // ── Commands ported from opencode ────────────────────────────────────

        case '/snapshot': {
          const subCmd = rest[0]?.toLowerCase()
          if (!subCmd || subCmd === 'list') {
            const snaps = listSnapshots()
            console.log()
            console.log(renderDivider('snapshots'))
            if (snaps.length === 0) {
              console.log(chalk.gray('  No snapshots yet. Snapshots are captured automatically before agent runs.'))
            } else {
              snaps.slice(0, 10).forEach((s, i) => {
                const date = new Date(s.timestamp).toLocaleString()
                console.log(`  ${chalk.cyan(String(i + 1).padStart(2))}  ${chalk.bold(s.id)}  ${chalk.gray(date)}  ${chalk.dim(s.files.length + ' files')}`)
                if (s.description) console.log(`      ${chalk.gray(s.description)}`)
              })
            }
            console.log()
            console.log(chalk.gray('  Usage: /snapshot diff <from-id> <to-id>   — show diff between two snapshots'))
            console.log(chalk.gray('         /snapshot restore <id>             — restore files from a snapshot'))
            console.log(renderDivider())
            console.log()
          } else if (subCmd === 'diff' && rest[1] && rest[2]) {
            const [, fromId, toId] = rest
            const diffs = snapshotDiff(fromId, toId)
            if (diffs.length === 0) {
              console.log(chalk.gray('\n  No differences found between snapshots.\n'))
            } else {
              console.log()
              console.log(renderDivider(`diff: ${fromId.slice(0, 8)} → ${toId.slice(0, 8)}`))
              for (const d of diffs) {
                console.log(`\n  ${chalk.bold(d.file)}  ${chalk.green('+' + d.added)}  ${chalk.red('-' + d.removed)}`)
                // Render patch lines with color
                d.patch.split('\n').forEach(line => {
                  if (line.startsWith('+++') || line.startsWith('---')) console.log(chalk.dim('  ' + line))
                  else if (line.startsWith('+')) console.log(chalk.green('  ' + line))
                  else if (line.startsWith('-')) console.log(chalk.red('  ' + line))
                  else if (line.startsWith('@@')) console.log(chalk.cyan('  ' + line))
                  else console.log(chalk.gray('  ' + line))
                })
              }
              console.log(renderDivider())
              console.log()
            }
          } else if (subCmd === 'restore' && rest[1]) {
            const snapshotId = rest[1]
            const result = snapshotRestore(snapshotId, process.cwd())
            console.log(result.startsWith('Error') ? chalk.red(`\n  ✗ ${result}\n`) : chalk.green(`\n  ✓ ${result}\n`))
          } else {
            console.log(chalk.yellow('\n  Usage: /snapshot [list|diff <from> <to>|restore <id>]\n'))
          }
          break
        }

        case '/skills': {
          const skills = loadAllSkills()
          console.log()
          console.log(renderDivider('active skills'))
          if (skills.length === 0) {
            console.log(chalk.gray('  No skills found.'))
            console.log(chalk.gray('  Place SKILL.md files in ~/.eco-agent/skills/<name>/ or .eco-agent/skills/<name>/'))
          } else {
            skills.forEach(s => {
              const sourceLabel = s.source === 'global' ? chalk.yellow('global') : s.source === 'project' ? chalk.cyan('project') : chalk.gray('local')
              console.log(`  ${chalk.bold(s.name.padEnd(24))} ${sourceLabel}`)
              const firstLine = s.content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
              if (firstLine) console.log(`  ${chalk.gray('  ' + firstLine.trim().slice(0, 80))}`)
            })
          }
          console.log(renderDivider())
          console.log()
          break
        }

        case '/providers': {
          const providers = getAvailableProviders()
          console.log()
          console.log(renderDivider('web search providers'))
          const providerInfo: Record<string, string> = {
            tavily: 'TAVILY_API_KEY set   — best quality, real-time results',
            brave: 'BRAVE_API_KEY set    — fast, privacy-focused',
            searxng: 'SEARXNG_URL set      — self-hosted, fully private',
            duckduckgo: 'no API key needed    — free, always available'
          }
          providers.forEach((p, i) => {
            const active = i === 0 ? chalk.green(' ← active') : ''
            console.log(`  ${chalk.cyan(p.padEnd(12))} ${chalk.gray(providerInfo[p] ?? '')}${active}`)
          })
          console.log()
          console.log(chalk.gray('  Set TAVILY_API_KEY, BRAVE_API_KEY, or SEARXNG_URL env var to enable premium search.'))
          console.log(renderDivider())
          console.log()
          break
        }

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
              // Use public loadHistory() API — avoids private field access
              agent.loadHistory(loaded.messages)
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
          } catch {
            console.log(chalk.red('\n  ✗ Error reading git diff. Are you in a git repository?\n'))
            break
          }

          console.log(chalk.cyan('\n  ⟳ Generating commit message...\n'))
          // Run WITHOUT tools — commit message generation needs no file/shell access
          // This saves ~800-1200 tokens (tool definitions not sent to LLM)
          const commitPrompt = `Based on the following git diff, generate a concise, descriptive commit message following Conventional Commits format. Output ONLY the commit message without quotes or extra text.\n\nDiff:\n${diff}`
          const commitSpinner = new Spinner('Generating...')
          commitSpinner.start()
          const commitMsg = await agent.run(commitPrompt, {
            onContent: (chunk) => process.stdout.write(chunk),
            onDone: () => commitSpinner.stop(),
            onError: (err) => { commitSpinner.stop(); console.log(chalk.red(`\n  ✗ ${err.message}`)) }
          }, []) // empty tools array = no tool definitions sent
          if (commitMsg && !commitMsg.startsWith('Error:')) {
            console.log('\n')
            const copy = await new Promise<string>(r => rl.question(chalk.green('  Copy to clipboard? [y/N] '), r))
            if (copy.trim().toLowerCase() === 'y') {
              try {
                // Cross-platform clipboard support
                const platform = process.platform
                const cmd = platform === 'darwin'
                  ? `echo ${JSON.stringify(commitMsg.trim())} | pbcopy`
                  : platform === 'linux'
                    ? `echo ${JSON.stringify(commitMsg.trim())} | xclip -selection clipboard 2>/dev/null || echo ${JSON.stringify(commitMsg.trim())} | xsel --clipboard --input 2>/dev/null`
                    : `echo ${JSON.stringify(commitMsg.trim())} | clip` // Windows
                child_process.execSync(cmd, { stdio: 'pipe' })
                console.log(chalk.green('  ✓ Copied to clipboard.\n'))
              } catch { console.log(chalk.gray('  (clipboard not available)\n')) }
            }
          }
          return prompt()
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
          } catch {
            try {
              log = child_process.execSync('git log -n 5 --oneline', { encoding: 'utf-8' })
            } catch {
              console.log(chalk.red('\n  ✗ Error reading git log.\n'))
              break
            }
          }

          console.log(chalk.cyan('\n  ⟳ Generating Pull Request description...\n'))
          // Run WITHOUT tools — PR description generation needs no file/shell access
          // This saves ~800-1200 tokens (tool definitions not sent to LLM)
          const prPrompt = `Based on the following git commits, generate a detailed Pull Request description in Markdown. Include a title, summary, and bullet points of changes.\n\nCommits:\n${log}`
          const prSpinner = new Spinner('Generating...')
          prSpinner.start()
          await agent.run(prPrompt, {
            onContent: (chunk) => { prSpinner.stop(); process.stdout.write(chalk.white(chunk)) },
            onDone: () => { prSpinner.stop(); console.log('\n') },
            onError: (err) => { prSpinner.stop(); console.log(chalk.red(`\n  ✗ ${err.message}`)) }
          }, []) // empty tools array = no tool definitions sent
          return prompt()
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

          // Pass config so workers inherit ponytailMode + maxIterations
          const swarmOrch = new SwarmOrchestrator(swarmProvider, tools, { maxWorkers: 3 }, config)

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
                console.log(`  ${chalk.bgYellow.black(' SKIP ')} ${chalk.yellow('!')} ${chalk.bold(evt.task.title)} ${chalk.gray('(dependency failed)')}`)
                break
              case 'worker:tool':
                console.log(`         ${chalk.gray('> ' + evt.toolName)}`)
                break
            }
          })

          const swarmResult = await swarmOrch.run(plan)

          console.log()
          console.log(renderDivider('swarm complete'))
          const durationSec = (swarmResult.duration / 1000).toFixed(1)
          console.log(`  ${chalk.green('✓')} ${swarmResult.succeeded} done  ${chalk.red('✗')} ${swarmResult.failed} failed  ${chalk.yellow('!')} ${swarmResult.skipped} skipped  ${chalk.gray(durationSec + 's')}`)
          console.log()
          console.log(chalk.bold('  Summary:'))
          console.log(renderMarkdown(swarmResult.summary))
          console.log(renderDivider())
          console.log()
          break
        }

        case '/plan': {
          agentMode = 'plan'
          console.log(chalk.yellow('\n  Plan mode ON — agent will explain its plan before executing.'))
          console.log(chalk.gray('  Use /act to switch back to execute mode.\n'))
          const planTask = rest.join(' ').trim()
          if (!planTask) {
            return prompt()
          }
          trimmed = planTask
          break // Fall through to execution
        }

        case '/act': {
          agentMode = 'act'
          console.log(chalk.green('\n  Act mode ON — agent will execute directly.'))
          console.log(chalk.gray('  Use /plan to switch to plan mode.\n'))
          const actTask = rest.join(' ').trim()
          if (!actTask) {
            return prompt()
          }
          trimmed = actTask
          break // Fall through to execution
        }

        case '/ponytail': {
          const modeArg = rest.join(' ').trim().toLowerCase()
          if (!modeArg) {
            // Show current mode
            const currentMode = agent.getPonytailMode()
            console.log()
            console.log(renderDivider('ponytail'))
            console.log(`  ${chalk.bold('Active mode:')} ${chalk.cyan(currentMode)} ${chalk.gray('(' + PONYTAIL_TOKEN_COST[currentMode] + ')')}`)
            console.log()
            console.log(`  ${chalk.gray('off')}    — ruleset disabled (+0 tokens)`)
            console.log(`  ${currentMode === 'lite' ? chalk.cyan('lite') : chalk.gray('lite')}   — minimalist YAGNI check (~35 tokens/request)${currentMode === 'lite' ? chalk.green(' ← active') : ''}`)
            console.log(`  ${currentMode === 'full' ? chalk.cyan('full') : chalk.gray('full')}   — 7-step ladder (~110 tokens/request)${currentMode === 'full' ? chalk.green(' ← active') : ''}`)
            console.log(`  ${currentMode === 'ultra' ? chalk.cyan('ultra') : chalk.gray('ultra')}  — ladder + active dead-code hunt (~140 tokens/request)${currentMode === 'ultra' ? chalk.green(' ← active') : ''}`)
            console.log()
            console.log(chalk.gray('  Usage: /ponytail <mode>   or type: stop ponytail'))
            console.log(renderDivider())
            console.log()
          } else {
            const newMode = parsePonytailMode(modeArg)
            agent.setPonytailMode(newMode)
            savePonytailMode(newMode)
            if (newMode === 'off') {
              console.log(chalk.gray(`\n  Ponytail disabled. No ruleset injected.\n`))
            } else {
              console.log(chalk.green(`\n  ✓ Ponytail mode set to: ${chalk.bold(newMode)} ${chalk.gray('(' + PONYTAIL_TOKEN_COST[newMode] + ')')}\n`))
            }
          }
          break
        }

        case '/ponytail-review': {
          let diffContent = ''
          try {
            const { execSync: execSyncLocal } = await import('child_process')
            diffContent = execSyncLocal('git diff', { encoding: 'utf-8' })
            if (!diffContent) diffContent = execSyncLocal('git diff --cached', { encoding: 'utf-8' })
            if (!diffContent) {
              console.log(chalk.yellow('\n  No changes in git diff to review.\n'))
              break
            }
          } catch {
            console.log(chalk.red('\n  ✗ Not a git repo or git not available.\n'))
            break
          }
          console.log(chalk.cyan('\n  ⟳ Reviewing diff for over-engineering...\n'))
          agentMode = 'act'
          trimmed = buildReviewPrompt(diffContent)
          break // fall through to agent.run
        }

        case '/ponytail-audit': {
          console.log(chalk.cyan('\n  ⟳ Starting full codebase audit for over-engineering...\n'))
          agentMode = 'act'
          trimmed = buildAuditPrompt()
          break // fall through to agent.run
        }

        case '/ponytail-debt': {
          // Pure local grep — zero LLM cost
          console.log()
          console.log(renderDivider('ponytail debt ledger'))
          const fsDebt = await import('fs')
          const pathDebt = await import('path')
          const rootDir = process.cwd()
          const IGNORE_DEBT = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])
          const debtItems: Array<{ file: string; line: number; text: string; hasTrigger: boolean }> = []

          function scanForDebt(dir: string): void {
            let entries: string[]
            try { entries = fsDebt.readdirSync(dir) } catch { return }
            for (const entry of entries) {
              if (IGNORE_DEBT.has(entry)) continue
              const full = pathDebt.join(dir, entry)
              let stat: ReturnType<typeof fsDebt.statSync>
              try { stat = fsDebt.statSync(full) } catch { continue }
              if (stat.isDirectory()) { scanForDebt(full); continue }
              const ext = pathDebt.extname(entry)
              if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)) continue
              let content = ''
              try { content = fsDebt.readFileSync(full, 'utf-8') } catch { continue }
              content.split('\n').forEach((lineText, idx) => {
                PONYTAIL_DEBT_REGEX.lastIndex = 0
                const match = PONYTAIL_DEBT_REGEX.exec(lineText)
                if (match) {
                  const markerText = match[1].trim()
                  debtItems.push({
                    file: pathDebt.relative(rootDir, full),
                    line: idx + 1,
                    text: markerText,
                    hasTrigger: markerText.includes(',')
                  })
                }
              })
            }
          }

          scanForDebt(rootDir)

          if (debtItems.length === 0) {
            console.log(chalk.gray('  No ponytail debt markers found.'))
          } else {
            debtItems.forEach(item => {
              const rel = chalk.cyan(`./${item.file}:${item.line}`)
              const tag = item.hasTrigger ? '' : chalk.red(' [no-trigger]')
              console.log(`  ${rel}:  ${chalk.gray('// ponytail: ')}${chalk.white(item.text)}${tag}`)
            })
            console.log()
            const noTrigger = debtItems.filter(i => !i.hasTrigger).length
            console.log(chalk.gray(`  ${debtItems.length} marker${debtItems.length !== 1 ? 's' : ''}, ${noTrigger} with no trigger.`))
          }
          console.log(renderDivider())
          console.log()
          break
        }

        case '/ponytail-gain': {
          // Status jujur: tampilkan scoreboard, atau pesan "belum diukur" bila tidak ada data
          console.log()
          console.log(renderDivider('ponytail gain'))
          const gainPath = await import('path')
          const fsGain = await import('fs')
          const gainFile = gainPath.join(process.cwd(), '.eco', 'ponytail-gain.json')
          if (fsGain.existsSync(gainFile)) {
            try {
              const raw = JSON.parse(fsGain.readFileSync(gainFile, 'utf-8'))
              console.log(chalk.bold('  Benchmark results (ponytail-gain.json):'))
              console.log()
              if (raw.runs && Array.isArray(raw.runs)) {
                raw.runs.forEach((r: { label?: string; withPonytail?: Record<string, number>; withoutPonytail?: Record<string, number> }, i: number) => {
                  console.log(`  ${chalk.cyan(String(i + 1) + '.')} ${chalk.bold(r.label ?? 'Run ' + (i + 1))}`)
                  if (r.withPonytail) console.log(`     ${chalk.green('with ponytail')}    : ${JSON.stringify(r.withPonytail)}`)
                  if (r.withoutPonytail) console.log(`     ${chalk.red('without ponytail')}: ${JSON.stringify(r.withoutPonytail)}`)
                  console.log()
                })
              } else {
                console.log(chalk.gray('  ' + JSON.stringify(raw, null, 2).replace(/\n/g, '\n  ')))
              }
            } catch {
              console.log(chalk.red('  ✗ Could not parse .eco/ponytail-gain.json'))
            }
          } else {
            console.log(chalk.yellow('  ! Status: not benchmarked yet'))
            console.log(chalk.gray('  No benchmark data found.'))
            console.log()
            console.log(chalk.gray('  To record gains, create .eco/ponytail-gain.json with structure:'))
            console.log(chalk.gray('  {'))
            console.log(chalk.gray('    "runs": ['))
            console.log(chalk.gray('      {'))
            console.log(chalk.gray('        "label": "feature-X on repo-Y",'))
            console.log(chalk.gray('        "withPonytail":    { "loc": 120, "tokens": 800, "cost": 0.02, "timeSec": 45 },'))
            console.log(chalk.gray('        "withoutPonytail": { "loc": 220, "tokens": 1500, "cost": 0.04, "timeSec": 70 }'))
            console.log(chalk.gray('      }'))
            console.log(chalk.gray('    ]'))
            console.log(chalk.gray('  }'))
          }
          console.log(renderDivider())
          console.log()
          break
        }

        case '/help':
          console.log()
          console.log(renderDivider('help'))
          console.log(chalk.bold('  ── Input ──────────────────────────────────────'))
          console.log(`  ${chalk.cyan('eco › <message>')}    Type any message (single-line or paste multi-line)`)
          console.log(`  ${chalk.cyan('/file <path>')}      Load a file as context, then add instruction`)
          console.log(`  ${chalk.cyan('<TAB>')}            Autocomplete commands & paths (/he→/help, /cd, /file, /ponytail, /snapshot)`)
          console.log(`  ${chalk.cyan('eco completion')}    Shell autocomplete script (bash|zsh|fish|powershell)`)
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
          console.log(`  ${chalk.cyan('/snapshot')}        View snapshots, diffs, or restore file state`)
          console.log(`  ${chalk.cyan('/skills')}          List active agent skills (loaded from SKILL.md)`)
          console.log(`  ${chalk.cyan('/providers')}       Show web search providers status`)
          console.log(`  ${chalk.cyan('/commit')}          Auto-generate git commit message (staged files)`)
          console.log(`  ${chalk.cyan('/pr')}              Auto-generate Pull Request description`)
          console.log(`  ${chalk.cyan('/debug <cmd>')}     Run command & auto-fix errors in a loop`)
          console.log(`  ${chalk.cyan('/swarm <goal>')}    Launch multi-agent swarm`)
          console.log()
          console.log(chalk.bold('  ── Ponytail (anti-overengineering) ─────────────'))
          console.log(`  ${chalk.cyan('/ponytail')}        Show active Ponytail mode`)
          console.log(`  ${chalk.cyan('/ponytail <mode>')} Set mode: off | lite | full | ultra`)
          console.log(`  ${chalk.cyan('/ponytail-review')} Review git diff for over-engineering`)
          console.log(`  ${chalk.cyan('/ponytail-audit')} Audit full codebase for over-engineering`)
          console.log(`  ${chalk.cyan('/ponytail-debt')}   Show // ponytail: debt markers (no LLM call)`)
          console.log(`  ${chalk.cyan('/ponytail-gain')}   Show benchmark scoreboard (no LLM call)`)
          console.log(`  ${chalk.cyan('stop ponytail')}    Deactivate Ponytail (natural phrase)`)
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

    // In plan mode, prepend instruction to think before acting
    // Note: CWD is already in the system prompt (via project context or startup injection).
    // We do NOT add it per-message to avoid wasting tokens on every turn.
    const finalInput = agentMode === 'plan'
      ? `Before doing anything, write a numbered step-by-step plan of what you will do to accomplish this task. Then ask me: "Shall I proceed? (yes/no)". Wait for my response before using any tools.\n\nTask: ${trimmed}`
      : trimmed

    // ── Auto-snapshot (ported from opencode) ──────────────────────────────
    // Capture file state before agent runs so user can diff/restore later
    const preRunSnapshotId = captureSnapshot(process.cwd(), `Before: ${finalInput.slice(0, 60)}`)

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
    let streamedLive = false
    let firstTokenMs: number | undefined
    const turnStarted = Date.now()

    await agent.run(finalInput, {
      onThinking: () => spinner.update('Waiting for model...'),

      onFirstToken: (ms) => {
        firstTokenMs = ms
        spinner.update(`Generating (first token in ${(ms / 1000).toFixed(1)}s)`)
      },

      onContent: (chunk) => {
        if (firstContent) {
          spinner.stop()
          // Start the response block on its own line (the previous output may
          // not have ended with a newline)
          ensureLineStart()
          process.stdout.write(renderDivider('response') + '\n')
          firstContent = false
          streamedLive = true
        }
        responseBuffer += chunk
        process.stdout.write(chalk.white(chunk))
      },

      onToolCall: (toolName, args) => {
        spinner.stop()
        // Start the tool box on its own line so streamed text above is kept
        ensureLineStart()
        if (toolName !== 'write_file') {
          console.log(renderToolCall(toolName, args))
        }
        spinner.update(`Running ${toolName}...`)
        spinner.start()
        firstContent = true
      },

      onConfirmTool: async (toolName, args) => {
        // ── Real permission gate (replaces the hardcoded 3-tool list) ──
        // SAFE tools (read-only) run without confirmation.
        if (getToolDangerLevel(toolName) === 'safe') return true

        const resource = (typeof args.path === 'string' && args.path)
          ? args.path
          : (typeof args.command === 'string' && args.command)
            ? args.command
            : undefined

        return permissions.check({ action: toolName, resource }, async (req) => {
          // ── Interactive prompt with context display ──
          spinner.stop()
          if (req.action === 'write_file') {
            const content = (args as { content?: string }).content ?? ''
            let oldContent = ''
            try { if (fs.existsSync(String(args.path))) oldContent = fs.readFileSync(String(args.path), 'utf-8') } catch { /* ignore */ }
            console.log(renderDiff(oldContent, content))
          } else if (req.action === 'patch_file') {
            const patch = (args as { patch?: string }).patch ?? ''
            console.log(chalk.gray('  Patch:') + chalk.white(' ' + patch.split('\n').slice(0, 6).join('\n  ')))
          } else if (req.action === 'delete_path') {
            console.log(chalk.red(`  ! WARNING: This will permanently delete: ${req.resource}`))
          } else if (req.action === 'run_shell') {
            console.log(chalk.yellow(`  $ ${req.resource ?? '(no command)'}`))
          } else if (req.action === 'rename_path') {
            console.log(chalk.yellow(`  ~ This will rename/move: ${(args as { oldPath?: string }).oldPath} -> ${(args as { newPath?: string }).newPath}`))
          }

          const ans = await new Promise<string>(resolve =>
            rl.question(chalk.green(`  Proceed? [Y]es once · [n]o · [a]lways allow ${req.action} · [v]never allow `), resolve)
          )
          const a = ans.trim().toLowerCase()
          if (a === 'a') return 'always'     // persistent rule in ~/.eco-agent/permissions.json
          if (a === 'v') return 'never'      // persistent deny
          if (a === 'y' || a === '') return 'allow'  // allowed for this session
          return 'deny'
        })
      },

      onToolResult: (_name, result, error) => {
        spinner.stop()
        // Keep the result on its own line
        ensureLineStart()
        console.log(renderToolResult(_name, result, error))
        spinner.update('Waiting for model...')
        spinner.start()
        firstContent = true
      },

      onError: (err) => {
        spinner.stop()
        const cause = (err as unknown as { cause?: unknown })?.cause
        const causeText = (cause as Error)?.message || (typeof cause === 'string' ? cause : '')
        console.log(chalk.red(`\n  ✗ Error: ${err.message}`))
        if (causeText && !err.message.includes(causeText)) {
          console.log(chalk.red(`    Cause: ${causeText}`))
        }
        if (err.message.includes('fetch failed') || (causeText && (causeText.includes('aborted') || causeText.includes('ECONNRESET')))) {
          console.log(chalk.yellow('  → The connection to the Google API was blocked or dropped by a Firewall, Antivirus, VPN, or Proxy on your machine.'))
        }
        if (err.message.includes('401') || err.message.includes('API')) {
          console.log(chalk.yellow('  → Type /config to update your API key.'))
        }
        firstContent = false
      },

      onDone: () => {
        spinner.stop()
        // The streamed answer has no trailing newline — close the line before
        // printing the closing divider, otherwise the divider would be
        // appended to the answer.
        ensureLineStart()
        if (responseBuffer) {
          if (streamedLive) {
            // The text was already printed live while the model generated it.
            // Re-drawing the whole answer (erase + re-render) is expensive on
            // Windows terminals and makes long answers look frozen.
            process.stdout.write('\n' + renderDivider() + '\n')
          } else {
            // Non-streaming provider: render the answer once, with markdown
            console.log(renderDivider('response'))
            console.log(renderMarkdown(responseBuffer))
            console.log(renderDivider())
          }

          // Timing diagnostics — makes slow providers obvious
          const total = ((Date.now() - turnStarted) / 1000).toFixed(1)
          const ttft = firstTokenMs !== undefined ? `, first token ${(firstTokenMs / 1000).toFixed(1)}s` : ''
          console.log(chalk.dim(`  ↳ done in ${total}s${ttft}`))
        }
        console.log()
        responseBuffer = ''
        autoSave()

        // ── Post-run snapshot (ported from opencode) ────────────────────────
        // Capture state after run and show diff hint if files were changed
        if (preRunSnapshotId) {
          const postRunSnapshotId = captureSnapshot(process.cwd(), `After: ${finalInput.slice(0, 60)}`)
          if (postRunSnapshotId && preRunSnapshotId !== postRunSnapshotId) {
            const changed = snapshotChangedFiles(preRunSnapshotId, postRunSnapshotId)
            if (changed.length > 0) {
              console.log(chalk.dim(`  ${changed.length} file(s) changed. Use ${chalk.white('/snapshot diff ' + preRunSnapshotId + ' ' + postRunSnapshotId)} to review, or ${chalk.white('/snapshot restore ' + preRunSnapshotId)} to undo.`))
              console.log()
            }
          }
        }
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
    const isSubCmd = ['plugin', 'session', 'mcp', 'init', 'swarm', 'completion'].includes(process.argv[2])
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
    } else if (providerNeedsKey(saved.mode) && !saved.apiKey) {
      // The saved provider needs an API key but none is stored (e.g. the key
      // was cleared) — offer the setup wizard instead of failing later with
      // "GEMINI_API_KEY not set".
      printBanner()
      console.log(chalk.yellow(`\n  ! No API key stored for ${saved.mode}. Let's set it up.\n`))
      saved = await runSetupWizard(false)
      saveConfig(saved)
    }

    // Load project context if .eco/ exists
    const cwd = process.cwd()
    const projectCtx = loadProjectContext(cwd)
    const customPrompt = loadCustomPrompt(cwd)
    // Inject CWD once into system prompt — not per-message (saves ~15 tokens/turn)
    const systemPrompt = projectCtx
      ? buildSystemPromptWithContext(projectCtx, customPrompt)
      : `You are Eco Agent, a powerful agentic AI assistant running in the terminal.\nCurrent working directory: ${cwd}\nUse tools to read/write files, run shell commands, search codebases, and more.\nBe concise, efficient, and always confirm before making destructive changes.`

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
      process.on('exit', () => { disconnectAll().catch(() => { }) })
    }

    // Respect model tool support capability
    const supportsTools = saved.supportsTools !== false
    const allTools = supportsTools ? [...defaultTools, ...pluginTools, ...mcpTools] : []

    if (!supportsTools) {
      console.log(chalk.yellow('  ! Text-only mode — this model does not support tools.'))
      console.log(chalk.gray('  Use /config to switch to a tool-capable model.\n'))
    }

    const activePonytailMode = getPonytailMode()
    const config = buildEcoConfig(saved.mode, saved.apiKey, saved.model, systemPrompt, saved.baseUrl, activePonytailMode)
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
      const provider = createProviderSafe(config.provider)
      const agent = new AgentLoop(provider, allTools, config)
      await agent.run(promptText, {
        onContent: (chunk) => process.stdout.write(chunk),
        onToolCall: (name, args) => process.stderr.write(chalk.yellow(`\n  > ${name} ${JSON.stringify(args).slice(0, 60)}\n`)),
        // Non-interactive permission gate: safe tools run; saved deny rules in
        // ~/.eco-agent/permissions.json are honored; everything else is allowed
        // (no TTY available to ask).
        onConfirmTool: async (toolName, args) => {
          if (getToolDangerLevel(toolName) === 'safe') return true
          const resource = (typeof args.path === 'string' && args.path) ? args.path : undefined
          const res = evaluatePermission({ action: toolName, resource }, loadSavedRules())
          return res.effect !== 'deny'
        },
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
  .option('--streamable', 'Use Streamable HTTP transport (remote server, modern)')
  .option('-c, --command <cmd>', 'Command to run (stdio only) e.g. npx')
  .option('-a, --args <args>', 'Comma-separated args e.g. -y,@modelcontextprotocol/server-github')
  .option('-u, --url <url>', 'Server URL (remote servers)')
  .option('-e, --env <pairs>', 'Env vars as KEY=VALUE,KEY2=VALUE2')
  .option('-H, --header <pairs>', 'HTTP headers as KEY=VALUE,KEY2=VALUE2 (remote servers)')
  .option('-d, --description <desc>', 'Optional description')
  .action((opts) => {
    if (!opts.name) {
      console.log(chalk.red('\n  ✗ --name is required\n'))
      process.exit(1)
    }

    const type = opts.streamable ? 'streamable' : opts.sse ? 'sse' : 'stdio'

    if (type === 'stdio' && !opts.command) {
      console.log(chalk.red('\n  ✗ --command is required for stdio servers\n'))
      process.exit(1)
    }
    if (type !== 'stdio' && !opts.url) {
      console.log(chalk.red(`\n  ✗ --url is required for ${type} servers\n`))
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

    // Parse HTTP header pairs (remote servers only)
    const headers: Record<string, string> = {}
    if (opts.header) {
      opts.header.split(',').forEach((pair: string) => {
        const [k, ...v] = pair.split('=')
        if (k) headers[k.trim()] = v.join('=').trim()
      })
    }

    const result = addServer({
      name: opts.name,
      type,
      command: opts.command,
      args: opts.args ? opts.args.split(',') : undefined,
      url: opts.url,
      env: Object.keys(env).length > 0 ? env : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
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
        console.log(`  ${chalk.cyan('>')}  ${chalk.bold(t.name)}`)
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


// ─── Completion subcommand ────────────────────────────────────────────────────
/**
 * Shell autocomplete generator.
 * Emits a script the user can `source` to get TAB-completion for the top-level
 * `eco` CLI (subcommands & flags) in bash, zsh, fish, or powershell.
 *
 * Interactive REPL autocomplete (slash commands, paths) is handled separately
 * by readline's completer — see createReplCompleter().
 */
program
  .command('completion [shell]')
  .description('Print shell completion script: bash | zsh | fish | powershell (source or eval its output)')
  .action((shell?: string) => {
    const sh = (shell ?? 'bash').toLowerCase()
    const cmds = ['init', 'plugin', 'session', 'mcp', 'swarm', 'completion', 'help']
    const flags = ['--reset', '--resume', '--version']

    if (sh === 'bash' || sh === 'zsh') {
      console.log(`# eco-agent completion for ${sh} — save to ~/.${sh}rc or source directly
#   eco completion ${sh} >> ~/.${sh}rc && source ~/.${sh}rc
_complete_eco() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${cmds.join(' ')} ${flags.join(' ')}"
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -o default -F _complete_eco eco`)
    } else if (sh === 'fish') {
      console.log(`# eco-agent completion for fish — save to ~/.config/fish/completions/eco.fish
#   eco completion fish > ~/.config/fish/completions/eco.fish
complete -c eco -n '__fish_use_subcommand' -a '${cmds.join(' ')}' -d 'Eco Agent command'
complete -c eco -n '__fish_use_subcommand' -l reset -d 'Reset saved configuration'
complete -c eco -n '__fish_use_subcommand' -l resume -d 'Resume last session'
complete -c eco -n '__fish_use_subcommand' -l version -d 'Show version'`)
    } else if (sh === 'powershell' || sh === 'pwsh') {
      console.log(`# eco-agent completion for powershell — dot-source this file in $PROFILE
#   eco completion powershell >> $PROFILE
Register-ArgumentCompleter -Native -CommandName 'eco' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @('${[...cmds, ...flags].join("', '")}')
  $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}`)
    } else {
      console.error(chalk.red(`\n  ✗ Unknown shell "${sh}". Supported: bash, zsh, fish, powershell\n`))
      process.exit(1)
    }
    console.error(chalk.gray(`  → Script generated for ${sh}. Install instructions are in the comments above.\n`))
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
      console.log(chalk.yellow('  ! Text-only mode — this model does not support tools.'))
      console.log(chalk.gray('  Use /config to switch to a tool-capable model.\n'))
    }
    const config = buildEcoConfig(saved.mode, saved.apiKey, saved.model, undefined, saved.baseUrl)
    const provider = createProviderSafe(config.provider)

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
          console.log(`  ${chalk.bgYellow.black(' SKIP ')} ${chalk.yellow('!')} ${chalk.bold(evt.task.title)}`)
          break
        case 'worker:tool':
          console.log(`         ${chalk.gray('> ' + evt.toolName)}`)
          break
      }
    })

    const result = await orch.run(plan)

    console.log()
    console.log(renderDivider('complete'))
    const sec = (result.duration / 1000).toFixed(1)
    console.log(`  ${chalk.green('✓')} ${result.succeeded} done  ${chalk.red('✗')} ${result.failed} failed  ${chalk.yellow('!')} ${result.skipped} skipped  ${chalk.gray(sec + 's')}`)
    console.log()
    console.log(chalk.bold('  Summary:'))
    console.log(renderMarkdown(result.summary))
    console.log(renderDivider())
    console.log()
  })

program.parse()
