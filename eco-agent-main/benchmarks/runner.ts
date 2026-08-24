#!/usr/bin/env tsx
/**
 * Ponytail Benchmark Runner
 * ─────────────────────────
 * Runs a benchmark task via eco-agent (programmatically) and records metrics.
 *
 * Usage:
 *   npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode full
 *   npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode off
 *   npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode full --dry-run
 *
 * Output:
 *   benchmarks/results/<ISO-timestamp>-<taskId>-<mode>.json
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createProvider } from '../src/providers/index.js'
import { AgentLoop } from '../src/loop/index.js'
import { defaultTools } from '../src/tools/index.js'
import { getSavedConfig } from '../src/utils/configStore.js'
import { parsePonytailMode } from '../src/rulesets/ponytail.js'
import type { BenchmarkTask, BenchmarkRun, RunMetrics } from './types.js'
import type { EcoConfig } from '../src/utils/types.js'
import type { PonytailMode } from '../src/rulesets/ponytail.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(__dirname, 'results')

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(): { taskFile: string; mode: PonytailMode; dryRun: boolean; provider?: string; model?: string } {
  const args = process.argv.slice(2)
  let taskFile = ''
  let mode: PonytailMode = 'full'
  let dryRun = false
  let provider: string | undefined
  let model: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--task' && args[i + 1])   { taskFile = args[++i]; continue }
    if (a === '--mode' && args[i + 1])   { mode = parsePonytailMode(args[++i]); continue }
    if (a === '--provider' && args[i + 1]) { provider = args[++i]; continue }
    if (a === '--model' && args[i + 1])  { model = args[++i]; continue }
    if (a === '--dry-run')               { dryRun = true; continue }
  }

  if (!taskFile) {
    console.error('Usage: npm run benchmark:run -- --task <path.md> --mode <off|lite|full|ultra> [--dry-run]')
    process.exit(1)
  }

  return { taskFile, mode, dryRun, provider, model }
}

// ─── Task loader ─────────────────────────────────────────────────────────────

/**
 * Parses a benchmark task from a markdown file.
 * Expected format:
 *   # Task Title
 *   <!-- id: task-01-parse-csv -->
 *   <rest is the prompt sent to the agent>
 */
function loadTask(filePath: string): BenchmarkTask {
  const abs = path.resolve(filePath)
  if (!fs.existsSync(abs)) {
    console.error(`Task file not found: ${abs}`)
    process.exit(1)
  }
  const raw = fs.readFileSync(abs, 'utf-8')
  const lines = raw.split('\n')

  // Extract title from first H1
  const titleLine = lines.find(l => l.startsWith('# '))
  const title = titleLine ? titleLine.slice(2).trim() : path.basename(filePath, '.md')

  // Extract id from <!-- id: xxx --> comment
  const idMatch = raw.match(/<!--\s*id:\s*([^\s>]+)\s*-->/)
  const id = idMatch ? idMatch[1] : path.basename(filePath, '.md')

  // Everything after the first blank line following the title/id comment is the prompt
  const startIdx = lines.findIndex(l => l.trim() === '' && lines.indexOf(l) > 0)
  const prompt = lines.slice(startIdx + 1).join('\n').trim()

  return { id, title, prompt }
}

// ─── LOC counter ─────────────────────────────────────────────────────────────

/** Count lines in content written by the agent. */
function countLoc(content: string): number {
  return content.split('\n').filter(l => l.trim() !== '').length
}

// ─── Cost estimator ──────────────────────────────────────────────────────────

/** Very rough token→USD estimates (update as needed). */
const COST_PER_1K: Record<string, number> = {
  'llama-3.3-70b-versatile': 0.00059,   // Groq approximate
  'llama3.2': 0,                          // Ollama local = free
  'meta-llama/llama-3.3-70b-instruct:free': 0, // OpenRouter free tier
  default: 0.001,
}

function estimateCost(tokens: number, model: string): number {
  const rate = COST_PER_1K[model] ?? COST_PER_1K['default']
  return (tokens / 1000) * rate
}

// ─── Dry-run mock ─────────────────────────────────────────────────────────────

/** Returns a fake BenchmarkRun for --dry-run mode (no real LLM calls). */
function makeDryRunResult(task: BenchmarkTask, mode: PonytailMode, model: string, provider: string): BenchmarkRun {
  const metrics: RunMetrics = {
    loc: 0, tokens: 0, costUsd: 0, timeSec: 0,
    toolCalls: 0, filesWritten: 0,
    responsePreview: '[dry-run: no LLM call made]'
  }
  return {
    schemaVersion: 1,
    taskId: task.id,
    taskTitle: task.title,
    ponytailMode: mode,
    provider,
    model,
    startedAt: new Date().toISOString(),
    metrics,
    dryRun: true,
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { taskFile, mode, dryRun, provider: providerOverride, model: modelOverride } = parseArgs()

  const task = loadTask(taskFile)
  console.log(`\n🏁 Ponytail Benchmark Runner`)
  console.log(`   Task  : ${task.id} — ${task.title}`)
  console.log(`   Mode  : ponytail/${mode}`)
  console.log(`   Dry   : ${dryRun ? 'yes (no LLM calls)' : 'no'}`)
  console.log()

  // Resolve provider config
  const saved = getSavedConfig()
  const providerType = (providerOverride ?? saved?.mode ?? 'groq') as EcoConfig['provider']['type']
  const modelName = modelOverride ?? saved?.model ?? 'llama-3.3-70b-versatile'
  const apiKey = saved?.apiKey

  if (dryRun) {
    const result = makeDryRunResult(task, mode, modelName, providerType)
    saveResult(result)
    printMetrics(result)
    return
  }

  const config: EcoConfig = {
    provider: { type: providerType, model: modelName, apiKey },
    maxIterations: 15,
    verbose: false,
    ponytailMode: mode,
  }

  const provider = createProvider(config.provider)

  // Instrument tool calls
  let totalLoc = 0
  let totalToolCalls = 0
  let totalFilesWritten = 0

  const instrumentedTools = defaultTools.map(t => ({
    ...t,
    execute: async (args: Record<string, unknown>) => {
      totalToolCalls++
      const result = await t.execute(args)
      if (t.name === 'write_file' && typeof args.content === 'string') {
        totalFilesWritten++
        totalLoc += countLoc(args.content as string)
      }
      return result
    }
  }))

  const agent = new AgentLoop(provider, instrumentedTools, config)

  console.log(`   ⟳ Running agent...`)
  const startMs = Date.now()
  let finalResponse = ''

  await agent.run(task.prompt, {
    onContent: (chunk) => { finalResponse += chunk },
    onToolCall: (name) => { if (name !== 'write_file') process.stdout.write(`     tool: ${name}\n`) },
    onDone: () => {},
    onError: (err) => { console.error(`\n   ✗ Error: ${err.message}`); process.exit(1) },
  })

  const timeSec = (Date.now() - startMs) / 1000
  const tokens = agent.getTotalTokens()
  const costUsd = estimateCost(tokens, modelName)

  const metrics: RunMetrics = {
    loc: totalLoc,
    tokens,
    costUsd,
    timeSec,
    toolCalls: totalToolCalls,
    filesWritten: totalFilesWritten,
    responsePreview: finalResponse.slice(0, 500),
  }

  const result: BenchmarkRun = {
    schemaVersion: 1,
    taskId: task.id,
    taskTitle: task.title,
    ponytailMode: mode,
    provider: providerType,
    model: modelName,
    startedAt: new Date(startMs).toISOString(),
    metrics,
    dryRun: false,
  }

  saveResult(result)
  printMetrics(result)
}

function saveResult(result: BenchmarkRun): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const ts = result.startedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const filename = `${ts}-${result.taskId}-${result.ponytailMode}.json`
  const outPath = path.join(RESULTS_DIR, filename)
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8')
  console.log(`\n   ✓ Saved → benchmarks/results/${filename}`)
}

function printMetrics(result: BenchmarkRun): void {
  const m = result.metrics
  console.log()
  console.log('   ── Metrics ────────────────────────────────')
  console.log(`   LOC written   : ${m.loc}`)
  console.log(`   Tokens used   : ${m.tokens}`)
  console.log(`   Cost (USD)    : $${m.costUsd.toFixed(5)}`)
  console.log(`   Time (sec)    : ${m.timeSec.toFixed(1)}s`)
  console.log(`   Tool calls    : ${m.toolCalls}`)
  console.log(`   Files written : ${m.filesWritten}`)
  if (result.dryRun) console.log('   [dry-run — no real LLM calls]')
  console.log()
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
