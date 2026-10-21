import type { PonytailMode } from '../rulesets/ponytail.js'

export type { PonytailMode }

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Message {
  role: Role
  content: string
  toolCallId?: string
  toolName?: string
  /** Tool calls announced by the assistant (needed for correct OpenAI/Anthropic/Gemini tool-calling round-trips) */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }>
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /**
   * Gemini 3.x "thought signature" — an opaque token the model attaches to a
   * functionCall part. It MUST be sent back verbatim in the next request or
   * the API rejects the request with:
   *   "Function call is missing a thought_signature in functionCall parts"
   * Other providers ignore this field.
   */
  thoughtSignature?: string
}

export interface ToolResult {
  toolCallId: string
  result: string
  error?: boolean
}

export interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface ProviderConfig {
  type: 'ollama' | 'groq' | 'openrouter' | 'mock' | 'openai' | 'deepseek' | 'openai-compatible' | 'anthropic' | 'gemini' | 'aistudio'
  model: string
  baseUrl?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}

export interface EcoConfig {
  provider: ProviderConfig
  systemPrompt?: string
  maxIterations?: number
  verbose?: boolean
  /** Ponytail minimalist coding ruleset mode. Defaults to 'full' (per upstream ponytail repo). */
  ponytailMode?: PonytailMode
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, {
    type: string
    description: string
    required?: boolean
  }>
  execute: (args: Record<string, unknown>) => Promise<string>
}
