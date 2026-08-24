# 🧪 Eco Agent — Rencana Uji Coba (Test Plan)

Dokumen ini merupakan rangkaian skenario uji coba (Test Cases) untuk memvalidasi pembaruan sistem **Eco Agent v0.1.0**. Uji coba ini dirancang untuk memastikan bahwa integrasi fitur baru, optimalisasi token, dan perbaikan *bug* berjalan stabil di lingkungan produksi.

---

## 📋 Pre-requisites (Persiapan Uji Coba)
Sebelum menjalankan rangkaian pengujian di bawah ini, pastikan:
- [ ] Node.js (v18+) sudah terinstall.
- [ ] Berada di root direktori proyek (`c:\Users\Ahmad\Downloads\eco-agent\eco-agent-main`).
- [ ] Sudah menjalankan `npm run build` tanpa error.
- [ ] Sudah melakukan link lokal (jika perlu) atau menjalankan file *entry-point* CLI secara langsung.

---

## 🏗️ Skenario Uji Coba (Test Cases)

### 📌 TC-01: Validasi Mode Ponytail (Anti-Overengineering)
**Tujuan:** Memastikan agen mengikuti 7-lapis aturan Ponytail secara ketat dan menolak instruksi pembuatan kode yang terlalu kompleks tanpa alasan.

- **Pre-condition:** CLI aktif, koneksi LLM stabil.
- **Langkah-langkah:**
  1. Buka terminal dan jalankan `eco`.
  2. Ketik perintah `/ponytail full` dan tekan Enter.
  3. Berikan *prompt* jebakan: *"Buatkan sistem cache yang kompleks menggunakan class dan Redis untuk menyimpan string sederhana."*
- **Expected Result (Ekspektasi):** 
  - Agen langsung memotong instruksi (YAGNI / Stdlib).
  - Agen menyarankan penggunaan objek/Map bawaan JavaScript standar.
  - Agen tidak membuat *boilerplate* kode yang panjang atau menambahkan referensi *library* eksternal.
- **Status:** `[ ] Pass / [ ] Fail / [ ] Blocked`
- **Catatan:** _______________________________________

### 📌 TC-02: Efisiensi Token Auto-Automation (`/commit`)
**Tujuan:** Menguji fitur `/commit` dapat berjalan tanpa mengirim *tool definitions* ke LLM (menghemat ~1000 token) dan clipboard berjalan *cross-platform*.

- **Pre-condition:** Terdapat perubahan *staged* di dalam repository lokal Git.
- **Langkah-langkah:**
  1. Modifikasi salah satu file sembarang, lalu jalankan `git add <file>`.
  2. Jalankan `eco` dan ketik perintah `/commit`.
  3. Tunggu hingga pesan *Conventional Commits* digenerate.
  4. Ketika muncul pertanyaan `Copy to clipboard? [y/N]`, ketik `y` lalu Enter.
  5. Paste (Ctrl+V / Cmd+V) di teks editor.
- **Expected Result (Ekspektasi):**
  - Proses generate terasa lebih cepat.
  - LLM tidak halusinasi memanggil alat (tools).
  - Teks berhasil tersalin ke *clipboard* baik di Windows (`clip`), Mac (`pbcopy`), maupun Linux (`xclip`/`xsel`).
- **Status:** `[ ] Pass / [ ] Fail / [ ] Blocked`
- **Catatan:** _______________________________________

### 📌 TC-03: Pencarian Web (DuckDuckGo API & Fallback)
**Tujuan:** Menguji stabilitas alat `web_search` yang kini menggunakan API ringan dan sistem *fallback* HTML.

- **Pre-condition:** Koneksi internet aktif.
- **Langkah-langkah:**
  1. Buka terminal dan jalankan `eco`.
  2. Ketik *prompt*: *"Gunakan web search untuk mencari siapa pemenang piala dunia 2022 dan berikan ringkasannya kepada saya."*
- **Expected Result (Ekspektasi):**
  - Agen memanggil tool `web_search`.
  - Tidak ada error JSON/parsing.
  - LLM merangkum jawaban dengan tepat sesuai data terkini dari internet.
- **Status:** `[ ] Pass / [ ] Fail / [ ] Blocked`
- **Catatan:** _______________________________________

### 📌 TC-04: Eksekusi Swarm Multi-Agent
**Tujuan:** Memastikan orchestrator `planSwarm` mewariskan properti penting (*Ponytail Mode* dan *Max Iterations*) dari *parent config* ke *worker config*.

- **Pre-condition:** CLI aktif.
- **Langkah-langkah:**
  1. Buka terminal dan jalankan `eco`.
  2. Ketik `/swarm`.
  3. Berikan *goal*: *"Buat file A.txt berisi 'halo', B.txt berisi 'dunia', dan C.txt yang menggabungkan isi A dan B."*
  4. Ketik `Y` untuk menyetujui rencana (*plan*) yang dibuat agen.
- **Expected Result (Ekspektasi):**
  - Tercipta beberapa task spesifik dalam *plan*.
  - Agen mengeksekusi sub-task secara paralel (terbatas *pLimit*).
  - Teks `[Using tools: ...]` tidak muncul secara berlebihan.
  - Sistem merangkum seluruh hasil (summary) tanpa error *type-casting*.
- **Status:** `[ ] Pass / [ ] Fail / [ ] Blocked`
- **Catatan:** _______________________________________

### 📌 TC-05: Resilience & Timeout Handling (fetchHelper)
**Tujuan:** Memastikan pengalaman pengguna CLI (UX) tetap baik saat terjadi koneksi lambat dengan menurunkan parameter *retry*.

- **Pre-condition:** Koneksi internet sengaja diputuskan (Offline) ATAU endpoint LLM *timeout*.
- **Langkah-langkah:**
  1. Putuskan koneksi internet perangkat Anda.
  2. Jalankan perintah sapaan biasa di `eco` (misal: "Halo").
- **Expected Result (Ekspektasi):**
  - CLI akan mengulang permintaan maksimum 3x (turun dari 5x).
  - Jeda tiap permintaan relatif singkat (mulai dari 1 detik).
  - Program akan gagal dengan pesan *error HTTP/Connection* dalam waktu **maksimal ~7 detik**, tidak lagi nge-*hang* hingga 1 menit seperti versi sebelumnya.
- **Status:** `[ ] Pass / [ ] Fail / [ ] Blocked`
- **Catatan:** _______________________________________

---
*Laporan Hasil Pengujian Terakhir Diperbarui: --/--/2026*
*Oleh: _________________*
