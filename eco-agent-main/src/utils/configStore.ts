import Conf from 'conf'
import type { SavedConfig } from './setupWizard.js'

export type { SavedConfig }

const store = new Conf<{ mode: string; apiKey: string; model: string; baseUrl: string; supportsTools: boolean }>({
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
