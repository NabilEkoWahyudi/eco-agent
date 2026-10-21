/**
 * Permission System
 * 
 * Provides rule-based permission checking before tool execution.
 * Supports allow/deny rules, per-session confirmation, and persistent saved rules.
 * 
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'

export type PermissionEffect = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  action: string          // e.g. 'run_shell', 'write_file', '*'
  resource?: string       // e.g. '/etc/*', 'rm *', '*'
  effect: PermissionEffect
  reason?: string
}

export type Ruleset = PermissionRule[]

export interface PermissionRequest {
  action: string
  resource?: string
  sessionId?: string
  description?: string
}

export interface PermissionResult {
  effect: PermissionEffect
  matchedRule?: PermissionRule
}

const ECO_PERMISSION_FILE = path.join(os.homedir(), '.eco-agent', 'permissions.json')

// Wildcard matcher: 'rm *' matches 'rm -rf /'
function matchesWildcard(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern === value) return true
  // Convert glob * to regex
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return regex.test(value)
}

/**
 * Evaluate a permission request against a ruleset.
 * Returns the first matching rule's effect, or 'ask' if no rule matches.
 */
export function evaluatePermission(request: PermissionRequest, rules: Ruleset): PermissionResult {
  for (const rule of rules) {
    const actionMatches = matchesWildcard(rule.action, request.action)
    // A rule without resource = global rule (matches any resource).
    // A rule WITH a specific resource must NOT match requests that carry no
    // resource at all — previously `!request.resource` made a rule like
    // "allow /project/a.txt" silently match every resourceless action.
    const resourceMatches = !rule.resource
      ? true
      : !request.resource
        ? false
        : matchesWildcard(rule.resource, request.resource)
    if (actionMatches && resourceMatches) {
      return { effect: rule.effect, matchedRule: rule }
    }
  }
  return { effect: 'ask' }
}

// In-memory session permissions (reset on restart)
const sessionRules: Map<string, Ruleset> = new Map()

// Load saved persistent rules
export function loadSavedRules(): Ruleset {
  try {
    if (existsSync(ECO_PERMISSION_FILE)) {
      return JSON.parse(readFileSync(ECO_PERMISSION_FILE, 'utf-8')) as Ruleset
    }
  } catch { /* ignore */ }
  return []
}

// Save a rule persistently
export function saveRule(rule: PermissionRule): void {
  try {
    const dir = path.dirname(ECO_PERMISSION_FILE)
    mkdirSync(dir, { recursive: true })
    const current = loadSavedRules()
    // Remove duplicate rules
    const filtered = current.filter(r => !(r.action === rule.action && r.resource === rule.resource))
    filtered.push(rule)
    writeFileSync(ECO_PERMISSION_FILE, JSON.stringify(filtered, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

// Add a rule for the current session only
export function addSessionRule(sessionId: string, rule: PermissionRule): void {
  const rules = sessionRules.get(sessionId) ?? []
  rules.unshift(rule)
  sessionRules.set(sessionId, rules)
}

// Clear session rules
export function clearSessionRules(sessionId: string): void {
  sessionRules.delete(sessionId)
}

/**
 * Permission manager - combines session and persistent rules.
 * Asks the user interactively if no rule matches.
 */
export class PermissionManager {
  private sessionId: string
  private defaultRules: Ruleset

  constructor(sessionId: string) {
    this.sessionId = sessionId
    // Default safe rules: allow read operations, ask for destructive ones
    this.defaultRules = [
      { action: 'read_file', effect: 'allow' },
      { action: 'list_directory', effect: 'allow' },
      { action: 'search_files', effect: 'allow' },
      { action: 'list_code_files', effect: 'allow' },
      { action: 'web_search', effect: 'allow' },
      { action: 'glob_files', effect: 'allow' },
      { action: 'grep_search', effect: 'allow' },
      { action: 'todo_read', effect: 'allow' },
    ]
  }

  /**
   * Check permission for a tool action.
   * Returns true if allowed, false if denied.
   * Prompts user interactively if no matching rule found.
   */
  async check(request: PermissionRequest, onAsk?: (req: PermissionRequest) => Promise<'allow' | 'deny' | 'always' | 'never'>): Promise<boolean> {
    // Check session rules first (highest priority)
    const sessionRuleSet = sessionRules.get(this.sessionId) ?? []
    const sessionResult = evaluatePermission(request, sessionRuleSet)
    if (sessionResult.effect !== 'ask') {
      return sessionResult.effect === 'allow'
    }

    // Check saved persistent rules
    const savedRules = loadSavedRules()
    const savedResult = evaluatePermission(request, savedRules)
    if (savedResult.effect !== 'ask') {
      return savedResult.effect === 'allow'
    }

    // Check default rules
    const defaultResult = evaluatePermission(request, this.defaultRules)
    if (defaultResult.effect !== 'ask') {
      return defaultResult.effect === 'allow'
    }

    // If no callback, deny unknown by default
    if (!onAsk) return false

    // Ask user
    const reply = await onAsk(request)
    if (reply === 'always') {
      saveRule({ action: request.action, resource: request.resource, effect: 'allow' })
      return true
    }
    if (reply === 'never') {
      saveRule({ action: request.action, resource: request.resource, effect: 'deny' })
      return false
    }
    if (reply === 'allow') {
      addSessionRule(this.sessionId, { action: request.action, resource: request.resource, effect: 'allow' })
      return true
    }
    // deny - only for this request
    return false
  }

  /**
   * Get combined ruleset for display purposes.
   */
  getRules(): Ruleset {
    return [
      ...(sessionRules.get(this.sessionId) ?? []),
      ...loadSavedRules(),
      ...this.defaultRules
    ]
  }
}

/**
 * Categorize tool danger level.
 * Used to decide whether to ask for permission.
 */
export const TOOL_DANGER_LEVELS: Record<string, 'safe' | 'caution' | 'dangerous'> = {
  'read_file': 'safe',
  'list_directory': 'safe',
  'search_files': 'safe',
  'list_code_files': 'safe',
  'web_search': 'safe',
  'glob_files': 'safe',
  'grep_search': 'safe',
  'todo_read': 'safe',
  'todo_write': 'safe',
  'write_file': 'caution',
  'create_directory': 'caution',
  'rename_path': 'caution',
  'patch_file': 'caution',
  'run_shell': 'dangerous',
  'delete_path': 'dangerous',
}

export function getToolDangerLevel(toolName: string): 'safe' | 'caution' | 'dangerous' {
  return TOOL_DANGER_LEVELS[toolName] ?? 'caution'
}
