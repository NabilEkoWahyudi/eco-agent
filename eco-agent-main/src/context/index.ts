import type { Message, EcoConfig } from '../utils/types.js'

const DEFAULT_SYSTEM_PROMPT = `You are Eco Agent, a powerful agentic AI assistant running in the terminal.
You have access to tools to read/write files, run shell commands, search codebases, and more.
When given a task, think step by step and use tools as needed to complete it.
Be concise, efficient, and always confirm before making destructive changes.`



export class ContextManager {
  private messages: Message[] = []
  private config: EcoConfig

  constructor(config: EcoConfig) {
    this.config = config
  }

  getSystemPrompt(): string {
    return this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
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

  // Summarize old messages if context gets too long
  trimIfNeeded(maxMessages = 40): void {
    if (this.messages.length <= maxMessages) return
    // Keep first 4 (initial context) and last 30 (recent context)
    const head = this.messages.slice(0, 4)
    const tail = this.messages.slice(-30)
    const trimmed = this.messages.length - head.length - tail.length
    this.messages = [
      ...head,
      { role: 'assistant', content: `[... ${trimmed} earlier messages trimmed to save context ...]` },
      ...tail
    ]
  }
}
