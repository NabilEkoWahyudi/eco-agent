import type { Message, EcoConfig, PonytailMode } from '../utils/types.js'
import { getPonytailPrompt } from '../rulesets/ponytail.js'

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
  private ponytailMode: PonytailMode

  constructor(config: EcoConfig, sessionMemory = '') {
    this.config = config
    this.isFreeModel = (config.provider.model ?? '').includes(':free')
    this.sessionMemory = sessionMemory
    // Default: 'full' per ponytail upstream, override via config
    this.ponytailMode = config.ponytailMode ?? 'full'
  }

  getSystemPrompt(): string {
    const base = this.config.systemPrompt
      ?? (this.isFreeModel ? LEAN_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT)
    const ponytailSnippet = getPonytailPrompt(this.ponytailMode)
    const withPonytail = ponytailSnippet ? base + '\n' + ponytailSnippet : base
    return this.sessionMemory ? withPonytail + this.sessionMemory : withPonytail
  }

  /** Change the Ponytail mode mid-session without restarting the agent. */
  setPonytailMode(mode: PonytailMode): void {
    this.ponytailMode = mode
  }

  getPonytailMode(): PonytailMode {
    return this.ponytailMode
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content })
  }

  addAssistantMessage(content: string, toolCalls?: Message['toolCalls']): void {
    const msg: Message = { role: 'assistant', content }
    if (toolCalls && toolCalls.length > 0) msg.toolCalls = toolCalls
    this.messages.push(msg)
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

  /**
   * Trim old messages if context gets too long.
   * Free models use a tighter limit (20 msgs) to avoid hitting token limits.
   * Note: We trim by message count (pragmatic), not exact token count.
   *
   * IMPORTANT: trimming happens at *turn* boundaries (a turn = user message +
   * its assistant reply + all following tool messages). Never split an
   * assistant message from its tool results — providers (OpenAI/Anthropic)
   * reject those orphaned sequences with HTTP 400.
   */
  trimIfNeeded(maxMessages = 40): void {
    const limit = this.isFreeModel ? 20 : maxMessages
    if (this.messages.length <= limit) return

    // Split messages into turns (turn starts at a user message)
    const turns: Message[][] = []
    for (const m of this.messages) {
      if (m.role === 'user' || turns.length === 0) turns.push([m])
      else turns[turns.length - 1].push(m)
    }

    const headTurnLimit = this.isFreeModel ? 1 : 2
    const headTurns = turns.slice(0, headTurnLimit)

    // Tail turns: take from the end until roughly the limit is respected
    const headMsgCount = headTurns.reduce((n, t) => n + t.length, 0)
    let tailMsgCount = 0
    const tailTurns: Message[][] = []
    for (let i = turns.length - 1; i >= headTurnLimit; i--) {
      const turn = turns[i]
      if (tailMsgCount + headMsgCount + turn.length > limit && tailTurns.length > 0) break
      tailTurns.unshift(turn)
      tailMsgCount += turn.length
    }

    const trimmed = turns.length - headTurns.length - tailTurns.length
    if (trimmed <= 0) return

    this.messages = [
      ...headTurns.flat(),
      { role: 'assistant', content: `[... ${trimmed} earlier turn${trimmed !== 1 ? 's' : ''} trimmed to save context ...]` },
      ...tailTurns.flat()
    ]
  }
}
