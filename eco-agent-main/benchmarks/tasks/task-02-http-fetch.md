# HTTP Fetch With Retry
<!-- id: task-02-http-fetch -->

Write a TypeScript function `fetchWithRetry(url: string, retries?: number): Promise<string>` that:
1. Uses Node's built-in `fetch` (no axios, no node-fetch)
2. Retries up to `retries` times (default: 3) on network error or HTTP 5xx
3. Waits 500ms × attempt number between retries (exponential-ish backoff)
4. Throws a descriptive Error if all retries are exhausted
5. Returns the response body as a string on success

Requirements:
- No external dependencies
- Write to `tmp-bench/fetch-retry.ts`
- Keep implementation under 30 LOC (non-blank, non-comment)
