import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, extname } from 'path'
import { execSync } from 'child_process'

export interface ProjectContext {
  name: string
  root: string
  type: string[]          // e.g. ['node', 'typescript', 'react']
  description?: string
  structure: string       // directory tree
  keyFiles: Record<string, string>  // filename -> content summary
  dependencies: string[]
  scripts: Record<string, string>
  gitBranch?: string
  gitStatus?: string
  createdAt: string
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', '.venv', 'venv',
  '.turbo', '.vercel', 'out', '.output'
])

const KEY_FILES = [
  'package.json', 'tsconfig.json', 'README.md', 'Makefile',
  'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'docker-compose.yml', 'Dockerfile', '.env.example',
  'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.ts'
]

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.java', '.c', '.cpp', '.cs', '.rb', '.php', '.swift'
])

function buildTree(dir: string, depth = 0, maxDepth = 3): string {
  if (depth > maxDepth) return ''
  const lines: string[] = []
  let entries: string[]

  try {
    entries = readdirSync(dir).filter(e => {
      if (e.startsWith('.') && e !== '.env.example') return false
      if (IGNORE_DIRS.has(e)) return false
      return true
    })
  } catch { return '' }

  entries.sort((a, b) => {
    const aDir = statSync(join(dir, a)).isDirectory()
    const bDir = statSync(join(dir, b)).isDirectory()
    if (aDir && !bDir) return -1
    if (!aDir && bDir) return 1
    return a.localeCompare(b)
  })

  entries.slice(0, 20).forEach((entry, i) => {
    const isLast = i === Math.min(entries.length, 20) - 1
    const prefix = '  '.repeat(depth) + (isLast ? '└─ ' : '├─ ')
    const fullPath = join(dir, entry)
    const isDir = statSync(fullPath).isDirectory()
    lines.push(prefix + entry + (isDir ? '/' : ''))
    if (isDir && depth < maxDepth) {
      lines.push(buildTree(fullPath, depth + 1, maxDepth))
    }
  })

  if (entries.length > 20) {
    lines.push('  '.repeat(depth) + `└─ ... (${entries.length - 20} more)`)
  }

  return lines.filter(Boolean).join('\n')
}

function detectProjectType(root: string, pkg: Record<string, unknown> | null): string[] {
  const types: string[] = []

  if (existsSync(join(root, 'package.json'))) types.push('node')
  if (existsSync(join(root, 'tsconfig.json'))) types.push('typescript')
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) types.push('python')
  if (existsSync(join(root, 'Cargo.toml'))) types.push('rust')
  if (existsSync(join(root, 'go.mod'))) types.push('go')
  if (existsSync(join(root, 'Dockerfile'))) types.push('docker')

  if (pkg?.dependencies) {
    const deps = pkg.dependencies as Record<string, string>
    if (deps['react']) types.push('react')
    if (deps['next']) types.push('next.js')
    if (deps['vue']) types.push('vue')
    if (deps['express'] || deps['fastify'] || deps['hono']) types.push('api-server')
    if (deps['electron']) types.push('electron')
  }

  return [...new Set(types)]
}

function countCodeFiles(dir: string): number {
  let count = 0
  try {
    readdirSync(dir).forEach(entry => {
      if (IGNORE_DIRS.has(entry)) return
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) count += countCodeFiles(full)
      else if (CODE_EXTENSIONS.has(extname(entry))) count++
    })
  } catch { /* skip */ }
  return count
}

function getGitInfo(root: string): { branch?: string; status?: string } {
  try {
    const branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim()
    const status = execSync('git status --short', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim()
    return { branch, status: status.slice(0, 500) }
  } catch {
    return {}
  }
}

export function scanProject(root: string): ProjectContext {
  // Read key files
  const keyFiles: Record<string, string> = {}
  let pkg: Record<string, unknown> | null = null

  for (const filename of KEY_FILES) {
    const filePath = join(root, filename)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8')
      if (filename === 'package.json') {
        pkg = JSON.parse(content) as Record<string, unknown>
        // Summarize package.json
        const summary = {
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          scripts: pkg.scripts,
          dependencies: Object.keys((pkg.dependencies as Record<string, string>) ?? {}),
          devDependencies: Object.keys((pkg.devDependencies as Record<string, string>) ?? {}).slice(0, 10)
        }
        keyFiles[filename] = JSON.stringify(summary, null, 2)
      } else if (filename === 'README.md') {
        // Only first 1000 chars of README
        keyFiles[filename] = content.slice(0, 1000) + (content.length > 1000 ? '\n...[truncated]' : '')
      } else {
        keyFiles[filename] = content.slice(0, 500)
      }
    } catch { /* skip */ }
  }

  const name = (pkg?.name as string) ?? root.split('/').pop() ?? 'unknown'
  const description = pkg?.description as string | undefined
  const scripts = (pkg?.scripts as Record<string, string>) ?? {}
  const dependencies = Object.keys((pkg?.dependencies as Record<string, string>) ?? {})
  const types = detectProjectType(root, pkg)
  const structure = buildTree(root)
  const { branch, status } = getGitInfo(root)
  const fileCount = countCodeFiles(root)

  return {
    name,
    root,
    type: types,
    description,
    structure: `Project: ${name} (${fileCount} code files)\n\n${structure}`,
    keyFiles,
    dependencies,
    scripts,
    gitBranch: branch,
    gitStatus: status,
    createdAt: new Date().toISOString()
  }
}

// ─── Eco project config file (.eco/context.json) ──────────────────────────────

const ECO_DIR_NAME = '.eco'
const CONTEXT_FILE = 'context.json'
const SYSTEM_PROMPT_FILE = 'prompt.md'

export function getEcoDir(root: string): string {
  return join(root, ECO_DIR_NAME)
}

export function saveProjectContext(root: string, context: ProjectContext): void {
  const ecoDir = getEcoDir(root)
  if (!existsSync(ecoDir)) {
    mkdirSync(ecoDir, { recursive: true })
  }
  writeFileSync(join(ecoDir, CONTEXT_FILE), JSON.stringify(context, null, 2), 'utf-8')
}

export function loadProjectContext(root: string): ProjectContext | null {
  const contextPath = join(root, ECO_DIR_NAME, CONTEXT_FILE)
  if (!existsSync(contextPath)) return null
  try {
    return JSON.parse(readFileSync(contextPath, 'utf-8')) as ProjectContext
  } catch { return null }
}

export function loadCustomPrompt(root: string): string | null {
  const promptPath = join(root, ECO_DIR_NAME, SYSTEM_PROMPT_FILE)
  if (!existsSync(promptPath)) return null
  try { return readFileSync(promptPath, 'utf-8') } catch { return null }
}

export function saveCustomPrompt(root: string, prompt: string): void {
  const ecoDir = getEcoDir(root)
  if (!existsSync(ecoDir)) {
    mkdirSync(ecoDir, { recursive: true })
  }
  writeFileSync(join(ecoDir, SYSTEM_PROMPT_FILE), prompt, 'utf-8')
}

export function buildSystemPromptWithContext(context: ProjectContext, customPrompt?: string | null): string {
  const keyFileSummary = Object.entries(context.keyFiles)
    .map(([f, c]) => `### ${f}\n\`\`\`\n${c}\n\`\`\``)
    .join('\n\n')

  return `You are Eco Agent, a powerful agentic AI assistant running in the terminal.
You have access to tools to read/write files, run shell commands, search codebases, and more.
When given a task, think step by step and use tools as needed to complete it.
Be concise, efficient, and always confirm before making destructive changes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROJECT CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Name: ${context.name}
Type: ${context.type.join(', ') || 'unknown'}
${context.description ? `Description: ${context.description}` : ''}
Root: ${context.root}
${context.gitBranch ? `Git branch: ${context.gitBranch}` : ''}
${context.gitStatus ? `Git status:\n${context.gitStatus}` : ''}

Dependencies: ${context.dependencies.slice(0, 20).join(', ')}${context.dependencies.length > 20 ? ` (+${context.dependencies.length - 20} more)` : ''}

Available scripts:
${Object.entries(context.scripts).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  none'}

Directory structure:
${context.structure}

Key files:
${keyFileSummary}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${customPrompt ? `\nCUSTOM INSTRUCTIONS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${customPrompt}\n` : ''}`
}
