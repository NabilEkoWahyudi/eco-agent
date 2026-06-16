import chalk from 'chalk'

export interface ModelCapabilities {
  id: string
  name: string
  supportsTools: boolean
  contextLength: number
  pricing?: { prompt: string; completion: string }
  isFree: boolean
}

/**
 * Fetch model info from OpenRouter and check tool support
 */
export async function checkOpenRouterModel(
  modelId: string,
  apiKey: string
): Promise<ModelCapabilities | null> {
  try {
    // 1. Verify API Key first
    const authRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    })
    if (!authRes.ok) throw new Error('Invalid API Key')

    // 2. Fetch models
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null

    const data = await res.json() as {
      data: Array<{
        id: string
        name: string
        context_length: number
        pricing: { prompt: string; completion: string }
        supported_parameters?: string[]
        top_provider?: { is_moderated?: boolean }
      }>
    }

    const model = data.data.find(m => m.id === modelId)
    if (!model) return null

    // Check tool support via supported_parameters
    const params = model.supported_parameters ?? []
    const supportsTools = params.includes('tools') || params.includes('tool_choice')

    const promptPrice = parseFloat(model.pricing?.prompt ?? '0')
    const isFree = promptPrice === 0

    return {
      id: model.id,
      name: model.name,
      supportsTools,
      contextLength: model.context_length,
      pricing: model.pricing,
      isFree
    }
  } catch {
    return null
  }
}

/**
 * Check Groq model capabilities
 */
export async function checkGroqModel(
  modelId: string,
  apiKey: string
): Promise<ModelCapabilities | null> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null

    const data = await res.json() as {
      data: Array<{ id: string; context_window: number }>
    }

    const model = data.data.find(m => m.id === modelId)
    if (!model) return null

    // Groq models that support tools (known list)
    const groqToolModels = [
      'llama-3.3-70b-versatile',
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-groq-70b-8192-tool-use-preview',
      'llama3-groq-8b-8192-tool-use-preview',
      'gemma2-9b-it',
      'mixtral-8x7b-32768',
    ]
    const supportsTools = groqToolModels.some(m => modelId.includes(m.split('-')[0]))

    return {
      id: model.id,
      name: model.id,
      supportsTools,
      contextLength: model.context_window,
      isFree: true // Groq is free tier
    }
  } catch {
    return null
  }
}

/**
 * Display model info box in terminal
 */
export function displayModelInfo(caps: ModelCapabilities): void {
  console.log()
  console.log(chalk.gray('  ┌─ Model Info ' + '─'.repeat(32) + '┐'))
  console.log(chalk.gray('  │ ') + chalk.bold(caps.name))
  console.log(chalk.gray('  │ ') + chalk.gray('Context : ') + chalk.white(caps.contextLength.toLocaleString() + ' tokens'))

  if (caps.pricing) {
    const prompt = parseFloat(caps.pricing.prompt)
    const priceStr = prompt === 0
      ? chalk.green('Free')
      : chalk.yellow(`$${(prompt * 1_000_000).toFixed(2)}/M tokens`)
    console.log(chalk.gray('  │ ') + chalk.gray('Pricing : ') + priceStr)
  }

  const toolStr = caps.supportsTools
    ? chalk.green('✓ Supported')
    : chalk.red('✗ Not supported (text-only mode)')
  console.log(chalk.gray('  │ ') + chalk.gray('Tools   : ') + toolStr)
  console.log(chalk.gray('  └' + '─'.repeat(46) + '┘'))
  console.log()

  if (!caps.supportsTools) {
    console.log(chalk.yellow('  ⚠ This model runs in text-only mode.'))
    console.log(chalk.gray('  Agent will answer questions but cannot use file/shell tools.'))
    console.log(chalk.gray('  For tool support, try: deepseek/deepseek-r1:free'))
    console.log()
  }
}
