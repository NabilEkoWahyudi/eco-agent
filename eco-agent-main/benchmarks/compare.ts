#!/usr/bin/env tsx
/**
 * Ponytail Benchmark Comparator
 * ──────────────────────────────
 * Compares two benchmark run JSON files (with-ponytail vs without-ponytail),
 * prints a delta table, and writes/updates .eco/ponytail-gain.json.
 *
 * Usage:
 *   npm run benchmark:compare -- \
 *     --with    benchmarks/results/2026-...-task-01-full.json \
 *     --without benchmarks/results/2026-...-task-01-off.json
 *
 *   # Or compare all matching pairs in results/ automatically:
 *   npm run benchmark:compare -- --auto
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { BenchmarkRun, GainComparison, PonytailGainFile } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(__dirname, 'results')

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(): { withFile?: string; withoutFile?: string; auto: boolean } {
  const args = process.argv.slice(2)
  let withFile: string | undefined
  let withoutFile: string | undefined
  let auto = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--with' && args[i + 1])    { withFile = args[++i]; continue }
    if (a === '--without' && args[i + 1]) { withoutFile = args[++i]; continue }
    if (a === '--auto')                   { auto = true; continue }
  }

  if (!auto && (!withFile || !withoutFile)) {
    console.error(
      'Usage:\n' +
      '  npm run benchmark:compare -- --with <file.json> --without <file.json>\n' +
      '  npm run benchmark:compare -- --auto'
    )
    process.exit(1)
  }
  return { withFile, withoutFile, auto }
}

// ─── Loader ───────────────────────────────────────────────────────────────────

function loadRun(filePath: string): BenchmarkRun {
  const abs = path.resolve(filePath)
  if (!fs.existsSync(abs)) {
    console.error(`Run file not found: ${abs}`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(abs, 'utf-8')) as BenchmarkRun
}

// ─── Auto-pair discovery ──────────────────────────────────────────────────────

/**
 * Finds all pairs (with-ponytail, without-ponytail) that share the same taskId.
 * "without" = mode 'off', "with" = any of lite/full/ultra.
 */
function discoverPairs(): Array<{ withFile: string; withoutFile: string }> {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(`No results directory found at: ${RESULTS_DIR}`)
    process.exit(1)
  }

  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'))
  const runs: Array<{ file: string; run: BenchmarkRun }> = files.map(f => ({
    file: path.join(RESULTS_DIR, f),
    run: JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as BenchmarkRun
  }))

  const pairs: Array<{ withFile: string; withoutFile: string }> = []
  const offRuns = runs.filter(r => r.run.ponytailMode === 'off')
  const onRuns  = runs.filter(r => r.run.ponytailMode !== 'off')

  for (const on of onRuns) {
    // Find the most recent 'off' run for the same taskId
    const matching = offRuns
      .filter(r => r.run.taskId === on.run.taskId)
      .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
    if (matching.length > 0) {
      pairs.push({ withFile: on.file, withoutFile: matching[0].file })
    }
  }

  if (pairs.length === 0) {
    console.log('\n  No comparable pairs found.')
    console.log('  Run the same task with --mode full AND --mode off to create a pair.\n')
    process.exit(0)
  }
  return pairs
}

// ─── Delta calculation ────────────────────────────────────────────────────────

function pct(before: number, after: number): number {
  if (before === 0) return 0
  return Math.round(((after - before) / before) * 100 * 10) / 10
}

function compare(withRun: BenchmarkRun, withoutRun: BenchmarkRun): GainComparison {
  const wm = withRun.metrics
  const nm = withoutRun.metrics
  return {
    taskId: withRun.taskId,
    taskTitle: withRun.taskTitle,
    label: `${withRun.taskTitle} (${withRun.ponytailMode} vs off)`,
    withPonytail: { ...wm, mode: withRun.ponytailMode },
    withoutPonytail: { ...nm, mode: withoutRun.ponytailMode },
    delta: {
      locPct:     pct(nm.loc,     wm.loc),
      tokensPct:  pct(nm.tokens,  wm.tokens),
      costPct:    pct(nm.costUsd, wm.costUsd),
      timeSecPct: pct(nm.timeSec, wm.timeSec),
    }
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────

function colorPct(v: number): string {
  const sign = v < 0 ? '' : '+'
  // Negative = reduction = good (green), Positive = increase = bad (red)
  const color = v < 0 ? '\x1b[32m' : v > 0 ? '\x1b[31m' : '\x1b[90m'
  return `${color}${sign}${v}%\x1b[0m`
}

function printComparison(c: GainComparison, index: number): void {
  const w = c.withPonytail
  const n = c.withoutPonytail
  const d = c.delta

  console.log(`\n  ${index + 1}. ${c.taskTitle}  [ponytail/${w.mode} vs off]`)
  console.log(`  ${'─'.repeat(60)}`)
  console.log(`  ${'Metric'.padEnd(18)} ${'with'.padStart(10)} ${'without'.padStart(10)} ${'Δ'.padStart(10)}`)
  console.log(`  ${'─'.repeat(60)}`)
  console.log(`  ${'LOC written'.padEnd(18)} ${String(w.loc).padStart(10)} ${String(n.loc).padStart(10)} ${colorPct(d.locPct).padStart(10)}`)
  console.log(`  ${'Tokens used'.padEnd(18)} ${String(w.tokens).padStart(10)} ${String(n.tokens).padStart(10)} ${colorPct(d.tokensPct).padStart(10)}`)
  console.log(`  ${'Cost (USD)'.padEnd(18)} ${('$' + w.costUsd.toFixed(4)).padStart(10)} ${('$' + n.costUsd.toFixed(4)).padStart(10)} ${colorPct(d.costPct).padStart(10)}`)
  console.log(`  ${'Time (sec)'.padEnd(18)} ${(w.timeSec.toFixed(1) + 's').padStart(10)} ${(n.timeSec.toFixed(1) + 's').padStart(10)} ${colorPct(d.timeSecPct).padStart(10)}`)
  console.log(`  ${'─'.repeat(60)}`)
}

// ─── Write .eco/ponytail-gain.json ───────────────────────────────────────────

function updateGainFile(comparisons: GainComparison[]): void {
  const ecoDir = path.join(process.cwd(), '.eco')
  fs.mkdirSync(ecoDir, { recursive: true })
  const gainPath = path.join(ecoDir, 'ponytail-gain.json')

  const gainFile: PonytailGainFile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runs: comparisons.map(c => ({
      label: c.label,
      withPonytail: {
        loc: c.withPonytail.loc,
        tokens: c.withPonytail.tokens,
        costUsd: c.withPonytail.costUsd,
        timeSec: c.withPonytail.timeSec,
      },
      withoutPonytail: {
        loc: c.withoutPonytail.loc,
        tokens: c.withoutPonytail.tokens,
        costUsd: c.withoutPonytail.costUsd,
        timeSec: c.withoutPonytail.timeSec,
      },
      deltaPct: {
        loc: c.delta.locPct,
        tokens: c.delta.tokensPct,
        costUsd: c.delta.costPct,
        timeSec: c.delta.timeSecPct,
      }
    }))
  }

  fs.writeFileSync(gainPath, JSON.stringify(gainFile, null, 2), 'utf-8')
  console.log(`\n  ✓ Updated .eco/ponytail-gain.json (${comparisons.length} comparison${comparisons.length !== 1 ? 's' : ''})`)
  console.log('  → Run /ponytail-gain inside eco to view the scoreboard.\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { withFile, withoutFile, auto } = parseArgs()

  console.log('\n📊 Ponytail Benchmark Comparator')

  let pairs: Array<{ withFile: string; withoutFile: string }>
  if (auto) {
    pairs = discoverPairs()
    console.log(`   Found ${pairs.length} comparable pair(s) in benchmarks/results/`)
  } else {
    pairs = [{ withFile: withFile!, withoutFile: withoutFile! }]
  }

  const comparisons: GainComparison[] = pairs.map(({ withFile, withoutFile }) => {
    const withRun    = loadRun(withFile)
    const withoutRun = loadRun(withoutFile)

    if (withRun.taskId !== withoutRun.taskId) {
      console.warn(`  ⚠ Task ID mismatch: ${withRun.taskId} vs ${withoutRun.taskId}. Proceeding anyway.`)
    }
    if (withoutRun.ponytailMode !== 'off') {
      console.warn(`  ⚠ The --without file has ponytailMode="${withoutRun.ponytailMode}", expected "off".`)
    }

    return compare(withRun, withoutRun)
  })

  comparisons.forEach((c, i) => printComparison(c, i))

  // Aggregate averages across all comparisons
  if (comparisons.length > 1) {
    const avg = (arr: number[]) => Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
    const avgLoc     = avg(comparisons.map(c => c.delta.locPct))
    const avgTokens  = avg(comparisons.map(c => c.delta.tokensPct))
    const avgCost    = avg(comparisons.map(c => c.delta.costPct))
    const avgTime    = avg(comparisons.map(c => c.delta.timeSecPct))

    console.log('\n  ── Aggregate (average across all tasks) ──────')
    console.log(`  LOC Δ avg     : ${colorPct(avgLoc)}`)
    console.log(`  Tokens Δ avg  : ${colorPct(avgTokens)}`)
    console.log(`  Cost Δ avg    : ${colorPct(avgCost)}`)
    console.log(`  Time Δ avg    : ${colorPct(avgTime)}`)
    console.log()
  }

  updateGainFile(comparisons)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
