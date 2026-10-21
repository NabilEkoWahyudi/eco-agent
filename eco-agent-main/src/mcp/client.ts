import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { EventSourceInit } from 'eventsource'
import type { McpServerConfig } from './types.js'
import type { Tool } from '../utils/types.js'

export class McpClient {
  private client: Client
  private config: McpServerConfig
  private connected = false

  constructor(config: McpServerConfig) {
    this.config = config
    this.client = new Client(
      { name: 'eco-agent', version: '0.1.0' },
      { capabilities: {} }
    )
  }

  async connect(): Promise<void> {
    if (this.connected) return

    let stdioTransport: StdioClientTransport | undefined
    let httpAttempts: Array<{ name: string; make: () => StreamableHTTPClientTransport | SSEClientTransport }> = []

    if (this.config.type === 'stdio') {
      if (!this.config.command) throw new Error(`Server "${this.config.name}" missing command`)
      stdioTransport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>
      })
    } else {
      if (!this.config.url) throw new Error(`Server "${this.config.name}" missing url`)
      const url = new URL(this.config.url)
      const headers = (this.config.headers ?? {}) as Record<string, string>
      // The SDK's EventSourceInit has no "headers" field — the documented way
      // to authenticate is a custom fetch that injects the headers.
      const fetchWithHeaders = (u: string | URL, init?: RequestInit) =>
        fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } })
      if (Object.keys(headers).length > 0) {
        // BUG FIX: configured headers were parsed & stored but never sent —
        // authenticated remote MCP servers could never work.
        httpAttempts = [
          { name: 'streamable-http', make: () => new StreamableHTTPClientTransport(url, { requestInit: { headers } }) },
          { name: 'legacy-sse', make: () => new SSEClientTransport(url, {
            eventSourceInit: { fetch: fetchWithHeaders as unknown as EventSourceInit['fetch'] }
          }) },
        ]
      } else {
        httpAttempts = [{ name: 'legacy-sse', make: () => new SSEClientTransport(url) }]
      }
    }

    if (stdioTransport) {
      await this.client.connect(stdioTransport)
      this.connected = true
      return
    }

    // Try modern Streamable HTTP first, fall back to legacy SSE on failure
    let lastErr: unknown
    let connected = false
    for (const attempt of httpAttempts) {
      try {
        await this.client.connect(attempt.make())
        connected = true
        break
      } catch (e) {
        lastErr = e
        try { await this.client.close() } catch { /* ignore */ }
      }
    }
    if (!connected) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    await this.client.close()
    this.connected = false
  }

  async getTools(): Promise<Tool[]> {
    await this.connect()
    const { tools } = await this.client.listTools()
    const serverName = this.config.name

    return tools.map(mcpTool => ({
      name: `${serverName}__${mcpTool.name}`,
      description: `[${serverName}] ${mcpTool.description ?? mcpTool.name}`,
      parameters: this.schemaToParams(mcpTool.inputSchema),
      execute: async (args: Record<string, unknown>) => {
        try {
          const result = await this.client.callTool({
            name: mcpTool.name,
            arguments: args
          })

          // Extract text content from MCP result
          if (Array.isArray(result.content)) {
            const text = result.content
              .map((c: { type: string; text?: string }) => c.type === 'text' ? c.text ?? '' : `[${c.type}]`)
              .join('\n')
            if (text) return text
          }

          // Guard: result.content may be undefined — JSON.stringify would
          // return undefined and break downstream `.toLowerCase()` in the loop
          if (result.content) return JSON.stringify(result.content)
          return '(tool completed with no output)'
        } catch (e) {
          return `MCP tool error: ${(e as Error).message}`
        }
      }
    }))
  }

  private schemaToParams(schema: unknown): Record<string, { type: string; description: string; required?: boolean }> {
    const s = schema as {
      properties?: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
    if (!s?.properties) return {}

    const required = new Set(s.required ?? [])
    return Object.fromEntries(
      Object.entries(s.properties).map(([key, val]) => [
        key,
        {
          type: val.type ?? 'string',
          description: val.description ?? key,
          required: required.has(key)
        }
      ])
    )
  }
}

// ─── Load all registered MCP servers as tools ─────────────────────────────────

const activeClients: McpClient[] = []

export async function loadMcpTools(servers: McpServerConfig[]): Promise<Tool[]> {
  const tools: Tool[] = []

  for (const server of servers) {
    const client = new McpClient(server)
    try {
      const serverTools = await client.getTools()
      tools.push(...serverTools)
      activeClients.push(client)
    } catch (e) {
      console.error(`  ! Failed to connect MCP server "${server.name}": ${(e as Error).message}`)
    }
  }

  return tools
}

export async function disconnectAll(): Promise<void> {
  await Promise.allSettled(activeClients.map(c => c.disconnect()))
  activeClients.length = 0
}
