import type { ProviderConfig, Message, LLMResponse, Tool } from '../utils/types.js'
import { OllamaProvider } from './ollama.js'
import { GroqProvider } from './groq.js'
import { MockProvider } from './mock.js'
import { OpenRouterProvider } from './openrouter.js'

export type Provider = {
  complete(messages: Message[], tools?: Tool[]): Promise<LLMResponse>
  stream?(messages: Message[]): AsyncGenerator<string>
}

export function createProvider(config: ProviderConfig): Provider {
  const type = config.type as string
  switch (type) {
    case 'ollama':      return new OllamaProvider(config)
    case 'groq':        return new GroqProvider(config)
    case 'openrouter':  return new OpenRouterProvider(config)
    case 'mock':        return new MockProvider()
    default:
      throw new Error(`Provider "${config.type}" not supported. Supported: ollama, groq, openrouter, mock`)
  }
}

export { OllamaProvider, GroqProvider, OpenRouterProvider, MockProvider }
