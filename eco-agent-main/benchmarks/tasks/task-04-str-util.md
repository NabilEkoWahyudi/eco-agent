# String Utility Functions
<!-- id: task-04-str-util -->

Write a TypeScript module with these three utility functions:
1. `slugify(s: string): string` — convert "Hello World! 2026" → "hello-world-2026"
2. `truncate(s: string, maxLen: number, suffix?: string): string` — cut at word boundary, append suffix (default "…")
3. `countWords(s: string): number` — count words, ignoring extra whitespace

Requirements:
- No external dependencies
- No helper classes or unnecessary abstractions — plain functions only
- Write to `tmp-bench/str-utils.ts`
- Each function should be ≤5 lines of actual logic
