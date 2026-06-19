import type { Message, EcoConfig } from '../utils/types.js'

const DEFAULT_SYSTEM_PROMPT = `You are Eco Agent, a powerful agentic AI assistant running in the terminal.
You have access to tools to read/write files, run shell commands, search codebases, and more.
When given a task, think step by step and use tools as needed to complete it.
Be concise, efficient, and always confirm before making destructive changes.`

// Shorter system prompt for free/limited models to save tokens
const LEAN_SYSTEM_PROMPT = `You are Eco Agent, a terminal AI assistant.
Use your tools to complete tasks. Be concise and direct.
Always confirm before deleting or overwriting files.`

export class ContextManager {
  private messages: Message[] = []
  private config: EcoConfig
  private totalTokens = 0
  private isFreeModel: boolean
  private sessionMemory: string

  constructor(config: EcoConfig, sessionMemory = '') {
    this.config = config
    this.isFreeModel = (config.provider.model ?? '').includes(':free')
    this.sessionMemory = sessionMemory
  }

  getSystemPrompt(): string {
    const base = this.config.systemPrompt
      ?? (this.isFreeModel ? LEAN_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT)
    return this.sessionMemory ? base + this.sessionMemory : base
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content })
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content })
  }

  addToolResult(toolCallId: string, toolName: string, result: string): void {
    this.messages.push({
      role: 'tool',
      content: result,
      toolCallId,
      toolName
    })
  }

  getMessages(): Message[] {
    return [
      { role: 'system', content: this.getSystemPrompt() },
      ...this.messages
    ]
  }

  getHistory(): Message[] {
    return [...this.messages]
  }

  clear(): void {
    this.messages = []
  }

  messageCount(): number {
    return this.messages.length
  }

  addUsage(tokens: number): void {
    this.totalTokens += tokens
  }

  getTotalTokens(): number {
    return this.totalTokens
  }

  // Trim old messages if context gets too long.
  // Free models use a tighter limit (20 msgs) to avoid hitting token limits.
  trimIfNeeded(maxMessages = 40): void {
    const limit = this.isFreeModel ? 20 : maxMessages
    if (this.messages.length <= limit) return
    // Keep first 2 (initial context) and last 16 for free, 30 for others
    const headCount = this.isFreeModel ? 2 : 4
    const tailCount = this.isFreeModel ? 16 : 30
    const head = this.messages.slice(0, headCount)
    const tail = this.messages.slice(-tailCount)
    const trimmed = this.messages.length - head.length - tail.length
    this.messages = [
      ...head,
      { role: 'assistant', content: `[... ${trimmed} earlier messages trimmed to save context ...]` },
      ...tail
    ]
  }
}
