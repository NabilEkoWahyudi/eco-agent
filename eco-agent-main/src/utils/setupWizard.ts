import * as readline from 'readline'
import chalk from 'chalk'
import { checkOpenRouterModel, checkGroqModel, displayModelInfo } from './modelChecker.js'

export interface SavedConfig {
  mode: 'mock' | 'groq' | 'openrouter' | 'ollama' | 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'aistudio' | 'openai-compatible'
  apiKey?: string
  model?: string
  baseUrl?: string
  supportsTools?: boolean
}

// ─── Model suggestions ────────────────────────────────────────────────────────

const GROQ_SUGGESTIONS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'qwen-qwq-32b',
  'gemma2-9b-it',
]

const OPENROUTER_SUGGESTIONS = [
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemma-3n-e4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-235b-a22b:free',
  'openai/gpt-4o',
  'anthropic/claude-sonnet-4-5',
  'google/gemini-2.5-pro-preview',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function divider(label = '') {
  const w = 46
  if (!label) return chalk.gray('  ' + '─'.repeat(w))
  const line = '─'.repeat(Math.max(0, Math.floor((w - label.length - 2) / 2)))
  return chalk.gray(`  ${line} ${label} ${line}`)
}

/**
 * Ask a regular visible question using the given readline interface.
 */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

/**
 * Ask a question but mask the typed characters with '*'.
 *
 * Strategy (same as Claude Code / Antigravity):
 *   – Use the SAME readline interface (no raw-mode switching)
 *   – Temporarily monkey-patch `_writeToOutput` on the rl interface so that
 *     any character the user types is replaced with '*' on screen.
 *   – Restore the original method immediately after Enter is pressed.
 *
 * This avoids all conflict between readline and process.stdin.setRawMode().
 */
function askHidden(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    // Access internal readline output writer (works on all Node ≥ 14)
    const rlAny = rl as any
    const originalWrite = rlAny._writeToOutput.bind(rl)

    let masking = false

    // Override the internal output writer
    rlAny._writeToOutput = function (str: string) {
      if (!masking) {
        // Before the user starts typing — show the prompt normally
        originalWrite(str)
        return
      }
      // Mask printable characters with '*'; pass through control sequences
      const masked = str.replace(/[^\r\n\x1b\x00-\x1f]/g, '*')
      originalWrite(masked)
    }

    rl.question(question, (answer) => {
      // Restore original writer before doing anything else
      rlAny._writeToOutput = originalWrite
      masking = false
      process.stdout.write('\n')
      resolve(answer.trim())
    })

    // Start masking after the prompt is written (next tick)
    setImmediate(() => { masking = true })
  })
}

// ─── Step: enter model ID ─────────────────────────────────────────────────────

const MODEL_DOCS_URLS: Record<string, string> = {
  groq:               'https://console.groq.com/docs/models',
  openrouter:         'https://openrouter.ai/models',
  openai:             'https://platform.openai.com/docs/models',
  deepseek:           'https://platform.deepseek.com/docs',
  anthropic:          'https://docs.anthropic.com/claude/docs/models-overview',
  gemini:             'https://ai.google.dev/gemini-api/docs/models',
  'openai-compatible': 'https://platform.openai.com/docs/models',
}

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  groq:               ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-qwq-32b', 'gemma2-9b-it'],
  openrouter:         ['deepseek/deepseek-r1:free', 'deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-4o', 'anthropic/claude-sonnet-4-5'],
  openai:             ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'],
  deepseek:           ['deepseek-chat', 'deepseek-reasoner (no tool calling)'],
  anthropic:          ['claude-sonnet-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  gemini:             ['gemini-3.8-flash', 'gemini-2.5-pro-preview', 'gemini-2.0-flash'],
  'openai-compatible': ['your-model-name'],
}

async function enterModelId(
  rl: readline.Interface,
  mode: SavedConfig['mode']
): Promise<string> {
  const docsUrl = MODEL_DOCS_URLS[mode] ?? 'https://openrouter.ai/models'
  const suggestions = MODEL_SUGGESTIONS[mode] ?? []

  console.log()
  console.log(chalk.bold('  Step 2 — Enter model ID:'))
  console.log()
  console.log(chalk.gray('  Type the exact model ID you want to use.'))
  console.log(chalk.gray('  Browse models at: ') + chalk.cyan(docsUrl))
  if (suggestions.length > 0) {
    console.log()
    console.log(chalk.bold('  Suggestions:'))
    suggestions.forEach(s => console.log(`    ${chalk.gray('·')} ${chalk.white(s)}`))
  }
  console.log()

  let modelId = ''
  while (!modelId.trim()) {
    modelId = (await ask(rl, chalk.green('  Model ID: '))).trim()
    if (!modelId) console.log(chalk.red('  ✗ Model ID cannot be empty'))
  }

  console.log(chalk.green(`  ✓ Model set: ${modelId}`))
  return modelId
}

// ─── Step: enter API key ──────────────────────────────────────────────────────

async function enterApiKey(
  rl: readline.Interface,
  prefixes: string | string[],
  hint: string,
  url: string
): Promise<string> {
  const validPrefixes = Array.isArray(prefixes) ? prefixes : [prefixes]

  console.log()
  console.log(divider('API Key'))
  console.log()
  console.log(chalk.bold('  Step 3 — Enter your API Key:'))
  console.log(chalk.gray('  Get one at: ') + chalk.cyan(url))
  console.log(chalk.gray(`  Format: ${hint}`))
  console.log()

  let key = ''
  let attempts = 0

  while (true) {
    key = await askHidden(rl, chalk.green(`  API Key (${hint}): `))

    if (!key) {
      console.log(chalk.red('  ✗ API key cannot be empty. Try again.'))
      continue
    }

    const hasValidPrefix = validPrefixes.some(p => key.startsWith(p))
    if (!hasValidPrefix) {
      console.log(chalk.red(`  ✗ Invalid format. Key must start with "${validPrefixes[0]}"`)) 
      attempts++
      if (attempts >= 3) {
        console.log(chalk.yellow(`  ! Still having trouble? Make sure you copied the full API key.`))
        console.log(chalk.yellow(`  ! Accepted prefixes: ${validPrefixes.join(', ')}.`))
        // Allow bypass after 3 failed attempts in case of new key format
        console.log(chalk.gray('  Press Enter to skip prefix check and proceed anyway.'))
      }
      if (attempts >= 4) break // allow bypass after 4 attempts
      continue
    }

    if (key.length < 20) {
      console.log(chalk.red('  ✗ Key seems too short. Please paste the complete key.'))
      continue
    }

    // Valid key
    break
  }

  console.log(chalk.green(`  ✓ API key accepted (...${key.slice(-4)})`))  
  return key
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export async function runSetupWizard(isReconfigure = false): Promise<SavedConfig> {
  while (true) {
    // ONE readline interface for the entire wizard — never closed early
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })

    // Prevent readline from swallowing Ctrl+C so the process can still exit
    rl.on('SIGINT', () => {
      rl.close()
      console.log()
      process.exit(0)
    })

    console.log()
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log(chalk.bold.green('   ECO AGENT — Setup'))
    console.log(chalk.gray(isReconfigure
      ? '   Changing configuration...'
      : '   Welcome! Let\'s get you set up.'))
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log()

    // ── Step 1: Choose provider ──────────────────────────────────────────────
    console.log(chalk.bold('  Step 1 — Choose provider:'))
    console.log()
    console.log(`  ${chalk.bgGreen.black(' 1 ')} ${chalk.bold('Groq')}           ${chalk.gray('Free & fast · gsk_... · console.groq.com')}`)
    console.log(`  ${chalk.bgMagenta.black(' 2 ')} ${chalk.bold('OpenRouter')}     ${chalk.gray('Multi-model aggregator · sk-or-... · openrouter.ai')}`)
    console.log(`  ${chalk.bgYellow.black(' 3 ')} ${chalk.bold('DeepSeek')}       ${chalk.gray('Official API, very cheap · platform.deepseek.com')}`)
    console.log(`  ${chalk.bgWhite.black(' 4 ')} ${chalk.bold('OpenAI')}         ${chalk.gray('Official API (GPT-4o, o3-mini) · platform.openai.com')}`)
    console.log(`  ${chalk.bgRed.black(' 5 ')} ${chalk.bold('Anthropic')}      ${chalk.gray('Claude 3.5/4 · sk-ant-... · console.anthropic.com')}`)
    console.log(`  ${chalk.bgBlue.black(' 6 ')} ${chalk.bold('Google Gemini')}  ${chalk.gray('Pick your model · AIza... · aistudio.google.com')}`)
    console.log(`  ${chalk.bgHex('#4285F4').black(' 7 ')} ${chalk.bold('AI Studio')}      ${chalk.gray('Google AI Studio · auto model · AIza... (recommended!)')}`)
    console.log(`  ${chalk.bgCyan.black(' 8 ')} ${chalk.bold('OpenAI-Compat')}  ${chalk.gray('Custom endpoint (LM Studio, vLLM, LocalAI, Together…)')}`)
    console.log(`  ${chalk.bgGreenBright.black(' 9 ')} ${chalk.bold('Ollama')}         ${chalk.gray('Local models — no API key · ollama.com')}`)
    console.log(`  ${chalk.bgGray.black(' 0 ')} ${chalk.bold('Mock')}           ${chalk.gray('Testing mode — no API key needed')}`)
    console.log()

    const validChoices = ['1','2','3','4','5','6','7','8','9','0']
    let p = ''
    while (!validChoices.includes(p)) {
      p = (await ask(rl, chalk.green('  Choose provider [1-9, 0=Mock]: '))).trim()
      if (!validChoices.includes(p)) console.log(chalk.red('  ✗ Please enter a number from 0 to 9'))
    }

    // Mock mode — no API key needed
    if (p === '0') {
      console.log()
      console.log(chalk.yellow('  Mock mode selected.'))
      console.log(chalk.gray('  Switch anytime with /config inside the REPL.'))
      console.log()

      let c = ''
      while (!['y', 'n', 'b', ''].includes(c.toLowerCase())) {
        c = (await ask(rl, chalk.green('  Continue with Mock? [Y/n] or [b] to go back: '))).trim().toLowerCase()
      }
      rl.close()

      if (c === 'b' || c === 'n') { console.log(); continue }

      console.log()
      console.log(chalk.green('  ✓ Mock mode active. Ready to go!\n'))
      return { mode: 'mock' }
    }

    // ── Google AI Studio: API key only, auto model (gemini-2.0-flash) ───────
    if (p === '7') {
      console.log()
      console.log(chalk.bold('  Google AI Studio — Quick Setup'))
      console.log()
      console.log(chalk.gray('  Uses ') + chalk.cyan('gemini-3.8-flash') + chalk.gray(' by default (free tier, very fast).'))
      console.log(chalk.gray('  Get your free API key at: ') + chalk.cyan('https://aistudio.google.com/app/apikey'))
      console.log()

      let aiStudioKey = ''
      while (true) {
        aiStudioKey = await askHidden(rl, chalk.green('  API Key (AIza... or AQ....): '))
        if (!aiStudioKey) {
          console.log(chalk.red('  ✗ API key cannot be empty. Try again.'))
          continue
        }
        if (aiStudioKey.length < 20) {
          console.log(chalk.red('  ✗ Key seems too short. Please paste the complete key.'))
          continue
        }
        // Accept AIza..., AQ., and any other Google key format
        const validPrefix = aiStudioKey.startsWith('AI') || aiStudioKey.startsWith('AQ')
        if (!validPrefix) {
          console.log(chalk.yellow('  ! Unexpected key format. Google keys usually start with "AIza" or "AQ."'))
          console.log(chalk.gray('  Proceeding anyway — if it fails, double-check your key at aistudio.google.com/app/apikey'))
        }
        break
      }

      const modelAiStudio = 'gemini-3.8-flash'

      rl.close()
      console.log()
      console.log(chalk.bold.green('  ══════════════════════════════════════════'))
      console.log(chalk.green('  Setup complete! Eco Agent is ready.'))
      console.log(chalk.gray(`     Provider : Google AI Studio`))
      console.log(chalk.gray(`     Model    : ${modelAiStudio} (auto)`))
      console.log(chalk.gray(`     API Key  : ...${aiStudioKey.slice(-4)}`))
      console.log(chalk.bold.green('  ══════════════════════════════════════════'))
      console.log()

      return { mode: 'aistudio', apiKey: aiStudioKey, model: modelAiStudio, supportsTools: true } as SavedConfig
    }

    // ── Ollama: no API key, just base URL ───────────────────────────────────
    if (p === '9') {
      console.log()
      console.log(chalk.bold('  Ollama — Local Model Setup'))
      console.log()

      const OLLAMA_SUGGESTIONS = [
        'llama3.2',
        'llama3.1:70b',
        'mistral',
        'gemma3',
        'qwen2.5-coder',
        'deepseek-r1',
        'phi4',
      ]
      console.log(chalk.gray('  Make sure Ollama is running: ') + chalk.cyan('ollama serve'))
      console.log(chalk.gray('  Pull a model first: ') + chalk.cyan('ollama pull llama3.2'))
      console.log()
      console.log(chalk.bold('  Suggestions:'))
      OLLAMA_SUGGESTIONS.forEach(s => console.log(`    ${chalk.gray('·')} ${chalk.white(s)}`))
      console.log()

      let ollamaModel = ''
      while (!ollamaModel.trim()) {
        ollamaModel = (await ask(rl, chalk.green('  Model name (e.g. llama3.2): '))).trim()
        if (!ollamaModel) console.log(chalk.red('  ✗ Model name cannot be empty'))
      }

      const defaultUrl = 'http://localhost:11434'
      const urlInput = (await ask(rl, chalk.green(`  Ollama URL [${defaultUrl}]: `))).trim()
      const ollamaUrl = urlInput || defaultUrl

      rl.close()

      console.log()
      console.log(chalk.bold.green('  ══════════════════════════════════════════'))
      console.log(chalk.green('  Setup complete! Eco Agent is ready.'))
      console.log(chalk.gray(`     Provider : Ollama (local)`))
      console.log(chalk.gray(`     Model    : ${ollamaModel}`))
      console.log(chalk.gray(`     URL      : ${ollamaUrl}`))
      console.log(chalk.bold.green('  ══════════════════════════════════════════'))
      console.log()

      return { mode: 'ollama', model: ollamaModel, baseUrl: ollamaUrl, supportsTools: true }
    }

    // ── OpenAI-Compatible: custom base URL + optional API key ────────────────
    if (p === '8') {
      console.log()
      console.log(chalk.bold('  OpenAI-Compatible — Custom Endpoint Setup'))
      console.log()
      console.log(chalk.gray('  Works with: LM Studio, vLLM, LocalAI, Together AI, xAI Grok, etc.'))
      console.log()

      const defaultCompatUrl = 'http://localhost:1234/v1'
      const urlInput = (await ask(rl, chalk.green(`  Base URL [${defaultCompatUrl}]: `))).trim()
      const compatUrl = urlInput || defaultCompatUrl

      let compatModel = ''
      while (!compatModel.trim()) {
        compatModel = (await ask(rl, chalk.green('  Model name: '))).trim()
        if (!compatModel) console.log(chalk.red('  ✗ Model name cannot be empty'))
      }

      const compatKeyInput = (await ask(rl, chalk.green('  API Key (leave blank if not needed): '))).trim()

      rl.close()

      console.log()
      console.log(chalk.bold.green('  ══════════════════════════════════════════'))
      console.log(chalk.green('  Setup complete! Eco Agent is ready.'))
      console.log(chalk.gray(`     Provider : OpenAI-Compatible`))
      console.log(chalk.gray(`     Endpoint : ${compatUrl}`))
      console.log(chalk.gray(`     Model    : ${compatModel}`))
      console.log(chalk.bold.green('  ══════════════════════════════════════════'))
      console.log()

      return {
        mode: 'openai-compatible',
        model: compatModel,
        baseUrl: compatUrl,
        apiKey: compatKeyInput || undefined,
        supportsTools: true
      } as SavedConfig
    }

    // ── Map choice number to mode string ────────────────────────────────────
    const modeMap: Record<string, SavedConfig['mode']> = {
      '1': 'groq',
      '2': 'openrouter',
      '3': 'deepseek',
      '4': 'openai',
      '5': 'anthropic',
      '6': 'gemini',
    }
    const mode = modeMap[p]

    // Key config per provider
    const keyConfig: Record<string, { prefixes: string[]; hint: string; url: string }> = {
      groq:       { prefixes: ['gsk_'],               hint: 'gsk_...',            url: 'https://console.groq.com/keys' },
      openrouter: { prefixes: ['sk-or-v1-', 'sk-or-'], hint: 'sk-or-...',          url: 'https://openrouter.ai/keys' },
      deepseek:   { prefixes: ['sk-'],                hint: 'sk-...',             url: 'https://platform.deepseek.com/api_keys' },
      openai:     { prefixes: ['sk-'],                hint: 'sk-...',             url: 'https://platform.openai.com/api-keys' },
      anthropic:  { prefixes: ['sk-ant-'],            hint: 'sk-ant-...',         url: 'https://console.anthropic.com/keys' },
      gemini:     { prefixes: ['AI', 'AQ'],            hint: 'AIza... or AQ....',  url: 'https://aistudio.google.com/app/apikey' },
    }
    const kc = keyConfig[mode]

    // ── Step 2: Enter model ID ───────────────────────────────────────────────
    const modelId = await enterModelId(rl, mode)

    // ── Step 3: Enter API key ────────────────────────────────────────────────
    const apiKey = await enterApiKey(rl, kc.prefixes, kc.hint, kc.url)

    // ── Step 4: Verify model capabilities (only for groq & openrouter) ───────
    console.log()
    let supportsTools = true

    if (mode === 'groq' || mode === 'openrouter') {
      console.log(chalk.cyan('  ⟳ Checking model capabilities...'))
      try {
        const caps = mode === 'openrouter'
          ? await checkOpenRouterModel(modelId, apiKey)
          : await checkGroqModel(modelId, apiKey)

        if (caps) {
          displayModelInfo(caps)
          supportsTools = caps.supportsTools
        } else {
          console.log(chalk.yellow(`  ! Could not verify model "${modelId}".`))
          console.log(chalk.gray('  Proceeding anyway — if it fails, try another model ID.'))
          console.log()
        }
      } catch {
        console.log(chalk.gray('  (Model check skipped — will try at runtime)'))
      }
    } else {
      console.log(chalk.gray('  (Model validation skipped — will verify at runtime)'))
    }

    // Done — close the single rl interface now
    rl.close()

    const providerLabels: Record<string, string> = {
      groq: 'Groq', openrouter: 'OpenRouter', deepseek: 'DeepSeek',
      openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', aistudio: 'Google AI Studio',
    }

    console.log()
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log(chalk.green('  Setup complete! Eco Agent is ready.'))
    console.log(chalk.gray(`     Provider : ${providerLabels[mode] ?? mode}`))
    console.log(chalk.gray(`     Model    : ${modelId}`))
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log()

    return { mode, apiKey, model: modelId, supportsTools } as SavedConfig
  }
}
