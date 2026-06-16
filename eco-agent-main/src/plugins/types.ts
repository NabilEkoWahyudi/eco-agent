import type { Tool } from '../utils/types.js'

/**
 * Contract yang harus diikuti setiap Eco Agent plugin.
 * Plugin adalah npm package yang export object ini sebagai default export.
 *
 * Contoh plugin package:
 *   module.exports = {
 *     name: 'eco-plugin-weather',
 *     version: '1.0.0',
 *     description: 'Get weather information',
 *     tools: [ weatherTool ]
 *   }
 */
export interface EcoPlugin {
  name: string
  version: string
  description: string
  tools: Tool[]
  onLoad?: () => Promise<void>    // lifecycle: saat plugin diload
  onUnload?: () => Promise<void>  // lifecycle: saat plugin diremove
}

export interface InstalledPlugin {
  name: string
  version: string
  description: string
  installedAt: string
  packageName: string
}

export interface PluginRegistry {
  plugins: InstalledPlugin[]
}
