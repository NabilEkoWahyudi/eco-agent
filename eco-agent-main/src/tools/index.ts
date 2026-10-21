import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, renameSync } from 'fs'
import { spawnSync } from 'child_process'
import { resolve, extname, join } from 'path'
import type { Tool } from '../utils/types.js'
import { checkShellCommand, checkFilePath } from '../utils/security.js'

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file from the filesystem',
  parameters: {
    path: { type: 'string', description: 'Path to the file to read', required: true }
  },
  async execute(args) {
    const filePath = resolve(args.path as string)

    const safety = checkFilePath(filePath)
    if (!safety.safe) return `Error: ${safety.reason}`

    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').length
      return `File: ${filePath} (${lines} lines)\n\n${content}`
    } catch (e) {
      return `Error reading file: ${(e as Error).message}`
    }
  }
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file if it does not exist. After a successful write, the task is COMPLETE — do NOT call write_file again for the same file.',
  parameters: {
    path: { type: 'string', description: 'Path to write to', required: true },
    content: { type: 'string', description: 'Content to write', required: true }
  },
  async execute(args) {
    const filePath = resolve(args.path as string)

    const safety = checkFilePath(filePath)
    if (!safety.safe) return `Error: ${safety.reason}`

    try {
      const dirPath = resolve(filePath, '..')
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }
      writeFileSync(filePath, args.content as string, 'utf-8')
      const lines = (args.content as string).split('\n').length
      return `SUCCESS: File written to ${filePath} (${lines} lines). The file is saved and ready. Do NOT write to this file again unless the user asks for changes.`
    } catch (e) {
      return `Error writing file: ${(e as Error).message}`
    }
  }
}

export const listDirTool: Tool = {
  name: 'list_directory',
  description: 'List files and directories at a given path',
  parameters: {
    path: { type: 'string', description: 'Directory path (default: current dir)', required: false }
  },
  async execute(args) {
    const dirPath = resolve((args.path as string) ?? '.')
    if (!existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`
    try {
      const entries = readdirSync(dirPath)
      const lines = entries.map(entry => {
        const fullPath = `${dirPath}/${entry}`
        const stat = statSync(fullPath)
        const type = stat.isDirectory() ? 'dir' : 'file'
        const size = stat.isFile() ? `${stat.size}b` : ''
        return `${type.padEnd(5)} ${entry}${size ? `  (${size})` : ''}`
      })
      return `Contents of ${dirPath}:\n\n${lines.join('\n')}`
    } catch (e) {
      return `Error listing directory: ${(e as Error).message}`
    }
  }
}

export const createDirTool: Tool = {
  name: 'create_directory',
  description: 'Create a new directory (including parent directories if needed)',
  parameters: {
    path: { type: 'string', description: 'Path to create', required: true }
  },
  async execute(args) {
    const dirPath = resolve(args.path as string)
    const safety = checkFilePath(dirPath)
    if (!safety.safe) return `Error: ${safety.reason}`

    try {
      mkdirSync(dirPath, { recursive: true })
      return `Successfully created directory ${dirPath}`
    } catch (e) {
      return `Error creating directory: ${(e as Error).message}`
    }
  }
}

export const deletePathTool: Tool = {
  name: 'delete_path',
  description: 'Delete a file or directory (recursively)',
  parameters: {
    path: { type: 'string', description: 'Path to delete', required: true }
  },
  async execute(args) {
    const targetPath = resolve(args.path as string)
    const safety = checkFilePath(targetPath)
    if (!safety.safe) return `Error: ${safety.reason}`

    try {
      if (!existsSync(targetPath)) return `Error: Path not found: ${targetPath}`
      rmSync(targetPath, { recursive: true, force: true })
      return `Successfully deleted ${targetPath}`
    } catch (e) {
      return `Error deleting path: ${(e as Error).message}`
    }
  }
}

export const renamePathTool: Tool = {
  name: 'rename_path',
  description: 'Rename or move a file or directory',
  parameters: {
    oldPath: { type: 'string', description: 'Current path', required: true },
    newPath: { type: 'string', description: 'New path', required: true }
  },
  async execute(args) {
    const oldPath = resolve(args.oldPath as string)
    const newPath = resolve(args.newPath as string)
    
    const safety1 = checkFilePath(oldPath)
    if (!safety1.safe) return `Error: ${safety1.reason}`
    const safety2 = checkFilePath(newPath)
    if (!safety2.safe) return `Error: ${safety2.reason}`

    try {
      if (!existsSync(oldPath)) return `Error: Path not found: ${oldPath}`
      renameSync(oldPath, newPath)
      return `Successfully renamed ${oldPath} to ${newPath}`
    } catch (e) {
      return `Error renaming path: ${(e as Error).message}`
    }
  }
}

export const shellTool: Tool = {
  name: 'run_shell',
  description: 'Run a shell command and return its output. Dangerous commands are blocked.',
  parameters: {
    command: { type: 'string', description: 'Shell command to execute', required: true },
    cwd: { type: 'string', description: 'Working directory (optional)', required: false }
  },
  async execute(args) {
    const cmd = args.command as string
    const cwd = args.cwd ? resolve(args.cwd as string) : process.cwd()

    // Security check
    const check = checkShellCommand(cmd)
    if (!check.allowed) {
      return `Error: Command blocked for safety. ${check.blocked}`
    }
    if (check.warnings.length > 0) {
      console.warn(`  ! Shell warnings: ${check.warnings.join(', ')}`)
    }

    try {
      // spawnSync (not execSync) so stdout AND stderr are always captured
      // separately — execSync only returns stdout on success and drops
      // stderr, which produced garbled output like
      //   "stderr: File Not FoundAhmad\Downloads Volume in drive C has no label."
      const res = spawnSync(cmd, {
        cwd,
        shell: true,
        windowsHide: true,
        timeout: 30000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      })

      if (res.error) {
        return `Command failed: ${res.error.message}`
      }

      const stdout = (res.stdout ?? '').trim()
      const stderr = (res.stderr ?? '').trim()

      if (res.status !== 0) {
        const parts: string[] = []
        if (stdout) parts.push(`stdout:\n${stdout}`)
        if (stderr) parts.push(`stderr:\n${stderr}`)
        parts.push(`exit code: ${res.status}`)
        return `Command failed:\n${parts.join('\n')}`
      }

      if (stdout) return stdout
      if (stderr) return stderr
      return '(command completed with no output)'
    } catch (e) {
      return `Command failed: ${(e as Error).message}`
    }
  }
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description: 'Search for text in files within a directory. Patterns are regular expressions.',
  parameters: {
    pattern: { type: 'string', description: 'Text or regex pattern to search for', required: true },
    path: { type: 'string', description: 'Directory to search in (default: current)', required: false },
    extension: { type: 'string', description: 'Filter by file extension e.g. ts, py', required: false }
  },
  /**
   * BUG FIX: this used to shell out to `grep -rn`, which does not exist on
   * Windows cmd.exe (the tool failed 100% of the time on Windows) and allowed
   * shell injection via an unquoted pattern. Now implemented natively in
   * JavaScript so it works identically on Windows/macOS/Linux.
   */
  async execute(args) {
    const pattern = args.pattern as string
    const searchPath = resolve((args.path as string) ?? '.')
    const ext = args.extension as string | undefined

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (e) {
      return `Error: Invalid regex pattern: ${(e as Error).message}`
    }

    if (!existsSync(searchPath)) return `Error: Directory not found: ${searchPath}`

    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'])
    const matches: string[] = []
    const MAX_RESULTS = 50

    function walk(dir: string): void {
      if (matches.length >= MAX_RESULTS) return
      let entries: string[]
      try { entries = readdirSync(dir) } catch { return }
      for (const entry of entries) {
        if (matches.length >= MAX_RESULTS) return
        if (IGNORE.has(entry)) continue
        const full = join(dir, entry)
        let stat: ReturnType<typeof statSync>
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) { walk(full); continue }
        if (ext && extname(entry) !== '.' + ext.replace(/^\./, '')) continue
        let content: string
        try { content = readFileSync(full, 'utf-8') } catch { continue } // skip binary/unreadable
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && matches.length < MAX_RESULTS; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          }
        }
      }
    }

    walk(searchPath)
    if (matches.length === 0) return `No matches found for: ${pattern}`
    const truncated = matches.length >= MAX_RESULTS ? `\n\n(Showing first ${MAX_RESULTS} matches)` : ''
    return `Search results for "${pattern}" in ${searchPath}:\n\n${matches.join('\n')}${truncated}`
  }
}

// List only non-sensitive file types for security
export const listCodeFilesTool: Tool = {
  name: 'list_code_files',
  description: 'List all code files in the project (ignores node_modules, .git, etc.)',
  parameters: {
    path: { type: 'string', description: 'Root directory (default: current)', required: false }
  },
  async execute(args) {
    const root = resolve((args.path as string) ?? '.')
    const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cs', '.md', '.json', '.yaml', '.yml', '.toml', '.sh'])
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'])

    const files: string[] = []
    function walk(dir: string) {
      try {
        readdirSync(dir).forEach(entry => {
          if (IGNORE.has(entry)) return
          const full = `${dir}/${entry}`
          const stat = statSync(full)
          if (stat.isDirectory()) walk(full)
          else if (CODE_EXTS.has(extname(entry))) files.push(full.replace(root + '/', ''))
        })
      } catch { /* skip */ }
    }
    walk(root)
    return `Code files in ${root} (${files.length} total):\n\n${files.join('\n')}`
  }
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for real-time information. Supports Tavily (set TAVILY_API_KEY), Brave (set BRAVE_API_KEY), SearXNG (set SEARXNG_URL), or DuckDuckGo (default, no key needed).',
  parameters: {
    query: { type: 'string', description: 'Search query', required: true }
  },
  async execute(args) {
    const rawQuery = args.query as string
    if (!rawQuery) return 'Error: Missing required parameter "query"'

    try {
      const { multiSearch, formatSearchResponse } = await import('./websearch.js')
      const response = await multiSearch(rawQuery)
      return formatSearchResponse(response)
    } catch (e) {
      return `Error searching the web: ${(e as Error).message}`
    }
  }
}

import { extendedTools } from './extended.js'

export const defaultTools: Tool[] = [
  readFileTool,
  writeFileTool,
  createDirTool,
  deletePathTool,
  renamePathTool,
  listDirTool,
  shellTool,
  searchFilesTool,
  listCodeFilesTool,
  webSearchTool,
  // Extended tools ported from opencode:
  ...extendedTools,
]
