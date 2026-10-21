import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
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
  return name.startsWith('/')
    || name.startsWith('.')
    || name.startsWith('~')
    // Windows: drive letter (C:\..., C:/...) and UNC paths (\\server\share)
    || /^[a-zA-Z]:[\\/]/.test(name)
    || name.startsWith('\\\\')
}

/**
 * Validate an npm package name before it can reach the shell / npm CLI.
 * Blocks shell metacharacters that could turn `eco plugin install` into
 * arbitrary command execution.
 */
function isValidNpmPackageName(name: string): boolean {
  // Scopes like @modelcontextprotocol/server-github are allowed
  return /^[a-zA-Z0-9][a-zA-Z0-9@/._-]*$/.test(name)
  && !/[;&|`$"'\\\s]/.test(name)
}

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1).replace(/^[\\/]/, ''))
  }
  return p
}

function importLocalModule(modulePath: string) {
  // Node ESM refuses absolute Windows paths (ERR_UNSUPPORTED_ESM_URL_SCHEME),
  // so always import via a file:// URL.
  const abs = resolve(modulePath)
  return import(pathToFileURL(abs).href)
}

function resolveModulePath(packageName: string): string {
  if (isLocalPath(packageName)) {
    const base = expandHome(resolve(packageName))
    // Prefer package.json "main" if present, else index.js
    const pkgJsonPath = join(base, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const main = (JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { main?: string }).main
        if (main && existsSync(join(base, main))) return join(base, main)
      } catch { /* fall through */ }
    }
    return join(base, 'index.js')
  }
  return join(PLUGINS_DIR, 'node_modules', packageName, 'index.js')
}

export async function installPlugin(packageName: string): Promise<{ ok: boolean; message: string }> {
  ensureDirs()

  const local = isLocalPath(packageName)

  if (!local) {
    // Command-injection guard: package names reaching npm must be plain names
    if (!isValidNpmPackageName(packageName)) {
      return { ok: false, message: `Nama package npm tidak valid: "${packageName}" (karakter shell dilarang)` }
    }
    // Init package.json di plugins dir jika belum ada
    const pkgPath = join(PLUGINS_DIR, 'package.json')
    if (!existsSync(pkgPath)) {
      writeFileSync(pkgPath, JSON.stringify({ name: 'eco-plugins', version: '1.0.0', type: 'commonjs' }, null, 2))
    }
    try {
      // execFileSync (bukan interpolation string shell) → tidak bisa diinject
      execFileSync('npm', ['install', packageName, '--prefix', PLUGINS_DIR, '--save', '--silent'], {
        timeout: 60000,
        stdio: 'pipe',
        shell: false
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
    const mod = await importLocalModule(modulePath)
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
      const mod = await importLocalModule(modulePath)
      const plugin = (mod.default ?? mod) as EcoPlugin
      if (plugin.onUnload) await plugin.onUnload()
    }
  } catch { /* skip */ }

  if (!isLocalPath(entry.packageName)) {
    if (isValidNpmPackageName(entry.packageName)) {
      try {
        execFileSync('npm', ['uninstall', entry.packageName, '--prefix', PLUGINS_DIR, '--silent'], {
          timeout: 30000,
          stdio: 'pipe',
          shell: false
        })
      } catch { /* continue */ }
    }
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
      const mod = await importLocalModule(modulePath)
      const plugin = (mod.default ?? mod) as EcoPlugin
      if (plugin.onLoad) await plugin.onLoad()
      tools.push(...plugin.tools)
    } catch (e) {
      console.error(`  ! Gagal load plugin "${entry.name}": ${(e as Error).message}`)
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
