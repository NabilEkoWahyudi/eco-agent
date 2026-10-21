import type { EcoConfig, Tool, ToolCall, PonytailMode, Message, LLMResponse } from '../utils/types.js'
import type { Provider } from '../providers/index.js'
import { ContextManager } from '../context/index.js'
import { truncateToolOutput } from '../utils/truncate.js'

export interface LoopOptions {
  onThinking?: () => void
  onContent?: (chunk: string) => void
  onToolCall?: (tool: string, args: Record<string, unknown>) => void
  onToolResult?: (tool: string, result: string, error: boolean) => void
  onConfirmTool?: (tool: string, args: Record<string, unknown>) => Promise<boolean>
  onDone?: (finalResponse: string) => void
  onError?: (error: Error) => void
  /** Fired once the first token of a streamed response arrives (ms since request). */
  onFirstToken?: (ms: number) => void
}

export class AgentLoop {
  private provider: Provider
  private tools: Tool[]
  private context: ContextManager
  private config: EcoConfig
  private maxIterations: number

  constructor(provider: Provider, tools: Tool[], config: EcoConfig, sessionMemory = '') {
    this.provider = provider
    this.tools = tools
    this.config = config
    this.context = new ContextManager(config, sessionMemory)
    this.maxIterations = config.maxIterations ?? 10
  }

  /**
   * Run the agentic loop.
   * @param userInput - The user message to process.
   * @param opts - Lifecycle callbacks.
   * @param toolsOverride - If provided, use these tools instead of the default ones.
   *                        Pass [] to run without any tools (e.g. /commit, /pr).
   */
  async run(userInput: string, opts: LoopOptions = {}, toolsOverride?: Tool[]): Promise<string> {
    const tools = toolsOverride !== undefined ? toolsOverride : this.tools
    this.context.addUserMessage(userInput)
    this.context.trimIfNeeded()

    let iterations = 0
    let finalResponse = ''
    const writtenFiles = new Set<string>() // Track files written in this run

    while (iterations < this.maxIterations) {
      iterations++
      opts.onThinking?.()

      let response
      let streamed = false
      try {
        // Keep the request inside the provider's token budget — tool results
        // from the previous iteration are part of the context as well.
        this.context.trimIfNeeded()
        const result = await this.callModel(tools, opts)
        response = result.response
        streamed = result.streamed
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        opts.onError?.(err)
        return `Error: ${err.message}`
      }

      // Track usage
      if (response.usage) {
        this.context.addUsage(response.usage.totalTokens)
      }

      if (response.content) {
        // With streaming the chunks were already delivered live — don't repeat them
        if (!streamed) opts.onContent?.(response.content)
        finalResponse = response.content
      }

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.context.addAssistantMessage(response.content)
        opts.onDone?.(finalResponse)
        return finalResponse
      }

      // Add assistant message — content plus the toolCalls that will be answered
      // by the tool-result messages that follow. Providers (OpenAI, Anthropic,
      // Gemini) require the tool_use/tool_calls block to be present in history
      // or they reject the follow-up tool messages with HTTP 400.
      this.context.addAssistantMessage(response.content, response.toolCalls)

      // Execute all tool calls
      for (const toolCall of response.toolCalls) {
        // Block duplicate writes to the same file in one run
        if (toolCall.name === 'write_file' && toolCall.arguments.path) {
          const filePath = String(toolCall.arguments.path)
          if (writtenFiles.has(filePath)) {
            const msg = `BLOCKED: File "${filePath}" was already written in this conversation turn. Do NOT write the same file again. The file is already saved. Respond to the user that the task is complete.`
            this.context.addToolResult(toolCall.id, toolCall.name, msg)
            opts.onToolResult?.(toolCall.name, msg, true)
            continue
          }
        }

        const result = await this.executeToolCall(toolCall, opts)
        // Keep the context small: huge tool outputs are re-sent with every
        // following request and slow the model down (prefill) a lot.
        const capped = truncateToolOutput(result.output)
        this.context.addToolResult(toolCall.id, toolCall.name, capped.text)

        // Track successful writes
        if (toolCall.name === 'write_file' && !result.error && toolCall.arguments.path) {
          writtenFiles.add(String(toolCall.arguments.path))
        }
      }
    }

    const maxMsg = `[Max iterations (${this.maxIterations}) reached]`
    opts.onDone?.(finalResponse || maxMsg)
    return finalResponse || maxMsg
  }

  /**
   * Ask the model for the next step.
   *
   * Uses the provider's streaming API when available so the user sees tokens
   * as they are generated (time-to-first-token) instead of staring at a
   * spinner until the whole answer is ready. Falls back to `complete()` for
   * providers without streaming support.
   */
  private async callModel(
    tools: Tool[],
    opts: LoopOptions
  ): Promise<{ response: LLMResponse; streamed: boolean }> {
    const messages = this.context.getMessages()
    const streamFn = this.provider.streamWithTools
    if (typeof streamFn !== 'function') {
      return { response: await this.provider.complete(messages, tools), streamed: false }
    }

    const started = Date.now()
    let firstTokenAt: number | undefined
    let content = ''
    let toolCalls: ToolCall[] | undefined
    let usage: LLMResponse['usage']
    let received = false

    try {
      for await (const event of streamFn.call(this.provider, messages, tools)) {
        received = true
        if (event.type === 'text') {
          if (firstTokenAt === undefined) {
            firstTokenAt = Date.now() - started
            opts.onFirstToken?.(firstTokenAt)
          }
          content += event.text
          opts.onContent?.(event.text)
        } else if (event.type === 'tool_calls') {
          toolCalls = event.toolCalls
        } else if (event.type === 'usage') {
          usage = event.usage
        }
      }
    } catch (e) {
      // Streaming failed (proxy, unsupported endpoint, …). If we already have
      // text, keep it; otherwise fall back to the non-streaming API.
      //
      // A 4xx error means the REQUEST ITSELF is invalid (bad URL, bad
      // parameter, invalid API key). Repeating it in another mode would only
      // waste time and add another failed request to the provider dashboard,
      // so those errors are surfaced directly.
      const status = (e as { status?: number })?.status
      const isClientError = typeof status === 'number' && status >= 400 && status < 500
      if (isClientError) throw e
      if (content || toolCalls) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)))
      } else {
        return { response: await this.provider.complete(messages, tools), streamed: false }
      }
    }

    // The server answered but produced nothing usable → fall back
    if (!received) {
      return { response: await this.provider.complete(messages, tools), streamed: false }
    }

    return {
      response: {
        content,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage,
      },
      streamed: true,
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
    opts: LoopOptions
  ): Promise<{ output: string; error: boolean }> {
    const tool = this.tools.find(t => t.name === toolCall.name)

    if (!tool) {
      const msg = `Error: Unknown tool "${toolCall.name}". Available tools: ${this.tools.map(t => t.name).join(', ')}`
      opts.onToolResult?.(toolCall.name, msg, true)
      return { output: msg, error: true }
    }

    // Bug fix: validate required parameters before execution
    // Prevents crash when LLM hallucinates tool calls with missing args
    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      if (paramDef.required && (toolCall.arguments[paramName] === undefined || toolCall.arguments[paramName] === null || toolCall.arguments[paramName] === '')) {
        const msg = `Error: Missing required parameter '${paramName}' for tool '${toolCall.name}'. Please provide all required parameters and try again.`
        opts.onToolResult?.(toolCall.name, msg, true)
        return { output: msg, error: true }
      }
    }

    opts.onToolCall?.(toolCall.name, toolCall.arguments)

    if (opts.onConfirmTool) {
      const confirmed = await opts.onConfirmTool(toolCall.name, toolCall.arguments)
      if (!confirmed) {
        const msg = `User cancelled tool execution.`
        opts.onToolResult?.(toolCall.name, msg, true)
        return { output: msg, error: true }
      }
    }

    try {
      const result = await tool.execute(toolCall.arguments)
      // Bug fix (ported from opencode): improved error detection
      // Previously only checked startsWith('error'), missing 'Command failed:', 'failed:', etc.
      const lowerResult = result.toLowerCase()
      const isError = lowerResult.startsWith('error') ||
        lowerResult.startsWith('command failed') ||
        lowerResult.includes('\nerror:') ||
        lowerResult.startsWith('failed:')
      opts.onToolResult?.(toolCall.name, result, isError)
      return { output: result, error: isError }
    } catch (e) {
      const msg = `Error: Tool '${toolCall.name}' threw an exception: ${(e as Error).message}`
      opts.onToolResult?.(toolCall.name, msg, true)
      return { output: msg, error: true }
    }
  }

  resetContext(): void {
    this.context.clear()
  }

  /**
   * Load a conversation history into this agent's context.
   * Used by session resume to restore previous messages without accessing private fields.
   */
  loadHistory(messages: Message[]): void {
    for (const m of messages) {
      if (m.role === 'user') this.context.addUserMessage(m.content)
      else if (m.role === 'assistant') {
        // Tool messages are not restored (ephemeral), so an assistant message
        // that announced toolCalls would be left dangling and break strict
        // providers (OpenAI/Anthropic). Persist it as plain text instead.
        this.context.addAssistantMessage(m.content)
      }
    }
  }

  /** Change Ponytail mode mid-session without restarting the agent. */
  setPonytailMode(mode: PonytailMode): void {
    this.context.setPonytailMode(mode)
  }

  getPonytailMode(): PonytailMode {
    return this.context.getPonytailMode()
  }

  getHistory() {
    return this.context.getHistory()
  }

  getTotalTokens() {
    return this.context.getTotalTokens()
  }
}
