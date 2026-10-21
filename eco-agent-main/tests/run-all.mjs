/**
 * Test runner — executes every *.test.mjs in this folder and reports.
 *
 *   npm test          run all tests
 *   npm test -- gemini   run only tests whose name contains "gemini"
 *
 * The tests use the compiled output in ../dist, so run `npm run build` first.
 */
import { readdirSync } from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]

const files = readdirSync(here)
  .filter(f => f.endsWith('.test.mjs'))
  .filter(f => !filter || f.includes(filter))
  .sort()

if (files.length === 0) {
  console.log('Tidak ada test yang cocok.')
  process.exit(0)
}

let failed = 0
let passedFiles = 0

for (const file of files) {
  console.log(`\n─── ${file} ${'─'.repeat(Math.max(0, 40 - file.length))}`)
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
    child.on('exit', (c, signal) => {
      if (signal) console.log(`    (child killed by signal: ${signal})`)
      if (c !== 0) console.log(`    (child exit code: ${c})`)
      resolve(c ?? 1)
    })
  })
  if (code === 0) passedFiles++
  else failed++
}

console.log(`\n${'═'.repeat(52)}`)
console.log(`${passedFiles}/${files.length} test file(s) lulus` + (failed ? ` — ${failed} gagal` : ''))
process.exit(failed > 0 ? 1 : 0)
