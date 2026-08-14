import Conf from 'conf'
import type { SavedConfig } from './setupWizard.js'
import { parsePonytailMode } from '../rulesets/ponytail.js'
import type { PonytailMode } from '../rulesets/ponytail.js'

export type { SavedConfig }

const store = new Conf<{
  mode: string
  apiKey: string
  model: string
  baseUrl: string
  supportsTools: boolean
  ponytailMode: string
}>({
  projectName: 'eco-agent'
})

export function getSavedConfig(): SavedConfig | null {
  const mode = store.get('mode', '')
  if (!mode) return null
  return {
    mode: mode as SavedConfig['mode'],
    apiKey: store.get('apiKey', '') || undefined,
    model: store.get('model', 'llama-3.3-70b-versatile') || 'llama-3.3-70b-versatile',
    baseUrl: store.get('baseUrl', '') || undefined,
    supportsTools: store.get('supportsTools', true)
  }
}

export function saveConfig(config: SavedConfig): void {
  store.set('mode', config.mode)
  store.set('apiKey', config.apiKey ?? '')
  store.set('model', config.model ?? 'llama-3.3-70b-versatile')
  store.set('baseUrl', config.baseUrl ?? '')
  store.set('supportsTools', config.supportsTools ?? true)
}

export function clearConfig(): void {
  store.clear()
}

export function hasConfig(): boolean {
  return !!store.get('mode', '')
}

/**
 * Resolve active Ponytail mode using priority chain:
 *   1. PONYTAIL_DEFAULT_MODE env var (highest priority)
 *   2. Persisted config value
 *   3. 'lite' default
 */
export function getPonytailMode(): PonytailMode {
  const envMode = process.env.PONYTAIL_DEFAULT_MODE
  if (envMode) return parsePonytailMode(envMode)
  const stored = store.get('ponytailMode', '')
  if (stored) return parsePonytailMode(stored)
  return 'lite'
}

/** Persist Ponytail mode to config store. */
export function savePonytailMode(mode: PonytailMode): void {
  store.set('ponytailMode', mode)
}

