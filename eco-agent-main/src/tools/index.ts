import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, extname } from 'path'
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
  description: 'Write content to a file. Creates the file if it does not exist.',
  parameters: {
    path: { type: 'string', description: 'Path to write to', required: true },
    content: { type: 'string', description: 'Content to write', required: true }
  },
  async execute(args) {
    const filePath = resolve(args.path as string)

    const safety = checkFilePath(filePath)
    if (!safety.safe) return `Error: ${safety.reason}`

    try {
      writeFileSync(filePath, args.content as string, 'utf-8')
      return `Successfully wrote to ${filePath}`
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
      console.warn(`  ⚠ Shell warnings: ${check.warnings.join(', ')}`)
    }

    try {
      const output = execSync(cmd, {
        cwd,
        timeout: 30000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      return output || '(command completed with no output)'
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string }
      const out = err.stdout ? `stdout:\n${err.stdout}\n` : ''
      const errOut = err.stderr ? `stderr:\n${err.stderr}` : err.message ?? 'Unknown error'
      return `Command failed:\n${out}${errOut}`
    }
  }
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description: 'Search for text in files within a directory',
  parameters: {
    pattern: { type: 'string', description: 'Text or regex pattern to search for', required: true },
    path: { type: 'string', description: 'Directory to search in (default: current)', required: false },
    extension: { type: 'string', description: 'Filter by file extension e.g. ts, py', required: false }
  },
  async execute(args) {
    const pattern = args.pattern as string
    const searchPath = resolve((args.path as string) ?? '.')
    const ext = args.extension as string | undefined

    try {
      const grepCmd = ext
        ? `grep -rn "${pattern}" ${searchPath} --include="*.${ext}" 2>/dev/null | head -50`
        : `grep -rn "${pattern}" ${searchPath} 2>/dev/null | head -50`

      const output = execSync(grepCmd, { encoding: 'utf-8', timeout: 10000 })
      return output || `No matches found for: ${pattern}`
    } catch (e) {
      const err = e as { stdout?: string }
      return err.stdout || `No matches found for: ${pattern}`
    }
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

export const defaultTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  shellTool,
  searchFilesTool,
  listCodeFilesTool
]
