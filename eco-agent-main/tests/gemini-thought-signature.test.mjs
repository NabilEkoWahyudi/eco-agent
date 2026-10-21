/**
 * Regression test for the Gemini 3.x "thought_signature" requirement.
 *
 * Before the fix: the model returned a functionCall part carrying a
 * thoughtSignature; eco-agent dropped it, so the NEXT request was rejected:
 *   400 "Function call is missing a thought_signature in functionCall parts"
 * (exactly the error in the user's screenshots)
 *
 * This test asserts the signature is echoed back verbatim.
 */
import http from 'http'
import { AgentLoop } from '../dist/loop/index.js'
import { GeminiProvider } from '../dist/providers/gemini.js'

const SIGNATURE = 'Cq0BdGhCJ3Fnc2VjcmV0U2lnbmF0dXJlVmFsdWUxMjM0'
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
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: { name: 'list_files', args: { path: '.' } },
              thoughtSignature: SIGNATURE,
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Selesai — file sudah terdaftar.' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
    }))
  })
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const provider = new GeminiProvider({
  type: 'gemini', model: 'gemini-3.8-flash',
  apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`,
})

const agent = new AgentLoop(provider, [{
  name: 'list_files', description: 'list files',
  parameters: { path: { type: 'string', description: 'dir', required: true } },
  execute: async () => 'a.txt\nb.txt',
}], { provider: {}, maxIterations: 3 })

const final = await agent.run('daftar file', { onError: e => console.log('ERR', e.message) })
console.log('FINAL:', final)

const second = requests[1]
const modelTurn = second.contents.find(c => c.role === 'model')
const fcPart = modelTurn?.parts?.find(p => p.functionCall)
const echoed = fcPart?.thoughtSignature

console.log('2nd request model part:', JSON.stringify(modelTurn))
const ok = echoed === SIGNATURE
console.log(ok
  ? 'PASSED: thought_signature echoed back verbatim'
  : `FAILED: thought_signature missing (got ${echoed})`)

// functionResponse must follow the model turn
const hasResponse = second.contents.some(c => c.parts?.some(p => p.functionResponse))
console.log(hasResponse ? 'PASSED: functionResponse present' : 'FAILED: functionResponse missing')

// Tutup server lalu BERI KODE EXIT lewat exitCode (process.exit() saat
// koneksi masih terbuka memicu crash libuv di Windows)
server.closeAllConnections?.()
server.close()
process.exitCode = ok && hasResponse ? 0 : 1