# Ponytail Benchmark — Methodology & Guide

Infrastruktur benchmark untuk mengukur dampak nyata ruleset Ponytail terhadap kualitas output eco-agent.

---

## Metodologi (mengikuti Ponytail asli)

| Parameter      | Nilai                                              |
|----------------|----------------------------------------------------|
| Task           | Fitur nyata (bukan "hello world")                 |
| Repo target    | Real-world (atau sandbox `tmp-bench/` dalam repo) |
| Jumlah run     | n ≥ 4 per kondisi (with & without Ponytail)       |
| Metrik         | LOC, token, biaya USD, waktu (detik)              |
| Kondisi        | Dengan Ponytail (`full` atau `ultra`) vs tanpa (`off`) |

---

## Struktur Folder

```
benchmarks/
├── README.md          ← panduan ini
├── types.ts           ← type definitions
├── runner.ts          ← CLI runner (jalankan task → ukur → simpan JSON)
├── compare.ts         ← CLI comparator (bandingkan dua run → tampilkan delta)
├── tasks/
│   ├── task-01-parse-csv.md
│   ├── task-02-http-fetch.md
│   ├── task-03-file-walk.md
│   └── task-04-str-util.md
└── results/           ← hasil JSON tiap run (auto-created)
    └── <timestamp>-<taskId>-<mode>.json
```

---

## Cara Menjalankan Benchmark

### Prasyarat
- Eco-agent sudah terkonfigurasi (`eco` pernah dijalankan dan setup wizard selesai)
- Node.js ≥ 18

### Langkah 1 — Jalankan task TANPA Ponytail (baseline)

```bash
npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode off
npm run benchmark:run -- --task benchmarks/tasks/task-02-http-fetch.md --mode off
npm run benchmark:run -- --task benchmarks/tasks/task-03-file-walk.md  --mode off
npm run benchmark:run -- --task benchmarks/tasks/task-04-str-util.md   --mode off
```

### Langkah 2 — Jalankan task DENGAN Ponytail full

```bash
npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode full
npm run benchmark:run -- --task benchmarks/tasks/task-02-http-fetch.md --mode full
npm run benchmark:run -- --task benchmarks/tasks/task-03-file-walk.md  --mode full
npm run benchmark:run -- --task benchmarks/tasks/task-04-str-util.md   --mode full
```

> Untuk memenuhi syarat n ≥ 4, ulangi kedua langkah di atas beberapa kali (task yang sama bisa dijalankan berulang).

### Langkah 3 — Bandingkan & tulis scoreboard

```bash
# Auto-discover semua pasangan (with vs without) di results/
npm run benchmark:compare -- --auto

# Atau bandingkan dua file spesifik
npm run benchmark:compare -- \
  --with    benchmarks/results/2026-...-task-01-full.json \
  --without benchmarks/results/2026-...-task-01-off.json
```

Setelah `compare` selesai, file `.eco/ponytail-gain.json` diperbarui.  
Jalankan `/ponytail-gain` di dalam eco untuk melihat scoreboard.

### Dry-run (tanpa memanggil LLM)

```bash
npm run benchmark:run -- --task benchmarks/tasks/task-01-parse-csv.md --mode full --dry-run
```

---

## Format Hasil (`results/*.json`)

```json
{
  "schemaVersion": 1,
  "taskId": "task-01-parse-csv",
  "taskTitle": "Parse CSV Without Library",
  "ponytailMode": "full",
  "provider": "groq",
  "model": "llama-3.3-70b-versatile",
  "startedAt": "2026-08-21T10:00:00.000Z",
  "metrics": {
    "loc": 42,
    "tokens": 1200,
    "costUsd": 0.00071,
    "timeSec": 18.3,
    "toolCalls": 3,
    "filesWritten": 1,
    "responsePreview": "..."
  },
  "dryRun": false
}
```

---

## Kriteria Validitas

Sebuah claim keberhasilan dianggap valid bila:
1. **n ≥ 4** — setidaknya 4 run per kondisi (with & without) untuk task yang sama
2. **Task real** — bukan "print hello world"; harus fitur yang representatif
3. **Kondisi identik** — provider, model, dan task prompt yang sama; hanya ponytailMode yang berbeda
4. **Semua metrik dicatat** — LOC, token, biaya, dan waktu wajib ada

---

## Menambah Task Baru

Buat file `benchmarks/tasks/task-XX-<nama>.md` dengan format:

```markdown
# Judul Task
<!-- id: task-XX-nama-unik -->

Deskripsi task yang diberikan ke agent sebagai prompt.
Semakin spesifik, semakin reproducible hasilnya.
```

---

## Interpretasi Hasil

| Delta (Δ) | Makna |
|-----------|-------|
| `−30% LOC` | Agent menulis 30% lebih sedikit kode (lebih minimalis) |
| `−25% tokens` | Percakapan 25% lebih hemat token |
| `−25% cost` | Biaya API 25% lebih rendah |
| `+5% time` | Sedikit lebih lambat (trade-off minor yang bisa diterima) |

Angka negatif pada LOC/token/cost = **Ponytail berhasil**.  
Angka positif pada time (kecuali sangat besar) = **masih wajar**.
