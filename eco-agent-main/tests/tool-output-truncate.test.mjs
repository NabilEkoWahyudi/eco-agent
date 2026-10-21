// Test: tool output truncation keeps the context small but preserves head+tail
import { truncateToolOutput, MAX_TOOL_OUTPUT } from '../dist/utils/truncate.js'

let passed = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('PASSED ', name) }
  else { failed++; console.log('FAILED ', name, extra) }
}

// 1. Short output is untouched
const short = 'hello world'
const r1 = truncateToolOutput(short)
check('short output untouched', r1.text === short && !r1.truncated)

// 2. Long output is capped, keeps head and tail
const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`)
const long = lines.join('\n')
const r2 = truncateToolOutput(long)
check('long output truncated', r2.truncated === true)
check('truncated length <= budget + marker', r2.text.length <= MAX_TOOL_OUTPUT + 200, `${r2.text.length}`)
check('head preserved', r2.text.includes('line 0 '))
check('tail preserved', r2.text.includes('line 1999 '))
check('middle removed', !r2.text.includes('line 1000 '))
check('removed lines reported', r2.removedLines > 1000, String(r2.removedLines))

// 3. Custom limit
const r3 = truncateToolOutput(long, 1000)
check('custom limit honoured', r3.text.length <= 1200, String(r3.text.length))

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
process.exitCode = failed > 0 ? 1 : 0