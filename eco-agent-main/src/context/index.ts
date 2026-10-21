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
  /**
   * Trim the context so it stays inside the provider's limits.
   *
   * Two budgets are enforced:
   *   - message count (keeps the conversation readable)
   *   - CHARACTER count — the important one: a single tool result can be
   *     thousands of characters, and providers meter input tokens per minute
   *     (TPM). A 100K-token request burns the quota and answers with 429.
   *
   * Whole turns are dropped (a turn = user message + its tool calls/results)
   * so an assistant message is never separated from its tool results.
   */
  trimIfNeeded(maxMessages = 40, maxChars = 60_000): void {
    const limit = this.isFreeModel ? 20 : maxMessages
    const charLimit = this.isFreeModel ? 30_000 : maxChars

    // Split messages into turns (turn starts at a user message)
    const turns: Message[][] = []
    for (const m of this.messages) {
      if (m.role === 'user' || turns.length === 0) turns.push([m])
      else turns[turns.length - 1].push(m)
    }

    const turnChars = (t: Message[]) => t.reduce((n, m) => n + m.content.length, 0)
    const totalChars = this.messages.reduce((n, m) => n + m.content.length, 0)
    if (this.messages.length <= limit && totalChars <= charLimit) return

    // Head: the oldest turns are kept for continuity, but never more than
    // half of the budget.
    const headTurnLimit = this.isFreeModel ? 1 : 2
    let headTurns = turns.slice(0, headTurnLimit)
    const halfBudget = Math.floor(charLimit / 2)
    while (headTurns.length > 1 && headTurns.reduce((n, t) => n + turnChars(t), 0) > halfBudget) {
      headTurns = headTurns.slice(1)
    }
    const headChars = headTurns.reduce((n, t) => n + turnChars(t), 0)

    // Tail: take turns from the end while both budgets allow it
    const headMsgCount = headTurns.reduce((n, t) => n + t.length, 0)
    let tailMsgCount = 0
    let tailChars = headChars
    const tailTurns: Message[][] = []
    for (let i = turns.length - 1; i >= headTurnLimit; i--) {
      const turn = turns[i]
      const chars = turnChars(turn)
      if (tailMsgCount + headMsgCount + turn.length > limit && tailTurns.length > 0) break
      if (tailChars + chars > charLimit) {
        // Always keep the newest turn (the model needs the current context),
        // but stop before the budget is blown.
        if (tailTurns.length === 0) {
          tailTurns.unshift(turn)
          tailMsgCount += turn.length
        }
        break
      }
      tailTurns.unshift(turn)
      tailMsgCount += turn.length
      tailChars += chars
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
