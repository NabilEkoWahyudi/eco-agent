/**
 * Regression tests for toolsOverride.
 *
 * Before the fix, run() sent `toolsOverride ?? this.tools` to the model but
 * executeToolCall() still looked tools up in `this.tools`. As a result an
 * empty override (used by /commit and /pr) still executed tools such as
 * write_file/run_shell, and tools that existed only in the override list were
 * rejected as "Unknown tool".
 */
import { AgentLoop } from '../dist/loop/index.js'

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log('PASSED ', name)
  } else {
    failed++
    console.log('FAILED ', name, detail)
  }
}

function makeTool(name, execute) {
  return { name, description: name, parameters: {}, execute }
}

function toolCallResponse(...calls) {
  return {
    content: 'calling tools',
    toolCalls: calls.map(([name, args = {}], i) => ({
      id: `call_${i}`,
      name,
      arguments: args,
    })),
    finishReason: 'tool_calls',
  }
}

function finalResponse(text = 'done') {
  return { content: text, finishReason: 'stop' }
}

/** Minimal Provider implementation: no streamWithTools, scripted responses. */
function makeProvider(responses) {
  let index = 0
  return {
    requests: [],
    async complete(messages, tools = []) {
      this.requests.push({ messages, tools })
      return responses[Math.min(index++, responses.length - 1)]
    },
  }
}

function makeLoop(tools, provider) {
  return new AgentLoop(provider, tools, { provider: {}, maxIterations: 4 })
}

// 1. Empty override must not execute anything, even if the model asks.
{
  let shellCalls = 0
  let writeCalls = 0
  const trackedShell = makeTool('run_shell', async () => { shellCalls++; return 'ran' })
  const trackedWrite = makeTool('write_file', async () => { writeCalls++; return 'wrote' })

  const provider = makeProvider([
    toolCallResponse(['run_shell', { command: 'echo hi' }], ['write_file', { path: 'x.txt', content: 'hi' }]),
    finalResponse(),
  ])
  const results = []
  const loop = makeLoop([trackedShell, trackedWrite], provider)

  await loop.run('commit', { onToolResult: (name, msg, error) => results.push({ name, msg, error }) }, [])

  check('empty override: no tool executed', shellCalls === 0 && writeCalls === 0,
    `shell=${shellCalls} write=${writeCalls}`)
  check('empty override: both calls reported as errors',
    results.length === 2 && results.every(r => r.error === true))
  check('empty override: error mentions no active tools',
    results.every(r => r.msg.includes('Available tools: (none)')),
    results.map(r => r.msg).join(' | '))
  check('empty override: model received an empty tool list',
    provider.requests[0].tools.length === 0)
}

// 2. A tool that exists only in the override list must execute.
{
  let specialCalls = 0
  const special = makeTool('special', async () => { specialCalls++; return 'ok' })
  const provider = makeProvider([
    toolCallResponse(['special']),
    finalResponse(),
  ])
  const loop = makeLoop([], provider)

  await loop.run('task', {}, [special])

  check('override-only tool executes', specialCalls === 1, `calls=${specialCalls}`)
}

// 3. A tool outside the override must not execute, even when it exists in this.tools.
{
  let readCalls = 0
  let writeCalls = 0
  const readFile = makeTool('read_file', async () => { readCalls++; return 'data' })
  const writeFile = makeTool('write_file', async () => { writeCalls++; return 'wrote' })
  const provider = makeProvider([
    toolCallResponse(['write_file', { path: 'x.txt' }]),
    finalResponse(),
  ])
  const results = []
  const loop = makeLoop([readFile, writeFile], provider)

  await loop.run('task', { onToolResult: (name, msg, error) => results.push({ name, msg, error }) },
    [readFile])

  check('tool outside override is rejected', writeCalls === 0, `writeCalls=${writeCalls}`)
  check('tool outside override reports Unknown tool',
    results[0]?.error === true && results[0]?.msg.includes('Unknown tool "write_file"'),
    results[0]?.msg)
  check('read_file was not executed either (model did not request it)', readCalls === 0)
}

// 4. Without an override, this.tools is still used (no regression).
{
  let readCalls = 0
  const readFile = makeTool('read_file', async () => { readCalls++; return 'data' })
  const provider = makeProvider([
    toolCallResponse(['read_file', { path: 'a.txt' }]),
    finalResponse(),
  ])
  const loop = makeLoop([readFile], provider)

  await loop.run('task', {})

  check('no override: default tools still execute', readCalls === 1, `calls=${readCalls}`)
}

// 5. The "Available tools" message must describe the active run, not this.tools.
{
  const provider = makeProvider([
    toolCallResponse(['nope']),
    finalResponse(),
  ])
  const results = []
  const loop = makeLoop([makeTool('write_file', async () => 'wrote')], provider)

  await loop.run('task', { onToolResult: (name, msg, error) => results.push({ name, msg, error }) },
    [makeTool('read_file', async () => 'data')])

  const msg = results[0]?.msg ?? ''
  check('error message lists override tools', msg.includes('Available tools: read_file'), msg)
  check('error message does not list inactive tools', !msg.includes('write_file'), msg)
}

// 6. Every provider request in the run uses the same resolved list.
{
  const readFile = makeTool('read_file', async () => 'data')
  const provider = makeProvider([
    toolCallResponse(['read_file', { path: 'a.txt' }]),
    finalResponse(),
  ])
  const loop = makeLoop([makeTool('write_file', async () => 'wrote')], provider)

  await loop.run('task', {}, [readFile])

  const names = provider.requests.map(r => r.tools.map(t => t.name))
  check('all requests use the override list', names.every(n => n.length === 1 && n[0] === 'read_file'),
    JSON.stringify(names))
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
process.exitCode = failed > 0 ? 1 : 0
