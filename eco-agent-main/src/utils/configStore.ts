import Conf from 'conf'
import type { SavedConfig } from './setupWizard.js'
import { parsePonytailMode } from '../rulesets/ponytail.js'
import type { PonytailMode } from '../rulesets/ponytail.js'
import { saveSecret, loadSecret } from './secretStore.js'

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
    // API key lives in the dedicated secret store (DPAPI-encrypted on
    // Windows). Legacy plaintext fallback for old configs.
    apiKey: loadSecret('apiKey') || store.get('apiKey', '') || undefined,
    model: store.get('model', '') || undefined,
    baseUrl: store.get('baseUrl', '') || undefined,
    supportsTools: store.get('supportsTools', true)
  }
}

export function saveConfig(config: SavedConfig): void {
  store.set('mode', config.mode)
  // Store the API key in the secret store instead of the plain config file.
  // SECURITY: the previous version wrote API keys unencrypted to
  // %APPDATA%\eco-agent-nodejs\Config\config.json where any process running
  // as the same user could read them.
  saveSecret('apiKey', config.apiKey ?? '')
  // Keep legacy field blank so old plaintext copies do not linger
  store.set('apiKey', '')
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
  return 'full'
}

/** Persist Ponytail mode to config store. */
export function savePonytailMode(mode: PonytailMode): void {
  store.set('ponytailMode', mode)
}

