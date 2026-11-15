# TheGadz Store

An Indonesian game top-up storefront inspired by modern top-up sites: a light green storefront, category rails, search, product pages, QRIS checkout, order tracking, and a token-protected admin console.

**Live store:** https://thegadz.github.io/
**API:** https://gadzstore-api.blueicespeed.workers.dev
**Admin:** https://gadzstore-api.blueicespeed.workers.dev/admin

## What works

- 5 categories, 24 products, ~100 denominations seeded in D1.
- Catalog, search, category pages, and product detail from the live API.
- Server-priced orders with player ID / zone / phone / account validation.
- QRIS checkout with QR rendering, 15-minute countdown, and automatic status refresh.
- Public order tracking by order ID, plus recent orders saved on the device.
- Admin console for marking paid, fulfilling with a supplier reference, cancelling, and filtering orders.
- Signed QRIS webhook and static-QRIS-to-dynamic-amount conversion with CRC16 validation.
- Demo mode for exercising the full flow before a real gateway is connected.

## Payment and fulfillment status

Payments are **QRIS-only**. The current deployment runs in **demo QRIS mode**: the Worker generates a per-order demo payload and exposes a demo-paid endpoint, because a real merchant/gateway account has not been provided yet. Set `DEMO_MODE=0` and supply a valid `QRIS_STATIC_PAYLOAD` or gateway integration before accepting real money.

Fulfillment is **manual** through `/admin`. The `supplier_ref` field records the supplier transaction; an automatic supplier adapter can be added later.

## Architecture

```text
GitHub Pages (static SPA)
  index.html / store.css / store.js
        │  fetch JSON, no build step
        ▼
Cloudflare Worker  ←  QRIS gateway webhook (HMAC-SHA256)
  /api/*  /admin
        │
        ▼
Cloudflare D1 (SQLite)
  categories · products · denominations · orders · order_events
```

- Frontend: vanilla HTML/CSS/JS, hash routing, vendored `qrcode-generator` 1.4.4.
- Backend: single ES-module Worker with D1 bindings and secrets.
- Money: integer rupiah, fee computed server-side (`QRIS_FEE_PERCENT`, default 0.7%).
- Orders expire after `ORDER_TTL_SECONDS` (default 900 seconds).

## Routes

| Route | Purpose |
| --- | --- |
| `#/` | Storefront home with category rails |
| `#/kategori/:slug` | Category listing |
| `#/produk/:slug` | Product detail and checkout form |
| `#/pesanan/:id` | Invoice, QRIS payment, status timeline |
| `#/lacak` | Order tracking and recent orders |
| `#/cari?q=...` | Search results |

## Project layout

```text
index.html              Storefront shell
store.css               Storefront styles
store.js                Storefront app and hash router
vendor/qrcode.min.js    QR renderer (MIT)
worker/store-worker.js  Worker API, QRIS logic, admin UI
db/schema.sql           D1 schema
db/seed.sql             Catalog seed
workers/deploy-store.ps1  PowerShell deployment over Cloudflare HTTP API
tests/api.tests.ps1     25 API contract/integration tests
docs/api.md             API reference
workers/README.md       Deployment and production checklist
vendor/README.md        Vendored asset provenance and license
```

Legacy pages (`about.html`, `cart.html`, `games.html`, `payment.html`, `voucher.html`, `styles.css`, `script.js`) are kept from an earlier static prototype and are not used by the storefront.

## Local development

There is no build step. Serve the repository root with any static file server, for example:

```bash
php -S localhost:4173
# or
npx serve .
```

Then open `http://localhost:4173/`. The API base is set in the `api-base` meta tag in `index.html`; the deployed Worker allows cross-origin reads.

## Deploy

Backend:

```powershell
powershell -ExecutionPolicy Bypass -File workers\deploy-store.ps1
```

Frontend: commit and push to `master`; GitHub Pages publishes the repository root.

Secrets live in `.env` (ignored by git). Required keys and production steps are documented in [`workers/README.md`](workers/README.md).

## Test

```powershell
powershell -ExecutionPolicy Bypass -File tests\api.tests.ps1
```

The last run passed all 25 checks.

## Documentation

- [`docs/api.md`](docs/api.md) — endpoints, payloads, status model, webhook, errors.
- [`workers/README.md`](workers/README.md) — deployment, environment variables, production checklist.
- [`docs/superpowers/specs/2026-11-15-tokogame-store-design.md`](docs/superpowers/specs/2026-11-15-tokogame-store-design.md) — design decisions.
- [`docs/superpowers/plans/2026-11-15-tokogame-store.md`](docs/superpowers/plans/2026-11-15-tokogame-store.md) — implementation plan.

## License

MIT. The vendored QR library is MIT by Kazuhiko Arase; see [`vendor/README.md`](vendor/README.md).
