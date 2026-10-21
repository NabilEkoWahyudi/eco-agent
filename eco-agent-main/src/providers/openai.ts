import type { ProviderConfig } from '../utils/types.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export const OPENAI_MODELS = [
  { id: 'gpt-4o',             label: 'GPT-4o',          desc: 'OpenAI flagship — very capable' },
  { id: 'gpt-4o-mini',        label: 'GPT-4o Mini',     desc: 'Fast & affordable GPT-4 class' },
  { id: 'gpt-4.1',            label: 'GPT-4.1',         desc: 'Powerful, long context' },
  { id: 'gpt-4.1-mini',       label: 'GPT-4.1 Mini',    desc: 'Balanced speed and quality' },
]

/**
 * Official OpenAI provider.
 * Thin preset over OpenAICompatibleProvider pointing to api.openai.com/v1.
 * No heavy SDK — uses native fetch only.
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        // Honor a custom baseUrl (Azure-style gateway / proxy / tests)
        baseUrl: config.baseUrl ?? OPENAI_BASE_URL,
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      },
      'OpenAI'
    )
    const key = config.apiKey ?? process.env.OPENAI_API_KEY ?? ''
    if (!key) throw new Error('OPENAI_API_KEY not set. Run /config to configure it.')
  }
}
