/**
 * Streaming test: the agent loop must use the provider's streaming API so
 * text arrives incrementally (visible time-to-first-token) and tool calls
 * still round-trip correctly.
 */
import http from 'http'
import { AgentLoop } from '../dist/loop/index.js'
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js'

let callCount = 0
const requests = []

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    requests.push(JSON.parse(body))
    callCount++
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })

    if (callCount === 1) {
      // Text deltas first, then a tool call, then finish
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Saya akan ' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'mencari file.' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."' } }] } }]
      }) + '\n\n')
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }]
      }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Selesai. ' } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'File ditemukan.' } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const provider = new OpenAICompatibleProvider({
  type: 'openai-compatible', model: 'test-model',
  baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
})

const chunks = []
const agent = new AgentLoop(provider, [{
  name: 'list_files', description: 'list files',
  parameters: { path: { type: 'string', description: 'dir', required: true } },
  execute: async () => 'a.txt\nb.txt',
}], { provider: {}, maxIterations: 3 })

const final = await agent.run('cari file', {
  onContent: (c) => chunks.push(c),
  onFirstToken: (ms) => console.log('first token after', ms, 'ms'),
  onError: e => console.log('ERR', e.message),
})

console.log('chunks received:', chunks.length, JSON.stringify(chunks))
console.log('final:', final)

const second = requests[1]
const hasAssistantToolCalls = second.messages.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
const hasToolResult = second.messages.some(m => m.role === 'tool')
const streamed = requests[0].stream === true

console.log('request used stream:true ->', streamed)
console.log('assistant tool_calls in 2nd request ->', hasAssistantToolCalls)
console.log('tool result in 2nd request ->', hasToolResult)

const ok = chunks.length >= 2 && streamed && hasAssistantToolCalls && hasToolResult
console.log(ok ? '\nPASSED: streaming + tool round-trip works' : '\nFAILED')
// Tutup server lalu BERI KODE EXIT lewat exitCode (process.exit() saat
// koneksi masih terbuka memicu crash libuv di Windows)
server.closeAllConnections?.()
server.close()
process.exitCode = ok ? 0 : 1