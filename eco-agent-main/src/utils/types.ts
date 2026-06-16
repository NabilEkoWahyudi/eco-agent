export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Message {
  role: Role
  content: string
  toolCallId?: string
  toolName?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
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
}

export interface ProviderConfig {
  type: 'ollama' | 'groq' | 'openai' | 'anthropic'
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
