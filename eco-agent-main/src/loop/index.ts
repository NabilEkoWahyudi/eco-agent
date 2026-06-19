import type { EcoConfig, Tool, ToolCall } from '../utils/types.js'
import type { Provider } from '../providers/index.js'
import { ContextManager } from '../context/index.js'

export interface LoopOptions {
  onThinking?: () => void
  onContent?: (chunk: string) => void
  onToolCall?: (tool: string, args: Record<string, unknown>) => void
  onToolResult?: (tool: string, result: string, error: boolean) => void
  onConfirmTool?: (tool: string, args: Record<string, unknown>) => Promise<boolean>
  onDone?: (finalResponse: string) => void
  onError?: (error: Error) => void
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

  async run(userInput: string, opts: LoopOptions = {}): Promise<string> {
    this.context.addUserMessage(userInput)
    this.context.trimIfNeeded()

    let iterations = 0
    let finalResponse = ''
    const writtenFiles = new Set<string>() // Track files written in this run

    while (iterations < this.maxIterations) {
      iterations++
      opts.onThinking?.()

      let response
      try {
        response = await this.provider.complete(this.context.getMessages(), this.tools)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        opts.onError?.(err)
        return `Error: ${err.message}`
      }

      // If there's text content, stream it out
      if (response.usage) {
        this.context.addUsage(response.usage.totalTokens)
      }

      if (response.content) {
        opts.onContent?.(response.content)
        finalResponse = response.content
      }

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.context.addAssistantMessage(response.content)
        opts.onDone?.(finalResponse)
        return finalResponse
      }

      // Add assistant message with tool call intent
      this.context.addAssistantMessage(
        response.content
          ? `${response.content}\n[Using tools: ${response.toolCalls.map(t => t.name).join(', ')}]`
          : `[Using tools: ${response.toolCalls.map(t => t.name).join(', ')}]`
      )

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
        this.context.addToolResult(toolCall.id, toolCall.name, result.output)

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

  private async executeToolCall(
    toolCall: ToolCall,
    opts: LoopOptions
  ): Promise<{ output: string; error: boolean }> {
    const tool = this.tools.find(t => t.name === toolCall.name)

    if (!tool) {
      const msg = `Error: Unknown tool "${toolCall.name}"`
      opts.onToolResult?.(toolCall.name, msg, true)
      return { output: msg, error: true }
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
      const isError = result.toLowerCase().startsWith('error')
      opts.onToolResult?.(toolCall.name, result, isError)
      return { output: result, error: isError }
    } catch (e) {
      const msg = `Tool error: ${(e as Error).message}`
      opts.onToolResult?.(toolCall.name, msg, true)
      return { output: msg, error: true }
    }
  }

  resetContext(): void {
    this.context.clear()
  }

  getHistory() {
    return this.context.getHistory()
  }

  getTotalTokens() {
    return this.context.getTotalTokens()
  }
}
