# Manajemen Harga — Design Doc

Tanggal: 2026-11-16
Status: **menunggu persetujuan** (belum ada kode yang ditulis)

## 1. Kenapa

Harga semua 310 nominal produk saat ini hanya bisa berubah lewat SQL manual
(`db\seed.sql` di-generate dari `db\catalog.json`, lalu dijalankan dengan
`workers\deploy-store.ps1`). Pemilik toko ingin mengubah harga "sewaktu-waktu"
tanpa SQL manual dan tanpa deploy, mengikuti SOP e-commerce.

Skala yang dipilih: **A — hanya pemilik sendiri, jarang mengubah harga**. Jadi
tidak perlu jadwal promo, ubah harga massal, akun/peran, atau persetujuan
berlapis. Yang tetap wajib menurut SOP e-commerce: harga jual, harga coret,
SKU, status aktif, dan jejak audit siapa/kapan/nilai lama-baru.

Kebijakan pesanan: **A — harga baru hanya berlaku untuk pesanan baru.** Pesanan
yang sudah dibuat tetap memakai harga saat checkout.

## 2. Kondisi sekarang (hasil recon)

- `denominations(id, product_id, label, price, compare_at, sku UNIQUE,
  supplier_code, active, sort)` sudah ada di `db\schema.sql`.
- `/api/catalog` (`min_price` per produk) dan `/api/products/<slug>` sudah
  membaca `price` + `compare_at` **live** dari D1 per request — tidak ada harga
  yang di-hardcode di worker maupun storefront.
- Storefront (`store.js` ~515) sudah menampilkan harga coret bila
  `compare_at > price`. `compare_at` saat ini selalu `0` karena belum ada UI.
- `handleCreateOrder` menyalin `price` ke `subtotal` saat order dibuat dan
  menolak denomination dengan `active = 0` (`invalid_denomination`). **Artinya
  keputusan "harga baru hanya untuk pesanan baru" sudah otomatis terpenuhi**
  tanpa mengubah logika order sama sekali.
- Belum ada endpoint tulis untuk denomination. `cors()` hanya
  `GET,POST,DELETE,OPTIONS`.
- **Risiko yang harus ditutup:** `db\seed.sql` dibuka dengan
  `DELETE FROM denominations;` dan `deploy-store.ps1` menjalankan seed secara
  default. Deploy berikutnya akan **menghapus semua harga hasil edit admin**
  (dan `ON CONFLICT` tidak menolong karena barisnya sudah dihapus, sehingga ID
  berubah dan riwayat audit menunjuk ID yang hilang).

## 3. Tujuan / bukan tujuan

Tujuan:
- Ubah `price`, `compare_at`, `active` per nominal dari tab "Harga" di `/admin`.
- Setiap perubahan tercatat: nilai lama, nilai baru, waktu, catatan, dan
  status aktif.
- Harga baru langsung tampil di storefront & dipakai order baru.
- Seed/deploy tidak lagi menimpa harga hasil edit admin.

Bukan tujuan:
- Ubah nama/label produk, tambah/hapus nominal, atau tambah produk (tetap
  urusan `catalog.json` + seed).
- Jadwal promo otomatis, diskon massal (%/kategori), kupon.
- Multi-user, peran, login per akun (tetap satu `ADMIN_TOKEN`).
- Mengubah pesanan yang sudah ada.

Anti-tujuan (dianggap gagal walau fiturnya jalan):
- Harga berubah tetapi pesanan lama ikut berubah/QRIS lama jadi tidak cocok.
- Harga hilang setelah deploy berikutnya.
- Perubahan harga tidak bisa ditelusuri (tanpa audit).

## 4. Pendekatan yang dipertimbangkan

**P1 — Edit harga di `catalog.json` + regenerate seed + deploy.** Nol kode
backend baru. Tapi tetap butuh SQL/deploy, butuh PowerShell + token Cloudflare
di perangkat, dan tidak ada audit. Gagal memenuhi permintaan inti
("tanpa SQL manual atau deploy").

**P2 — Editor "harga saja": `PATCH /api/admin/prices` + tab Harga.** Cepat,
tapi tanpa audit dan tanpa kontrol `compare_at`/`active`, jadi tidak memenuhi
standar SOP e-commerce yang diminta.

**P3 — Endpoint admin + tabel audit + UI tab Harga + seed reconcile
(dipilih).** Sedikit lebih banyak kerja: satu tabel baru, satu endpoint
`GET`/`PATCH`, satu tab admin, dan perubahan cara seed bekerja. Hasilnya harga
bisa diubah kapan saja dari HP, ada jejak audit, dan deploy berikutnya aman.

Dipilih **P3**. Detail desainnya di bawah.

## 5. Desain

### 5.1 Tabel audit baru — `price_changes`

```sql
CREATE TABLE IF NOT EXISTS price_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  denomination_id INTEGER NOT NULL,          -- tanpa FK: riwayat tetap ada walau nominal dihapus
  sku TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',            -- snapshot label saat diubah
  old_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL,
  old_compare_at INTEGER NOT NULL DEFAULT 0,
  new_compare_at INTEGER NOT NULL DEFAULT 0,
  old_active INTEGER NOT NULL DEFAULT 1,
  new_active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'admin',      -- 'admin' | 'seed'
  changed_at TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_price_changes_denom ON price_changes(denomination_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_price_changes_time ON price_changes(changed_at);
```

Tanpa `REFERENCES` sengaja: kalau suatu nominal dihapus oleh seed, riwayat
harga tetap terbaca. Ditambahkan ke `db\schema.sql` (idempoten, `IF NOT
EXISTS`, jadi deploy lama aman).

### 5.2 Validasi (server, satu-satunya sumber kebenaran)

Berlaku per item di `PATCH`:

| Aturan | Pesan error |
|---|---|
| `price` integer, 1 ≤ price ≤ 1.000.000.000 | `harga harus bilangan bulat rupiah lebih dari 0` |
| `compare_at` integer, `0` atau `>= price` | `harga coret harus 0 atau lebih besar/sama dengan harga jual` |
| `active` boolean/0-1 | `status aktif tidak valid` |
| `note` string ≤ 200 char | `catatan maksimal 200 karakter` |
| maksimal 50 item per request | `maksimal 50 harga per permintaan` |

Ditolak utuh (all-or-nothing): bila satu item gagal validasi, **tidak ada**
yang ditulis.

Harga disimpan sebagai integer rupiah (tanpa desimal), sesuai tipe kolom
sekarang. Pembulatan dilakukan di input UI (hanya terima digit).

### 5.3 API

`GET /api/admin/prices`
Header `Authorization: Bearer <ADMIN_TOKEN>` (guard `/api/admin/` sudah ada).

```json
{
  "items": [
    {
      "id": 12, "sku": "MOBILELEGENDS-3", "label": "86 Diamonds",
      "product_slug": "mobile-legends", "product_name": "Mobile Legends Diamonds",
      "category_name": "Top Up Game", "product_active": 1,
      "price": 22000, "compare_at": 0, "active": 1,
      "last_change": { "old_price": 20000, "new_price": 22000,
                       "changed_at": "2026-11-16T02:11:00.000Z", "note": "naik modal" }
    }
  ],
  "updated_at": "2026-11-16T02:11:00.000Z"
}
```

`last_change` = baris terakhir di `price_changes` untuk nominal tsb (atau
`null`). Diambil dengan satu query `LEFT JOIN` subselect, bukan N+1.

`GET /api/admin/prices/history?limit=100&denomination_id=12` (opsional filter)
→ 100 baris terbaru `price_changes`.

`PATCH /api/admin/prices`
```json
{ "items": [
  { "id": 12, "price": 22000, "compare_at": 25000, "active": 1, "note": "naik modal" },
  { "id": 13, "active": 0, "note": "stok habis" }
] }
```
Field yang boleh dikirim: `id` (wajib), `price`, `compare_at`, `active`,
`note`. Field yang tidak dikirim = tidak diubah.

Implementasi: satu `env.DB.batch([...])` berisi `UPDATE` per item + `INSERT`
audit per item yang benar-benar berubah (harga/compare/aktif berbeda), lalu
`SELECT` ulang untuk respons. D1 batch bersifat transaksional, jadi tidak
mungkin ada update tanpa audit. Item yang nilainya sama dengan sekarang tidak
menghasilkan baris audit (menghindari noise saat tombol Simpan ditekan dua
kali), kecuali `note` diisi dan ada perubahan lain.

Respons: `200 { "changed": 2, "items": [ ...sama seperti GET... ] }`.

`cors()` ditambah `PATCH` di `access-control-allow-methods`.

### 5.4 UI — tab "Harga" di `/admin`

Header admin mendapat dua tab: **Pesanan** (sekarang) dan **Harga** (baru).
Tab Harga:

```
┌ thegadzstore admin ────────────────────────────── [Pesanan] [Harga]   Keluar ┐
│ Cari: [ diamond            ]  Kategori: [Semua ▾]  [ ] tampilkan nonaktif     │
│                                                                              │
│ Mobile Legends Diamonds                                    [Simpan (2)]       │
│ ┌──────────────────────────────┬───────────┬───────────┬────────┬──────────┐ │
│ │ Nominal (SKU)                │ Harga     │ Coret     │ Aktif  │ Terakhir  │ │
│ ├──────────────────────────────┼───────────┼───────────┼────────┼──────────┤ │
│ │ 86 Diamonds (MOBILE…-3)      │ [ 22000 ] │ [ 25000 ] │ [✓]    │ 20.000→  │ │
│ │                              │           │           │        │ 22.000    │ │
│ │ 172 Diamonds (MOBILE…-5)     │ [ 43000 ] │ [     0 ] │ [ ]    │ —         │ │
│ └──────────────────────────────┴───────────┴───────────┴────────┴──────────┘ │
│ Catatan perubahan (opsional): [ naik modal 16/11        ]                    │
│ Hanya baris yang berubah yang dikirim.                                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Detail perilaku:
- Angka ditampilkan dan diterima sebagai digit saja; `rupiah()` dipakai untuk
  kolom "Terakhir".
- Tombol **Simpan** mengirim hanya baris yang berbeda (di-diff di klien) dan
  nonaktif bila tidak ada perubahan. Setelah sukses, tabel di-refresh dan
  muncul toast "2 harga diperbarui".
- Checkbox Aktif: bila dimatikan, nominal hilang dari storefront dan tidak
  bisa dipesan (`invalid_denomination`) — itu perilaku yang diinginkan, diberi
  peringatan kecil saat pertama kali mematikan salah satu.
- Di bawah tabel, panel **Riwayat perubahan** 20 baris terbaru (waktu, SKU,
  lama → baru, catatan) — read-only, cukup untuk audit skala A.
- Tanpa perubahan di `store.js`/`store.css` (harga sudah live), jadi
  cache-buster storefront tidak perlu dinaikkan.

### 5.5 Seed & deploy: berhenti menghapus harga

Ini bagian yang mencegah fitur ini merusak dirinya sendiri.

`db\build-seed.ps1` diubah: buang `DELETE FROM denominations;` dan
`DELETE FROM products;`. Ganti dengan pola **upsert yang tidak menyentuh
harga**:

```sql
INSERT INTO products (slug, name, ...) VALUES (...)
ON CONFLICT(slug) DO UPDATE SET
  name=excluded.name, category_id=excluded.category_id, short=excluded.short,
  icon=excluded.icon, color=excluded.color, image=excluded.image,
  target_type=excluded.target_type, requires_zone=excluded.requires_zone,
  description=excluded.description, sort=excluded.sort;
  -- active TIDAK ditimpa: kewenangan admin
```

Untuk `denominations`, upsert pada `sku` (sudah UNIQUE):

```sql
INSERT INTO denominations (product_id, label, price, compare_at, sku, supplier_code, active, sort)
SELECT ... FROM data JOIN products p ON p.slug = data.product_slug
ON CONFLICT(sku) DO UPDATE SET
  product_id=excluded.product_id, label=excluded.label, sort=excluded.sort;
  -- price, compare_at, active SENGAJA tidak ditimpa
```

Efeknya:
- Nominal/produk baru di `catalog.json` masuk dengan harga awalnya.
- Nominal yang dihapus dari `catalog.json` **tidak** dihapus otomatis
  (agar audit tetap valid). Bila perlu menghapus, itu tindakan sadar: admin
  menonaktifkannya, atau menjalankan reset eksplisit (di bawah).
- ID nominal stabil → riwayat audit tetap nyambung.

Untuk kasus benar-benar ingin reset ke harga katalog (misal salah total),
`db\build-seed.ps1` diberi switch `-ResetPrices` yang menghasilkan seed gaya
lama (DELETE + INSERT). `workers\deploy-store.ps1` **tidak** memakai switch
ini; hanya dipakai manual dan disebutkan di dokumentasi sebagai tindakan
berisiko (menghapus riwayat harga).

`deploy-store.ps1` juga ditambah: bila `-SkipSeed` tidak diberikan, tetap
aman karena seed sekarang idempoten dan tidak menyentuh harga. Tidak perlu
mengubah default ke `-SkipSeed` — tapi pesan ringkas saat deploy harus
mencetak "seed: upsert (harga admin dipertahankan)".

### 5.6 Pesanan lama

Tidak ada perubahan kode order. `orders` sudah menyimpan `subtotal`, dan QRIS
yang sudah dibuat memakai nominal itu. Harga baru hanya terbaca saat
`handleCreateOrder` berikutnya memanggil `denominations.price`.

## 6. Berkas yang akan disentuh

| Berkas | Perubahan |
|---|---|
| `db\schema.sql` | tambah `price_changes` + 2 index |
| `db\build-seed.ps1` | upsert tanpa DELETE; switch `-ResetPrices` |
| `db\seed.sql` | regenerasi (hasil generator baru, ~36 KB) |
| `worker\store-worker.js` | `cors()` + PATCH; `handleAdminPrices`, `handleAdminPriceHistory`, `handleAdminPricesUpdate`; rute; tab + tampilan Harga di `adminPage()` |
| `workers\deploy-store.ps1` | pesan log seed; tanpa perubahan alur |
| `tests\api.tests.ps1` | +8 tes (lihat §7) |
| `docs\...` | doc ini + catatan singkat di README deploy |

## 7. Tes baru (`tests\api.tests.ps1`)

1. `GET /api/admin/prices` tanpa token → 401.
2. `GET /api/admin/prices` dengan token → 200, jumlah item = 310, tiap item
   punya `sku`, `price`, `compare_at`, `active`, `product_name`.
3. `PATCH` harga naik → 200, `GET /api/products/<slug>` menampilkan harga baru
   dan `GET /api/catalog` menampilkan `min_price` yang benar.
4. `PATCH` membuat baris audit yang bisa dibaca dari
   `/api/admin/prices/history?denomination_id=`, dengan `old_price`/`new_price`
   benar. (Dibuktikan sebelum → sesudah.)
5. `PATCH` `compare_at` < `price` → 400 `invalid_compare_at`; harga di DB
   tidak berubah (all-or-nothing).
6. `PATCH` `price: 0` / negatif / desimal → 400.
7. `PATCH` `active: 0` → order baru untuk nominal itu → 400
   `invalid_denomination`; kembalikan `active: 1`.
8. **Harga baru hanya untuk pesanan baru**: buat order (harga A), ubah harga
   ke B, order kedua → subtotal B, order pertama tetap A (dibaca ulang lewat
   `/api/orders/<id>`). Order uji dibatalkan/di-cancel setelahnya agar D1
   tetap bersih.
9. `PATCH` dengan 2 item yang salah satunya invalid → tidak ada yang berubah.

Semua tes mengembalikan harga ke nilai semula di blok `finally` supaya data
produksi tidak bergeser, dan mem-verifikasi pemulihannya.

## 8. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Deploy menimpa harga admin | §5.5: seed upsert, tanpa DELETE |
| Salah ketik harga (kurang satu nol) | audit + `last_change` tampil di tabel, riwayat 20 baris, bisa langsung dikoreksi |
| Harga coret < harga jual membingungkan pembeli | validasi server 400 |
| Nominal dinonaktifkan tapi masih tampil | `/api/catalog` & `/api/products` sudah filter `active = 1`; tes #7 membuktikan |
| Order bersamaan saat harga berubah | order membaca `price` sekali di dalam `handleCreateOrder`; pesanan lama tidak disentuh |
| Penyalahgunaan endpoint | tetap butuh `ADMIN_TOKEN`; batas 50 item/permintaan; (rate limit admin di luar skala A, dicatat di daftar pra-produksi) |

## 9. Yang diserahkan ke builder

- Nama internal fungsi/rute boleh disesuaikan asal kontrak §5.3 tetap.
- Bentuk tabel admin (kolom tambahan "SKU" terpisah) boleh dirapikan asal
  informasi wajib tetap terlihat: nominal, SKU, harga, coret, aktif, terakhir.
- Teks toast/peringatan boleh diperhalus.

## 10. Keputusan saya (silakan dikoreksi sambil membaca)

1. **`compare_at = 0` berarti "tanpa harga coret"** — bukan "sama dengan
   harga". Storefront sudah memakai aturan ini.
2. **Riwayat tidak ikut terhapus** walau nominal dihapus → `price_changes`
   tanpa foreign key.
3. **Batas 50 item per request** cukup untuk kebutuhan sesekali dan mencegah
   satu request raksasa.
4. **Tanpa uji harga di UI otomatis** (tidak ada runner browser); UI
   diverifikasi manual lewat DOM seperti sebelumnya.
5. **Tidak menambah rate limit admin** sekarang; dicatat sebagai butir
   pra-produksi bersama rotasi token.
