import * as readline from 'readline'
import chalk from 'chalk'
import { checkOpenRouterModel, checkGroqModel, displayModelInfo } from './modelChecker.js'

export interface SavedConfig {
  mode: 'mock' | 'groq' | 'openrouter'
  apiKey?: string
  model?: string
  supportsTools?: boolean
}

// ─── Model suggestions ────────────────────────────────────────────────────────

const GROQ_SUGGESTIONS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'qwen-qwq-32b',
  'gemma2-9b-it',
  'mixtral-8x7b-32768',
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

async function enterModelId(
  rl: readline.Interface,
  mode: 'groq' | 'openrouter'
): Promise<string> {
  const suggestions = mode === 'groq' ? GROQ_SUGGESTIONS : OPENROUTER_SUGGESTIONS
  const docsUrl = mode === 'groq'
    ? 'https://console.groq.com/docs/models'
    : 'https://openrouter.ai/models'

  console.log()
  console.log(chalk.bold('  Step 2 — Enter model ID:'))
  console.log()
  console.log(chalk.gray('  Type the exact model ID you want to use.'))
  console.log(chalk.gray('  Browse models at: ') + chalk.cyan(docsUrl))
  console.log()
  console.log(chalk.bold('  Suggestions:'))
  suggestions.forEach(s => {
    console.log(`    ${chalk.gray('·')} ${chalk.white(s)}`)
  })
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
  prefix: string,
  hint: string,
  url: string
): Promise<string> {
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

    if (!key.startsWith(prefix)) {
      console.log(chalk.red(`  ✗ Invalid format. Key must start with "${prefix}"`))
      attempts++
      if (attempts >= 3) {
        console.log(chalk.yellow(`  ⚠  Still having trouble? Make sure you copied the full API key.`))
      }
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
    console.log(chalk.bold.green('   🌿 ECO AGENT — Setup'))
    console.log(chalk.gray(isReconfigure
      ? '   Changing configuration...'
      : '   Welcome! Let\'s get you set up.'))
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log()

    // ── Step 1: Choose provider ──────────────────────────────────────────────
    console.log(chalk.bold('  Step 1 — Choose provider:'))
    console.log()
    console.log(`  ${chalk.bgGreen.black(' 1 ')} ${chalk.bold('Mock')}`)
    console.log(`      ${chalk.gray('Testing mode — no API key needed')}`)
    console.log()
    console.log(`  ${chalk.bgCyan.black(' 2 ')} ${chalk.bold('Groq')}`)
    console.log(`      ${chalk.gray('Free & fast — console.groq.com')}`)
    console.log(`      ${chalk.gray('Key format: gsk_...')}`)
    console.log()
    console.log(`  ${chalk.bgMagenta.black(' 3 ')} ${chalk.bold('OpenRouter')}`)
    console.log(`      ${chalk.gray('Any model: Gemma, DeepSeek, GPT, Claude, Qwen, Llama...')}`)
    console.log(`      ${chalk.gray('Key format: sk-or-... · openrouter.ai')}`)
    console.log()

    let p = ''
    while (!['1', '2', '3'].includes(p)) {
      p = (await ask(rl, chalk.green('  Choose provider [1/2/3]: '))).trim()
      if (!['1', '2', '3'].includes(p)) console.log(chalk.red('  ✗ Please enter 1, 2, or 3'))
    }

    // Mock mode — no API key needed
    if (p === '1') {
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

    const mode = p === '2' ? 'groq' : 'openrouter'
    const keyPrefix = mode === 'groq' ? 'gsk_' : 'sk-or-'
    const keyHint   = mode === 'groq' ? 'gsk_...' : 'sk-or-...'
    const keyUrl    = mode === 'groq'
      ? 'https://console.groq.com/keys'
      : 'https://openrouter.ai/keys'

    // ── Step 2: Enter model ID (still uses same rl) ──────────────────────────
    const modelId = await enterModelId(rl, mode)

    // ── Step 3: Enter API key (same rl, muted output) ────────────────────────
    // NOTE: rl is NOT closed here — this was the original bug
    const apiKey = await enterApiKey(rl, keyPrefix, keyHint, keyUrl)

    // ── Step 4: Verify model capabilities ────────────────────────────────────
    console.log()
    console.log(chalk.cyan('  ⟳ Checking model capabilities...'))
    let supportsTools = true

    try {
      const caps = mode === 'openrouter'
        ? await checkOpenRouterModel(modelId, apiKey)
        : await checkGroqModel(modelId, apiKey)

      if (caps) {
        displayModelInfo(caps)
        supportsTools = caps.supportsTools
      } else {
        console.log(chalk.yellow(`  ⚠ Could not verify model "${modelId}".`))
        console.log(chalk.gray('  Proceeding anyway — if it fails, try another model ID.'))
        console.log()
      }
    } catch {
      console.log(chalk.gray('  (Model check skipped — will try at runtime)'))
    }

    // Done — close the single rl interface now
    rl.close()

    console.log()
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log(chalk.green('  🌿 Setup complete! Eco Agent is ready.'))
    console.log(chalk.gray(`     Provider : ${mode === 'groq' ? 'Groq' : 'OpenRouter'}`))
    console.log(chalk.gray(`     Model    : ${modelId}`))
    console.log(chalk.bold.green('  ══════════════════════════════════════════'))
    console.log()

    return { mode, apiKey, model: modelId, supportsTools }
  }
}
