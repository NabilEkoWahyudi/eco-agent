# Eco Agent — Ponytail Integration

**Tanggal:** 14 Agustus 2026
**Sumber ide:** [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — ruleset minimalis "lazy senior dev" untuk AI coding agent

Integrasi native ke source code eco-agent (bukan lewat MCP server terpisah), supaya ruleset-nya nempel di system prompt yang memang sudah terkirim tiap request — tanpa proses tambahan dan biaya token seminimal mungkin.

---

## Fitur baru

### 1. Ruleset minimalis 3 tier — `/ponytail [mode]`

Sebelum menulis kode baru, agent dicek dulu lewat ladder: apakah fitur ini perlu ada (YAGNI) → sudah ada di codebase? → stdlib sudah sediakan? → platform native sudah sediakan? → dependency yang sudah terpasang sudah cover? → baru terakhir tulis kode minimum.

| Mode | Isi | Estimasi biaya |
|---|---|---|
| `off` | Ruleset nonaktif | +0 token |
| `lite` *(default)* | Cek minimalis saja | ~35 token/request |
| `full` | + ladder 7 langkah lengkap | ~110 token/request |
| `ultra` | + aktif cari kode/dependency lama yang bisa dihapus | ~140 token/request |

```
eco › /ponytail            # lihat mode aktif
eco › /ponytail full       # naikkan ke ladder lengkap
eco › stop ponytail        # matikan cepat (frasa natural, harus jadi keseluruhan pesan)
```

Mode tersimpan otomatis untuk sesi berikutnya. Bisa juga di-set lewat environment variable (prioritas tertinggi):
```bash
export PONYTAIL_DEFAULT_MODE=full
```

### 2. `/ponytail-review` — review diff untuk over-engineering

Ambil `git diff` saat ini, minta agent cari *hanya* kode yang kelebihan rekayasa (bukan bug/security/performance) dan hasilkan daftar temuan satu baris per item, dengan tag `delete:` / `stdlib:` / `native:` / `yagni:` / `shrink:`. Tidak mengubah file — cuma melaporkan.

### 3. `/ponytail-audit` — sama seperti review, tapi seluruh repo

Agent pakai tools file/search miliknya sendiri untuk scan seluruh codebase, bukan cuma diff yang sedang berjalan.

### 4. `/ponytail-debt` — ledger utang teknis, **tanpa LLM call**

Grep seluruh repo untuk komentar bertanda `ponytail: <ceiling>, <upgrade-trigger>` yang sengaja ditinggalkan sebagai shortcut, lalu kelompokkan jadi ledger. Baris yang tidak punya trigger upgrade ditandai `[no-trigger]` — potensi utang yang diam-diam membusuk jadi permanen.

```
eco › /ponytail-debt

  Ponytail debt ledger:

  ./src/parser.ts:42:  // ponytail: string-split parsing, upgrade ke date lib kalau timezone mulai relevan
  ./src/utils.ts:88:  // ponytail: quick hack di sini  [no-trigger]

  2 markers, 1 with no trigger.
```

Ini satu-satunya command baru yang murni lokal — nol biaya token, karena formatnya deterministik (grep + regex).

---

## File yang berubah

| File | Perubahan |
|---|---|
| `src/rulesets/ponytail.ts` *(baru)* | Teks ruleset 3 tier |
| `src/utils/types.ts` | Field `ponytailMode` di `EcoConfig` |
| `src/utils/configStore.ts` | Resolusi mode: env var → config tersimpan → `lite` |
| `src/context/index.ts` | Titik injeksi ruleset ke system prompt |
| `src/loop/index.ts` | Ganti mode di tengah sesi tanpa restart |
| `src/cli/index.ts` | Command `/ponytail`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, deteksi frasa deaktivasi |

6 file, +202/-6 baris. Tanpa dependency baru.

---

## Referensi

- Ide & ruleset asli: [github.com/DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
- Repo yang diintegrasikan: [github.com/NabilEkoWahyudi/eco-agent](https://github.com/NabilEkoWahyudi/eco-agent)