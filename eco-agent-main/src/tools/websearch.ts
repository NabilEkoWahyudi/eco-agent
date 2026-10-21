/**
 * Web Search Multi-Provider
 * 
 * Supports multiple search providers with automatic fallback:
 * - Tavily API (best quality, needs API key)
 * - SearXNG (self-hosted, free)
 * - Brave Search API (needs API key)
 * - DuckDuckGo (free, no API key, existing fallback)
 * 
 */

export type WebSearchProvider = 'tavily' | 'brave' | 'searxng' | 'duckduckgo'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  score?: number
}

export interface SearchResponse {
  provider: WebSearchProvider
  query: string
  results: SearchResult[]
  answer?: string  // Some providers return a direct AI answer
}

// ─────────────────────────────────────────────────────────
// Provider: Tavily
// ─────────────────────────────────────────────────────────

async function searchTavily(query: string, apiKey: string): Promise<SearchResponse> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      include_answer: true,
      max_results: 6,
    }),
    signal: AbortSignal.timeout(12000),
  })

  if (!res.ok) throw new Error(`Tavily error: HTTP ${res.status}`)

  const data = await res.json() as {
    answer?: string
    results?: Array<{ title: string; url: string; content: string; score?: number }>
  }

  return {
    provider: 'tavily',
    query,
    answer: data.answer,
    results: (data.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 300) ?? '',
      score: r.score,
    }))
  }
}

// ─────────────────────────────────────────────────────────
// Provider: Brave Search
// ─────────────────────────────────────────────────────────

async function searchBrave(query: string, apiKey: string): Promise<SearchResponse> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(12000),
  })

  if (!res.ok) throw new Error(`Brave error: HTTP ${res.status}`)

  const data = await res.json() as {
    web?: {
      results?: Array<{ title: string; url: string; description?: string }>
    }
  }

  return {
    provider: 'brave',
    query,
    results: (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? '',
    }))
  }
}

// ─────────────────────────────────────────────────────────
// Provider: SearXNG (self-hosted instance)
// ─────────────────────────────────────────────────────────

async function searchSearxng(query: string, instanceUrl: string): Promise<SearchResponse> {
  const url = `${instanceUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&categories=general`
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'eco-agent/1.0',
    },
    signal: AbortSignal.timeout(12000),
  })

  if (!res.ok) throw new Error(`SearXNG error: HTTP ${res.status}`)

  const data = await res.json() as {
    results?: Array<{ title: string; url: string; content?: string }>
    answers?: string[]
  }

  return {
    provider: 'searxng',
    query,
    answer: data.answers?.[0],
    results: (data.results ?? []).slice(0, 6).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
    }))
  }
}

// ─────────────────────────────────────────────────────────
// Provider: DuckDuckGo (existing logic, enhanced)
// ─────────────────────────────────────────────────────────

async function searchDuckDuckGo(query: string): Promise<SearchResponse> {
  // Strategy 1: DDG Instant Answer API
  try {
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'eco-agent/1.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const data = await res.json() as {
        AbstractText?: string
        AbstractURL?: string
        Answer?: string
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
      }

      const results: SearchResult[] = []
      if (data.AbstractText && data.AbstractURL) {
        results.push({ title: 'Summary', url: data.AbstractURL, snippet: data.AbstractText.slice(0, 300) })
      }
      if (data.RelatedTopics?.length) {
        data.RelatedTopics
          .filter(t => t.Text && t.FirstURL)
          .slice(0, 5)
          .forEach(t => results.push({ title: t.Text!.split(' - ')[0] ?? '', url: t.FirstURL!, snippet: t.Text! }))
      }
      if (results.length > 0 || data.Answer) {
        return { provider: 'duckduckgo', query, answer: data.Answer, results }
      }
    }
  } catch { /* fall through */ }

  // Strategy 2: DDG Lite HTML scraping
  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(htmlUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) throw new Error(`DuckDuckGo error: HTTP ${res.status}`)

  const html = await res.text()
  const results: SearchResult[] = []
  const blocks = html.match(/<div[^>]+class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g) ?? []
  for (const block of blocks.slice(0, 6)) {
    const titleMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([^<]+)<\/a>/)
    const urlMatch = block.match(/href="([^"]+)"/)
    const snippetMatch = block.match(/class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\//)
    const title = titleMatch?.[1]?.trim()
    const snippet = snippetMatch?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (title && snippet) {
      results.push({ title, url: urlMatch?.[1] ?? '', snippet: snippet.slice(0, 300) })
    }
  }

  return { provider: 'duckduckgo', query, results }
}

// ─────────────────────────────────────────────────────────
// Main multi-provider search function
// ─────────────────────────────────────────────────────────

export interface MultiSearchOptions {
  provider?: WebSearchProvider
  tavilyApiKey?: string
  braveApiKey?: string
  searxngUrl?: string
}

function getProviderFromEnv(): { provider: WebSearchProvider; tavilyKey?: string; braveKey?: string; searxngUrl?: string } {
  if (process.env.TAVILY_API_KEY) return { provider: 'tavily', tavilyKey: process.env.TAVILY_API_KEY }
  if (process.env.BRAVE_API_KEY) return { provider: 'brave', braveKey: process.env.BRAVE_API_KEY }
  if (process.env.SEARXNG_URL) return { provider: 'searxng', searxngUrl: process.env.SEARXNG_URL }
  return { provider: 'duckduckgo' }
}

/**
 * Perform a web search using the best available provider.
 * Falls back to DuckDuckGo if the primary provider fails.
 */
export async function multiSearch(query: string, opts?: MultiSearchOptions): Promise<SearchResponse> {
  const envConfig = getProviderFromEnv()
  const provider = opts?.provider ?? envConfig.provider
  const tavilyKey = opts?.tavilyApiKey ?? envConfig.tavilyKey
  const braveKey = opts?.braveApiKey ?? envConfig.braveKey
  const searxngUrl = opts?.searxngUrl ?? envConfig.searxngUrl

  // Try primary provider
  try {
    switch (provider) {
      case 'tavily':
        if (!tavilyKey) throw new Error('TAVILY_API_KEY not set')
        return await searchTavily(query, tavilyKey)
      case 'brave':
        if (!braveKey) throw new Error('BRAVE_API_KEY not set')
        return await searchBrave(query, braveKey)
      case 'searxng':
        if (!searxngUrl) throw new Error('SEARXNG_URL not set')
        return await searchSearxng(query, searxngUrl)
      case 'duckduckgo':
        return await searchDuckDuckGo(query)
    }
  } catch (primaryError) {
    // Fallback to DuckDuckGo if primary fails
    if (provider !== 'duckduckgo') {
      try {
        return await searchDuckDuckGo(query)
      } catch { /* both failed */ }
    }
    throw primaryError
  }
}

/**
 * Format search response as a readable string for the LLM.
 */
export function formatSearchResponse(response: SearchResponse): string {
  const parts: string[] = [`Search results for "${response.query}" (via ${response.provider}):`]

  if (response.answer) {
    parts.push(`\nDirect answer: ${response.answer}`)
  }

  if (response.results.length === 0) {
    parts.push('\nNo results found.')
    return parts.join('\n')
  }

  parts.push('')
  for (const result of response.results) {
    parts.push(`- **${result.title}**`)
    if (result.url) parts.push(`  ${result.url}`)
    if (result.snippet) parts.push(`  ${result.snippet}`)
    parts.push('')
  }

  return parts.join('\n')
}

/**
 * Detect which web search providers are available based on env vars.
 */
export function getAvailableProviders(): WebSearchProvider[] {
  const providers: WebSearchProvider[] = ['duckduckgo'] // always available
  if (process.env.TAVILY_API_KEY) providers.unshift('tavily')
  if (process.env.BRAVE_API_KEY) providers.unshift('brave')
  if (process.env.SEARXNG_URL) providers.push('searxng')
  return providers
}
