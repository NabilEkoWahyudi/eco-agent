// baseUrl honoring test: providers pointed at a dead local port must try THAT
// port (fetch failed / ECONNREFUSED), proving config.baseUrl overrides presets.
const { OpenAIProvider } = await import('../dist/providers/openai.js')
const { GeminiProvider } = await import('../dist/providers/gemini.js')
const { OpenRouterProvider } = await import('../dist/providers/openrouter.js')

const dead = 'http://127.0.0.1:59999'
const tests = [
  ['openai', new OpenAIProvider({ type: 'openai', apiKey: 'k', baseUrl: dead })],
  ['gemini', new GeminiProvider({ type: 'gemini', apiKey: 'k', baseUrl: dead })],
  ['openrouter', new OpenRouterProvider({ type: 'openrouter', apiKey: 'k', baseUrl: dead })],
]

let ok = 0
for (const [name, prov] of tests) {
  try {
    await prov.complete([{ role: 'user', content: 'x' }])
    console.log('FAILED', name, '(no error!)')
  } catch (e) {
    const msg = String(e?.message || e) + String(e?.cause?.message || '')
    const hit = msg.includes('59999') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
    console.log(hit ? 'PASSED ' : 'FAILED ', name, '->', msg.slice(0, 90))
    if (hit) ok++
  }
}
process.exitCode = ok === tests.length ? 0 : 1