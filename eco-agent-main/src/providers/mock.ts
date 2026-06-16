import type { Message, LLMResponse, Tool } from '../utils/types.js'

/**
 * Mock provider for testing — simulates tool calling and responses
 * without needing a real LLM. Used via: --provider mock
 */
export class MockProvider {
  private callCount = 0

  async complete(messages: Message[], tools: Tool[] = []): Promise<LLMResponse> {
    this.callCount++
    const lastMsg = messages.filter(m => m.role === 'user').pop()
    const input = lastMsg?.content?.toLowerCase() ?? ''

    // Simulate tool calling on first turn for certain keywords
    if (this.callCount === 1 && tools.length > 0) {
      if (input.includes('list') || input.includes('files') || input.includes('directory')) {
        return {
          content: 'Let me list the directory for you.',
          toolCalls: [{
            id: 'tc_mock_001',
            name: 'list_directory',
            arguments: { path: '.' }
          }],
          finishReason: 'tool_calls'
        }
      }
      if (input.includes('read') && input.includes('file')) {
        return {
          content: 'Let me read that file.',
          toolCalls: [{
            id: 'tc_mock_002',
            name: 'read_file',
            arguments: { path: 'README.md' }
          }],
          finishReason: 'tool_calls'
        }
      }
      if (input.includes('shell') || input.includes('run') || input.includes('command')) {
        return {
          content: 'Running the command.',
          toolCalls: [{
            id: 'tc_mock_003',
            name: 'run_shell',
            arguments: { command: 'echo "Hello from Eco Agent shell tool!"' }
          }],
          finishReason: 'tool_calls'
        }
      }
    }

    // Final response after tools or for simple queries
    return {
      content: this.generateResponse(input),
      finishReason: 'stop'
    }
  }

  private generateResponse(input: string): string {
    if (input.includes('hello') || input.includes('hi')) {
      return 'Hello! I\'m Eco Agent (mock mode). I\'m ready to help with files, shell commands, and more!'
    }
    if (input.includes('help')) {
      return 'I can help you with:\n- Reading and writing files\n- Running shell commands\n- Searching through codebases\n- Listing directory contents\n\nTry: "list files in current directory" or "read README.md"'
    }
    return `[Mock response] Task understood: "${input}"\n\nIn real mode (Ollama/Groq), I would reason through this and use tools to complete it. Switch to a real provider with --provider ollama or --provider groq.`
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const response = await this.complete(messages)
    for (const word of response.content.split(' ')) {
      yield word + ' '
      await new Promise(r => setTimeout(r, 30))
    }
  }
}
