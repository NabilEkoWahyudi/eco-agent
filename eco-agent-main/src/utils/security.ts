import chalk from 'chalk'

// ─── Shell command safety ─────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  // Destructive filesystem
  /rm\s+-rf\s+\/(?!\w)/,
  /rm\s+-rf\s+~\/?$/,
  /rm\s+--no-preserve-root/,
  /mkfs/,
  /fdisk/,
  /dd\s+if=\/dev\/zero/,
  /shred/,
  // Fork bombs & resource exhaustion
  /:\(\)\s*\{.*\}/,
  /while\s*true.*do/,
  // Network exfiltration patterns
  /curl.*\|\s*(bash|sh|zsh)/,
  /wget.*\|\s*(bash|sh|zsh)/,
  // Privilege escalation
  /sudo\s+chmod\s+777\s+\/etc/,
  /sudo\s+rm\s+-rf/,
  // Crypto miners
  /xmrig|minerd|cgminer/,
  // Environment manipulation
  /unset\s+HOME/,
  /chmod\s+000\s+/,
]

const WARN_PATTERNS = [
  { pattern: /rm\s+-rf/, message: 'Recursive delete detected' },
  { pattern: /sudo/, message: 'Sudo command' },
  { pattern: /chmod\s+[0-7]*7[0-7]*\s+/, message: 'Broad permission change' },
  { pattern: />\s*\/etc\//, message: 'Writing to /etc/' },
  { pattern: /curl|wget/, message: 'Network request' },
  { pattern: /eval\s*\(/, message: 'eval() detected' },
  { pattern: /npm\s+install\s+-g/, message: 'Global npm install' },
]

export interface ShellCheckResult {
  allowed: boolean
  blocked?: string
  warnings: string[]
}

export function checkShellCommand(cmd: string): ShellCheckResult {
  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        allowed: false,
        blocked: `Command matches blocked pattern: ${pattern.toString()}`,
        warnings: []
      }
    }
  }

  // Check warning patterns
  const warnings: string[] = []
  for (const { pattern, message } of WARN_PATTERNS) {
    if (pattern.test(cmd)) warnings.push(message)
  }

  return { allowed: true, warnings }
}

// ─── API Key validation ────────────────────────────────────────────────────────

export function validateGroqKey(key: string): { valid: boolean; reason?: string } {
  if (!key.startsWith('gsk_')) return { valid: false, reason: 'Must start with gsk_' }
  if (key.length < 40) return { valid: false, reason: 'Key too short' }
  if (!/^gsk_[a-zA-Z0-9]+$/.test(key)) return { valid: false, reason: 'Invalid characters' }
  return { valid: true }
}

export function validateOpenRouterKey(key: string): { valid: boolean; reason?: string } {
  if (!key.startsWith('sk-or-')) return { valid: false, reason: 'Must start with sk-or-' }
  if (key.length < 20) return { valid: false, reason: 'Key too short' }
  return { valid: true }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

export class RateLimiter {
  private requests: number[] = []
  private maxRequests: number
  private windowMs: number

  constructor(maxRequests = 30, windowMs = 60000) {
    this.maxRequests = maxRequests
    this.windowMs = windowMs
  }

  check(): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now()
    this.requests = this.requests.filter(t => now - t < this.windowMs)

    if (this.requests.length >= this.maxRequests) {
      const oldest = this.requests[0]
      const retryAfterMs = this.windowMs - (now - oldest)
      return { allowed: false, retryAfterMs }
    }

    this.requests.push(now)
    return { allowed: true }
  }

  remaining(): number {
    const now = Date.now()
    this.requests = this.requests.filter(t => now - t < this.windowMs)
    return Math.max(0, this.maxRequests - this.requests.length)
  }
}

// ─── File path safety ─────────────────────────────────────────────────────────

const SENSITIVE_PATHS = [
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\/etc\/sudoers/,
  /\.ssh\/(id_rsa|id_ed25519|authorized_keys)$/,
  /\.aws\/credentials/,
  /\.gnupg\//,
  /keychain/i,
]

export function checkFilePath(filePath: string): { safe: boolean; reason?: string } {
  for (const pattern of SENSITIVE_PATHS) {
    if (pattern.test(filePath)) {
      return { safe: false, reason: `Access to sensitive path blocked: ${filePath}` }
    }
  }
  return { safe: true }
}

// ─── Plugin safety warning ────────────────────────────────────────────────────

export function pluginSafetyWarning(packageName: string): string {
  return [
    chalk.yellow(`  ⚠ Security warning`),
    chalk.gray(`  You are about to install: ${chalk.white(packageName)}`),
    chalk.gray('  Plugins run with full access to your filesystem and shell.'),
    chalk.gray('  Only install plugins from sources you trust.'),
  ].join('\n')
}
