/**
 * Regression test: the streamed model text must NOT be erased by the spinner
 * or by the tool-call box (this was the "output disappears" bug).
 *
 * Flow mirrors the user screenshot:
 *   turn 1: model streams text + a tool call  → tool runs
 *   turn 2: model streams the final text
 */
import http from 'http'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Project root = one level above tests/
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const H = 'C:/Users/Ahmad/AppData/Local/Temp/opencode/eco-vanish-home2'
fs.rmSync(H, { recursive: true, force: true })
fs.mkdirSync(H + '/.appdata/eco-agent-nodejs/Config', { recursive: true })
fs.mkdirSync(H + '/.appdata/eco-agent-secrets-nodejs', { recursive: true })

let callCount = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    callCount++
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (callCount === 1) {
      // narration, then a tool call
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'NARASI_MODEL_SEBELUM_TOOL' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_directory', arguments: '{"path":"."}' } }] } }]
      }) + '\n\n')
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'JAWABAN_FINAL_MODEL' } }] }) + '\n\n')
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

fs.writeFileSync(H + '/.appdata/eco-agent-nodejs/Config/config.json', JSON.stringify({
  mode: 'openai-compatible', apiKey: 'test-key', model: 'fake-model',
  baseUrl: `http://127.0.0.1:${port}`, supportsTools: true, ponytailMode: 'full',
}))

const child = spawn('node', ['dist/cli/index.js'], {
  cwd: PROJECT_ROOT,
  env: { ...process.env, USERPROFILE: H, HOME: H, APPDATA: H + '/.appdata' },
})

let raw = ''
child.stdout.on('data', d => { raw += d.toString() })
child.stderr.on('data', d => process.stderr.write(d))

child.stdin.write('kerjakan sesuatu\n')
setTimeout(() => { child.stdin.write('/exit\n') }, 3500)
setTimeout(() => {
  const visible = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('=== OUTPUT TERLIHAT ===')
  const i = visible.indexOf('eco ›')
  console.log(visible.slice(i, i + 1600))

  const checks = [
    ['narasi model sebelum tool terlihat', visible.includes('NARASI_MODEL_SEBELUM_TOOL')],
    ['kotak tool call terlihat', visible.includes('list_directory')],
    ['hasil tool terlihat', visible.includes('✓ list_directory:')],
    ['jawaban final terlihat', visible.includes('JAWABAN_FINAL_MODEL')],
    ['tidak ada erase-display', !/\x1b\[0J/.test(raw)],
  ]
  console.log('\n=== HASIL ===')
  let ok = true
  for (const [name, cond] of checks) {
    console.log((cond ? 'PASSED  ' : 'FAILED  ') + name)
    if (!cond) ok = false
  }
  child.kill();   console.log(ok ? '\nPASSED: output tidak hilang' : '\nFAILED: output masih hilang')
  process.exit(ok ? 0 : 1)
}, 5000)
