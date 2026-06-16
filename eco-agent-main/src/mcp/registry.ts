import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { McpServerConfig, McpRegistry } from './types.js'

const ECO_DIR = join(homedir(), '.eco-agent')
const REGISTRY_FILE = join(ECO_DIR, 'mcp.json')

function ensureDir() {
  if (!existsSync(ECO_DIR)) mkdirSync(ECO_DIR, { recursive: true })
}

export function readRegistry(): McpRegistry {
  if (!existsSync(REGISTRY_FILE)) return { servers: [] }
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8')) as McpRegistry
  } catch {
    return { servers: [] }
  }
}

function writeRegistry(registry: McpRegistry) {
  ensureDir()
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8')
}

export function addServer(config: Omit<McpServerConfig, 'addedAt'>): { ok: boolean; message: string } {
  const registry = readRegistry()
  const existing = registry.servers.find(s => s.name === config.name)
  if (existing) {
    return { ok: false, message: `Server "${config.name}" already exists. Use mcp remove first.` }
  }
  registry.servers.push({ ...config, addedAt: new Date().toISOString() })
  writeRegistry(registry)
  return { ok: true, message: `MCP server "${config.name}" added.` }
}

export function removeServer(name: string): { ok: boolean; message: string } {
  const registry = readRegistry()
  const idx = registry.servers.findIndex(s => s.name === name)
  if (idx < 0) return { ok: false, message: `Server "${name}" not found.` }
  registry.servers.splice(idx, 1)
  writeRegistry(registry)
  return { ok: true, message: `MCP server "${name}" removed.` }
}

export function listServers(): McpServerConfig[] {
  return readRegistry().servers
}

export function getServer(name: string): McpServerConfig | null {
  return readRegistry().servers.find(s => s.name === name) ?? null
}
