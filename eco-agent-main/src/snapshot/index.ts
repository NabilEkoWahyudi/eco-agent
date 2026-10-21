/**
 * Snapshot System 
 * 
 * Captures file state before agent modifications using git-based content addressing.
 * Allows listing changed files and diffing/restoring between snapshots.
 * 
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

export interface FileDiff {
  file: string
  patch: string
  added: number
  removed: number
}

export interface SnapshotInfo {
  id: string
  timestamp: number
  description?: string
  files: string[]
}

const ECO_SNAPSHOT_DIR = path.join(os.homedir(), '.eco-agent', 'snapshots')

function ensureSnapshotDir() {
  mkdirSync(ECO_SNAPSHOT_DIR, { recursive: true })
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function getTrackedFiles(cwd: string): string[] {
  try {
    const output = execSync('git ls-files', { cwd, encoding: 'utf-8' })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function readFilesSafe(cwd: string, files: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const file of files) {
    const fullPath = path.resolve(cwd, file)
    if (existsSync(fullPath)) {
      try {
        result.set(file, readFileSync(fullPath, 'utf-8'))
      } catch { /* skip binary/inaccessible */ }
    }
  }
  return result
}

/**
 * Capture current state of git-tracked files in cwd.
 * Returns snapshot ID or undefined if capture failed.
 */
export function captureSnapshot(cwd: string, description?: string): string | undefined {
  try {
    ensureSnapshotDir()
    if (!isGitRepo(cwd)) return undefined

    const files = getTrackedFiles(cwd)
    if (files.length === 0) return undefined

    const contents = readFilesSafe(cwd, files)
    const timestamp = Date.now()
    const id = hashContent(`${cwd}:${timestamp}:${JSON.stringify([...contents.keys()])}`)

    const snapshotData: Record<string, string> = {}
    for (const [file, content] of contents) {
      snapshotData[file] = content
    }

    const meta: SnapshotInfo = {
      id,
      timestamp,
      description,
      files: [...contents.keys()]
    }

    const snapDir = path.join(ECO_SNAPSHOT_DIR, id)
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(path.join(snapDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
    writeFileSync(path.join(snapDir, 'files.json'), JSON.stringify(snapshotData, null, 2), 'utf-8')

    return id
  } catch {
    return undefined
  }
}

/**
 * List files changed between two snapshots.
 */
export function snapshotChangedFiles(fromId: string, toId: string): string[] {
  try {
    const fromPath = path.join(ECO_SNAPSHOT_DIR, fromId, 'files.json')
    const toPath = path.join(ECO_SNAPSHOT_DIR, toId, 'files.json')
    if (!existsSync(fromPath) || !existsSync(toPath)) return []

    const from: Record<string, string> = JSON.parse(readFileSync(fromPath, 'utf-8'))
    const to: Record<string, string> = JSON.parse(readFileSync(toPath, 'utf-8'))

    const changed: string[] = []
    const allFiles = new Set([...Object.keys(from), ...Object.keys(to)])
    for (const file of allFiles) {
      if (from[file] !== to[file]) changed.push(file)
    }
    return changed
  } catch {
    return []
  }
}

/**
 * Generate unified diffs for changed files between two snapshots.
 */
export function snapshotDiff(fromId: string, toId: string, filterFiles?: string[]): FileDiff[] {
  try {
    const fromPath = path.join(ECO_SNAPSHOT_DIR, fromId, 'files.json')
    const toPath = path.join(ECO_SNAPSHOT_DIR, toId, 'files.json')
    if (!existsSync(fromPath) || !existsSync(toPath)) return []

    const from: Record<string, string> = JSON.parse(readFileSync(fromPath, 'utf-8'))
    const to: Record<string, string> = JSON.parse(readFileSync(toPath, 'utf-8'))

    const allFiles = new Set([...Object.keys(from), ...Object.keys(to)])
    const diffs: FileDiff[] = []

    for (const file of allFiles) {
      if (filterFiles && !filterFiles.includes(file)) continue
      const a = from[file] ?? ''
      const b = to[file] ?? ''
      if (a === b) continue

      const diff = createUnifiedDiff(file, a, b)
      const added = (diff.match(/^\+[^+]/gm) || []).length
      const removed = (diff.match(/^-[^-]/gm) || []).length
      diffs.push({ file, patch: diff, added, removed })
    }
    return diffs
  } catch {
    return []
  }
}

/**
 * Restore specific files from a snapshot.
 */
export function snapshotRestore(snapshotId: string, cwd: string, files?: string[]): string {
  try {
    const filesPath = path.join(ECO_SNAPSHOT_DIR, snapshotId, 'files.json')
    if (!existsSync(filesPath)) return `Error: Snapshot ${snapshotId} not found`

    const snapshotFiles: Record<string, string> = JSON.parse(readFileSync(filesPath, 'utf-8'))
    const toRestore = files
      ? Object.entries(snapshotFiles).filter(([f]) => files.includes(f))
      : Object.entries(snapshotFiles)

    let restoredCount = 0
    for (const [file, content] of toRestore) {
      const fullPath = path.resolve(cwd, file)
      mkdirSync(path.dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content, 'utf-8')
      restoredCount++
    }
    return `Restored ${restoredCount} files from snapshot ${snapshotId}`
  } catch (e) {
    return `Error restoring snapshot: ${(e as Error).message}`
  }
}

/**
 * Get metadata for a snapshot.
 */
export function getSnapshot(snapshotId: string): SnapshotInfo | undefined {
  try {
    const metaPath = path.join(ECO_SNAPSHOT_DIR, snapshotId, 'meta.json')
    if (!existsSync(metaPath)) return undefined
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapshotInfo
  } catch {
    return undefined
  }
}

/**
 * List all snapshots, newest first.
 */
export function listSnapshots(): SnapshotInfo[] {
  try {
    ensureSnapshotDir()
    const dirs = readdirSync(ECO_SNAPSHOT_DIR).filter(d => {
      try {
        return statSync(path.join(ECO_SNAPSHOT_DIR, d)).isDirectory()
      } catch { return false }
    })

    const snapshots: SnapshotInfo[] = []
    for (const dir of dirs) {
      const info = getSnapshot(dir)
      if (info) snapshots.push(info)
    }
    return snapshots.sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

// Simple unified diff implementation (no external deps)
function createUnifiedDiff(filename: string, oldContent: string, newContent: string, context = 3): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  // LCS-based diff
  const hunks: string[] = []
  let header = `--- a/${filename}\n+++ b/${filename}`
  hunks.push(header)

  const diff = computeDiff(oldLines, newLines)
  const groups = groupChanges(diff, context)

  for (const group of groups) {
    const oldStart = group.oldStart + 1
    const newStart = group.newStart + 1
    const oldCount = group.lines.filter(l => l.type !== 'add').length
    const newCount = group.lines.filter(l => l.type !== 'remove').length
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const line of group.lines) {
      if (line.type === 'add') hunks.push(`+${line.text}`)
      else if (line.type === 'remove') hunks.push(`-${line.text}`)
      else hunks.push(` ${line.text}`)
    }
  }

  return hunks.join('\n')
}

type DiffLine = { type: 'keep' | 'add' | 'remove'; text: string }
type HunkGroup = { oldStart: number; newStart: number; lines: DiffLine[] }

function computeDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Myers diff algorithm (simplified)
  const n = oldLines.length
  const m = newLines.length
  const result: DiffLine[] = []

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      result.push({ type: 'keep', text: oldLines[i] })
      i++; j++
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ type: 'add', text: newLines[j] })
      j++
    } else {
      result.push({ type: 'remove', text: oldLines[i] })
      i++
    }
  }
  return result
}

function groupChanges(diff: DiffLine[], context: number): HunkGroup[] {
  const groups: HunkGroup[] = []
  let currentGroup: HunkGroup | null = null
  let oldLine = 0, newLine = 0
  let lastChangeIdx = -999

  for (let idx = 0; idx < diff.length; idx++) {
    const line = diff[idx]
    const isChange = line.type !== 'keep'
    const nearChange = diff.slice(Math.max(0, idx - context), Math.min(diff.length, idx + context + 1)).some(l => l.type !== 'keep')

    if (isChange || nearChange) {
      if (!currentGroup) {
        const startIdx = Math.max(0, idx - context)
        let oldStart = 0, newStart = 0
        for (let k = 0; k < startIdx; k++) {
          if (diff[k].type !== 'add') oldStart++
          if (diff[k].type !== 'remove') newStart++
        }
        currentGroup = { oldStart, newStart, lines: [] }
        // Add context before
        for (let k = startIdx; k < idx; k++) {
          currentGroup.lines.push(diff[k])
        }
      }
      currentGroup.lines.push(line)
      if (isChange) lastChangeIdx = idx
    } else if (currentGroup) {
      if (idx > lastChangeIdx + context) {
        groups.push(currentGroup)
        currentGroup = null
      } else {
        currentGroup.lines.push(line)
      }
    }

    if (line.type !== 'add') oldLine++
    if (line.type !== 'remove') newLine++
  }

  if (currentGroup) groups.push(currentGroup)
  return groups
}
