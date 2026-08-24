# Recursive File Walker
<!-- id: task-03-file-walk -->

Write a TypeScript function `walkDir(dir: string, extensions: string[]): string[]` that:
1. Recursively walks a directory using Node's `fs` module (no glob libraries)
2. Returns absolute paths of all files matching the given extensions (e.g., `['.ts', '.js']`)
3. Skips `node_modules`, `.git`, `dist`, `build` directories automatically
4. Returns an empty array if `dir` does not exist

Requirements:
- No external dependencies (Node stdlib only)
- Write to `tmp-bench/file-walker.ts`
- Synchronous implementation preferred
- Keep it minimal — do not add classes, interfaces, or extra abstractions
