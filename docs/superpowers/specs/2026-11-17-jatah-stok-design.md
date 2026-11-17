# Jatah Stok (Stock Quota) — Design Doc

Tanggal: 2026-11-17
Status: **menunggu persetujuan** (belum ada kode yang ditulis, belum ada deploy)

## 1. Kenapa

Pemilik toko perlu tahu berapa barang yang masih bisa dijual hari ini, per
nominal, dan menghentikan penjualan ketika jatah habis — tanpa mengubah harga
dan tanpa SQL manual.

Kenyataan katalog: 60 produk top-up game/live app dan 13 produk voucher, pulsa,
e-money. Semuanya barang **digital** yang dipenuhi lewat supplier, jadi tidak
ada stok fisik dan tidak ada kode voucher yang disimpan sendiri. Maka "stok"
di sini adalah **jatah jual (kuota)**: berapa yang sanggup dipenuhi, diisi admin,
dan berkurang otomatis oleh pesanan yang masih berjalan. Memasuki hari baru,
pesanan `pending` yang kedaluwarsa lepas dengan sendirinya, jadi sisa pulih tanpa
jatah harus diisi ulang; admin hanya menaikkan angka bila perlu.

Keputusan yang sudah diambil:
- **Skala A** — satu admin, operasi sederhana, tanpa peran/akun.
- **Nominal habis tampil bertanda "Habis" dan tidak bisa diklik/dipesan** (pilihan 2).
  Server wajib menolak order untuk nominal habis, bukan hanya UI menyembunyikan tombol.
- Kebijakan harga: harga baru hanya untuk pesanan baru (tidak berubah).

## 2. Kondisi sekarang

- `denominations` tidak punya kolom stok. `handleCatalog` & `handleProduct`
  hanya menyaring `active = 1`.
- `handleCreateOrder` (`worker\store-worker.js` ~557) memilih nominal dengan
  `p.active = 1 AND d.active = 1`, lalu menyimpan `subtotal`/`total` dan
  `expires_at`. Tidak ada pemeriksaan ketersediaan.
- Status pesanan: `pending`, `paid`, `fulfilled`, `expired`, `cancelled`.
  `pending` dibatasi `expires_at`; `paid` = sudah dibayar belum diproses.
- Harga sudah punya endpoint admin + audit (`price_changes`) sesuai design
  `2026-11-16-manajemen-harga-design.md` — dokumen itu **belum diimplementasikan**.
  Design stok ini **tidak bergantung** padanya, tetapi keduanya berbagi tab admin,
  tabel yang bisa diedit langsung, dan pola `PATCH /api/admin/*`, jadi
  dikerjakan berurutan: harga dulu, lalu stok.
- Storefront menggambar pilihan nominal di `store.js` ~509 (`renderDenom`).

## 3. Tujuan / bukan tujuan

Tujuan:
- Admin mengisi **jatah harian** per nominal dari tab "Stok" di `/admin`.
- Sistem menghitung **sisa nyata** sendiri: jatah − pesanan `paid` yang belum
  diproses − pesanan `pending` yang belum kedaluwarsa.
- Nominal dengan sisa 0 ditandai **Habis** di storefront, tidak bisa dipilih,
  dan **ditolak server** (`409 out_of_stock`).
- Ringkasan hari ini: terjual (dari `paid_at`), total yang ditahan, jumlah
  nominal habis, jumlah jatah yang perlu diisi ulang.

Bukan tujuan:
- Mengelola kode voucher/serial number per unit (tidak ada stok fisik).
- Impor massal CSV, notifikasi otomatis stok menipis, grafik riwayat, jadwal
  jatah berbeda per hari.
- Reservasi stok berjangka panjang di luar masa bayar pesanan.

Anti-tujuan (dianggap gagal walau fitur jalan):
- Pembeli bisa membayar untuk nominal yang jatahnya sudah habis.
- Sisa stok negatif atau tampil lebih besar dari kenyataan.
- Deploy berikutnya menghapus jatah yang sudah diisi admin.

## 4. Pendekatan yang dipertimbangkan

**P1 — Hitung stok dari histori penjualan, tanpa kolom jatah.** Nol input
admin: "sisa" = batas harian tetap (mis. 50) − terjual. Tidak realistis karena
kemampuan tiap nominal berbeda jauh (nominal besar jauh lebih mahal modalnya),
dan tidak ada cara menutup satu nominal yang supplier-nya bermasalah.

**P2 — Tabel `stock_units` berisi satu baris per kode barang.** Akurat untuk
voucher yang kodenya benar-benar disimpan, tapi untuk 60 produk top-up game
tidak ada unit yang bisa dimasukkan, jadi 82% katalog tidak terlayani dan admin
harus mengunggah kode terus-menerus.

**P3 — Kolom `daily_quota` + hitung sisa dari pesanan berjalan (dipilih).**
Satu angka yang diisi admin per nominal, sisanya dihitung server. Ringan (satu
kolom, satu query agregat), bekerja untuk seluruh 73 produk, otomatis
menyesuaikan diri ketika pesanan dibayar/kedaluwarsa/dibatalkan.

Dipilih **P3**.

## 5. Desain

### 5.1 Skema

Tambahan kolom ke `denominations` (migrasi `ALTER TABLE ... ADD COLUMN`,
idempoten, pola yang sudah dipakai `deploy-store.ps1`):

```sql
ALTER TABLE denominations ADD COLUMN daily_quota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE denominations ADD COLUMN quota_date TEXT NOT NULL DEFAULT '';
ALTER TABLE denominations ADD COLUMN quota_note TEXT NOT NULL DEFAULT '';
```

`daily_quota` = **0 berarti tanpa batas** (perilaku hari ini dipertahankan;
tidak ada nominal yang tiba-tiba tidak bisa dibeli setelah deploy).
`quota_date` = tanggal lokal toko (WIB, `YYYY-MM-DD`) saat angka jatah terakhir
diubah. **Bukan** pemicu reset: ia hanya penanda "isi ulang" agar admin tahu
angka ini diisi kemarin (§5.2).

Tabel audit (pola sama dengan `price_changes`):

```sql
CREATE TABLE IF NOT EXISTS stock_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  denomination_id INTEGER NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  old_quota INTEGER NOT NULL DEFAULT 0,
  new_quota INTEGER NOT NULL DEFAULT 0,
  old_note TEXT NOT NULL DEFAULT '',
  new_note TEXT NOT NULL DEFAULT '',
  quota_date TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_changes_denom ON stock_changes(denomination_id, changed_at);
```

### 5.2 Perhitungan sisa (satu sumber kebenaran, di server)

Satu definisi kanonik `held`, dipakai di semua tempat (tabel admin, ringkasan,
storefront, dan penolakan order):

```
held(denomination_id) = COUNT orders WHERE denomination_id = ?
                        AND ( status = 'paid'                                  -- dibayar, belum selesai
                           OR (status = 'pending' AND expires_at > sekarang) )  -- masih boleh dibayar
                        -- 'fulfilled', 'cancelled', 'expired' TIDAK menahan
```

`held` **tidak dibatasi tanggal**: pesanan `pending` dari kemarin yang belum
kedaluwarsa tetap menahan jatah hari ini, karena barangnya tetap harus dikirim.

```
tanpa_batas = (daily_quota = 0)
sisa        = tanpa_batas ? null : max(0, daily_quota − held)
tersedia    = tanpa_batas OR sisa > 0
```

Satu query agregat `GROUP BY denomination_id` mengambil `held` untuk semua
nominal sekaligus, bukan per baris.

`quota_date` hanya dipakai sebagai petunjuk "jatah diisi kemarin, isi ulang",
tidak pernah memaksa angka jadi 0 — supaya toko tidak berhenti jual hanya karena
admin belum membuka panel hari itu. Penanda muncul bila
`daily_quota > 0 AND quota_date <> hari ini (WIB)`; `quota_date = ''` diperlakukan
sebagai "belum pernah diisi" dan **tidak** diberi penanda.

### 5.3 API

`GET /api/admin/stock?date=YYYY-MM-DD` (default hari ini WIB)

```json
{
  "date": "2026-11-17",
  "summary": {
    "sold": 12,              // paid_at jatuh pada tanggal itu (paid + fulfilled)
    "held": 17,              // total held SEKARANG, definisi §5.2, semua nominal aktif
    "out_of_stock": 5,       // nominal aktif dengan tersedia = false
    "quota_stale": 3,        // nominal dengan penanda "isi ulang" (bisa difilter tanggal)
  },
  "items": [{
    "id": 12, "sku": "MOBILELEGENDS-3", "label": "86 Diamonds",
    "product_slug": "mobile-legends", "product_name": "Mobile Legends Diamonds",
    "category_name": "Top Up Game", "product_active": 1, "active": 1,
    "daily_quota": 20, "quota_date": "2026-11-17", "quota_stale": false,
    "quota_note": "",
    "held": 2, "remaining": 18, "available": true,
    "sold": 6                // paid_at di tanggal itu, untuk nominal ini
  }]
}
```

- `date` **hanya** memfilter `sold` dan `quota_stale`. `held`/`remaining`/
  `available` selalu kondisi sekarang (bukan per tanggal) — supaya admin tidak
  pernah melihat "sisa 3" untuk barang yang sebenarnya sudah terjual.
- `summary.held` adalah jumlah `held` semua nominal aktif, jadi angka ringkasan
  dan angka kolom "Ditahan" selalu bisa dijumlahkan.
- "Terjual" memakai **`paid_at`**, bukan `created_at`: uang masuk saat dibayar,
  dan order yang dibuat 23:50 lalu dibayar 00:05 harus tercatat di hari
  pembayaran. `paid_at` sudah ada di `orders`; ditambah index
  `idx_orders_paid_at(status, paid_at)`.
- Item yang ditampilkan: **semua** nominal (aktif maupun nonaktif) agar admin
  tahu data mana yang "mati"; `active`/`product_active` membuat status itu
  terlihat. Jumlah tetap 310.

`GET /api/admin/stock/holders?denomination_id=12&limit=50`
→ pesanan yang menahan nominal itu (`held`), dengan `public_id`, `status`,
`player_id`, `total`, `created_at`, `expires_at`, `paid_at`. Query memakai
definisi `held` yang sama (bukan sekadar `status = 'pending'`), sehingga daftar
ini tidak menampilkan pesanan kedaluwarsa yang sebenarnya sudah tidak menahan
apa pun.

`PATCH /api/admin/stock`

```json
{ "items": [ { "id": 12, "daily_quota": 20, "note": "supplier siap 20" },
             { "id": 13, "daily_quota": 0 } ] }
```

- **Field yang tidak dikirim = tidak diubah.** `{"id": 13, "daily_quota": 0}`
  hanya mengubah jatah, catatan tidak disentuh. `{"id": 13, "note": ""}`
  menghapus catatan, jatah tidak disentuh.
- Validasi: `id` wajib & harus ada di DB (selain itu 400 `invalid_denomination`);
  `daily_quota` integer 0 ≤ n ≤ 100000; `note` ≤ 200 karakter (`""` = hapus
  catatan); maks 100 item/request.
- Nominal nonaktif tetap **boleh** diubah jatahnya (admin mungkin
  menyiapkannya sebelum diaktifkan lagi); tidak ada penolakan dan tidak ada
  penulisan khusus.
- All-or-nothing per request: satu `env.DB.batch()` berisi `UPDATE` + `INSERT
  stock_changes` untuk tiap item yang benar-benar berubah, lalu `SELECT` ulang
  untuk respons.
- Menulis `daily_quota` (nilai berbeda) selalu membarui `quota_date = hari ini
  WIB`. Mengubah `note` saja **tidak** membarui `quota_date`, jadi penanda
  "isi ulang" tidak hilang karena catatan diedit.
- `stock_changes` ditulis **hanya** bila `old_quota <> new_quota` **atau**
  `old_note <> new_note`; menyimpan ulang tanpa perubahan tidak menambah baris.
  Menekan Simpan dua kali tidak menghasilkan baris ganda.
- Respons `200 { changed, date, summary, items }` (bentuk sama dengan `GET`).

**Storefront & katalog:**

- `/api/products/<slug>`: tiap nominal mendapat `remaining` (null bila tanpa
  batas) dan `available`.
- `/api/catalog`: `min_price` dan `denomination_count` dihitung **hanya dari
  nominal yang tersedia**. Bila tidak ada satu pun yang tersedia, `min_price`
  tetap memakai `MIN(price)` nominal aktif (harga acuan, bukan janji bisa
  dibeli) dan produk mendapat `in_stock: false`, `available_count: 0`. Kartu
  produk menampilkan lencana "Habis", jadi harga acuan tidak pernah tampil
  sebagai tawaran.

**Penolakan order** (`handleCreateOrder`): setelah nominal dipilih dan sebelum
QR dibangun, hitung `held` untuk nominal itu dan tolak `409 out_of_stock` bila
`tersedia = false`. Tidak ada QR yang terlanjur terbit untuk barang habis.

Tidak ada pemeriksaan kedua setelah order tersimpan. Menghapus order yang sudah
tersimpan berarti pembeli memegang QR untuk pesanan yang lenyap — lebih buruk
daripada kelebihan satu pesanan pada balapan yang sangat sempit. Balapan dua
pembeli di detik yang sama dicatat sebagai batas praktis (§8).

### 5.4 Storefront

- `renderDenom` menambah kelas `is-out` dan atribut `disabled` untuk
  `available === false`; label harga diganti "Habis". Nominal habis tetap
  terlihat, tidak bisa dipilih.
- Kartu produk di katalog menampilkan lencana "Habis" bila `in_stock === false`
  (kartu tetap tampil, sesuai pilihan 2), dan harga "Mulai dari" mengikuti
  nominal yang tersedia (§5.3).
- Bila pembeli membuka detail produk lama lalu mencoba membeli nominal yang
  baru saja habis, `store.js` menampilkan pesan dari `409 out_of_stock` apa adanya.
- `store.js`/`store.css` berubah → cache-buster `index.html` naik dari
  `?v=20261116b` ke `?v=20261117a`.

### 5.5 UI admin — tab "Stok"

```
┌ thegadzstore admin ─────── [Pesanan] [Harga] [Stok] ─────── Keluar ┐
│ 17 Nov 2026 · 12 terjual · 17 ditahan · 5 habis · 3 isi ulang        │
│                                                                       │
│ Cari: [              ]  Kategori: [Semua ▾]  [x] hanya habis  [x] isi ulang │
│                                                                       │
│ Mobile Legends Diamonds                                               │
│ Nominal (SKU)        Jatah  Ditahan  Sisa   Terjual  Status           │
│ 86 Diamonds (ML-3)   [  20]    2       18     6      Tersedia         │
│ 172 Diamonds (ML-5)  [   0]    1       ∞      0      Tanpa batas      │
│ 344 Diamonds (ML-7)  [  10]   10       0      4      Habis ▸ lihat     │
│                                                                       │
│ Catatan: [ isi ulang dari supplier ]        [ Simpan (1 perubahan) ]  │
└───────────────────────────────────────────────────────────────────────┘
```

- Jatah (dan catatan) diedit langsung di tabel; hanya baris berubah yang
  dikirim, dan penyimpanan dipecah otomatis menjadi batch ≤ 100 item.
  Bila satu batch gagal, batch berikutnya tidak dikirim dan admin diberi tahu
  batch mana yang gagal — jadi "all-or-nothing" berlaku **per request**, bukan
  per klik Simpan; baris yang sudah tersimpan tetap tersimpan dan tabel diisi
  ulang dari respons server agar tidak ada angka palsu di layar.
- "Habis ▸ lihat" memanggil `/api/admin/stock/holders` — daftar pesanan yang
  benar-benar menahan nominal itu (definisi `held` §5.2, jadi pesanan
  kedaluwarsa tidak ikut muncul walau statusnya masih `pending`).
- Nominal berjatah kemarin diberi penanda "isi ulang" (bukan pemblokiran).
- Admin tetap bisa membiarkan jatah 0 (tanpa batas) tanpa mengisi apa pun.
- Seluruh 310 nominal tampil, termasuk nominal/produk nonaktif, yang ditandai
  redup dengan keterangan "nonaktif" supaya tidak dikira bisa dijual.

### 5.6 Seed & deploy

Menyusul keputusan pada design harga §5.5: seed menjadi upsert yang **tidak**
menimpa `price`, `compare_at`, `active`, dan sekarang juga **tidak** menimpa
`daily_quota`/`quota_date`/`quota_note`. Deploy tidak boleh mematikan jatah yang
sudah diisi. `db\schema.sql` ditambah kolom + tabel audit; `deploy-store.ps1`
menambah tiga `ALTER TABLE` idempoten ke daftar migrasi yang sudah ada, plus
index `idx_orders_paid_at(status, paid_at)`.

## 6. Berkas yang akan disentuh

| Berkas | Perubahan |
|---|---|
| `db\schema.sql` | kolom `daily_quota`, `quota_date`, `quota_note`; tabel `stock_changes`; index `idx_orders_paid_at` |
| `workers\deploy-store.ps1` | 3 migrasi `ADD COLUMN` idempoten + index |
| `db\build-seed.ps1` + `db\seed.sql` | tidak menimpa jatah (mengikuti design harga) |
| `worker\store-worker.js` | `cors` PATCH; `handleAdminStock`, `handleAdminStockHolders`, `handleAdminStockUpdate`; cek stok di `handleCreateOrder`; `remaining`/`available` di product, `in_stock`/`available_count`/`min_price` tersedia di catalog; tab "Stok" di `adminPage()` |
| `store.js`, `store.css`, `index.html` | tampilan "Habis", disable klik, cache-buster |
| `tests\api.tests.ps1` | +10 tes (§7), plus pembaruan assertion lama bila bentuk respons berubah |
| `tests\storefront.tests.ps1` | +2 tes markup |

## 7. Tes

Semua tes memakai nominal uji yang sama. **Nilai jatah awal dibaca dulu lalu
dipulihkan persis** — tidak pernah dipaksa ke 0, karena 0 berarti "tanpa batas"
dan bisa membuka produk nyata. Order uji (yang hanya `pending`) dihapus di
akhir agar tidak menahan jatah.

1. `GET /api/admin/stock` tanpa token → 401.
2. `GET /api/admin/stock` dengan token → 200; `items` = 310 (termasuk
   nonaktif); tiap item punya `daily_quota`, `quota_date`, `quota_stale`,
   `held`, `remaining`, `available`; `summary` punya `sold`, `held`,
   `out_of_stock`, `quota_stale`.
3. `PATCH` jatah 1 nominal (held = 0) → `remaining` = jatah, `available: true`;
   `/api/products/<slug>` menampilkan `remaining`/`available` yang sama dan
   `compare_at` tidak berubah.
4. Jatah = 2, buat 2 order `pending` → order ke-3 → `409 out_of_stock`;
   `/api/products/<slug>` menandai nominal itu `available: false`;
   `/api/catalog` menandai produknya `in_stock: false` bila itu satu-satunya
   nominal tersedia.
5. Jatah = 1 dengan 1 order `pending` → `POST /api/admin/orders/<id>`
   aksi `cancel` → nominal kembali `available: true` (pesanan `cancelled`
   tidak menahan).
6. Jatah = 1 dengan 1 order `pending` → `PATCH` `daily_quota: 0` → nominal
   `available: true`, `remaining: null`, dan pembelian tidak lagi ditolak.
7. `daily_quota` negatif / desimal / > 100000 / bukan angka → 400; satu request
   yang berisi satu item valid + satu item tidak valid → tidak ada baris yang
   berubah (all-or-nothing per request).
8. `PATCH` jatah membuat baris `stock_changes` dengan `old_quota`/`new_quota`
   benar; `PATCH` berisi nilai jatah **dan** catatan yang sama persis tidak
   menambah baris; `PATCH {"note": "..."}` saja mencatat `old_note`/`new_note`
   dan **tidak** membarui `quota_date`.
9. Order `pending` yang sudah lewat `expires_at` tidak menahan stok (dibuat
   dengan menunggu kedaluwarsa tidak praktis untuk tes live → diuji lewat
   `GET /api/admin/stock/holders` setelah `expires_at` lewat, atau dengan
   order yang dibuat lalu menunggu bila TTL pendek; bila tidak bisa, tes
   memeriksa invarian `held` = `paid` + `pending` yang belum kedaluwarsa pada
   data yang ada).
10. `GET /api/admin/stock/holders?denomination_id=<uji>` mengembalikan pesanan
    uji yang menahan dan **tidak** mengembalikan pesanan `cancelled`/`expired`.
11. (storefront) `GET /` markup tetap valid; `store.js` memuat kata
    `out_of_stock`; `store.css` memuat gaya `.is-out`.

Tes memulihkan jatah ke nilai awal (bukan 0) dan menghapus order ujinya.

## 8. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Dua pembeli memesan nominal terakhir bersamaan | satu cek sebelum insert, sebelum QR dibuat. Balapan sangat sempit (satu request cycle) dan dicatat sebagai batas praktis lalu lintas satu toko; sengaja **tidak** ada penghapusan order setelah tersimpan, karena pembeli bisa memegang QR untuk pesanan yang lenyap |
| Admin lupa mengisi jatah → penjualan berhenti | 0 = tanpa batas, jadi default tidak pernah menutup toko |
| Jatah kemarin dianggap masih berlaku | penanda "isi ulang" di UI; bukan pemblokiran otomatis |
| Deploy menghapus jatah | seed upsert tidak menyentuh `daily_quota` |
| Pesanan `pending` yang tidak pernah dibayar menahan stok | otomatis lepas saat `expires_at` lewat (definisi `held` tidak bergantung pada cron); tombol "lihat" memakai definisi yang sama |
| Status `pending` yang basi membuat UI tampak tidak konsisten | `held` selalu dari `expires_at`, bukan dari kolom `status`; daftar holders memakai query yang sama |
| Tes mengubah jatah produksi | tes mencatat dan memulihkan nilai persis, tidak pernah "reset ke 0" |
| Simpan banyak baris melebihi batas 100 item | UI memecah otomatis; kegagalan satu batch dilaporkan per batch |
| Timezone salah menghitung "hari ini" | semua perhitungan tanggal memakai WIB (`+07:00`) di server |

## 9. Yang diserahkan ke builder

- Nama fungsi internal, bentuk rinci respons (selama field di §5.3 ada), dan
  susunan kolom tabel boleh dirapikan.
- Teks tombol/lencana boleh diperhalus.
- Pemilihan nominal uji untuk tes, selama nilai awal dipulihkan persis.
- Susunan HTML/CSS tab "Stok" dan cara batch dipecah, selama kontrak §5.3 dan
  aturan §5.2 tetap.

## 10. Keputusan saya (silakan dikoreksi)

1. **`daily_quota = 0` berarti tanpa batas**, bukan "stok nol" — menghindari
   seluruh toko berhenti setelah deploy.
2. **Jatah tidak otomatis jadi 0 saat ganti hari.** Yang berubah hanya `held`
   (pesanan kedaluwarsa lepas); UI menandai "isi ulang".
3. **`held` = `paid` + `pending` yang belum kedaluwarsa**, lintas tanggal; bukan
   `fulfilled`/`cancelled`/`expired`.
4. **"Habis" tetap tampil di storefront** (pilihan 2), dengan lencana per produk
   lewat `in_stock`.
5. **"Terjual" memakai `paid_at`**, bukan tanggal pesanan dibuat.
6. **Harga "Mulai dari" hanya dari nominal yang tersedia**, dan bila semua habis
   produk ditandai `in_stock: false` dengan `available_count: 0`.
7. **Tidak ada pemeriksaan stok kedua setelah order tersimpan** — satu cek
   sebelum QR; balapan dicatat sebagai batas.
8. **Batas 100 item per `PATCH`, dipecah otomatis oleh UI**; kegagalan berlaku
   per batch dan dilaporkan.
9. **Field yang tidak dikirim tidak diubah**; audit ditulis bila jatah **atau**
   catatan benar-benar berubah.
10. **Tes tidak pernah "reset ke 0"** — nilai awal dipulihkan persis.
11. **Timezone tetap WIB**, sesuai QRIS dan operasi toko.
