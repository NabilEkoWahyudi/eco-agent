export interface McpServerConfig {
  name: string
  type: 'stdio' | 'sse'
  // stdio: spawn a local process
  command?: string          // e.g. "npx"
  args?: string[]           // e.g. ["-y", "@modelcontextprotocol/server-github"]
  env?: Record<string, string>
  // sse: connect to remote HTTP server
  url?: string
  headers?: Record<string, string>
  // metadata
  description?: string
  addedAt: string
}

export interface McpRegistry {
  servers: McpServerConfig[]
}

export interface McpTool {
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
