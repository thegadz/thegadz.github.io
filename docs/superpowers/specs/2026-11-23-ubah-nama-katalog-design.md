# Ubah Nama Produk & Kategori dari Admin

Tanggal: 2026-11-23
Status: disetujui pemilik proyek
Prasyarat: `docs/superpowers/specs/2026-11-16-manajemen-harga-design.md` (tab admin, auth, pola `batch()`)

## 1. Masalah

Nama kategori dan produk di storefront berasal dari tabel D1 (`categories.name`,
`products.name`) yang saat ini hanya bisa diubah lewat SQL manual. Pemilik toko
ingin mengganti nama tampilan (mis. "Mobile Legends" → "MLBB") langsung dari
`/admin`, tanpa deploy dan tanpa menyentuh slug/SKU.

## 2. Batasan (non-goals)

- Tidak mengganti branding toko (`thegadzstore`) — itu ada di `index.html`/`store.js`.
- Tidak mengubah `slug`, `sku`, ikon, gambar, atau urutan.
- Tidak mengubah nama nominal/voucher (`denominations.label`); nominal punya
  label harga yang melekat pada SKU dan sudah terlihat di tab Harga.
- Tidak menambah project/worker baru — endpoint & UI menempel di worker yang sama.

## 3. Kontrak API (admin, `Authorization: Bearer <ADMIN_TOKEN>`)

### 3.1 `GET /api/admin/catalog`

Mengembalikan seluruh kategori dan produk (termasuk yang nonaktif, agar admin
bisa memperbaiki nama produk tersembunyi).

```json
{
  "categories": [
    { "id": 1, "slug": "mobile-legends", "name": "Mobile Legends", "active": 1, "product_count": 12 }
  ],
  "products": [
    { "id": 7, "slug": "mlbb-diamond", "name": "Diamond MLBB", "active": 1,
      "category_id": 1, "category_name": "Mobile Legends",
      "last_change": { "old_name": "Diamond", "new_name": "Diamond MLBB", "changed_at": "2026-11-23T07:00:00.000Z" } }
  ],
  "updated_at": "2026-11-23T07:00:00.000Z"
}
```

`updated_at` = `changed_at` terbaru dari `catalog_changes`, atau `null` bila
belum ada perubahan.

### 3.2 `PATCH /api/admin/catalog`

```json
{ "items": [ { "type": "product", "id": 7, "name": "Diamond MLBB" },
             { "type": "category", "id": 1, "name": "Mobile Legends" } ] }
```

Respons `200`:

```json
{ "changed": 2, "items": [ ...sama seperti entri 3.1 untuk setiap id yang dikirim... ] }
```

Aturan validasi — semua item divalidasi **sebelum** satu pun statement ditulis,
dan seluruh tulisan dieksekusi dalam **satu** `env.DB.batch()` (all-or-nothing):

| Kode | HTTP | Kondisi |
|---|---|---|
| `invalid_items` | 400 | `items` bukan array atau kosong |
| `too_many_items` | 400 | lebih dari 50 item |
| `invalid_type` | 400 | `type` bukan `product`/`category` |
| `invalid_id` | 400 | `id` bukan bilangan bulat ≥ 1 |
| `duplicate_item` | 400 | pasangan `(type, id)` muncul dua kali |
| `invalid_name` | 400 | nama (setelah `sanitizeText`) kosong atau > 60 karakter |
| `not_found` | 400 | `(type, id)` tidak ada di D1 |

Catatan:
- Panjang dihitung dari nama **asli** setelah `trim` (bukan setelah `slice`),
  jadi nama 61 karakter ditolak, tidak dipotong diam-diam.
- Nama yang identik dengan nilai sekarang **tidak** menulis apa pun (bukan
  error, tidak masuk `changed`) — idempoten.
- Karakter kontrol dan `<`/`>` dibuang oleh `sanitizeText` (sama seperti jalur
  tulis lain); `"` dan `'` tetap disimpan karena sudah di-escape di UI.
- Bila semua item tidak berubah, respons tetap `200 { changed: 0 }` tanpa
  menyentuh DB.

## 4. Penyimpanan & audit

Tabel baru di `db/schema.sql` (tanpa FK, riwayat tetap ada bila entitas dihapus):

```sql
CREATE TABLE IF NOT EXISTS catalog_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,          -- 'product' | 'category'
  entity_id INTEGER NOT NULL,
  slug TEXT NOT NULL DEFAULT '',      -- slug saat perubahan, untuk dibaca manusia
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_changes_entity ON catalog_changes(entity_type, entity_id, changed_at);
```

`adminPage()` memakai subselect `id DESC LIMIT 1` per entitas (pola identik
`PRICE_SELECT`) agar `last_change` murah: satu query per tabel, bukan N+1.

## 5. UI admin

Tab baru **"Produk"** di header admin, di antara "Harga" dan "Stok".

- Dua kartu: **Kategori** dan **Produk**.
- Tiap baris: ikon kecil, slug (redup), input nama (`maxlength=60`), tombol
  **Simpan** per baris yang hanya aktif bila nama berbeda dari nilai server.
- Baris kategori yang diganti namanya menampilkan badge jumlah produk.
- Kotak cari (filter nama/slug) di atas daftar.
- Setelah simpan: baris memperbarui nilai server, notice "Nama diperbarui.",
  dan storefront langsung memakai nama baru karena `/api/catalog` dibaca live.
- Auto-refresh 15 detik tidak menimpa input yang sedang difokuskan (pola
  `editingPrices()` sudah ada; UI baru memakai penjaga serupa).
- Riwayat 10 perubahan terakhir ditampilkan di bawah daftar.

## 6. Tes (`tests/api.tests.ps1`)

1. `admin catalog tanpa token ditolak` → 401.
2. `admin catalog mengembalikan kategori dan produk` → jumlah 5/73, field wajib bertipe benar.
3. `ganti nama produk tersimpan dan terlihat di catalog publik` → PATCH lalu
   `GET /api/catalog` memuat nama baru; slug tidak berubah; nama asli dipulihkan.
4. `ganti nama kategori tersimpan dan terlihat di produk` → PATCH lalu
   `category_name` di `/api/products/<slug>` ikut berubah; dipulihkan.
5. `nama kosong atau terlalu panjang ditolak` → `invalid_name`, data tidak berubah.
6. `satu item invalid membatalkan seluruh patch nama` → item valid + invalid dalam
   satu request; nama item valid **tidak** berubah (bukti batch all-or-nothing).
7. `nama tanpa perubahan tidak menulis riwayat` → kirim nama yang sama, `changed = 0`.

Tes menulis ke produksi, jadi setiap tes memulihkan nama asli di blok `finally`
(pola yang sudah dipakai tes harga).

## 7. Risiko

| Risiko | Mitigasi |
|---|---|
| Nama diubah saat ada pesanan berjalan | `orders.product_name` adalah salinan saat checkout, jadi pesanan lama tidak berubah — ini memang perilaku yang diinginkan. |
| Admin mengosongkan nama | Ditolak server (`invalid_name`), bukan hanya `required` di input. |
| Nama sangat panjang merusak layout kartu | Batas 60 karakter + `text-overflow` sudah ada pada kartu produk. |
