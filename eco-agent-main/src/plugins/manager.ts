import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { homedir } from 'os'
import type { Tool } from '../utils/types.js'
import type { EcoPlugin, InstalledPlugin, PluginRegistry } from './types.js'

const ECO_DIR = join(homedir(), '.eco-agent')
const PLUGINS_DIR = join(ECO_DIR, 'plugins')
const REGISTRY_FILE = join(ECO_DIR, 'plugins.json')

function ensureDirs() {
  if (!existsSync(ECO_DIR)) mkdirSync(ECO_DIR, { recursive: true })
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true })
}

function readRegistry(): PluginRegistry {
  if (!existsSync(REGISTRY_FILE)) return { plugins: [] }
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8')) as PluginRegistry
  } catch {
    return { plugins: [] }
  }
}

function writeRegistry(registry: PluginRegistry) {
  ensureDirs()
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8')
}

function isLocalPath(name: string): boolean {
  return name.startsWith('/') || name.startsWith('.') || name.startsWith('~')
}

function resolveModulePath(packageName: string): string {
  if (isLocalPath(packageName)) {
    return join(packageName, 'index.js')
  }
  return join(PLUGINS_DIR, 'node_modules', packageName, 'index.js')
}

export async function installPlugin(packageName: string): Promise<{ ok: boolean; message: string }> {
  ensureDirs()

  const local = isLocalPath(packageName)

  if (!local) {
    // Init package.json di plugins dir jika belum ada
    const pkgPath = join(PLUGINS_DIR, 'package.json')
    if (!existsSync(pkgPath)) {
      writeFileSync(pkgPath, JSON.stringify({ name: 'eco-plugins', version: '1.0.0', type: 'commonjs' }, null, 2))
    }
    try {
      execSync(`npm install ${packageName} --prefix "${PLUGINS_DIR}" --save --silent`, {
        timeout: 60000,
        stdio: 'pipe'
      })
    } catch (e) {
      return { ok: false, message: `Gagal install dari npm: ${(e as Error).message}` }
    }
  }

  // Load untuk validasi
  const modulePath = resolveModulePath(packageName)
  if (!existsSync(modulePath)) {
    return { ok: false, message: `Plugin tidak valid: index.js tidak ditemukan di ${modulePath}` }
  }

  let plugin: EcoPlugin
  try {
    const mod = await import(modulePath)
    plugin = (mod.default ?? mod) as EcoPlugin
    if (!plugin.name || !plugin.tools || !Array.isArray(plugin.tools)) {
      return { ok: false, message: 'Plugin tidak valid: harus export { name, version, description, tools }' }
    }
  } catch (e) {
    return { ok: false, message: `Gagal load plugin: ${(e as Error).message}` }
  }

  if (plugin.onLoad) await plugin.onLoad()

  const registry = readRegistry()
  const existing = registry.plugins.findIndex(p => p.packageName === packageName)
  const entry: InstalledPlugin = {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    installedAt: new Date().toISOString(),
    packageName
  }

  if (existing >= 0) {
    registry.plugins[existing] = entry
  } else {
    registry.plugins.push(entry)
  }

  writeRegistry(registry)
  return { ok: true, message: `Plugin "${plugin.name}" v${plugin.version} berhasil diinstall!` }
}

export async function removePlugin(packageName: string): Promise<{ ok: boolean; message: string }> {
  const registry = readRegistry()
  const idx = registry.plugins.findIndex(p => p.packageName === packageName || p.name === packageName)

  if (idx < 0) return { ok: false, message: `Plugin "${packageName}" tidak ditemukan.` }

  const entry = registry.plugins[idx]
  try {
    const modulePath = resolveModulePath(entry.packageName)
    if (existsSync(modulePath)) {
      const mod = await import(modulePath)
      const plugin = (mod.default ?? mod) as EcoPlugin
      if (plugin.onUnload) await plugin.onUnload()
    }
  } catch { /* skip */ }

  if (!isLocalPath(entry.packageName)) {
    try {
      execSync(`npm uninstall ${entry.packageName} --prefix "${PLUGINS_DIR}" --silent`, {
        timeout: 30000, stdio: 'pipe'
      })
    } catch { /* continue */ }
  }

  registry.plugins.splice(idx, 1)
  writeRegistry(registry)
  return { ok: true, message: `Plugin "${entry.name}" berhasil dihapus.` }
}

export async function loadAllPlugins(): Promise<Tool[]> {
  const registry = readRegistry()
  const tools: Tool[] = []

  for (const entry of registry.plugins) {
    try {
      const modulePath = resolveModulePath(entry.packageName)
      if (!existsSync(modulePath)) continue
      const mod = await import(modulePath)
      const plugin = (mod.default ?? mod) as EcoPlugin
      if (plugin.onLoad) await plugin.onLoad()
      tools.push(...plugin.tools)
    } catch (e) {
      console.error(`  ⚠ Gagal load plugin "${entry.name}": ${(e as Error).message}`)
    }
  }

  return tools
}

export function listPlugins(): InstalledPlugin[] {
  return readRegistry().plugins
}

export function getPluginsDir(): string {
  return PLUGINS_DIR
}
