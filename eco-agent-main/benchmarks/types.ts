/**
 * Benchmark type definitions for Ponytail gain measurement.
 * Methodology: run the same task with & without Ponytail (n≥4), measure LOC/tokens/cost/time.
 */

import type { PonytailMode } from '../src/rulesets/ponytail.js'

export type { PonytailMode }

/** A benchmark task definition loaded from a .md file. */
export interface BenchmarkTask {
  /** Unique short ID, e.g. "task-01-parse-csv" */
  id: string
  /** Human-readable title */
  title: string
  /** Full task description sent to the agent as the user prompt */
  prompt: string
  /** Optional target directory (defaults to a temp sandbox dir) */
  targetDir?: string
}

/** Raw measurements from a single benchmark run. */
export interface RunMetrics {
  /** Lines of code written by the agent (sum of all write_file calls) */
  loc: number
  /** Total LLM tokens consumed */
  tokens: number
  /** Estimated USD cost (0 if unknown) */
  costUsd: number
  /** Wall-clock time in seconds */
  timeSec: number
  /** Number of tool calls made */
  toolCalls: number
  /** Number of write_file calls made */
  filesWritten: number
  /** Agent's final response text (truncated to 500 chars) */
  responsePreview: string
}

/** Result of a single benchmark run, saved to results/<timestamp>-<taskId>-<mode>.json */
export interface BenchmarkRun {
  /** Schema version for forward compatibility */
  schemaVersion: 1
  taskId: string
  taskTitle: string
  ponytailMode: PonytailMode
  provider: string
  model: string
  /** ISO 8601 timestamp */
  startedAt: string
  metrics: RunMetrics
  /** Whether this was a dry-run (no real LLM calls) */
  dryRun: boolean
}

/** Comparison result between a withPonytail run and a withoutPonytail run. */
export interface GainComparison {
  taskId: string
  taskTitle: string
  label: string
  withPonytail: RunMetrics & { mode: PonytailMode }
  withoutPonytail: RunMetrics & { mode: PonytailMode }
  /** Delta percentages: negative = reduction (good), positive = increase (bad) */
  delta: {
    locPct: number
    tokensPct: number
    costPct: number
    timeSecPct: number
  }
}

/** Schema for .eco/ponytail-gain.json — read by /ponytail-gain CLI command. */
export interface PonytailGainFile {
  schemaVersion: 1
  generatedAt: string
  runs: Array<{
    label: string
    withPonytail: Record<string, number>
    withoutPonytail: Record<string, number>
    deltaPct: Record<string, number>
  }>
}
