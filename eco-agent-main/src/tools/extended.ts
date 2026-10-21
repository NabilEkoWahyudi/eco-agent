/**
 * Extended Tools
 * 
 * Additional tools : 
 * - glob_files: Find files matching glob patterns
 * - grep_search: Search text with regex, with line numbers and context
 * - patch_file: Apply unified diff patches to files
 * - todo_write/todo_read: Task tracking within sessions
 * - fetch_url: Fetch and convert web pages to markdown
 * 
 */

import {
  readFileSync, writeFileSync, readdirSync, statSync,
  existsSync, mkdirSync
} from 'fs'
import { execSync } from 'child_process'
import { resolve, join, extname, relative, basename, dirname } from 'path'
import type { Tool } from '../utils/types.js'

// ─────────────────────────────────────────────────────────
// GLOB TOOL 
// ─────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage'])

function globMatch(pattern: string, filepath: string): boolean {
  // Convert glob pattern to regex
  // Support: *, **, ?, {a,b}, [a-z]
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, (c) => {
      if (c === '{' || c === '}' || c === ',' ) return c
      return '\\' + c
    })
    .replace(/\*\*/g, '__DSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DSTAR__\//g, '(.+/)?')
    .replace(/__DSTAR__/g, '.*')
    .replace(/\?/g, '[^/]')

  // Handle {a,b} alternatives
  regexStr = regexStr.replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(',').join('|')})`)

  try {
    const regex = new RegExp('^' + regexStr + '$')
    // Match against full path or just filename
    return regex.test(filepath) || regex.test(basename(filepath))
  } catch {
    return false
  }
}

function walkForGlob(
  dir: string,
  pattern: string,
  root: string,
  results: string[],
  maxResults: number,
  hidden: boolean
): void {
  if (results.length >= maxResults) return
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (!hidden && entry.startsWith('.')) continue
      if (IGNORE_DIRS.has(entry)) continue
      const full = join(dir, entry)
      const rel = relative(root, full).replace(/\\/g, '/')
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) {
          // Check if dir itself matches (for directory globs)
          if (globMatch(pattern, rel + '/')) results.push(rel + '/')
          walkForGlob(full, pattern, root, results, maxResults, hidden)
        } else {
          if (globMatch(pattern, rel)) results.push(rel)
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

export const globFilesTool: Tool = {
  name: 'glob_files',
  description: 'Find files matching a glob pattern (e.g. **/*.ts, src/**/*.{ts,tsx}, *.md). Returns relative paths.',
  parameters: {
    pattern: { type: 'string', description: 'Glob pattern to match files against', required: true },
    path: { type: 'string', description: 'Root directory to search from (default: current)', required: false },
    limit: { type: 'number', description: 'Maximum number of results (default: 100)', required: false },
    hidden: { type: 'boolean', description: 'Include hidden files/dirs starting with . (default: false)', required: false }
  },
  async execute(args) {
    const pattern = args.pattern as string
    if (!pattern) return 'Error: Missing required parameter "pattern"'

    const searchRoot = resolve((args.path as string) ?? '.')
    const limit = Math.min((args.limit as number) ?? 100, 500)
    const hidden = (args.hidden as boolean) ?? false

    if (!existsSync(searchRoot)) return `Error: Directory not found: ${searchRoot}`

    const results: string[] = []
    walkForGlob(searchRoot, pattern, searchRoot, results, limit, hidden)

    if (results.length === 0) return `No files found matching pattern: ${pattern}`
    const truncated = results.length >= limit ? `\n\n(Showing first ${limit} results)` : ''
    return `Files matching "${pattern}" in ${searchRoot} (${results.length} found):\n\n${results.join('\n')}${truncated}`
  }
}

// ─────────────────────────────────────────────────────────
// GREP TOOL - Ported from opencode ripgrep.ts (Node.js native version)
// ─────────────────────────────────────────────────────────

interface GrepMatch {
  file: string
  line: number
  text: string
  match: string
}

function grepInFile(
  filePath: string,
  relPath: string,
  pattern: RegExp,
  results: GrepMatch[],
  limit: number
): void {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= limit) return
      const match = lines[i].match(pattern)
      if (match) {
        results.push({
          file: relPath,
          line: i + 1,
          text: lines[i].length > 500 ? lines[i].slice(0, 500) + '...' : lines[i],
          match: match[0]
        })
      }
    }
  } catch { /* skip binary/unreadable */ }
}

function grepWalk(
  dir: string,
  root: string,
  pattern: RegExp,
  includeExt: string | undefined,
  results: GrepMatch[],
  limit: number
): void {
  if (results.length >= limit) return
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (results.length >= limit) return
      if (IGNORE_DIRS.has(entry)) continue
      const full = join(dir, entry)
      const rel = relative(root, full).replace(/\\/g, '/')
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) {
          grepWalk(full, root, pattern, includeExt, results, limit)
        } else {
          if (includeExt && extname(entry) !== '.' + includeExt.replace(/^\./, '')) continue
          grepInFile(full, rel, pattern, results, limit)
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

export const grepSearchTool: Tool = {
  name: 'grep_search',
  description: 'Search for text patterns in files using regex. Returns matching lines with file paths and line numbers.',
  parameters: {
    pattern: { type: 'string', description: 'Regex or text pattern to search for', required: true },
    path: { type: 'string', description: 'Directory or file to search in (default: current)', required: false },
    include: { type: 'string', description: 'File extension filter (e.g. ts, py, md)', required: false },
    literal: { type: 'boolean', description: 'Use literal string matching instead of regex (default: false)', required: false },
    case_sensitive: { type: 'boolean', description: 'Case-sensitive matching (default: true)', required: false },
    limit: { type: 'number', description: 'Maximum number of matches (default: 50)', required: false }
  },
  async execute(args) {
    const patternStr = args.pattern as string
    if (!patternStr) return 'Error: Missing required parameter "pattern"'

    const searchPath = resolve((args.path as string) ?? '.')
    const includeExt = args.include as string | undefined
    const literal = (args.literal as boolean) ?? false
    const caseSensitive = (args.case_sensitive as boolean) ?? true
    const limit = Math.min((args.limit as number) ?? 50, 200)

    if (!existsSync(searchPath)) return `Error: Path not found: ${searchPath}`

    let regex: RegExp
    try {
      const flags = caseSensitive ? 'g' : 'gi'
      const safePattern = literal ? patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : patternStr
      regex = new RegExp(safePattern, flags)
    } catch (e) {
      return `Error: Invalid regex pattern: ${(e as Error).message}`
    }

    const results: GrepMatch[] = []
    const stat = statSync(searchPath)
    if (stat.isFile()) {
      grepInFile(searchPath, basename(searchPath), regex, results, limit)
    } else {
      grepWalk(searchPath, searchPath, regex, includeExt, results, limit)
    }

    if (results.length === 0) return `No matches found for: ${patternStr}`

    const output = results.map(r =>
      `${r.file}:${r.line}: ${r.text.trim()}`
    ).join('\n')

    const truncated = results.length >= limit ? `\n\n(Showing first ${limit} matches)` : ''
    return `Grep results for "${patternStr}" (${results.length} matches):\n\n${output}${truncated}`
  }
}

// ─────────────────────────────────────────────────────────
// PATCH FILE TOOL - Ported from opencode patch.ts
// Applies unified diff patches to files
// ─────────────────────────────────────────────────────────

/**
 * Apply a unified diff patch.
 *
 * BUG FIX: the previous version did `result.splice(adjustedStart, oldCount, ...adds)`,
 * which *deleted the context lines* of the hunk (oldCount counts context +
 * removed lines, but only removed lines are replaced). Now every hunk is
 * applied by verifying the removed lines match the original file, keeping
 * context intact, and failing loudly when the patch does not apply.
 */
function applyUnifiedPatch(original: string, patch: string): string | null {
  const lines = original.split('\n')
  const patchLines = patch.split('\n')
  const results: string[] = [...lines]

  let offset = 0 // Track line number shifts from previous hunks
  let appliedAny = false

  for (let i = 0; i < patchLines.length; i++) {
    const hunkHeader = patchLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!hunkHeader) continue

    const oldStart = parseInt(hunkHeader[1], 10) - 1 // 0-indexed
    const oldCount = parseInt(hunkHeader[2] ?? '1', 10)
    const newCount = parseInt(hunkHeader[4] ?? '1', 10)

    const hunkLines: string[] = []
    let j = i + 1
    while (j < patchLines.length && !patchLines[j].startsWith('@@')) {
      hunkLines.push(patchLines[j])
      j++
    }

    // Rebuild the hunk preserving context lines, removing only "-" lines and
    // inserting "+" lines. Context/added lines stay in their original relative
    // order, which is exactly the new-file content.
    const removeds: string[] = []
    const rebuilt: string[] = []
    for (const hl of hunkLines) {
      if (hl.startsWith('\\')) continue // "\ No newline at end of file"
      if (hl.startsWith('-')) { removeds.push(hl.slice(1)); continue }
      if (hl.startsWith('+')) { rebuilt.push(hl.slice(1)); continue }
      // context line (starting with ' ') — tolerate empty-context diffs
      rebuilt.push(hl.startsWith(' ') ? hl.slice(1) : hl)
    }

    // Verify every old-file line of this hunk (context + removed, in order)
    // matches the original, starting at the anchor and skipping context lines
    // that precede the removed ones in the hunk.
    const anchor = oldStart + offset
    let linePos = anchor
    let matchOk = true
    for (const hl of hunkLines) {
      if (hl.startsWith('\\') || hl.startsWith('+')) continue
      // slice the prefix for context (' x') and removed ('-x') lines
      const original = (hl.startsWith(' ') || hl.startsWith('-')) ? hl.slice(1) : hl
      if (results[linePos] !== original) { matchOk = false; break }
      linePos++
    }
    if (!matchOk) return null

    // Splice out the consumed old lines (context + removed) and insert rebuilt
    results.splice(anchor, linePos - anchor, ...rebuilt)
    offset += (newCount - oldCount)
    appliedAny = true
  }

  if (!appliedAny) return null // patch had no hunks
  return results.join('\n')
}

export const patchFileTool: Tool = {
  name: 'patch_file',
  description: 'Apply a unified diff patch to a file. The patch parameter should be in standard unified diff format (output of git diff or diff -u).',
  parameters: {
    path: { type: 'string', description: 'Path to the file to patch', required: true },
    patch: { type: 'string', description: 'Unified diff patch content', required: true }
  },
  async execute(args) {
    const filePath = resolve(args.path as string)
    const patch = args.patch as string

    if (!filePath) return 'Error: Missing required parameter "path"'
    if (!patch) return 'Error: Missing required parameter "patch"'
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`

    try {
      const original = readFileSync(filePath, 'utf-8')
      const patched = applyUnifiedPatch(original, patch)
      if (patched === null) return `Error: Could not apply patch to ${filePath}`
      writeFileSync(filePath, patched, 'utf-8')
      const changedLines = patch.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length
      return `SUCCESS: Patch applied to ${filePath} (${changedLines} lines changed)`
    } catch (e) {
      return `Error applying patch: ${(e as Error).message}`
    }
  }
}

// ─────────────────────────────────────────────────────────
// EDIT FILE TOOL - Ported from opencode edit.ts
// Precise in-file string replacement
// ─────────────────────────────────────────────────────────

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file by replacing a specific string with new content. Use this for precise surgical edits rather than rewriting the whole file.',
  parameters: {
    path: { type: 'string', description: 'Path to the file to edit', required: true },
    old_string: { type: 'string', description: 'The exact text to find and replace (must be unique in the file)', required: true },
    new_string: { type: 'string', description: 'The new text to replace it with', required: true }
  },
  async execute(args) {
    const filePath = resolve(args.path as string)
    const oldStr = args.old_string as string
    const newStr = args.new_string as string

    if (!filePath) return 'Error: Missing required parameter "path"'
    if (oldStr === undefined || oldStr === null) return 'Error: Missing required parameter "old_string"'
    if (newStr === undefined || newStr === null) return 'Error: Missing required parameter "new_string"'
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`

    try {
      const content = readFileSync(filePath, 'utf-8')
      const count = content.split(oldStr).length - 1
      if (count === 0) return `Error: Could not find the text to replace in ${filePath}. The "old_string" must match exactly.`
      if (count > 1) return `Error: Found ${count} occurrences of the text. The "old_string" must be unique. Add more context to make it unique.`

      const newContent = content.replace(oldStr, () => newStr)
      writeFileSync(filePath, newContent, 'utf-8')
      return `SUCCESS: Edited ${filePath} — replaced 1 occurrence`
    } catch (e) {
      return `Error editing file: ${(e as Error).message}`
    }
  }
}

// ─────────────────────────────────────────────────────────
// TODO TOOL - Ported from opencode todo.ts
// Session-scoped task tracking
// ─────────────────────────────────────────────────────────

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'done'
  priority: 'low' | 'medium' | 'high'
  createdAt: number
}

// In-memory todo store (scoped to process)
const todoStore: Map<string, TodoItem[]> = new Map()
let globalTodoList: TodoItem[] = []

function generateTodoId(): string {
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description: 'Manage your task list. Use this to track what needs to be done in the current session. Can create, update status, or clear todos.',
  parameters: {
    action: { type: 'string', description: 'Action: "create", "update", "delete", "clear"', required: true },
    content: { type: 'string', description: 'Task description (for "create")', required: false },
    id: { type: 'string', description: 'Todo ID (for "update" or "delete")', required: false },
    status: { type: 'string', description: 'New status: "pending", "in_progress", "done" (for "update")', required: false },
    priority: { type: 'string', description: 'Priority: "low", "medium", "high" (for "create")', required: false }
  },
  async execute(args) {
    const action = args.action as string
    if (!action) return 'Error: Missing required parameter "action"'

    switch (action) {
      case 'create': {
        const content = args.content as string
        if (!content) return 'Error: Missing "content" for create action'
        const item: TodoItem = {
          id: generateTodoId(),
          content,
          status: 'pending',
          priority: (args.priority as TodoItem['priority']) ?? 'medium',
          createdAt: Date.now()
        }
        globalTodoList.push(item)
        return `Todo created: [${item.id}] ${item.content} (${item.priority} priority)`
      }
      case 'update': {
        const id = args.id as string
        if (!id) return 'Error: Missing "id" for update action'
        const item = globalTodoList.find(t => t.id === id)
        if (!item) return `Error: Todo not found: ${id}`
        if (args.status) item.status = args.status as TodoItem['status']
        if (args.content) item.content = args.content as string
        return `Todo updated: [${item.id}] ${item.content} — status: ${item.status}`
      }
      case 'delete': {
        const id = args.id as string
        if (!id) return 'Error: Missing "id" for delete action'
        const idx = globalTodoList.findIndex(t => t.id === id)
        if (idx === -1) return `Error: Todo not found: ${id}`
        const removed = globalTodoList.splice(idx, 1)[0]
        return `Todo deleted: ${removed.content}`
      }
      case 'clear': {
        const count = globalTodoList.length
        globalTodoList = []
        return `Cleared ${count} todos`
      }
      default:
        return `Error: Unknown action "${action}". Valid actions: create, update, delete, clear`
    }
  }
}

export const todoReadTool: Tool = {
  name: 'todo_read',
  description: 'Read your current task list to see what needs to be done, what is in progress, and what is done.',
  parameters: {
    status: { type: 'string', description: 'Filter by status: "pending", "in_progress", "done", or "all" (default: all)', required: false }
  },
  async execute(args) {
    const statusFilter = (args.status as string) ?? 'all'
    const todos = statusFilter === 'all'
      ? globalTodoList
      : globalTodoList.filter(t => t.status === statusFilter)

    if (todos.length === 0) {
      return statusFilter === 'all'
        ? 'No todos. Use todo_write to create tasks.'
        : `No todos with status: ${statusFilter}`
    }

    const statusIcon: Record<string, string> = {
      pending: 'o',
      in_progress: '~',
      done: 'x'
    }
    const priorityIcon: Record<string, string> = {
      low: '-',
      medium: '=',
      high: '!'
    }

    const lines = todos.map(t =>
      `${statusIcon[t.status] ?? '?'} ${priorityIcon[t.priority] ?? ''} [${t.id}] ${t.content} (${t.status})`
    )
    return `Task list (${todos.length} items):\n\n${lines.join('\n')}`
  }
}

// ─────────────────────────────────────────────────────────
// FETCH URL TOOL - Ported from opencode fetch.ts
// Fetch web pages and convert to text/markdown
// ─────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    // Remove script and style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert headings
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
      const hashes = '#'.repeat(parseInt(level))
      return `\n${hashes} ${content.replace(/<[^>]+>/g, '').trim()}\n`
    })
    // Convert links
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, '').trim()
      return cleanText ? `[${cleanText}](${href})` : href
    })
    // Convert paragraphs and divs to newlines
    .replace(/<\/(p|div|section|article|main|header|footer|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  description: 'Fetch a web page and return its text content. Useful for reading documentation, articles, or any public web content.',
  parameters: {
    url: { type: 'string', description: 'URL to fetch', required: true },
    max_length: { type: 'number', description: 'Maximum characters to return (default: 8000)', required: false }
  },
  async execute(args) {
    const url = args.url as string
    const maxLength = Math.min((args.max_length as number) ?? 8000, 20000)

    if (!url) return 'Error: Missing required parameter "url"'

    try {
      new URL(url) // validate URL
    } catch {
      return `Error: Invalid URL: ${url}`
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; eco-agent/1.0; +https://github.com/eco-agent)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(15000)
      })

      if (!response.ok) return `Error: HTTP ${response.status} ${response.statusText} for ${url}`

      const contentType = response.headers.get('content-type') ?? ''
      const text = await response.text()

      let content: string
      if (contentType.includes('text/html')) {
        content = htmlToText(text)
      } else {
        content = text
      }

      const truncated = content.length > maxLength
      const result = truncated ? content.slice(0, maxLength) : content
      const suffix = truncated ? `\n\n...(truncated, ${content.length - maxLength} more characters)` : ''

      return `Content from ${url}:\n\n${result}${suffix}`
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError') return `Error: Request timed out for ${url}`
      return `Error fetching ${url}: ${err.message}`
    }
  }
}

// Export all new tools
export const extendedTools: Tool[] = [
  globFilesTool,
  grepSearchTool,
  editFileTool,
  patchFileTool,
  todoReadTool,
  todoWriteTool,
  fetchUrlTool,
]
