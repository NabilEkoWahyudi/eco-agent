'use strict'

const webSearchTool = {
  name: 'web_search',
  description: 'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. No API key needed.',
  parameters: {
    query: { type: 'string', description: 'Search query', required: true },
    limit: { type: 'number', description: 'Max results to return (default: 5)', required: false }
  },
  async execute(args) {
    const query = args.query
    const limit = Number(args.limit ?? 5)
    try {
      const encoded = encodeURIComponent(query)
      const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'eco-agent/1.0' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const results = []
      if (data.Abstract) results.push(`[Answer] ${data.Abstract}\nSource: ${data.AbstractURL}`)
      if (data.RelatedTopics?.length > 0) {
        data.RelatedTopics.filter(t => t.Text && t.FirstURL).slice(0, limit).forEach(t => {
          results.push(`[Result] ${t.Text}\nURL: ${t.FirstURL}`)
        })
      }
      if (results.length === 0) return `No results for: "${query}"\nTry a more specific query.`
      return `Search results for: "${query}"\n\n${results.join('\n\n')}`
    } catch (e) {
      return `Search error: ${e.message}`
    }
  }
}

const webFetchTool = {
  name: 'web_fetch',
  description: 'Fetch and read the text content of a webpage URL.',
  parameters: {
    url: { type: 'string', description: 'The URL to fetch', required: true }
  },
  async execute(args) {
    try {
      const res = await fetch(args.url, {
        headers: { 'User-Agent': 'eco-agent/1.0' },
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) return `Error: HTTP ${res.status} for ${args.url}`
      const html = await res.text()
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 4000)
      return `Content from ${args.url}:\n\n${text}${text.length >= 4000 ? '\n\n[... truncated]' : ''}`
    } catch (e) {
      return `Fetch error: ${e.message}`
    }
  }
}

module.exports = {
  name: 'eco-plugin-websearch',
  version: '1.0.0',
  description: 'Web search & fetch tools powered by DuckDuckGo',
  tools: [webSearchTool, webFetchTool]
}
