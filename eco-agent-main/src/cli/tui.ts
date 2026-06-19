import chalk from 'chalk'
import ansiEscapes from 'ansi-escapes'

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class Spinner {
  private frame = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private message: string

  constructor(message = 'Thinking...') {
    this.message = message
  }

  start() {
    process.stdout.write(ansiEscapes.cursorHide)
    this.timer = setInterval(() => {
      const icon = chalk.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length])
      process.stdout.write(`\r  ${icon}  ${chalk.gray(this.message)}`)
      this.frame++
    }, 80)
  }

  update(message: string) {
    this.message = message
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    process.stdout.write('\r' + ' '.repeat(this.message.length + 10) + '\r')
    process.stdout.write(ansiEscapes.cursorShow)
  }
}

// ─── Syntax highlighter (manual, no deps) ────────────────────────────────────

function highlightCode(code: string, lang = ''): string {
  const l = lang.toLowerCase()

  // Keywords per language
  const keywords: Record<string, string[]> = {
    js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'new', 'this', 'typeof', 'null', 'undefined', 'true', 'false', 'try', 'catch', 'throw'],
    ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'new', 'this', 'typeof', 'null', 'undefined', 'true', 'false', 'try', 'catch', 'throw', 'interface', 'type', 'extends', 'implements', 'string', 'number', 'boolean'],
    py: ['def', 'class', 'return', 'if', 'else', 'elif', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'raise', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'break', 'continue'],
    sh: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'echo', 'export', 'source'],
  }

  const langMap: Record<string, string> = {
    javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh', sh: 'sh'
  }

  const kws = keywords[langMap[l] ?? l] ?? keywords['js']

  return code
    .split('\n')
    .map(line => {
      // Comments
      if (line.trim().startsWith('#') || line.trim().startsWith('//')) {
        return chalk.gray(line)
      }
      // Strings
      line = line.replace(/(["'`])(.*?)\1/g, (_, q, s) => chalk.green(`${q}${s}${q}`))
      // Numbers
      line = line.replace(/\b(\d+\.?\d*)\b/g, chalk.yellow('$1'))
      // Keywords
      kws.forEach(kw => {
        line = line.replace(new RegExp(`\\b(${kw})\\b`, 'g'), chalk.magenta('$1'))
      })
      // Function calls
      line = line.replace(/\b([a-zA-Z_]\w*)\s*\(/g, chalk.blue('$1') + '(')
      return line
    })
    .join('\n')
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

export function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inCodeBlock = false
  let codeLang = ''
  let codeLines: string[] = []

  for (const line of lines) {
    // Code block start/end
    const codeMatch = line.match(/^```(\w*)$/)
    if (codeMatch && !inCodeBlock) {
      inCodeBlock = true
      codeLang = codeMatch[1] ?? ''
      codeLines = []
      continue
    }
    if (line.trim() === '```' && inCodeBlock) {
      inCodeBlock = false
      const highlighted = highlightCode(codeLines.join('\n'), codeLang)
      const border = chalk.gray('  ┌' + '─'.repeat(60) + '┐')
      const footer = chalk.gray('  └' + '─'.repeat(60) + '┘')
      const label = codeLang ? chalk.gray(` ${codeLang}`) : ''
      out.push(chalk.gray('  ┌─') + label + chalk.gray('─'.repeat(Math.max(0, 59 - codeLang.length)) + '┐'))
      highlighted.split('\n').forEach(l => {
        out.push(chalk.gray('  │ ') + l)
      })
      out.push(footer)
      void border
      codeLines = []
      continue
    }
    if (inCodeBlock) { codeLines.push(line); continue }

    // Headings
    const h3 = line.match(/^### (.+)/)
    const h2 = line.match(/^## (.+)/)
    const h1 = line.match(/^# (.+)/)
    if (h1) { out.push('\n  ' + chalk.bold.green(h1[1])); continue }
    if (h2) { out.push('\n  ' + chalk.bold.cyan(h2[1])); continue }
    if (h3) { out.push('  ' + chalk.bold(h3[1])); continue }

    // Horizontal rule
    if (line.match(/^---+$/)) { out.push(chalk.gray('  ' + '─'.repeat(60))); continue }

    // Bullet points
    const bullet = line.match(/^(\s*)[*\-+] (.+)/)
    if (bullet) {
      out.push(bullet[1] + '  ' + chalk.green('●') + ' ' + renderInline(bullet[2]))
      continue
    }

    // Numbered list
    const numbered = line.match(/^(\s*)(\d+)\. (.+)/)
    if (numbered) {
      out.push(numbered[1] + '  ' + chalk.cyan(numbered[2] + '.') + ' ' + renderInline(numbered[3]))
      continue
    }

    // Blockquote
    const quote = line.match(/^> (.+)/)
    if (quote) {
      out.push(chalk.gray('  ▎ ') + chalk.italic.gray(quote[1]))
      continue
    }

    // Regular text with inline formatting
    out.push(line ? '  ' + renderInline(line) : '')
  }

  return out.join('\n')
}

function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, chalk.bold('$1'))
    .replace(/\*(.+?)\*/g, chalk.italic('$1'))
    .replace(/`(.+?)`/g, chalk.bgGray.white(' $1 '))
    .replace(/\[(.+?)\]\((.+?)\)/g, chalk.cyan.underline('$1') + chalk.gray(' ($2)'))
}

// ─── Status bar ───────────────────────────────────────────────────────────────

export class StatusBar {
  private mode: string
  private model: string
  private sessionId?: string
  private msgCount = 0
  private pluginCount = 0
  private tokens = 0
  private cwd = process.cwd()

  constructor(mode: string, model: string, pluginCount = 0) {
    this.mode = mode
    this.model = model
    this.pluginCount = pluginCount
  }

  update(opts: { sessionId?: string; msgCount?: number; tokens?: number; cwd?: string }) {
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId
    if (opts.msgCount !== undefined) this.msgCount = opts.msgCount
    if (opts.tokens !== undefined) this.tokens = opts.tokens
    if (opts.cwd !== undefined) this.cwd = opts.cwd
  }

  render(): string {
    const termWidth = process.stdout.columns || 80
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const shortCwd = this.cwd.startsWith(home)
      ? '~' + this.cwd.slice(home.length)
      : this.cwd
    const modeTag = this.mode === 'mock'
      ? chalk.bgYellow.black(' MOCK ')
      : this.mode === 'openrouter'
        ? chalk.bgMagenta.black(' OPENROUTER ')
        : this.mode === 'ollama'
          ? chalk.bgBlue.black(' OLLAMA ')
          : chalk.bgCyan.black(' GROQ ')
    const modelStr = chalk.gray(this.model)
    const cwdStr = chalk.dim.yellow(shortCwd)
    const session = this.sessionId
      ? chalk.gray(`session:${this.sessionId.slice(0, 8)}`)
      : chalk.gray('no session')
    const msgs = chalk.gray(`${this.msgCount} msgs`)
    const tks = this.tokens > 0 ? chalk.gray(` · ${this.tokens.toLocaleString()} tkns`) : ''
    const plugins = this.pluginCount > 0 ? chalk.gray(` · ${this.pluginCount} plugins`) : ''
    const right = `${msgs}${tks} · ${session}${plugins}`
    const left = ` ${modeTag} ${modelStr}  ${cwdStr} `
    const gap = Math.max(1, termWidth - left.replace(/\x1b\[[0-9;]*m/g, '').length - right.replace(/\x1b\[[0-9;]*m/g, '').length - 2)
    return chalk.bgBlack(left + ' '.repeat(gap) + right + ' ')
  }

  print() {
    process.stdout.write('\n' + this.render() + '\n\n')
  }
}

// ─── Tool call box ────────────────────────────────────────────────────────────

export function renderToolCall(toolName: string, args: Record<string, unknown>): string {
  const argsStr = JSON.stringify(args, null, 2)
  const lines = argsStr.split('\n')
  
  // Ambil maksimal 5 baris pertama untuk preview
  let displayLines = lines.slice(0, 5)
  if (lines.length > 5) {
    displayLines.push('  ...')
  }

  // Potong teks tiap baris agar tidak melebihi lebar maksimal box
  const MAX_WIDTH = 70
  displayLines = displayLines.map(l => {
    // Kurangi space untuk border dan margin
    const maxLineLen = MAX_WIDTH - 4 
    return l.length > maxLineLen ? l.slice(0, maxLineLen - 3) + '...' : l
  })

  const maxLen = Math.max(toolName.length + 4, ...displayLines.map(l => l.length))
  const width = Math.min(maxLen + 4, MAX_WIDTH)

  const top = chalk.yellow('  ╭─ ') + chalk.bold.yellow(`⚙ ${toolName}`) + chalk.yellow(' ' + '─'.repeat(Math.max(0, width - toolName.length - 5)) + '╮')
  const body = displayLines.map(l => chalk.yellow('  │ ') + chalk.gray(l.padEnd(width - 4)) + chalk.yellow(' │')).join('\n')
  const bottom = chalk.yellow('  ╰' + '─'.repeat(width) + '╯')

  return `\n${top}\n${body}\n${bottom}`
}

export function renderToolResult(toolName: string, result: string, error: boolean): string {
  const icon = error ? chalk.red('✗') : chalk.green('✓')
  const color = error ? chalk.red : chalk.gray
  const preview = result.slice(0, 200).replace(/\n/g, ' ')
  return `  ${icon} ${chalk.gray(toolName + ':')} ${color(preview + (result.length > 200 ? '…' : ''))}`
}

// ─── Divider ──────────────────────────────────────────────────────────────────

export function renderDivider(label = ''): string {
  const width = (process.stdout.columns || 80) - 4
  if (!label) return chalk.gray('  ' + '─'.repeat(width))
  const line = '─'.repeat(Math.max(0, (width - label.length - 2) / 2))
  return chalk.gray(`  ${line} ${label} ${line}`)
}

// ─── Simple Diff Renderer ─────────────────────────────────────────────────────

export function renderDiff(oldContent: string, newContent: string): string {
  if (oldContent === newContent) return chalk.gray('  (No changes)')
  
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  
  const out: string[] = []
  // Very basic diff just for previewing writes (could be improved with a real diff library)
  // For now, we'll just show the new content if old is empty, or show a replaced message
  if (!oldContent) {
    out.push(chalk.green('  + New file contents:'))
    newLines.slice(0, 10).forEach(l => out.push(chalk.green('  + ') + chalk.gray(l)))
    if (newLines.length > 10) out.push(chalk.gray(`  ... and ${newLines.length - 10} more lines.`))
  } else {
    out.push(chalk.yellow('  ~ File will be overwritten. Preview of new contents:'))
    newLines.slice(0, 10).forEach(l => out.push(chalk.yellow('  ~ ') + chalk.gray(l)))
    if (newLines.length > 10) out.push(chalk.gray(`  ... and ${newLines.length - 10} more lines.`))
  }
  
  return out.join('\n')
}

