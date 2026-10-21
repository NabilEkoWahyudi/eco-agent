import type { ProviderConfig } from '../utils/types.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

export const DEEPSEEK_MODELS = [
  { id: 'deepseek-chat',     label: 'DeepSeek V3 (Chat)',    desc: 'Best for general tasks, very affordable' },
  { id: 'deepseek-reasoner', label: 'DeepSeek R1 (Reason)',  desc: 'Chain-of-thought reasoning, great for coding' },
]

/**
 * Official DeepSeek provider.
 * Thin preset over OpenAICompatibleProvider pointing to api.deepseek.com.
 * DeepSeek's API is 100% OpenAI-compatible (same schema, different base URL).
 * No heavy SDK — uses native fetch only.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        // Honor a custom baseUrl (proxy / tests / compatible gateways)
        baseUrl: config.baseUrl ?? DEEPSEEK_BASE_URL,
        apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
      },
      'DeepSeek'
    )
    const key = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ''
    if (!key) throw new Error('DEEPSEEK_API_KEY not set. Get one at platform.deepseek.com. Run /config to configure it.')
  }

  /**
   * deepseek-reasoner (R1) does not support function calling — the API rejects
   * requests that include `tools`. Strip them for that model.
   */
  override async complete(
    messages: Parameters<OpenAICompatibleProvider['complete']>[0],
    tools: Parameters<OpenAICompatibleProvider['complete']>[1] = []
  ): ReturnType<OpenAICompatibleProvider['complete']> {
    const isReasoner = this.config.model === 'deepseek-reasoner'
    return super.complete(messages, isReasoner ? [] : tools)
  }
}
