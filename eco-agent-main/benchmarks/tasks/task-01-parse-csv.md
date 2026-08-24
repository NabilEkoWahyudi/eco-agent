# Parse CSV Without Library
<!-- id: task-01-parse-csv -->

Write a TypeScript function `parseCsv(raw: string): Record<string, string>[]` that:
1. Splits the input by newlines
2. Uses the first row as headers
3. Returns an array of objects mapping header→value for each data row
4. Handles quoted fields that contain commas (e.g., `"Smith, John"`)
5. Strips leading/trailing whitespace from each value

Requirements:
- No external dependencies (stdlib only)
- Include a brief usage example in a comment at the top of the file
- Write the result to a new file: `tmp-bench/csv-parser.ts`
- Keep it as short as possible
