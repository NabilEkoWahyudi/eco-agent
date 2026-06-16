import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Message } from '../utils/types.js'

const ECO_DIR = join(homedir(), '.eco-agent')
const SESSIONS_DIR = join(ECO_DIR, 'sessions')

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  provider: string
  model: string
}

export interface Session {
  meta: SessionMeta
  messages: Message[]
}

function ensureDirs() {
  if (!existsSync(ECO_DIR)) mkdirSync(ECO_DIR, { recursive: true })
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true })
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`)
}

function generateTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser) return 'Untitled session'
  const title = firstUser.content.replace(/\n/g, ' ').trim()
  return title.length > 50 ? title.slice(0, 47) + '...' : title
}

export function saveSession(
  messages: Message[],
  provider: string,
  model: string,
  existingId?: string
): SessionMeta {
  ensureDirs()

  const id = existingId ?? generateId()
  const now = new Date().toISOString()
  let createdAt = now
  let title = generateTitle(messages)

  if (existingId && existsSync(sessionPath(existingId))) {
    try {
      const existing = JSON.parse(readFileSync(sessionPath(existingId), 'utf-8')) as Session
      createdAt = existing.meta.createdAt
      title = existing.meta.title
    } catch { /* use defaults */ }
  }

  const meta: SessionMeta = { id, title, createdAt, updatedAt: now, messageCount: messages.length, provider, model }
  writeFileSync(sessionPath(id), JSON.stringify({ meta, messages }, null, 2), 'utf-8')
  return meta
}

export function loadSession(id: string): Session | null {
  const path = sessionPath(id)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Session } catch { return null }
}

export function listSessions(): SessionMeta[] {
  ensureDirs()
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return (JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8')) as Session).meta }
      catch { return null }
    })
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export function deleteSession(id: string): boolean {
  const path = sessionPath(id)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

export function renameSession(id: string, newTitle: string): boolean {
  const session = loadSession(id)
  if (!session) return false
  session.meta.title = newTitle
  session.meta.updatedAt = new Date().toISOString()
  writeFileSync(sessionPath(id), JSON.stringify(session, null, 2), 'utf-8')
  return true
}

export function getSessionsDir(): string {
  return SESSIONS_DIR
}

export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(isoDate).toLocaleDateString('en-US')
}
