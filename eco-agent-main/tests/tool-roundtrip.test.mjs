/**
 * Integration test: verify the agent loop round-trips assistant toolCalls
 * correctly against a standard OpenAI chat-completions server.
 * Before the fix: the 2nd request would contain a `role:'tool'` message
 * without a preceding assistant `tool_calls` message → real providers reject it.
 */
import http from 'http'
import { AgentLoop } from '../dist/loop/index.js'
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js'

const requests = []
let callCount = 0

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body)
    requests.push(parsed)
    callCount++
    if (callCount === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: 'I will call the tool.',
            tool_calls: [{ id: 'call_abc123', function: { name: 'list_files', arguments: '{"path":"."}' } }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }))
      return
    }
    const msgs = parsed.messages
    const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant')
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    const okToolCalls = Array.isArray(lastAsst?.tool_calls) && lastAsst.tool_calls.length > 0
    const okToolId = lastTool?.tool_call_id === 'call_abc123'
    res.end(JSON.stringify({
      choices: [{
        message: { content: `VALIDATION: tool_calls_present=${okToolCalls}, tool_id_linked=${okToolId}` },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const provider = new OpenAICompatibleProvider({
  type: 'openai-compatible', model: 'test-model',
  baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key'
})

const agent = new AgentLoop(provider, [{
  name: 'list_files',
  description: 'list files',
  parameters: { path: { type: 'string', description: 'dir', required: true } },
  execute: async () => 'a.txt\nb.txt'
}], { provider: {}, maxIterations: 3 })

const final = await agent.run('please list files', { onError: () => { /* noop */ } })
console.log('FINAL RESPONSE:', final)

const second = requests[1]
console.log('\n--- Second request message roles ---')
for (const m of second.messages) {
  console.log(`${String(m.role).padEnd(10)} ${m.tool_calls ? 'tool_calls=' + JSON.stringify(m.tool_calls) : ''} ${String(m.content ?? '').slice(0, 60)}`)
}

const secondOk = second.messages.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
console.log(secondOk ? '\nPASSED: assistant tool_calls persisted in history' : '\nFAILED: tool_calls missing from history')
// Tutup server lalu BERI KODE EXIT lewat exitCode (process.exit() saat
// koneksi masih terbuka memicu crash libuv di Windows)
server.closeAllConnections?.()
server.close()
process.exitCode = secondOk ? 0 : 1