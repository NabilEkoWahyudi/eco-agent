/**
 * Skill System 
 * Loads "skills" from SKILL.md files in known directories.
 * Skills are instruction files that extend the system prompt with specialized context.
 * 
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

export interface SkillInfo {
  id: string
  name: string
  path: string
  content: string
  source: 'local' | 'global' | 'project'
  files: string[]
}

function getSkillSearchDirs(): string[] {
  // Computed lazily (not at import time) so /cd changes the search scope
  return [
    path.join(os.homedir(), '.eco-agent', 'skills'),
    path.join(process.cwd(), '.eco-agent', 'skills'),
    path.join(process.cwd(), '.agents', 'skills'),
  ]
}

const SKILL_FILENAME = 'SKILL.md'

function hashPath(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 12)
}

function parseSkillName(content: string, fallbackName: string): string {
  // Normalize CRLF — on Windows files, `$` in multiline mode keeps the `\r`,
  // which corrupts names like "my-skill\r"
  const normalized = content.replace(/\r\n/g, '\n')
  // Try to extract name from frontmatter: `name: my-skill`
  const frontmatter = normalized.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m)
    if (nameMatch) return nameMatch[1].trim()
  }
  // Try first H1 heading
  const h1 = normalized.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return fallbackName
}

function listSkillFiles(skillDir: string): string[] {
  // Directories never worth walking into — a stray node_modules can add
  // thousands of entries and drown the skill's real files.
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__'])
  try {
    const files: string[] = []
    function walk(dir: string, relative: string) {
      readdirSync(dir).forEach(entry => {
        if (entry === SKILL_FILENAME) return
        if (SKIP_DIRS.has(entry)) return
        const full = path.join(dir, entry)
        const rel = path.join(relative, entry)
        try {
          if (statSync(full).isDirectory()) walk(full, rel)
          else files.push(rel)
        } catch { /* skip */ }
      })
    }
    walk(skillDir, '')
    return files.slice(0, 20) // Cap at 20 files per skill
  } catch {
    return []
  }
}

/**
 * Discover and load all skills from known directories.
 */
export function loadAllSkills(searchDirs?: string[]): SkillInfo[] {
  const dirs = searchDirs ?? getSkillSearchDirs()
  const skills: SkillInfo[] = []
  const seenIds = new Set<string>()

  for (const baseDir of dirs) {
    if (!existsSync(baseDir)) continue
    try {
      const entries = readdirSync(baseDir)
      for (const entry of entries) {
        const skillDir = path.join(baseDir, entry)
        const skillFile = path.join(skillDir, SKILL_FILENAME)

        let skillFilePath = skillFile
        let isDir = false
        
        try {
          isDir = statSync(skillDir).isDirectory()
        } catch { continue }

        // Support both: skills/my-skill/SKILL.md and skills/my-skill.md
        if (!isDir) {
          if (entry.endsWith('.md')) {
            skillFilePath = skillDir
          } else continue
        }

        if (!existsSync(skillFilePath)) continue

        try {
          const content = readFileSync(skillFilePath, 'utf-8')
          const name = parseSkillName(content, isDir ? entry : entry.replace(/\.md$/, ''))
          const id = hashPath(skillFilePath)

          if (seenIds.has(id)) continue
          seenIds.add(id)

          const files = isDir ? listSkillFiles(skillDir) : []

          // Determine source from path
          let source: 'local' | 'global' | 'project' = 'local'
          if (skillFilePath.startsWith(os.homedir())) source = 'global'
          else if (skillFilePath.startsWith(process.cwd())) source = 'project'

          skills.push({ id, name, path: skillFilePath, content, source, files })
        } catch { /* skip */ }
      }
    } catch { /* skip dir */ }
  }
  return skills
}

/**
 * Format a skill for injection into the system prompt.
 * Matches opencode's XML-tagged skill format.
 */
export function formatSkillForPrompt(skill: SkillInfo): string {
  const lines = [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    '',
    skill.content.trim(),
  ]

  if (skill.files.length > 0) {
    const skillDir = path.dirname(skill.path)
    lines.push('')
    lines.push(`Base directory for this skill: ${skillDir}`)
    lines.push('Relative paths in this skill are relative to this base directory.')
    lines.push('')
    lines.push('<skill_files>')
    for (const file of skill.files) {
      lines.push(`<file>${file}</file>`)
    }
    lines.push('</skill_files>')
  }
  lines.push('</skill_content>')
  return lines.join('\n')
}

/**
 * Build a skills section for the system prompt.
 */
export function buildSkillsSystemPrompt(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''
  return [
    '\n## Active Skills\n',
    ...skills.map(s => formatSkillForPrompt(s))
  ].join('\n')
}

/**
 * Get a specific skill by name or id.
 */
export function getSkill(nameOrId: string, searchDirs?: string[]): SkillInfo | undefined {
  const skills = loadAllSkills(searchDirs)
  return skills.find(s => s.name === nameOrId || s.id === nameOrId)
}
