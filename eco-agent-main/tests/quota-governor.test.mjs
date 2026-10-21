/**
 * Test: quota governor + 429 circuit breaker.
 * A server that always answers 429 must not be hammered with retries
 * (every retry shows up as a failed request on the provider dashboard).
 */
import http from 'http'
import { fetchWithRetry } from '../dist/utils/fetchHelper.js'

let hits = 0
const server = http.createServer((req, res) => {
  hits++
  res.writeHead(429, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Quota exceeded for quota metric: Requests' } }))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

let pass = 0, fail = 0
const ck = (n, c, e = '') => { c ? (pass++, console.log('PASSED ', n)) : (fail++, console.log('FAILED ', n, e)) }

// 1. Repeated 429 → circuit breaker stops retrying (max 2 attempts, not 4)
hits = 0
const res = await fetchWithRetry(`http://127.0.0.1:${port}/x`, { method: 'GET' }, {
  providerName: 'TestProvider', maxRetries: 3, initialDelayMs: 10, maxConsecutive429: 2,
})
ck('response returned to caller', res.status === 429)
ck('stopped after 2 attempts (not 4)', hits === 2, 'hits=' + hits)

// 2. onResponse hook is called
hits = 0
let seen = 0
await fetchWithRetry(`http://127.0.0.1:${port}/y`, { method: 'GET' }, {
  providerName: 'TestProvider', maxRetries: 1, initialDelayMs: 10, maxConsecutive429: 5,
  onResponse: () => { seen++ },
})
ck('onResponse called for every response', seen === 2, 'seen=' + seen)

// 3. A single 429 is retried (not tripped by the breaker)
hits = 0
let call = 0
const flaky = http.createServer((req, res) => {
  call++; hits++
  if (call === 1) {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'slow down' } }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":true}')
})
await new Promise(r => flaky.listen(0, '127.0.0.1', r))
const fport = flaky.address().port
const res2 = await fetchWithRetry(`http://127.0.0.1:${fport}/z`, { method: 'GET' }, {
  providerName: 'TestProvider', maxRetries: 3, initialDelayMs: 10, maxConsecutive429: 2,
})
ck('single 429 is retried and succeeds', res2.status === 200 && hits === 2, `status=${res2.status} hits=${hits}`)

flaky.close(); console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
// Tutup server lalu BERI KODE EXIT lewat exitCode (process.exit() saat
// koneksi masih terbuka memicu crash libuv di Windows)
server.closeAllConnections?.()
server.close()
process.exitCode = fail > 0 ? 1 : 0