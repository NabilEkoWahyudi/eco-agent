/**
 * Gemini streaming test: SSE streamGenerateContent must yield text deltas AND
 * a tool_calls event that carries the Gemini 3.x thoughtSignature.
 */
import http from 'http'
import { AgentLoop } from '../dist/loop/index.js'
import { GeminiProvider } from '../dist/providers/gemini.js'

const SIG = 'ThoughtSig-ABC-123'
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
      res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Saya cek dulu.' }] } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'list_files', args: { path: '.' } }, thoughtSignature: SIG }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
      }) + '\n\n')
      res.end()
      return
    }
    res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Selesai.' }] } }] }) + '\n\n')
    res.end()
  })
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const provider = new GeminiProvider({
  type: 'gemini', model: 'gemini-3.8-flash', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`,
})

const chunks = []
const agent = new AgentLoop(provider, [{
  name: 'list_files', description: 'list',
  parameters: { path: { type: 'string', description: 'd', required: true } },
  execute: async () => 'x.txt',
}], { provider: {}, maxIterations: 3 })

const final = await agent.run('cek file', { onContent: c => chunks.push(c), onError: e => console.log('ERR', e.message) })

const modelTurn = requests[1].contents.find(c => c.role === 'model')
const fcPart = modelTurn?.parts?.find(p => p.functionCall)

console.log('chunks:', JSON.stringify(chunks))
console.log('final:', final)
console.log('stream url used:', requests[0].contents.length > 0)
console.log('thoughtSignature echoed:', fcPart?.thoughtSignature === SIG ? 'PASSED' : 'FAILED (' + fcPart?.thoughtSignature + ')')
console.log('functionResponse present:', requests[1].contents.some(c => c.parts?.some(p => p.functionResponse)) ? 'PASSED' : 'FAILED')

// Tutup server lalu BERI KODE EXIT lewat exitCode (process.exit() saat
// koneksi masih terbuka memicu crash libuv di Windows)
server.closeAllConnections?.()
server.close()
process.exitCode = fcPart?.thoughtSignature === SIG ? 0 : 1