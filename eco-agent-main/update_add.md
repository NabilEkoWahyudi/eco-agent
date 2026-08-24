Analisis Implementasi Ponytail di Eco Agent

Perbandingan antara mekanisme asli Ponytail dan implementasinya di Eco Agent, beserta roadmap untuk mendekatkan fidelity ke 100%.

Ponytail (asli): https://github.com/DietrichGebert/ponytail
Eco Agent: https://github.com/NabilEkoWahyudi/eco-agent
1. Ringkasan

Mekanisme Ponytail sudah diimplementasikan di eco-agent melalui src/rulesets/ponytail.ts, dan terintegrasi ke banyak bagian sistem: system prompt (context/index.ts), config persistence (configStore.ts), agent loop (loop/index.ts), dan command CLI (cli/index.ts).

Estimasi kesesuaian mekanisme inti (ladder, mode, debt marker, review/audit tag, deaktivasi): ~75–80%.

Estimasi keberhasilan/efektivitas (LOC/biaya/waktu berkurang seperti klaim -54% dari Ponytail asli): tidak dapat diukur — eco-agent belum memiliki benchmark sendiri untuk fitur ini.

2. Elemen yang Sudah Diporting dengan Akurat
Elemen	Ponytail asli	Eco Agent	Status
Ladder 7 langkah	YAGNI → codebase → stdlib → native → deps → one line → minimum	Ada, tapi step 6 berubah (lihat §3)	Sebagian
Mode intensitas	lite / full / ultra	Sama persis	✅
Konvensi debt marker	// ponytail: <alasan>, <upgrade-trigger> + deteksi no-trigger	Sama persis, termasuk logic no-trigger	✅
Tag review/audit	delete: stdlib: native: yagni: shrink:	Sama persis	✅
Frasa deaktivasi	"stop ponytail"	Sama persis	✅
/ponytail-debt zero-cost	Pure grep, tanpa panggil LLM	Sama, pure local grep	✅
Command review/audit	/ponytail-review, /ponytail-audit	Ada, prompt setara	✅

3. Gap yang Ditemukan
Ladder step 6 menyimpang — Ponytail asli: "Can it be one line?". Eco-agent: "Popular lib" (mempertimbangkan menambah dependency baru). Ini bertentangan dengan filosofi minimalis Ponytail yang justru menghindari dependency baru.
Mode lite beda filosofi — Ponytail asli: tetap bangun yang diminta, tapi sebutkan alternatif malas dalam satu baris (user yang pilih). Eco-agent: lite tetap memaksakan skip/reuse otomatis, lebih dekat ke full yang dipersingkat.
Regex debt marker tidak lengkap — PONYTAIL_DEBT_REGEX hanya cocok gaya komentar //, padahal scanner menyisir juga .py, .go, .rs yang lazimnya pakai #. Marker di file non-JS/TS tidak akan terdeteksi.
Aturan pelengkap belum masuk ke prompt — belum ada: "bug fix = root cause bukan symptom", "no unrequested abstractions", batasan output ("code dulu, penjelasan maksimal 3 baris").
Tidak ada /ponytail-gain — Ponytail asli punya scoreboard hasil benchmark terukur; eco-agent belum punya padanannya.
Tidak ada benchmark sama sekali — folder benchmarks/ di Ponytail asli (metodologi: task fitur nyata di repo real-world, dijalankan dengan & tanpa skill, n≥4, ukur LOC/token/biaya/waktu) tidak punya padanan di eco-agent. Akibatnya klaim keberhasilan fitur ini di eco-agent tidak memiliki dasar data.

4. Roadmap Menuju Fidelity ~100%
#	Tindakan	Kompleksitas	File terdampak
1	Kembalikan ladder step 6 jadi "one line", buang/pindahkan "Popular lib"	Ringan — edit teks	src/rulesets/ponytail.ts
2	Rewrite mode lite agar bersifat saran, bukan enforcement	Ringan — edit teks	src/rulesets/ponytail.ts
3	Perluas regex debt marker mendukung gaya komentar #	Ringan — edit regex	src/rulesets/ponytail.ts, src/cli/index.ts
4	Tambahkan aturan root-cause, no-unrequested-abstraction, batasan output	Ringan — tambah teks	src/rulesets/ponytail.ts
5	Bangun command /ponytail-gain (status jujur: "belum diukur" bila belum ada data)	Sedang — command baru	src/cli/index.ts
6	Jalankan benchmark agentic sebanding (repo real-world, dengan/tanpa mode ponytail, n≥4, ukur LOC/token/biaya/waktu)	Berat — infrastruktur baru	proyek terpisah / folder benchmarks/ baru

Poin 1–4 dapat dikerjakan langsung sebagai patch kode dalam satu sesi. Poin 5–6 memerlukan infrastruktur benchmark terpisah dan repo target uji, di luar cakupan patch teks biasa.

Disusun berdasarkan pembacaan langsung source code kedua repository per Agustus 2026.

Ponytail: https://github.com/DietrichGebert/ponytail
Eco Agent: https://github.com/NabilEkoWahyudi/eco-agent

5. Penyelidikan Bug `web_search` & OpenRouter (Agustus 2026)
Berdasarkan log pengujian terbaru, ditemukan dua masalah kritis terkait kegagalan `web_search` dan _crash_ aplikasi:

**Bug 1: `web_search` gagal (fetch failed / timeout)**
- **Gejala:** Muncul error `fetch failed` atau `The operation was aborted due to timeout`.
- **Penyebab:** DuckDuckGo (baik Instant Answer API di `api.duckduckgo.com` maupun scraping di `html.duckduckgo.com`) telah meningkatkan perlindungan anti-bot mereka. Seringkali mereka menolak (block) atau membiarkan koneksi _hang_ (timeout) pada _request_ yang datang dari script Node.js (terutama dari IP datacenter atau karena TLS fingerprinting), meskipun sudah disematkan `User-Agent` palsu.
- **Rekomendasi Solusi:** Mempertimbangkan pergantian provider pencarian yang lebih handal untuk _agentic tools_ (misal: SearxNG, Serper.dev, Tavily, atau Google Custom Search API), atau menambahkan mekanisme rotasi _User-Agent_ dan _proxy_ jika tetap ingin menggunakan DuckDuckGo.

**Bug 2: Aplikasi _Crash_ `Cannot read properties of undefined (reading '0')`**
- **Gejala:** Aplikasi terhenti total dengan error `TypeError` saat mencoba membaca array index `0`.
- **Penyebab:** Pada file `src/providers/openrouter.ts` (baris 116), terdapat pemanggilan `const choice = data.choices[0]`. Jika model LLM (seperti model gratis/eksperimental `nvidia/nemotron-3-ultra-550b-a55b:free`) gagal menghasilkan respons yang valid (karena tidak _support_ fungsi tools, _overloaded_, atau error internal), objek `data.choices` yang dikembalikan dari OpenRouter mungkin kosong (`[]`) atau `undefined`. Karena tidak ada validasi _null-check_, program langsung _crash_.
- **Rekomendasi Solusi:** Menambahkan pengecekan pengaman sebelum mengakses index array: 
  ```typescript
  if (!data.choices || data.choices.length === 0) {
    throw new Error('OpenRouter: Model tidak mengembalikan jawaban (choices kosong/undefined).')
  }
  const choice = data.choices[0]
  ```

**Bug 3: Eksekusi Tool Tanpa Validasi Parameter & Kesalahan Flagging Error**
- **Gejala:** Saat LLM (terutama model berkapasitas rendah) berhalusinasi dan memanggil tool seperti `run_shell` dengan argumen kosong (`{}`), program tetap memaksakan eksekusinya dan error yang terjadi tidak ditandai dengan warna merah (`X`).
- **Penyebab:** Ada dua kelemahan di kode internal Eco Agent:
  1. **Kurangnya Validasi Parameter:** Di `src/tools/index.ts`, argumen tidak divalidasi. Pada `run_shell`, `args.command` langsung diteruskan ke `execSync()`. Jika argumen dari LLM kosong, `cmd` bernilai `undefined`, yang menyebabkan `execSync(undefined)` melempar `TypeError [ERR_INVALID_ARG_TYPE]`.
  2. **Logika Flagging Error Kurang Akurat:** Pada `src/loop/index.ts`, status error ditentukan dari `result.toLowerCase().startsWith('error')`. Namun, `run_shell` mengembalikan pesan yang diawali dengan `"Command failed:"`. Akibatnya, sistem menganggap _crash_ tersebut sebagai "sukses", menampilkannya dengan tanda `✓` abu-abu, dan membuat LLM semakin kebingungan karena tidak menyadari bahwa perintahnya gagal.
- **Rekomendasi Solusi:** 
  - Validasi keberadaan parameter wajib (seperti `args.command`) di setiap awal blok eksekusi tool, dan segera kembalikan string `"Error: Missing required parameter 'command'"` jika tidak ada.
  - Perbaiki logika `isError` di _agentic loop_, mungkin dengan menambahkan pengecekan `.includes('failed')` atau mengubah pesan kembalian dari tool menjadi berawalan `Error:`.