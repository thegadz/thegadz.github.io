# Manajemen Harga & Jatah Stok — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin bisa mengubah harga, harga coret, status aktif, dan jatah harian per nominal dari tab admin di `/admin` — tanpa SQL manual dan tanpa deploy — dengan audit trail, dan storefront menolak pembelian nominal yang jatahnya habis.

**Architecture:** Satu Cloudflare Worker (+ D1) sudah menjadi satu-satunya sumber kebenaran. Dua tabel audit baru (`price_changes`, `stock_changes`) mencatat setiap perubahan; tiga kolom baru pada `denominations` (`daily_quota`, `quota_date`, `quota_note`) menyimpan jatah. "Sisa" **tidak** disimpan: dihitung dari pesanan berjalan (`paid` + `pending` yang belum kedaluwarsa) dengan satu query agregat. Endpoint `PATCH /api/admin/prices` dan `PATCH /api/admin/stock` menulis lewat `env.DB.batch()` (transaksional, all-or-nothing per request). Seed berubah dari DELETE+INSERT menjadi upsert yang tidak menimpa harga/jatah, sehingga deploy berikutnya tidak menghapus pekerjaan admin.

**Tech Stack:** HTML/CSS/vanilla JS (storefront + `adminPage()` di dalam worker), Cloudflare Workers (ES module), D1 (SQLite), PowerShell 5.1 untuk seed/deploy/tes.

**Spec:**
- `docs/superpowers/specs/2026-11-16-manajemen-harga-design.md`
- `docs/superpowers/specs/2026-11-17-jatah-stok-design.md`

**Urutan:** Harga dulu (Task 1–6), lalu Stok (Task 7–14). Harga tidak bergantung pada stok; stok memakai tab admin dan pola `PATCH` yang dibangun di bagian harga.

## Status (2026-11-17)

- Belum ada kode ditulis. Plan ini belum dieksekusi.
- Baseline tes: `tests\api.tests.ps1` 30 passed / 0 failed; `tests\storefront.tests.ps1` 8 passed / 0 failed.
- D1 produksi bersih: 0 orders, 0 order_events, 73 products, 310 denominations.

## Global Constraints

- Bahasa komentar/pesan user-visible: Indonesia. Nama fungsi/kolom: Inggris snake_case seperti kode yang ada.
- Semua perhitungan tanggal memakai **WIB (`+07:00`)** di server.
- Semua nilai rupiah = integer (tanpa desimal, tanpa titik).
- `daily_quota = 0` berarti **tanpa batas**; jangan pernah menafsirkannya sebagai "stok nol".
- `held` = order `paid` **atau** `pending` dengan `expires_at > sekarang`; `fulfilled`/`cancelled`/`expired` tidak menahan. Satu definisi, dipakai di semua tempat.
- Satu `env.DB.batch()` per request tulis → tidak boleh ada update tanpa audit.
- Seed: **upsert**, tidak menimpa `price`, `compare_at`, `active`, `daily_quota`, `quota_date`, `quota_note`.
- Tes **wajib** memulihkan nilai awal persis (harga, compare_at, active, jatah, catatan) dan menghapus/membatalkan order ujinya. Jangan pernah "reset ke 0".
- PowerShell 5.1: tidak ada ternary, tidak ada `??`; tulis file `.ps1` lewat `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))` bila harus dibuat oleh skrip.
- D1 HTTP `/query` hanya menerima **satu** statement per panggilan (dipakai `Invoke-D1` di `workers\deploy-store.ps1`).
- Tidak ada Node/npm/Python/Deno, tidak ada runner tes browser. UI diverifikasi manual lewat DOM browser.
- **Deploy hanya setelah persetujuan pengguna.** Task 14 diakhiri dengan permintaan izin, bukan deploy otomatis.

## Review Focus

Saat mereview implementasi, periksa khusus:

1. **Seed tidak menghapus harga/jatah** — `db\seed.sql` hasil regenerasi tidak boleh punya `DELETE FROM denominations` / `DELETE FROM products` (kecuali dengan `-ResetPrices`).
2. **`held` tunggal** — tidak ada tempat kedua yang mendefinisikan ulang "pesanan yang menahan".
3. **All-or-nothing** — kegagalan validasi satu item tidak menulis apa pun.
4. **Audit tidak berisik** — simpan ulang tanpa perubahan tidak menambah baris.
5. **Harga lama tidak berubah** — `handleCreateOrder` tetap menyalin `price` ke `subtotal`; tidak ada kode yang menyentuh `orders` saat harga/jatah berubah.
6. **`remaining`/`available` konsisten** antara `/api/products/<slug>`, cek di `handleCreateOrder`, dan tab admin.
7. **Rahasia** — `ADMIN_TOKEN` tidak pernah muncul di HTML/JS halaman admin (token dari `sessionStorage`, dikirim per request).

## File Structure

| Berkas | Tanggung jawab |
|---|---|
| `db\schema.sql` | Sumber skema idempoten: `price_changes`, `stock_changes`, kolom jatah, index `idx_orders_paid_at`. |
| `db\build-seed.ps1` | Generator `db\seed.sql`: upsert untuk products/denominations; switch `-ResetPrices`. |
| `db\seed.sql` | Artefak hasil generator (jangan diedit tangan). |
| `workers\deploy-store.ps1` | Terapkan skema, migrasi `ADD COLUMN` idempoten, index tambahan, seed, upload worker. |
| `worker\store-worker.js` | Semua API + `adminPage()`. Fungsi baru dikelompokkan dekat `handleCatalog`/`handleAdminList`. |
| `store.js` | Render nominal "Habis" + lencana produk; pakai pesan `409 out_of_stock` apa adanya. |
| `store.css` | Gaya `.is-out`, `.card-badge`. |
| `index.html` | Cache-buster `?v=20261117a`. |
| `tests\api.tests.ps1` | +9 tes harga, +10 tes stok. |
| `tests\storefront.tests.ps1` | +2 tes markup. |
| `README.md` | Catatan `-ResetPrices` dan seed upsert. |

---

# Bagian A — Harga

## Task 1: Skema `price_changes`

**Files:**
- Modify: `db\schema.sql` (setelah blok `denominations`, ~baris 42)
- Modify: `workers\deploy-store.ps1` (daftar `$migrations`, ~baris 90–104)

**Interfaces:**
- Produces: tabel `price_changes` dengan kolom §5.1 spec harga; dipakai Task 3, 4, 5.

- [ ] **Step 1: Tambah tabel ke `db\schema.sql`**

Sisipkan tepat setelah `CREATE INDEX IF NOT EXISTS idx_denominations_product ...`:

```sql
-- Audit perubahan harga. Tanpa FK: riwayat tetap ada walau nominal dihapus.
CREATE TABLE IF NOT EXISTS price_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  denomination_id INTEGER NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  old_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL,
  old_compare_at INTEGER NOT NULL DEFAULT 0,
  new_compare_at INTEGER NOT NULL DEFAULT 0,
  old_active INTEGER NOT NULL DEFAULT 1,
  new_active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'admin',
  changed_at TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_price_changes_denom ON price_changes(denomination_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_price_changes_time ON price_changes(changed_at);
```

- [ ] **Step 2: Verifikasi tidak ada duplikat & file tetap valid**

Jalankan:

```powershell
Select-String -Path "db\schema.sql" -Pattern "CREATE TABLE|CREATE INDEX" | ForEach-Object { $_.Line }
```

Harapan: tiap nama tabel/index muncul sekali. Tidak ada `price_changes` sebelumnya.

- [ ] **Step 3: Commit**

```powershell
git add db\schema.sql
git commit -m "Tambah tabel audit price_changes ke skema"
```

---

## Task 2: Seed upsert + switch `-ResetPrices`

**Files:**
- Modify: `db\build-seed.ps1` (param, baris 31–41 dan 82–110)
- Modify: `workers\deploy-store.ps1` (pesan log seed, ~baris 120–130)
- Regenerate: `db\seed.sql`

**Interfaces:**
- Produces: `db\seed.sql` idempoten; `build-seed.ps1 -ResetPrices` menghasilkan gaya lama.

- [ ] **Step 1: Baca ulang generator sebelum mengubah**

Baca `db\build-seed.ps1` baris 1–110 seluruhnya. Catat:
- baris `DELETE FROM denominations;` dan `DELETE FROM products;` di ~33–34,
- baris `INSERT INTO products ...` di ~82–83,
- blok `WITH data(...)` untuk denominations di ~98–103 (perhatikan kolom yang dipakai dan nilai `sort`).

- [ ] **Step 2: Tambah parameter switch**

Ubah header param menjadi:

```powershell
param(
  [string]$CatalogPath = "",
  [string]$OutPath = "",
  [switch]$ResetPrices
)
```

- [ ] **Step 3: Jangan emit DELETE kecuali `-ResetPrices`**

Bungkus dua baris `DELETE` dengan:

```powershell
if ($ResetPrices) {
  $lines.Add("-- RESET: menghapus semua nominal & produk (riwayat audit tidak ikut terhapus).")
  $lines.Add("DELETE FROM denominations;")
  $lines.Add("DELETE FROM products;")
}
```

Tambahkan komentar header pada keluaran:

```powershell
if (-not $ResetPrices) {
  $lines.Add("-- Mode upsert: price, compare_at, active, daily_quota, quota_date, quota_note TIDAK ditimpa.")
}
```

- [ ] **Step 4: Ubah INSERT products menjadi upsert**

Ganti `INSERT INTO products (...)` menjadi `INSERT INTO products (...) VALUES (...)` diikuti:

```sql
ON CONFLICT(slug) DO UPDATE SET
  name = excluded.name,
  category_id = excluded.category_id,
  short = excluded.short,
  icon = excluded.icon,
  color = excluded.color,
  image = excluded.image,
  target_type = excluded.target_type,
  requires_zone = excluded.requires_zone,
  description = excluded.description,
  sort = excluded.sort;
```

`active` **tidak** ada di daftar `DO UPDATE` (kewenangan admin). Gunakan daftar kolom persis yang sudah dipakai generator sekarang — jangan menambah/menghapus kolom.

Bila `-ResetPrices` aktif, upsert ini tetap aman (tidak ada konflik setelah DELETE); tidak perlu dua jalur.

- [ ] **Step 5: Ubah denominations menjadi upsert pada `sku`**

Di akhir blok `WITH data(...) ... SELECT ... FROM data JOIN products p ON p.slug = data.product_slug`, tambahkan:

```sql
ON CONFLICT(sku) DO UPDATE SET
  product_id = excluded.product_id,
  label = excluded.label,
  sort = excluded.sort;
```

`price`, `compare_at`, `active` sengaja tidak ditimpa. Jangan menambahkan `daily_quota`/`quota_date`/`quota_note` ke sini sama sekali.

- [ ] **Step 6: Regenerasi dan periksa hasil**

```powershell
powershell -NoProfile -File "db\build-seed.ps1"
Select-String -Path "db\seed.sql" -Pattern "DELETE FROM|ON CONFLICT" | ForEach-Object { "$($_.LineNumber): $($_.Line)" }
```

Harapan: **0 baris** `DELETE FROM`, **2 baris** `ON CONFLICT` (products, denominations). Jumlah baris `INSERT INTO denominations` tetap sama seperti sebelumnya.

- [ ] **Step 7: Periksa mode reset**

```powershell
powershell -NoProfile -File "db\build-seed.ps1" -OutPath "$env:TEMP\seed-reset.sql" -ResetPrices
Select-String -Path "$env:TEMP\seed-reset.sql" -Pattern "DELETE FROM" | ForEach-Object { $_.Line }
Remove-Item "$env:TEMP\seed-reset.sql"
```

Harapan: dua baris `DELETE FROM` muncul. Jalankan ulang tanpa switch sebelum lanjut agar `db\seed.sql` kembali ke mode upsert:

```powershell
powershell -NoProfile -File "db\build-seed.ps1"
```

- [ ] **Step 8: Pesan log deploy**

Di `workers\deploy-store.ps1`, pada blok seed (~120–130), tambahkan satu baris log sebelum menjalankan seed:

```powershell
Write-Host "  seed: upsert (harga & jatah admin dipertahankan)" -ForegroundColor DarkGray
```

Jangan mengubah flag default `-SkipSeed` maupun urutannya.

- [ ] **Step 9: Commit**

```powershell
git add db\build-seed.ps1 db\seed.sql workers\deploy-store.ps1
git commit -m "Seed jadi upsert yang tidak menimpa harga/jatah, tambah -ResetPrices"
```

---

## Task 3: `GET /api/admin/prices` + `/history` (baca)

**Files:**
- Modify: `worker\store-worker.js`: `cors()` ~30–37, rute ~366–485, helper harga baru setelah `productJson`, fungsi baru setelah `handleProduct` (~553)

**Interfaces:**
- Produces:
  - `priceRows(env)` → `Promise<Array>` baris harga ber-`last_change` ternormalisasi; dipakai Task 4 (respons PATCH) dan Task 5 (UI).
  - `priceJson(row)` → objek item sesuai §5.3 spec harga.
  - `GET /api/admin/prices` → `{ items, updated_at }`
  - `GET /api/admin/prices/history?limit=100&denomination_id=12` → `{ items }`

- [ ] **Step 1: Baca ulang titik sisip**

Baca `worker\store-worker.js` baris 25–40 (`cors`), 366–380 (guard admin), 268–290 (`productJson`), 486–555 (`handleCatalog`/`handleProduct`), 909–940 (`handleAdminList`) untuk meniru gaya `dbAll`/`num`/`HttpError`.

- [ ] **Step 2: Tambah `PATCH` ke CORS**

Ubah `access-control-allow-methods` menjadi `GET,POST,PATCH,DELETE,OPTIONS`. Guard `/api/admin/` di `fetch` sudah berlaku semua method — jangan ubah.

- [ ] **Step 3: Tulis query harga**

Tambahkan di atas `handleAdminList`:

```js
const PRICE_SELECT = `
  SELECT d.id, d.sku, d.label, d.price, d.compare_at, d.active,
         d.product_id, p.slug AS product_slug, p.name AS product_name,
         p.active AS product_active, c.name AS category_name,
         pc.old_price, pc.new_price, pc.changed_at AS last_changed_at, pc.note AS last_note
  FROM denominations d
  JOIN products p ON p.id = d.product_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN price_changes pc ON pc.id = (
    SELECT id FROM price_changes x WHERE x.denomination_id = d.id ORDER BY x.id DESC LIMIT 1
  )`;

function priceJson(row) {
  return {
    id: row.id,
    sku: row.sku,
    label: row.label,
    product_slug: row.product_slug,
    product_name: row.product_name,
    category_name: row.category_name,
    product_active: num(row.product_active),
    price: num(row.price),
    compare_at: num(row.compare_at),
    active: num(row.active),
    last_change: row.last_changed_at
      ? { old_price: num(row.old_price), new_price: num(row.new_price),
          changed_at: row.last_changed_at, note: row.last_note || "" }
      : null,
  };
}

async function priceRows(env, ids) {
  if (Array.isArray(ids) && ids.length === 0) return [];
  const filter = Array.isArray(ids) ? ` WHERE d.id IN (${ids.map(() => "?").join(",")})` : "";
  const rows = await dbAll(env, `${PRICE_SELECT}${filter} ORDER BY p.sort, d.sort, d.id`, ids || []);
  return rows.map(priceJson);
}

function pricesUpdatedAt(items) {
  let latest = "";
  for (const it of items) {
    if (it.last_change && it.last_change.changed_at > latest) latest = it.last_change.changed_at;
  }
  return latest;
}
```

Subselect `LEFT JOIN` ini satu query untuk semua nominal (bukan N+1), memakai `idx_price_changes_denom`.

- [ ] **Step 4: Tulis handler baca**

```js
async function handleAdminPrices(env) {
  const items = await priceRows(env, null);
  return json({ items, updated_at: pricesUpdatedAt(items) });
}

async function handleAdminPriceHistory(env, url) {
  const limit = Math.min(500, Math.max(1, num(url.searchParams.get("limit")) || 100));
  const denom = num(url.searchParams.get("denomination_id"));
  const where = denom ? "WHERE denomination_id = ?" : "";
  const args = denom ? [denom, limit] : [limit];
  const rows = await dbAll(env,
    `SELECT id, denomination_id, sku, label, old_price, new_price, old_compare_at, new_compare_at,
            old_active, new_active, note, source, changed_at, request_id
       FROM price_changes ${where} ORDER BY id DESC LIMIT ?`, args);
  return json({ items: rows });
}
```

Petakan angka dengan `num()` pada `old_price`/`new_price`/`old_compare_at`/`new_compare_at`/`old_active`/`new_active` bila `dbAll` mengembalikan tipe campuran.

- [ ] **Step 5: Daftarkan rute**

Di cabang admin (dekat rute `/api/admin/orders`), tambahkan sebelum cabang admin generik:

```js
if (method === "GET" && path === "/api/admin/prices") return handleAdminPrices(env);
if (method === "GET" && path === "/api/admin/prices/history") return handleAdminPriceHistory(env, url);
```

Urutkan rute spesifik (`/history`) **sebelum** yang umum bila kelak ditambah `PATCH` di Task 4 pada path yang sama.

- [ ] **Step 6: Cek sintaks**

Tidak ada Node/Deno di mesin ini, jadi `node --check` tidak bisa dipakai. Pemeriksaan sintaks terjadi otomatis saat esbuild mem-*bundle* `worker\store-worker.js` pada deploy (Task 6/14) — bila ada galat sintaks, deploy berhenti sebelum apa pun dikirim. Untuk sekarang cukup pastikan berkas tersimpan dan tidak ada karakter rusak di sekitar blok yang disunting.

- [ ] **Step 7: Commit**

```powershell
git add worker\store-worker.js
git commit -m "API admin: GET /api/admin/prices dan /prices/history"
```

---

## Task 4: `PATCH /api/admin/prices` (tulis + audit)

**Files:**
- Modify: `worker\store-worker.js`: fungsi validasi & handler setelah Task 3

**Interfaces:**
- Produces: `PATCH /api/admin/prices` → `{ changed, items }`
- Memakai `priceRows` (Task 3), `readJson`, `HttpError`, `nowIso`, `sanitizeText`.

- [ ] **Step 1: Besarkan batas `readJson`**

Pada `readJson` (~142–155) naikkan batas dari 20.000 menjadi **200.000** byte (cukup untuk 100 item stok + margin), dan pertahankan `413 payload_too_large` dengan pesan yang sama. Tidak ada pemanggil lain yang bergantung pada angka 20.000.

- [ ] **Step 2: Tulis validator harga**

```js
const MAX_PRICE = 1000000000;

function pricePatchItem(raw, index) {
  const id = num(raw && raw.id);
  if (!id) throw new HttpError(400, "invalid_denomination", "id nominal tidak valid");
  const item = { id: id, touched: false };
  if (raw.price !== undefined) {
    const price = raw.price;
    if (typeof price !== "number" || !Number.isInteger(price) || price < 1 || price > MAX_PRICE) {
      throw new HttpError(400, "invalid_price", "harga harus bilangan bulat rupiah lebih dari 0");
    }
    item.price = price; item.touched = true;
  }
  if (raw.active !== undefined) {
    const active = raw.active === true ? 1 : raw.active === false ? 0 : num(raw.active);
    if (active !== 0 && active !== 1) throw new HttpError(400, "invalid_active", "status aktif tidak valid");
    item.active = active; item.touched = true;
  }
  if (raw.compare_at !== undefined) {
    if (typeof raw.compare_at !== "number" || !Number.isInteger(raw.compare_at) || raw.compare_at < 0) {
      throw new HttpError(400, "invalid_compare_at", "harga coret harus 0 atau lebih besar/sama dengan harga jual");
    }
    item.compare_at = raw.compare_at; item.touched = true;
  }
  if (raw.note !== undefined) {
    const note = sanitizeText(String(raw.note), 200);
    if (String(raw.note).trim().length > 200) throw new HttpError(400, "invalid_note", "catatan maksimal 200 karakter");
    item.note = note; item.touched = true;
  }
  return item;
}
```

Catatan: `typeof raw.price !== "number"` sekaligus menolak `"22000"` (string), desimal, dan `NaN`. `compare_at` dicek terhadap harga **efektif** setelah mempertimbangkan field lain.

- [ ] **Step 3: Tulis handler tulis**

```js
async function handleAdminPricesUpdate(env, request) {
  const body = await readJson(request);
  const rawItems = Array.isArray(body && body.items) ? body.items : [];
  if (!rawItems.length) throw new HttpError(400, "invalid_items", "tidak ada item yang dikirim");
  if (rawItems.length > 50) throw new HttpError(400, "too_many_items", "maksimal 50 harga per permintaan");

  const ids = rawItems.map((r) => num(r && r.id)).filter(Boolean);
  if (!ids.length) throw new HttpError(400, "invalid_denomination", "id nominal tidak valid");
  const current = await priceRows(env, ids);
  const byId = new Map(current.map((r) => [r.id, r]));

  const requestId = (request.headers.get("cf-ray") || "") + "-" + Date.now();
  const changedAt = nowIso();
  const statements = [];
  let changed = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const item = pricePatchItem(rawItems[i], i);
    const row = byId.get(item.id);
    if (!row) throw new HttpError(400, "invalid_denomination", "nominal " + item.id + " tidak ditemukan");
    const price = item.price !== undefined ? item.price : row.price;
    const compareAt = item.compare_at !== undefined ? item.compare_at : row.compare_at;
    const active = item.active !== undefined ? item.active : row.active;
    if (compareAt !== 0 && compareAt < price) {
      throw new HttpError(400, "invalid_compare_at", "harga coret harus 0 atau lebih besar/sama dengan harga jual");
    }
    if (price === row.price && compareAt === row.compare_at && active === row.active) continue;
    changed++;
    statements.push(env.DB.prepare(
      "UPDATE denominations SET price = ?, compare_at = ?, active = ? WHERE id = ?"
    ).bind(price, compareAt, active, item.id));
    statements.push(env.DB.prepare(
      `INSERT INTO price_changes (denomination_id, sku, label, old_price, new_price, old_compare_at,
        new_compare_at, old_active, new_active, note, source, changed_at, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)`
    ).bind(item.id, row.sku, row.label, row.price, price, row.compare_at, compareAt,
           row.active, active, item.note || "", changedAt, requestId));
  }

  if (statements.length) await env.DB.batch(statements);
  const items = await priceRows(env, ids);
  return json({ changed, items });
}
```

Aturan `note` (spec §5.3): catatan hanya bermakna bila ada perubahan lain — karena itu `note` disimpan di baris audit, dan item tanpa perubahan tidak menulis apa pun (termasuk catatan). Rumuskan sebagai komentar di kode.

- [ ] **Step 4: Daftarkan rute**

```js
if (method === "PATCH" && path === "/api/admin/prices") return handleAdminPricesUpdate(env, request);
```

Pastikan guard `/api/admin/` + `Bearer` tetap jalan untuk PATCH.

- [ ] **Step 5: Commit**

```powershell
git add worker\store-worker.js
git commit -m "API admin: PATCH /api/admin/prices dengan audit all-or-nothing"
```

---

## Task 5: UI admin — tab "Harga"

**Files:**
- Modify: `worker\store-worker.js` — `adminPage()` (CSS 1047–1091, markup 1093–1125, JS IIFE 1126–1294)

**Interfaces:**
- Memakai: `GET /api/admin/prices`, `PATCH /api/admin/prices`, `GET /api/admin/prices/history?limit=20`.
- Produces: `data-tab` navigation (`orders`, `prices`, kelak `stock`), fungsi `showTab(name)`, `loadPrices()`, `loadHistory()`.

- [ ] **Step 1: Baca ulang `adminPage()` seluruhnya**

Baca baris 1040–1298 dan catat: `$`/`esc`/`rupiah`/`when`/`label`/`api`/`showLogin`/`showDashboard`/`load`/`runAction`, serta `setInterval(load, 15000)` di `showDashboard()`.

- [ ] **Step 2: Tab yang sadar-aktif, refresh hanya tab aktif**

Ganti `setInterval(load, 15000)` dengan timer yang memanggil tab aktif:

```js
var tab = "orders";
function showTab(name) {
  tab = name;
  document.querySelectorAll("[data-tab]").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-tab") === name);
  });
  document.querySelectorAll("[data-panel]").forEach(function (p) {
    p.hidden = p.getAttribute("data-panel") !== name;
  });
  if (name === "orders") load();
  else if (name === "prices") loadPrices();
  else if (name === "stock" && typeof loadStock === "function") loadStock();
}
function refreshActive() {
  if (tab === "orders") load();
  else if (tab === "prices") loadPrices();
  else if (typeof loadStock === "function") loadStock();
}
```

`setInterval(refreshActive, 15000)` dipasang sekali di `showDashboard()`. `showDashboard()` memanggil `showTab(tab)` setelah dashboard tampil.

**Penting (Task 5 belum punya `loadStock`):** `loadStock` baru didefinisikan di Task 13. Karena `showTab`/`refreshActive` sudah memakai `typeof loadStock === "function"`, tombol "Stok" hanya tidak melakukan apa-apa sampai Task 13 — **jangan** menulis `loadStock()` tanpa penjaga `typeof`, dan jangan mengubahnya menjadi variabel (`var loadStock = function …`) karena deklarasi fungsi di IIFE yang sama sudah tepat.

- [ ] **Step 3: Markup header & panel**

Header: ganti blok judul dengan

```html
<div style="display:flex;gap:8px;align-items:center">
  <b>thegadzstore admin</b>
  <nav class="tabs">
    <button data-tab="orders" class="on" onclick="__tab('orders')">Pesanan</button>
    <button data-tab="prices" onclick="__tab('prices')">Harga</button>
    <button data-tab="stock" onclick="__tab('stock')">Stok</button>
  </nav>
</div>
```

Panel: beri `data-panel="orders"` pada `<section>` yang sudah ada, lalu tambah panel harga:

```html
<section data-panel="prices" hidden>
  <div class="filters">
    <input id="p-q" placeholder="Cari nominal / SKU" style="min-width:220px" />
    <select id="p-cat"><option value="">Semua kategori</option></select>
    <label><input type="checkbox" id="p-all" /> tampilkan nonaktif</label>
    <span style="flex:1"></span>
    <input id="p-note" placeholder="Catatan perubahan (opsional)" maxlength="200" style="min-width:200px" />
    <button id="p-save" class="primary" disabled>Simpan</button>
  </div>
  <p class="notice" id="p-notice"></p>
  <div id="p-list"></div>
  <h3 style="margin:24px 0 8px;font-size:15px">Riwayat perubahan</h3>
  <div id="p-history" class="history"></div>
</section>
```

Catatan: `__tab` diekspos dari IIFE lewat `window.__tab = showTab;`. Hindari inline handler bila CSP kelak ditambahkan — alternatif yang sama baiknya: pasang `addEventListener` pada `[data-tab]`; **pilih satu** dan pakai konsisten.

- [ ] **Step 4: CSS tambahan**

Tambahkan ke blok `<style>`:

```css
.tabs{display:flex;gap:4px}.tabs button{background:transparent;border:1px solid transparent;color:#cbd5e1;border-radius:8px;padding:7px 12px}
.tabs button.on{background:#1e293b;border-color:#334155;color:#fff}
.pgrid input[type=number]{width:110px;text-align:right}
.pgrid tr.dim{opacity:.5}
.pgrid .delta{color:var(--muted);font-size:12px}
.history{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 12px}
.history div{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}
.history div:last-child{border-bottom:0}
```

- [ ] **Step 5: Logika tab Harga**

```js
var priceState = { items: [], draft: {} };

function priceRowsHtml(items) {
  var groups = {};
  items.forEach(function (it) { (groups[it.product_name] = groups[it.product_name] || []).push(it); });
  return Object.keys(groups).map(function (name) {
    return '<div class="pcard"><h3>' + esc(name) + '</h3><table class="pgrid">' +
      '<thead><tr><th>Nominal (SKU)</th><th>Harga</th><th>Coret</th><th>Aktif</th><th>Terakhir</th></tr></thead><tbody>' +
      groups[name].map(function (it) {
        var d = priceState.draft[it.id] || it;
        var dim = (!it.active || !it.product_active) ? ' class="dim"' : '';
        var last = it.last_change ? rupiah(it.last_change.old_price) + " → " + rupiah(it.last_change.new_price) : "—";
        return '<tr' + dim + ' data-id="' + it.id + '">' +
          '<td>' + esc(it.label) + '<div class="delta">' + esc(it.sku) + '</div></td>' +
          '<td><input type="number" min="1" data-k="price" value="' + d.price + '" /></td>' +
          '<td><input type="number" min="0" data-k="compare_at" value="' + d.compare_at + '" /></td>' +
          '<td><input type="checkbox" data-k="active"' + (d.active ? " checked" : "") + ' /></td>' +
          '<td>' + last + '</td></tr>';
      }).join("") + '</tbody></table></div>';
  }).join("");
}

function priceIsDirty() {
  return Object.keys(priceState.draft).length > 0;
}
```

Input handler (delegasi pada `#p-list`): `input`/`change` → baca `data-id`, `data-k`; bandingkan dengan item asli; bila sama hapus dari `draft`, bila beda simpan ke `draft[id]`; perbarui `#p-save` (`disabled = !priceIsDirty()`, teks `Simpan (n)`).

Filter: `#p-q` mencocokkan `label`/`sku` (case-insensitive), `#p-cat` mencocokkan `category_name`, `#p-all` menyembunyikan `active === 0 || product_active === 0` bila tidak dicentang. Filter hanya menyaring baris yang dirender — draft tetap dipertahankan.

Simpan:

```js
function savePrices() {
  var items = Object.keys(priceState.draft).map(function (id) {
    var d = priceState.draft[id], body = { id: Number(id) };
    var orig = priceState.items.filter(function (x) { return x.id === Number(id); })[0];
    if (d.price !== orig.price) body.price = Math.round(d.price);
    if (d.compare_at !== orig.compare_at) body.compare_at = Math.round(d.compare_at);
    if (d.active !== orig.active) body.active = d.active ? 1 : 0;
    var note = $("p-note").value.trim();
    if (note) body.note = note;
    return body;
  });
  ...
}
```

Kirim satu `PATCH` (maks 50 item; bila `items.length > 50`, kirim berurutan dan laporkan per batch). Sukses: `priceState.draft = {}`, `$("p-note").value = ""`, isi ulang dari `data.items`, `loadHistory()`, `$("p-notice").textContent = data.changed + " harga diperbarui"`. Gagal: tampilkan `err.message` apa adanya, **jangan** kosongkan draft.

Peringatan nonaktif: saat pertama kali checkbox `active` dimatikan di sesi itu, tampilkan `confirm("Nominal ini akan hilang dari storefront dan tidak bisa dipesan. Lanjutkan?")`; bila ditolak, kembalikan checkbox.

Riwayat: `GET /api/admin/prices/history?limit=20` → baris `waktu · SKU · lama → baru · catatan`.

- [ ] **Step 6: Verifikasi manual di browser**

Setelah deploy (Task 6) buka `/admin`, login, pindah ke tab Harga:
- tabel terisi 310 baris, dikelompokkan per produk;
- ubah satu harga → tombol Simpan aktif berisi "Simpan (1)";
- simpan → toast "1 harga diperbarui", "Terakhir" berubah, riwayat bertambah;
- coba `compare_at` < `price` → pesan error server tampil, nilai harga tidak berubah di tabel setelah reload;
- pindah tab Pesanan → auto-refresh 15 detik tidak memuat ulang tabel harga.

- [ ] **Step 7: Commit**

```powershell
git add worker\store-worker.js
git commit -m "Admin UI: tab Harga dengan editor harga + riwayat audit"
```

---

## Task 6: Tes harga (+9)

**Files:**
- Modify: `tests\api.tests.ps1` (sisipkan setelah blok payment proof, sebelum ringkasan di akhir file)

**Interfaces:**
- Memakai: `Invoke-Api`, `Test-Case`, `Get-AdminHeaders`, `Assert-*`.

- [ ] **Step 1: Baca harness tes**

Baca `tests\api.tests.ps1` baris 1–125 (helper) dan satu contoh `Test-Case` yang memakai `Get-AdminHeaders` untuk meniru gaya `-Headers`/`-Method`/`-Body`.

- [ ] **Step 2: Tulis blok tes harga**

Tambahkan satu blok dengan nominal uji tetap (nominal pertama yang aktif). Pola wajib: baca nilai awal → `try { ... } finally { PATCH kembali ke nilai awal }`.

```powershell
# ---------------------------------------------------------------- harga
$script:PriceProbe = (Invoke-Api -Path "/api/admin/prices" -Headers (Get-AdminHeaders)).Json.items |
  Where-Object { $_.active -eq 1 } | Select-Object -First 1
$script:PriceStart = $script:PriceProbe.price
$script:PriceSlug  = $script:PriceProbe.product_slug

Test-Case "admin prices tanpa token ditolak" {
  $r = Invoke-Api -Path "/api/admin/prices" -Headers @{}
  Assert-Equal 401 $r.Status "harus 401 tanpa token"
}
```

Tes 2–9 mengikuti spec §7 dengan urutan: bentuk respons (310 item, field wajib) → naik harga lalu cek `/api/products/<slug>` + `/api/catalog` `min_price` → baris audit di `/history?denomination_id=` dengan `old_price`/`new_price` benar → `compare_at < price` 400 `invalid_compare_at` + harga tidak berubah → `price` 0 / negatif / desimal → 400 → `active: 0` lalu order baru 400 `invalid_denomination`, pulihkan `active: 1` → order A, ubah harga ke B, order B, order A tetap A lewat `/api/orders/<public_id>`, lalu cancel kedua order → 2 item di mana satu invalid → 400 dan **tidak ada** yang berubah.

Aturan tambahan untuk tes order (Tes 8):
- Simpan `$orderA`/`$orderB` di variabel skrip agar `finally` bisa `cancel` keduanya walau assertion gagal.
- Jangan mengandalkan nominal yang jatahnya mungkin diisi admin lain; setelah Task 12 stok habis → `409`. Bila terjadi, tes mencatat SKIP dengan pesan jelas (dan jumlah pass tidak bertambah) — bukan gagal.
- Verifikasi ulang `price` di akhir blok.

- [ ] **Step 3: Deploy dulu, baru jalankan**

Tes ini menembak API live, jadi harus ada versi worker + skema terbaru. Minta persetujuan pengguna, lalu:

```powershell
powershell -NoProfile -File "workers\deploy-store.ps1"
powershell -NoProfile -File "tests\api.tests.ps1"
```

Harapan: **39 passed, 0 failed** (30 lama + 9 baru).

- [ ] **Step 4: Commit**

```powershell
git add tests\api.tests.ps1
git commit -m "Tes API: manajemen harga admin (+9)"
```

---

# Bagian B — Jatah Stok

## Task 7: Skema stok + index `paid_at`

**Files:**
- Modify: `db\schema.sql` (kolom di `denominations` 30–40, tabel `stock_changes` + index `idx_orders_paid_at`)
- Modify: `workers\deploy-store.ps1` (`$migrations` 90–104; index tambahan setelah migrasi)

**Interfaces:**
- Produces: kolom `daily_quota`, `quota_date`, `quota_note`; tabel `stock_changes`; index `idx_orders_paid_at`.

- [ ] **Step 1: Tambah kolom ke `CREATE TABLE denominations`**

```sql
  daily_quota INTEGER NOT NULL DEFAULT 0,
  quota_date TEXT NOT NULL DEFAULT '',
  quota_note TEXT NOT NULL DEFAULT '',
```

Sisipkan setelah `active`, sebelum `sort`, dengan koma yang benar.

- [ ] **Step 2: Tambah tabel audit + index ke `db\schema.sql`**

```sql
-- Audit perubahan jatah. Tanpa FK: riwayat tetap ada walau nominal dihapus.
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
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(status, paid_at);
```

- [ ] **Step 3: Migrasi `ADD COLUMN` di `deploy-store.ps1`**

Di hashtable `$migrations`, tambahkan entri `denominations`:

```powershell
  denominations = [ordered]@{
    daily_quota = "INTEGER NOT NULL DEFAULT 0"
    quota_date  = "TEXT NOT NULL DEFAULT ''"
    quota_note  = "TEXT NOT NULL DEFAULT ''"
  }
```

Urutan key tidak penting; loop yang ada sudah idempoten lewat `PRAGMA table_info`.

- [ ] **Step 4: Pastikan index untuk tabel lama ikut dibuat**

Index `idx_orders_paid_at` ditambahkan ke `db\schema.sql` (langkah 2), sehingga loop `$schemaStatements` yang sudah ada akan menerapkannya pada DB lama. Verifikasi bahwa loop itu memakai `CREATE ... IF NOT EXISTS` saja (aman) dan tidak punya `DROP`.

- [ ] **Step 5: Commit**

```powershell
git add db\schema.sql workers\deploy-store.ps1
git commit -m "Skema: kolom jatah, tabel stock_changes, index orders(status, paid_at)"
```

---

## Task 8: Helper `held` / `remaining` / `available` (satu sumber)

**Files:**
- Modify: `worker\store-worker.js`: helper baru setelah `num()`/`nowIso()` (~63–70)

**Interfaces:**
- Produces:
  - `todayWib()` → `"YYYY-MM-DD"` (tanggal WIB sekarang)
  - `heldMap(env, ids?)` → `Promise<Map<number, number>>`
  - `stockView(row, held)` → `{ remaining, available, quota_stale }`
  - `heldWhere()` → fragmen SQL kanonik

- [ ] **Step 1: Tanggal WIB**

```js
function todayWib(date) {
  const d = date ? new Date(date) : new Date();
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Definisi `held` tunggal**

```js
// Definisi kanonik "menahan jatah": dibayar, atau masih menunggu bayar dan belum kedaluwarsa.
const HELD_SQL = "(o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > ?))";

async function heldMap(env, ids) {
  const now = nowIso();
  const filter = Array.isArray(ids) ? ` AND o.denomination_id IN (${ids.map(() => "?").join(",")})` : "";
  const args = [now].concat(Array.isArray(ids) ? ids : []);
  const rows = await dbAll(env,
    `SELECT o.denomination_id AS id, COUNT(*) AS n FROM orders o
      WHERE ${HELD_SQL}${filter} GROUP BY o.denomination_id`, args);
  const map = new Map();
  for (const r of rows) map.set(num(r.id), num(r.n));
  return map;
}
```

`HELD_SQL` memakai alias `o` — query lain yang memakai definisi ini **wajib** memberi alias `orders o`.

- [ ] **Step 3: Turunan sisa**

```js
function stockView(row, held) {
  const quota = num(row.daily_quota);
  const remaining = quota > 0 ? Math.max(0, quota - held) : null;
  return {
    remaining: remaining,
    available: quota === 0 || remaining > 0,
    quota_stale: quota > 0 && !!row.quota_date && row.quota_date !== todayWib(),
  };
}
```

`quota_date === ""` → belum pernah diisi → tidak ada penanda (spec §5.2).

- [ ] **Step 4: Commit**

```powershell
git add worker\store-worker.js
git commit -m "Helper held/remaining/available untuk jatah stok"
```

---

## Task 9: Endpoint stok admin (read + holders + PATCH)

**Files:**
- Modify: `worker\store-worker.js`: handler baru setelah `handleAdminPriceHistory`; rute di cabang admin

**Interfaces:**
- Produces:
  - `stockRows(env, dateStr)` → `{ date, summary, items }` (dipakai `GET` dan respons `PATCH`)
  - `GET /api/admin/stock?date=YYYY-MM-DD`
  - `GET /api/admin/stock/holders?denomination_id=&limit=50`
  - `PATCH /api/admin/stock` → `{ changed, date, summary, items }`

- [ ] **Step 1: Baris stok**

```js
async function stockRows(env, dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr : todayWib();
  const rows = await dbAll(env,
    `SELECT d.id, d.sku, d.label, d.active, d.daily_quota, d.quota_date, d.quota_note,
            p.slug AS product_slug, p.name AS product_name, p.active AS product_active,
            c.name AS category_name
       FROM denominations d
       JOIN products p ON p.id = d.product_id
       JOIN categories c ON c.id = p.category_id
      ORDER BY p.sort, d.sort, d.id`);
  const held = await heldMap(env);
  const soldRows = await dbAll(env,
    `SELECT denomination_id AS id, COUNT(*) AS n FROM orders
      WHERE status IN ('paid','fulfilled') AND paid_at IS NOT NULL
        AND substr(datetime(paid_at, '+7 hours'), 1, 10) = ?
      GROUP BY denomination_id`, [date]);
  const soldMap = new Map(soldRows.map((r) => [num(r.id), num(r.n)]));

  const items = rows.map((r) => {
    const h = held.get(num(r.id)) || 0;
    const v = stockView(r, h);
    return {
      id: num(r.id), sku: r.sku, label: r.label,
      product_slug: r.product_slug, product_name: r.product_name,
      category_name: r.category_name, product_active: num(r.product_active), active: num(r.active),
      daily_quota: num(r.daily_quota), quota_date: r.quota_date || "", quota_stale: v.quota_stale,
      quota_note: r.quota_note || "",
      held: h, remaining: v.remaining, available: v.available,
      sold: soldMap.get(num(r.id)) || 0,
    };
  });
  const live = items.filter((i) => i.active && i.product_active);
  return {
    date,
    summary: {
      sold: items.reduce((a, i) => a + i.sold, 0),
      held: live.reduce((a, i) => a + i.held, 0),
      out_of_stock: live.filter((i) => !i.available).length,
      quota_stale: items.filter((i) => i.quota_stale).length,
    },
    items,
  };
}
```

Catatan: `paid_at` disimpan ISO UTC; `datetime(paid_at, '+7 hours')` menggeser ke WIB sebelum `substr(...,1,10)`.

- [ ] **Step 2: Handler baca & holders**

```js
async function handleAdminStock(env, url) {
  return json(await stockRows(env, url.searchParams.get("date")));
}

async function handleAdminStockHolders(env, url) {
  const denom = num(url.searchParams.get("denomination_id"));
  if (!denom) throw new HttpError(400, "invalid_denomination", "id nominal tidak valid");
  const limit = Math.min(200, Math.max(1, num(url.searchParams.get("limit")) || 50));
  const rows = await dbAll(env,
    `SELECT o.public_id, o.status, o.player_id, o.total, o.created_at, o.expires_at, o.paid_at
       FROM orders o WHERE ${HELD_SQL} AND o.denomination_id = ?
      ORDER BY o.id DESC LIMIT ?`, [nowIso(), denom, limit]);
  return json({ items: rows });
}
```

- [ ] **Step 3: Validator & handler tulis**

```js
function stockPatchItem(raw) {
  const id = num(raw && raw.id);
  if (!id) throw new HttpError(400, "invalid_denomination", "id nominal tidak valid");
  const item = { id: id };
  if (raw.daily_quota !== undefined) {
    const q = raw.daily_quota;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 0 || q > 100000) {
      throw new HttpError(400, "invalid_quota", "jatah harus bilangan bulat 0 sampai 100000");
    }
    item.daily_quota = q;
  }
  if (raw.note !== undefined) {
    const text = String(raw.note);
    if (text.trim().length > 200) throw new HttpError(400, "invalid_note", "catatan maksimal 200 karakter");
    item.note = sanitizeText(text, 200);
  }
  return item;
}

async function handleAdminStockUpdate(env, request) {
  const body = await readJson(request);
  const rawItems = Array.isArray(body && body.items) ? body.items : [];
  if (!rawItems.length) throw new HttpError(400, "invalid_items", "tidak ada item yang dikirim");
  if (rawItems.length > 100) throw new HttpError(400, "too_many_items", "maksimal 100 jatah per permintaan");

  const items = rawItems.map(stockPatchItem);
  const ids = items.map((i) => i.id);
  const current = await dbAll(env,
    `SELECT id, sku, label, daily_quota, quota_date, quota_note FROM denominations
      WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  const byId = new Map(current.map((r) => [num(r.id), r]));
  for (const it of items) {
    if (!byId.has(it.id)) throw new HttpError(400, "invalid_denomination", "nominal " + it.id + " tidak ditemukan");
  }

  const today = todayWib();
  const changedAt = nowIso();
  const statements = [];
  let changed = 0;
  for (const it of items) {
    const row = byId.get(it.id);
    const oldQuota = num(row.daily_quota);
    const oldNote = row.quota_note || "";
    const newQuota = it.daily_quota !== undefined ? it.daily_quota : oldQuota;
    const newNote = it.note !== undefined ? it.note : oldNote;
    if (newQuota === oldQuota && newNote === oldNote) continue;
    changed++;
    const quotaDate = newQuota !== oldQuota ? today : (row.quota_date || "");
    statements.push(env.DB.prepare(
      "UPDATE denominations SET daily_quota = ?, quota_note = ?, quota_date = ? WHERE id = ?"
    ).bind(newQuota, newNote, quotaDate, it.id));
    statements.push(env.DB.prepare(
      `INSERT INTO stock_changes (denomination_id, sku, label, old_quota, new_quota, old_note, new_note, quota_date, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(it.id, row.sku, row.label, oldQuota, newQuota, oldNote, newNote, quotaDate, changedAt));
  }
  if (statements.length) await env.DB.batch(statements);
  const result = await stockRows(env, null);
  return json({ changed, date: result.date, summary: result.summary, items: result.items });
}
```

Edit catatan-saja **tidak** membarui `quota_date` (spec §5.3) — sudah terlihat dari `quotaDate` di atas.

- [ ] **Step 4: Rute**

```js
if (method === "GET" && path === "/api/admin/stock") return handleAdminStock(env, url);
if (method === "GET" && path === "/api/admin/stock/holders") return handleAdminStockHolders(env, url);
if (method === "PATCH" && path === "/api/admin/stock") return handleAdminStockUpdate(env, request);
```

- [ ] **Step 5: Commit**

```powershell
git add worker\store-worker.js
git commit -m "API admin: GET/PATCH /api/admin/stock dan daftar pemegang pesanan"
```

---

## Task 10: Tolak order untuk nominal habis (`409 out_of_stock`)

**Files:**
- Modify: `worker\store-worker.js`: `handleCreateOrder` (~557–639)

**Interfaces:**
- Memakai: `stockView`, `heldMap` (Task 8).
- Produces: error `409 out_of_stock` sebelum QR dibuat.

- [ ] **Step 1: Baca `handleCreateOrder` penuh**

Baca baris 557–639 dan tandai: select item (~570–577), validasi (~578–580), `validateTarget` (~580), subtotal/fee/expires (~582–588), QR (~601–607), insert (~609–634).

- [ ] **Step 2: Tambahkan kolom jatah ke select item**

Tambahkan `d.daily_quota, d.quota_date` ke daftar kolom (jangan ubah `WHERE p.active = 1 AND d.active = 1`).

- [ ] **Step 3: Cek stok sebelum membuat QR**

Setelah `validateTarget(...)` dan **sebelum** perhitungan QR:

```js
const quota = num(item.daily_quota);
if (quota > 0) {
  const held = (await heldMap(env, [num(item.id)])).get(num(item.id)) || 0;
  if (!stockView(item, held).available) {
    throw new HttpError(409, "out_of_stock", "nominal ini sedang habis, silakan pilih nominal lain");
  }
}
```

Pendekatan `heldMap` + `stockView` (bukan SQL terpisah) memastikan definisi `held` identik dengan tab admin. Nominal tanpa batas (`daily_quota = 0`) tidak melakukan query tambahan.

- [ ] **Step 4: Commit**

```powershell
git add worker\store-worker.js
git commit -m "Tolak order 409 out_of_stock untuk nominal yang jatahnya habis"
```

---

## Task 11: `remaining`/`available` di produk, `in_stock` di katalog

**Files:**
- Modify: `worker\store-worker.js`: `handleProduct` (~524–553), `handleCatalog` (~486–522), `productJson` (~268–286)

**Interfaces:**
- Produces: `/api/products/<slug>` item `{ ..., remaining, available }`; `/api/catalog` produk `{ ..., in_stock, available_count, min_price, denomination_count }`.

- [ ] **Step 1: `handleProduct` — sertakan jatah**

Tambahkan `d.daily_quota, d.quota_date` ke select nominal, ambil `heldMap(env, ids)` sekali untuk semua nominal produk, lalu petakan tiap nominal:

```js
.map((d) => {
  const v = stockView(d, held.get(num(d.id)) || 0);
  return { id: num(d.id), label: d.label, price: num(d.price), compare_at: num(d.compare_at),
           sku: d.sku, remaining: v.remaining, available: v.available };
})
```

Jangan hapus field yang sudah ada (`id`, `label`, `price`, `compare_at`, `sku`).

- [ ] **Step 2: `handleCatalog` — hitung `in_stock`/`available_count`/`min_price` dari nominal tersedia**

Ganti query harga (490–494) dengan satu query nominal aktif yang menyertakan jatah:

```sql
SELECT d.product_id, d.price, d.daily_quota
  FROM denominations d WHERE d.active = 1
```

Hitung `held` sekali untuk semua id lewat `heldMap(env)`. Lalu per produk:

```js
const live = rows.filter((r) => r.product_id === p.id);
const avail = live.filter((r) => stockView(r, held.get(num(r.id)) || 0).available);
out.available_count = avail.length;
out.in_stock = avail.length > 0;
out.denomination_count = avail.length;
out.min_price = avail.length
  ? Math.min.apply(null, avail.map((r) => num(r.price)))
  : (live.length ? Math.min.apply(null, live.map((r) => num(r.price))) : 0);
```

- [ ] **Step 3: `productJson` — jangan menimpa angka baru**

`productJson` (268–286) dipakai `handleCatalog` saja. Tambahkan dua field dengan nama kolom yang **sama** dengan yang dihasilkan `handleCatalog`:

```js
    in_stock: row.in_stock === undefined ? true : !!row.in_stock,
    available_count: row.available_count || 0,
```

`min_price`/`denomination_count` tetap `row.x || 0`. `handleCatalog` mengoper `in_stock` dan `available_count` lewat spread `{ ...row, ... }` seperti `min_price` sekarang, jadi tidak ada jalur lain yang perlu diubah. Default `true` penting: produk yang belum menghitung stok tidak boleh tiba-tiba tampak habis di storefront.

- [ ] **Step 4: Commit**

```powershell
git add worker\store-worker.js
git commit -m "Katalog & produk: remaining, available, in_stock, available_count"
```

---

## Task 12: Storefront — "Habis" + cache-buster

**Files:**
- Modify: `store.js` (`renderDenom` ~509, alur checkout ~597–639)
- Modify: `store.css`
- Modify: `index.html` (baris 14 & 167)

**Interfaces:**
- Memakai: `available`, `remaining`, `in_stock`, `available_count` dari Task 11.

- [ ] **Step 1: `renderDenom` — tandai habis**

Pada pembuatan tombol nominal:

```js
var out = d.available === false;
buttonClass += out ? " is-out" : "";
if (out) btn.setAttribute("aria-disabled", "true");
```

Label harga diganti `Habis` bila `out`. Nominal tetap dirender (tidak disembunyikan). Jangan pakai atribut `disabled` pada elemen yang dibangun sebagai `div`/`label` — tangani klik di handler:

```js
if (out) return; // jangan pilih nominal habis
```

- [ ] **Step 2: Pesan `409`**

Di blok catch alur checkout, tampilkan `err.message` apa adanya bila `status === 409` (server sudah mengirim pesan Indonesia), dan panggil ulang pemuatan produk agar status terbaru muncul.

- [ ] **Step 3: Lencana produk di katalog**

Bila `product.in_stock === false`, render `<span class="card-badge">Habis</span>` pada kartu dan teks harga "Mulai dari" memakai `min_price` (bila `available_count === 0`, tampilkan harga tanpa embel-embel "Mulai dari" dan tanpa tombol beli langsung).

- [ ] **Step 4: CSS**

```css
.is-out{opacity:.55;cursor:not-allowed}
.is-out .denom-price{text-decoration:line-through}
.card-badge{position:absolute;top:10px;right:10px;background:#fee2e2;color:#b91c1c;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
```

Sesuaikan nama kelas dengan yang benar-benar dipakai `store.js` saat render (baca dulu).

- [ ] **Step 5: Cache-buster**

Di `index.html`, ganti `?v=20261116b` menjadi `?v=20261117a` pada baris 14 dan 167.

- [ ] **Step 6: Commit**

```powershell
git add store.js store.css index.html
git commit -m "Storefront: nominal habis tidak bisa dipilih, lencana Habis, cache-buster"
```

---

## Task 13: UI admin — tab "Stok" + panel pemegang pesanan

**Files:**
- Modify: `worker\store-worker.js` — `adminPage()`: panel `data-panel="stock"` + fungsi `loadStock()`/`saveStock()` (placeholder `loadStock` sudah dibuat di Task 5 Step 2)

**Interfaces:**
- Memakai: `GET /api/admin/stock`, `PATCH /api/admin/stock`, `GET /api/admin/stock/holders?denomination_id=`.
- Produces: tab "Stok" (tombol `data-tab="stock"` sudah ada di header sejak Task 5); `stockState`, `stockView`-HTML, `holdersPanel(id)`.

**Interfaces:**
- Memakai: `GET /api/admin/stock`, `PATCH /api/admin/stock`.
- Produces: tab "Stok" (tombol `data-tab="stock"` sudah ada di header sejak Task 5); `stockState`, `stockRowsHtml()`, `loadStock()`, `saveStock()`, `holdersPanel(id)`.

- [ ] **Step 1: Markup panel di `showDashboard()`**

Sisipkan **setelah** `<section data-panel="prices" hidden>…</section>` (dari Task 5):

```html
<section data-panel="stock" hidden>
  <div class="filters">
    <input id="s-q" placeholder="Cari nominal / SKU" style="min-width:220px" />
    <select id="s-cat"><option value="">Semua kategori</option></select>
    <select id="s-state">
      <option value="">Semua status</option>
      <option value="out">Habis</option>
      <option value="stale">Perlu isi ulang</option>
      <option value="unlimited">Tanpa batas</option>
    </select>
    <label><input type="checkbox" id="s-all" /> tampilkan nonaktif</label>
    <span style="flex:1"></span>
    <span class="muted" id="s-date"></span>
    <button id="s-save" class="primary" disabled>Simpan</button>
  </div>
  <p class="notice" id="s-notice"></p>
  <div id="s-list"></div>
  <div id="s-holders" hidden></div>
</section>
```

- [ ] **Step 2: CSS tambahan**

Tambahkan ke blok `<style>` (dekat aturan `.pgrid` dari Task 5):

```css
.sgrid input[type=number]{width:90px;text-align:right}
.sgrid input.note{width:100%;margin-top:2px;padding:2px 6px;font-size:11px}
.sgrid tr.dim{opacity:.5}
.sgrid tr.out td{color:#f87171}
.sgrid .sub{color:var(--muted);font-size:12px}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600}
.badge.ok{background:#052e1a;color:#4ade80}
.badge.warn{background:#3f2d05;color:#fbbf24}
.badge.bad{background:#3f0d0d;color:#f87171}
.badge.mute{background:#1e293b;color:#94a3b8}
.hp{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-top:12px}
.hp table{width:100%;border-collapse:collapse;font-size:13px}
.hp td,.hp th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left}
```

- [ ] **Step 3: Logika stok**

```js
var stockState = { items: [], draft: {} };

function stockBadge(it) {
  if (it.daily_quota === 0) return '<span class="badge mute">Tanpa batas</span>';
  if (!it.available) return '<span class="badge bad">Habis</span>';
  if (it.quota_stale) return '<span class="badge warn">Perlu isi ulang</span>';
  return '<span class="badge ok">Tersedia</span>';
}

function stockRowsHtml() {
  var q = $("s-q").value.trim().toLowerCase();
  var cat = $("s-cat").value;
  var st = $("s-state").value;
  var showAll = $("s-all").checked;
  var groups = {};
  stockState.items.forEach(function (it) {
    if (!showAll && (!it.active || !it.product_active)) return;
    if (q && (it.label + " " + it.sku).toLowerCase().indexOf(q) < 0) return;
    if (cat && it.category_name !== cat) return;
    if (st === "out" && it.available) return;
    if (st === "stale" && !it.quota_stale) return;
    if (st === "unlimited" && it.daily_quota !== 0) return;
    (groups[it.product_name] = groups[it.product_name] || []).push(it);
  });
  var names = Object.keys(groups);
  if (!names.length) return '<p class="notice">Tidak ada nominal yang cocok.</p>';
  return names.map(function (name) {
    return '<div class="pcard"><h3>' + esc(name) + '</h3><table class="sgrid">' +
      '<thead><tr><th>Nominal (SKU)</th><th>Jatah</th><th>Ditahan</th><th>Sisa</th><th>Terjual</th><th>Status</th></tr></thead><tbody>' +
      groups[name].map(function (it) {
        var d = stockState.draft[it.id] || it;
        var cls = [];
        if (!it.active || !it.product_active) cls.push("dim");
        if (it.daily_quota > 0 && !it.available) cls.push("out");
        var quota = '<input type="number" min="0" max="100000" data-k="daily_quota" value="' + d.daily_quota + '" />';
        var sisa = it.remaining === null ? "∞" : it.remaining;
        return '<tr' + (cls.length ? ' class="' + cls.join(" ") + '"' : "") + ' data-id="' + it.id + '">' +
          '<td>' + esc(it.label) + '<div class="sub">' + esc(it.sku) + '</div>' +
          '<input class="sub note" data-k="note" maxlength="200" placeholder="catatan"' +
          ' value="' + esc(d.note === undefined ? it.quota_note : d.note) + '" /></td>' +
          '<td>' + quota + '</td>' +
          '<td>' + it.held + '</td><td>' + sisa + '</td><td>' + it.sold + '</td>' +
          '<td>' + stockBadge(it) +
          (it.held > 0 ? ' <a href="#" data-holders="' + it.id + '">lihat</a>' : "") +
          '</td></tr>';
      }).join("") + '</tbody></table></div>';
  }).join("");
}

function stockDirtyCount() { return Object.keys(stockState.draft).length; }

function loadStock() {
  return api("/api/admin/stock").then(function (data) {
    stockState.items = data.items;
    stockState.draft = {};
    $("s-date").textContent = "Terjual dihitung untuk " + data.date + " (WIB)";
    var cats = {};
    data.items.forEach(function (it) { cats[it.category_name] = 1; });
    $("s-cat").innerHTML = '<option value="">Semua kategori</option>' +
      Object.keys(cats).sort().map(function (c) { return '<option>' + esc(c) + '</option>'; }).join("");
    $("s-list").innerHTML = stockRowsHtml();
    updateSaveButton();
    return data;
  });
}

function updateSaveButton() {
  var n = stockDirtyCount();
  var btn = $("s-save");
  btn.disabled = n === 0;
  btn.textContent = n ? "Simpan (" + n + ")" : "Simpan";
}

function saveStock() {
  var ids = Object.keys(stockState.draft);
  var bodies = ids.map(function (id) {
    var d = stockState.draft[id];
    var orig = stockState.items.filter(function (x) { return x.id === Number(id); })[0];
    var body = { id: Number(id) };
    if (d.daily_quota !== orig.daily_quota) body.daily_quota = Math.round(d.daily_quota);
    if (d.note !== undefined && d.note !== orig.quota_note) body.note = d.note;
    return body;
  });
  // server membatasi 100 item per PATCH: kirim berurutan, laporkan per batch
  var batches = [];
  for (var i = 0; i < bodies.length; i += 100) batches.push(bodies.slice(i, i + 100));
  var total = 0;
  var failed = 0;
  var chain = Promise.resolve();
  batches.forEach(function (b) {
    chain = chain.then(function () {
      return api("/api/admin/stock", "PATCH", { items: b }).then(
        function (data) { total += data.changed; },
        function (err) { failed += b.length; $("s-notice").textContent = err.message; }
      );
    });
  });
  return chain.then(function () {
    $("s-notice").textContent = failed
      ? total + " jatah tersimpan, " + failed + " gagal (lihat pesan di atas)"
      : total + " jatah diperbarui";
    return loadStock();
  });
}
```

Catatan perilaku (sesuai spec §5.3):
- `daily_quota = 0` berarti **tanpa batas** — kolom Jatah **selalu** berupa `<input type=number>` (nilai `0` = tanpa batas), sedangkan status tanpa batas ditandai badge "Tanpa batas" dan Sisa `∞`. Satu jalur UI saja, tidak ada teks yang bisa diklik.
- Editor `note` per baris: `<input class="sub note" data-k="note">` di sel "Nominal (SKU)" (placeholder "catatan"), hanya dikirim bila berubah. `""` menghapus catatan. Handler `input` yang sama menulis ke `draft[id].note`; **jangan** me-render ulang `#s-list` di handler itu (fokus kursor akan hilang) — cukup `updateSaveButton()`.
- Nominal yang jatahnya habis tetap tampil (kelas `out`) agar admin tahu apa yang harus diisi.
- `stockBadge()` memakai `it` (data server), bukan `d` (draft), sehingga badge baru berubah setelah simpan + muat ulang — itu memang yang diinginkan.

- [ ] **Step 4: Panel pemegang pesanan**

```js
function holdersPanel(id) {
  var box = $("s-holders");
  box.hidden = false;
  box.innerHTML = '<div class="hp">Memuat…</div>';
  return api("/api/admin/stock/holders?denomination_id=" + id + "&limit=50").then(function (data) {
    var it = stockState.items.filter(function (x) { return x.id === id; })[0] || {};
    box.innerHTML = '<div class="hp"><b>' + esc(it.label || id) + '</b> — ' + data.items.length +
      ' pesanan menahan jatah' +
      '<table><thead><tr><th>ID</th><th>Status</th><th>Tujuan</th><th>Total</th><th>Dibuat</th><th>Kedaluwarsa</th></tr></thead><tbody>' +
      (data.items.length ? data.items.map(function (o) {
        return '<tr><td>' + esc(o.public_id) + '</td><td>' + esc(label(o.status)) + '</td><td>' +
          esc(o.player_id || "—") + '</td><td>' + rupiah(o.total) + '</td><td>' +
          esc(when(o.created_at)) + '</td><td>' +
          esc(when(o.expires_at)) + '</td></tr>';
      }).join("") : '<tr><td colspan="6">Tidak ada pesanan berjalan.</td></tr>') +
      '</tbody></table></div>';
  });
}
```

Pasang listener (delegasi, sekali saat dashboard tampil) pada `#s-list`:

```js
$("s-list").addEventListener("click", function (e) {
  var a = e.target.closest("[data-holders]");
  if (!a) return;
  e.preventDefault();
  holdersPanel(Number(a.getAttribute("data-holders")));
});
$("s-list").addEventListener("input", function (e) {
  var tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  var id = Number(tr.getAttribute("data-id"));
  var k = e.target.getAttribute("data-k");
  if (!k) return;
  var orig = stockState.items.filter(function (x) { return x.id === id; })[0];
  var next = k === "daily_quota" ? Math.max(0, Math.round(Number(e.target.value) || 0)) : e.target.value;
  var base = stockState.draft[id] || { id: id, daily_quota: orig.daily_quota, note: orig.quota_note };
  base[k === "daily_quota" ? "daily_quota" : "note"] = next;
  var sameQuota = base.daily_quota === orig.daily_quota;
  var sameNote = (base.note === undefined ? orig.quota_note : base.note) === orig.quota_note;
  if (sameQuota && sameNote) delete stockState.draft[id];
  else stockState.draft[id] = base;
  updateSaveButton();
});
$("s-q").addEventListener("input", function () { $("s-list").innerHTML = stockRowsHtml(); });
["s-cat", "s-state"].forEach(function (id) {
  $(id).addEventListener("change", function () { $("s-list").innerHTML = stockRowsHtml(); });
});
$("s-all").addEventListener("change", function () { $("s-list").innerHTML = stockRowsHtml(); });
$("s-save").addEventListener("click", saveStock);
```

Listener ini dipasang **sekali** di `showDashboard()` setelah `document.body.innerHTML` diganti (sebelum `showTab(tab)`).

- [ ] **Step 5: Verifikasi manual di browser**

Setelah deploy (Task 14):
- tab Stok menampilkan 310 nominal dikelompokkan per produk, kolom Jatah/Ditahan/Sisa/Terjual/Status terisi;
- semua nominal tanpa batas menampilkan badge "Tanpa batas" dan Sisa ∞;
- ubah satu jatah menjadi 1 → Simpan (1) → tersimpan, badge jadi "Tersedia", riwayat `stock_changes` bertambah (cek lewat D1 atau ulang tab);
- klik "lihat" pada nominal yang punya `held` → panel pemegang pesanan tampil;
- filter "Habis" hanya menampilkan nominal yang tidak tersedia;
- uncheck "tampilkan nonaktif" → nominal nonaktif hilang dari daftar.

- [ ] **Step 6: Commit**

```powershell
git add worker\store-worker.js
git commit -m "Admin UI: tab Stok dengan editor jatah + panel pemegang pesanan"
```

---

## Task 14: Tes stok (+10 API, +2 storefront), README, deploy

**Files:**
- Modify: `tests\api.tests.ps1` (blok stok setelah blok harga Task 6)
- Modify: `tests\storefront.tests.ps1`
- Modify: `README.md`
- Deploy: `workers\deploy-store.ps1` (**dengan persetujuan pengguna**)

**Interfaces:**
- Memakai: `Invoke-Api`, `Test-Case`, `Get-AdminHeaders`, helper harga Task 6 (`$script:PriceProbe`, `$script:PriceSlug`).

- [ ] **Step 1: Pilih nominal uji & simpan nilai awal**

Nominal uji stok = nominal yang sama dengan `$script:PriceProbe` (aktif, punya produk aktif). Simpan:

```powershell
$script:StockStart = (Invoke-Api -Path "/api/admin/stock" -Headers (Get-AdminHeaders)).Json.items |
  Where-Object { $_.id -eq $script:PriceProbe.id } | Select-Object -First 1
```

`$script:StockStart.daily_quota` / `.quota_note` / `.quota_date` dipakai di `finally` untuk memulihkan persis.

- [ ] **Step 2: Tulis 10 tes stok**

Urutan **persis** mengikuti spec stok §7 (11 butir; butir 11 = 2 tes statis di Step 3, jadi 10 tes API). Setiap tes memakai nominal yang sama dan **selalu** memulihkan jatah awal + menutup order uji.

1. `GET /api/admin/stock` tanpa token → 401.
2. Dengan token → 200; `items.Count -eq 310` (termasuk nonaktif); tiap item punya `daily_quota`, `quota_date`, `quota_stale`, `held`, `remaining`, `available`; `summary` punya `sold`, `held`, `out_of_stock`, `quota_stale`.
3. `PATCH` jatah (held = 0) → `remaining` = jatah, `available: true`; `/api/products/<slug>` memberi `remaining`/`available` yang sama dan `compare_at` **tidak** berubah.
4. Jatah = 2 + 2 order `pending` → order ke-3 `409 out_of_stock`; `/api/products/<slug>` → nominal `available: false`; `/api/catalog` → produk `in_stock: false` bila nominal itu satu-satunya yang tersedia.
5. Jatah = 1 + 1 order `pending` → `POST /api/admin/orders/<public_id>` aksi `cancel` → nominal kembali `available: true` (pesanan `cancelled` tidak menahan).
6. Jatah = 1 + 1 order `pending` → `PATCH { daily_quota: 0 }` → `available: true`, `remaining: null`, dan pembelian tidak lagi ditolak.
7. `daily_quota` negatif / desimal / > 100000 / bukan angka → 400 `invalid_quota`; request berisi satu item valid + satu item tidak valid → tidak ada baris yang berubah (all-or-nothing).
8. `PATCH` jatah menulis `stock_changes` dengan `old_quota`/`new_quota` benar; `PATCH` dengan jatah **dan** catatan yang sama persis → `changed = 0` (tidak menambah baris); `PATCH {"note":"…"}` saja → mencatat `old_note`/`new_note` dan **tidak** membarui `quota_date`.
9. Order `pending` yang `expires_at`-nya sudah lewat tidak menahan stok — tidak praktis ditunggu di tes live, jadi periksa **invarian** pada `/api/admin/stock/holders`: setiap pesanan yang dikembalikan berstatus `paid` atau (`pending` dengan `expires_at` > sekarang), dan tidak ada `cancelled`/`expired`/`fulfilled`.
10. `GET /api/admin/stock/holders?denomination_id=<uji>` mengembalikan pesanan uji yang menahan dan **tidak** mengembalikan pesanan `cancelled`; `denomination_id` kosong → 400 `invalid_denomination`.

Pola wajib:

```powershell
Test-Case "jatah 0 berarti tanpa batas" {
  try {
    $null = Invoke-Api -Path "/api/admin/stock" -Method "PATCH" -Headers (Get-AdminHeaders) `
      -Body @{ items = @(@{ id = $script:ProbeId; daily_quota = 0 }) }
    $r = Invoke-Api -Path "/api/admin/stock" -Headers (Get-AdminHeaders)
    $it = $r.Json.items | Where-Object { $_.id -eq $script:ProbeId } | Select-Object -First 1
    Assert-Equal $null $it.remaining "tanpa batas harus null"
    Assert-Equal $true $it.available "tanpa batas selalu tersedia"
  } finally { Restore-Stock }
}
```

`Restore-Stock` didefinisikan sekali di blok tes:

```powershell
function Restore-Stock {
  $null = Invoke-Api -Path "/api/admin/stock" -Method "PATCH" -Headers (Get-AdminHeaders) `
    -Body @{ items = @(@{ id = $script:StockStart.id; daily_quota = $script:StockStart.daily_quota; note = $script:StockStart.quota_note }) }
}
```

Order uji yang tersisa (status `pending`) **wajib** dibatalkan lewat `POST /api/admin/orders/<public_id>` body `action = "cancel"` di blok `finally` supaya `held` kembali seperti semula — jalankan `cancel` **sebelum** `Restore-Stock` bila urutannya berpengaruh, dan jangan menghapus baris `orders` langsung (endpoint admin tidak menyediakannya).

- [ ] **Step 3: Dua tes statis storefront**

Di `tests\storefront.tests.ps1`, tambahkan:

```powershell
Test-Case "store.js mengenali status out_of_stock" {
  $js = Get-Content -Path (Join-Path $script:Root "store.js") -Raw
  Assert-True ($js -match "out_of_stock") "store.js harus menangani 409 out_of_stock"
}

Test-Case "store.css punya gaya .is-out" {
  $css = Get-Content -Path (Join-Path $script:Root "store.css") -Raw
  Assert-True ($css -match "\.is-out") "store.css harus punya aturan .is-out"
}
```

Sesuaikan nama helper (`Get-Content`/`Assert-True`) dengan yang benar-benar dipakai file itu — baca dulu polanya.

- [ ] **Step 4: README**

Tambahkan di bagian seed/deploy:

```markdown
### Seed tidak menimpa harga & jatah

`db\build-seed.ps1` sekarang menghasilkan seed gaya **upsert**: produk dan nominal
diperbarui (nama, ikon, kategori, urutan), tetapi `price`, `compare_at`, `active`,
`daily_quota`, `quota_date`, dan `quota_note` **dibiarkan** apa adanya. Jadi deploy
ulang aman setelah Anda mengubah harga/jatah dari `/admin`.

Bila benar-benar ingin kembali ke harga katalog di `db\catalog.json`:

    powershell -NoProfile -File "db\build-seed.ps1" -ResetPrices

`-ResetPrices` menghapus semua produk & nominal lalu memasukkannya ulang dari katalog.
Riwayat audit (`price_changes`, `stock_changes`) **tidak** ikut terhapus, dan
**jatah stok ikut hilang** (kembali 0 = tanpa batas).
```

- [ ] **Step 5: Deploy — minta persetujuan dulu**

Tampilkan ringkasan ke pengguna: berkas yang berubah, 13 tes baru, dan peringatan bahwa `deploy-store.ps1` menerapkan skema + seed ke DB produksi (upsert, harga/jatah aman). **Tunggu jawaban "ya".** Setelah disetujui:

```powershell
powershell -NoProfile -File "workers\deploy-store.ps1"
```

- [ ] **Step 6: Jalankan kedua suite**

```powershell
powershell -NoProfile -File "tests\api.tests.ps1"
powershell -NoProfile -File "tests\storefront.tests.ps1"
```

Harapan: API **49 passed / 0 failed** (30 lama + 9 harga + 10 stok); storefront **10 passed / 0 failed** (8 lama + 2 baru). Bila ada yang gagal, perbaiki kode (bukan tes) kecuali tes memang salah tulis.

- [ ] **Step 7: Verifikasi DB bersih setelah tes**

`deploy-store.ps1` **tidak** punya parameter `-Query`; ia hanya punya `-SkipSeed`. Jalankan pemeriksaan lewat wrangler langsung (nama DB & flag dari `workers\deploy-store.ps1`):

```powershell
npx wrangler d1 execute gadzstore --remote --command "SELECT (SELECT COUNT(*) FROM orders) AS o, (SELECT COUNT(*) FROM order_events) AS e, (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM denominations) AS d"
```

Bila wrangler tidak tersedia di mesin ini, pakai `Invoke-D1` dari `workers\deploy-store.ps1` dengan menyalin blok fungsinya ke sesi PowerShell, atau lewat HTTP API D1 (`POST /accounts/<id>/d1/database/<db>/query`) memakai kredensial di `.env`.

Harapan: `o = 0`, `e = 0`, `p = 73`, `d = 310`.

- [ ] **Step 8: Cache-buster sudah dinaikkan di Task 12** — pastikan `?v=20261117a` pada `index.html` baris 14 & 167, lalu cek hard-reload storefront di browser.

- [ ] **Step 9: Commit**

```powershell
git add tests\api.tests.ps1 tests\storefront.tests.ps1 README.md
git commit -m "Tes stok (+10 API, +2 storefront) dan dokumentasi seed upsert"
```

---

## Ringkasan Hasil yang Diharapkan

| Area | Endpoint / berkas | Hasil |
|---|---|---|
| Harga | `PATCH /api/admin/prices` | ubah harga, harga coret, aktif; audit `price_changes`; all-or-nothing |
| Harga | tab "Harga" | tabel per produk, draft + "Simpan (n)", riwayat perubahan |
| Stok | `PATCH /api/admin/stock` | jatah harian + catatan; audit `stock_changes` |
| Stok | tab "Stok" | Jatah / Ditahan / Sisa / Terjual / Status + panel pemegang pesanan |
| Storefront | `/api/products/<slug>`, `/api/catalog` | `remaining`, `available`, `in_stock`, `available_count` |
| Storefront | `store.js`, `store.css` | nominal habis tidak bisa dipilih + lencana "Habis" |
| Order | `POST /api/orders` | `409 out_of_stock` sebelum QR dibuat |
| Operasi | `db\build-seed.ps1`, `deploy-store.ps1` | seed upsert, tidak menimpa harga/jatah |
| Tes | 2 suite | 49 API + 10 storefront, semua lulus |
