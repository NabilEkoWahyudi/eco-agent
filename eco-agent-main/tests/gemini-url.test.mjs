/**
 * Regression test: the Gemini provider must build a valid query string.
 *
 * Before the fix the key was appended with `?key=` to a URL that already had
 * `?alt=sse`, producing
 *   ...:streamGenerateContent?alt=sse?key=AIza...
 * → 400 "Invalid value \"sse?key=...\" for query parameter 'alt'"
 */
import http from 'http'
import { GeminiProvider } from '../dist/providers/gemini.js'

let seenUrl = ''
let seenBody = null
const server = http.createServer((req, res) => {
  seenUrl = req.url
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    seenBody = body
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'halo dari stream' }] } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const provider = new GeminiProvider({
  type: 'gemini', model: 'gemini-3.8-flash', apiKey: 'AIzaTESTKEY',
  baseUrl: `http://127.0.0.1:${port}/v1beta/models`,
})

let pass = 0, fail = 0
const ck = (n, c, e = '') => { c ? (pass++, console.log('PASSED ', n)) : (fail++, console.log('FAILED ', n, e)) }

const chunks = []
for await (const ev of provider.streamWithTools([{ role: 'user', content: 'hi' }], [])) {
  if (ev.type === 'text') chunks.push(ev.text)
}

ck('query string memakai &key= (bukan ?key=)', seenUrl.includes('alt=sse&key=AIzaTESTKEY'), seenUrl)
ck('tidak ada "sse?key=" yang rusak', !seenUrl.includes('sse?key='), seenUrl)
ck('hanya satu tanda "?" di URL', (seenUrl.match(/\?/g) || []).length === 1, seenUrl)
ck('teks stream diterima', chunks.join('') === 'halo dari stream', JSON.stringify(chunks))
ck('body request terkirim', !!seenBody && seenBody.includes('contents'))

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
// Tutup server lalu BERI KODE EXIT lewat exitCode (process.exit() saat
// koneksi masih terbuka memicu crash libuv di Windows)
server.closeAllConnections?.()
server.close()
process.exitCode = fail > 0 ? 1 : 0