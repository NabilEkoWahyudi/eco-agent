import type { ProviderConfig, Message, LLMResponse, Tool } from '../utils/types.js'
import type { ProviderStreamEvent } from './streamShared.js'
import { OllamaProvider } from './ollama.js'
import { GroqProvider } from './groq.js'
import { MockProvider } from './mock.js'
import { OpenRouterProvider } from './openrouter.js'
import { OpenAIProvider } from './openai.js'
import { DeepSeekProvider } from './deepseek.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'

export type Provider = {
  complete(messages: Message[], tools?: Tool[]): Promise<LLMResponse>
  stream?(messages: Message[]): AsyncGenerator<string>
  /**
   * Streaming with tool support. Yields text deltas while the model is still
   * generating, then a `tool_calls` event. Providers that implement this get
   * instant feedback in the REPL instead of waiting for the full response.
   */
  streamWithTools?(messages: Message[], tools?: Tool[]): AsyncGenerator<ProviderStreamEvent>
}

export function createProvider(config: ProviderConfig): Provider {
  const type = config.type as string
  switch (type) {
    case 'ollama':             return new OllamaProvider(config)
    case 'groq':               return new GroqProvider(config)
    case 'openrouter':         return new OpenRouterProvider(config)
    case 'mock':               return new MockProvider()
    case 'openai':             return new OpenAIProvider(config)
    case 'deepseek':           return new DeepSeekProvider(config)
    case 'openai-compatible':  return new OpenAICompatibleProvider(config)
    case 'anthropic':          return new AnthropicProvider(config)
    case 'gemini':             return new GeminiProvider(config)
    case 'aistudio':           return new GeminiProvider(config)  // AI Studio uses the same Gemini REST API
    default:
      throw new Error(
        `Provider "${config.type}" not supported. Supported: ollama, groq, openrouter, openai, deepseek, openai-compatible, anthropic, gemini, aistudio, mock`
      )
  }
}

export {
  OllamaProvider,
  GroqProvider,
  OpenRouterProvider,
  MockProvider,
  OpenAIProvider,
  DeepSeekProvider,
  OpenAICompatibleProvider,
  AnthropicProvider,
  GeminiProvider,
}
