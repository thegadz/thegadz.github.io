# TheGadz Store — Tokogame-style real store

## Intent

Turn the current static demo into a real Indonesian game top-up storefront inspired by
tokogame.com: a light, catalog-first storefront with many products and categories, backed by
a real database and order API, paying only via QRIS.

The human partner explicitly asked to build without further discovery. This document records
the calls made so the build can proceed.

## Goals

- Tokogame-style storefront: utility bar, header with search, category nav, hero, category
  rails (Top Up Game, Voucher, Pulsa, E-Money, Live Apps), product cards, promo/how-to
  sections, footer.
- Product page with account target form, denominations, QRIS checkout, invoice and countdown.
- Order tracking by order ID.
- Real backend on Cloudflare Workers + D1: catalog, orders, order events, admin actions,
  webhook seam.
- Admin page for confirming QRIS payments and fulfilling orders manually.
- Deployable with the existing Cloudflare account and no local Node.js installation.

## Non-goals

- Customer accounts/login.
- Blog CMS (promo cards are static).
- Live supplier API integration (adapter seam + manual fulfillment instead).
- Real payment gateway credentials (adapter seam + static QRIS/demo mode instead).
- Copying tokogame.com branding, images, copy, or product artwork.

## Constraints

- No Node.js, npm, Python, or winget in the environment. Tooling must be PowerShell + HTTP APIs.
- Cloudflare account `blueicespeed`, existing API token, D1 database `gadzstore`.
- Frontend stays on GitHub Pages (`https://thegadz.github.io/`); API runs on
  `https://gadzstore-api.blueicespeed.workers.dev`.
- `thegadz.store` domain is expired; custom domain work is out of scope for this build.
- Secrets live in `.env` and are never committed. Worker secrets use `secret_text` bindings.

## Decisions

- **Backend:** single module Worker, hand-rolled router, D1 SQL. No framework because Node/npm
  is unavailable and a single focused file keeps API deployment simple.
- **Frontend:** vanilla HTML/CSS/JS SPA with hash routes; data from the API; no build step.
- **Payment:** QRIS only. Two modes:
  - `demo` when `QRIS_STATIC_PAYLOAD` is empty: per-order demo QR payload, admin/demo confirm.
  - `static` when a merchant static QRIS payload is configured: inject the exact amount and
    recompute CRC16 to produce a per-order dynamic QRIS payload. Payment is confirmed by the
    admin, or by a signed gateway webhook when one is connected.
- **Fulfillment:** manual admin action with optional supplier reference. Supplier adapter seam
  documented but not implemented.
- **Admin auth:** random bearer token (`ADMIN_TOKEN`), constant-time comparison.
- **Fee:** 0.7% QRIS fee added to the order total, configurable via `QRIS_FEE_PERCENT`.

## Architecture

```
GitHub Pages (static SPA)  ──HTTPS/JSON──>  Cloudflare Worker  ──D1 SQL──>  gadzstore D1
        index.html/store.js/store.css          /api/*               ├─ categories
        vendor/qrcode.min.js                   /admin (inline UI)   ├─ products
                                               /api/webhooks/qris   ├─ denominations
                                                                    ├─ orders
                                                                    └─ order_events
```

## Data model

- `categories(id, slug, name, sort, active)`
- `products(id, slug, name, category_id, unit, short, icon, color, requires_zone, description,
  active, sort)`
- `denominations(id, product_id, label, price, compare_at, sku, supplier_code, active, sort)`
- `orders(id, public_id, product_id, denomination_id, product_name, denomination_label,
  player_id, zone_id, nickname, subtotal, fee, total, payment_method, status, qr_payload,
  expires_at, paid_at, fulfilled_at, supplier_ref, created_at, updated_at)`
- `order_events(id, order_id, type, message, created_at)`
- `settings(key, value)`

Order statuses: `pending → paid → fulfilled`; `pending → expired`; `pending|paid → cancelled`.

## API

Public:
- `GET /api/health`
- `GET /api/config` — store name, QRIS mode, fee percent, demo flag.
- `GET /api/catalog` — categories with product cards.
- `GET /api/products/:slug` — product + denominations.
- `POST /api/orders` — create order, server-side pricing.
- `GET /api/orders/:publicId` — order status + timeline.
- `POST /api/orders/:publicId/demo-paid` — only when demo mode; lets the demo flow complete.
- `POST /api/webhooks/qris` — HMAC-SHA256 signed gateway callback (future use).

Admin (`Authorization: Bearer <ADMIN_TOKEN>`):
- `GET /api/admin/orders?status=&limit=`
- `POST /api/admin/orders/:publicId/paid`
- `POST /api/admin/orders/:publicId/fulfill`
- `POST /api/admin/orders/:publicId/cancel`
- `GET /api/admin/qris/preview?amount=` — validates static QRIS conversion.
- `GET /admin` — inline admin UI.

## Payment seam

A gateway adapter only needs to call the webhook with:
`X-Signature: HMAC-SHA256(rawBody, QRIS_WEBHOOK_SECRET)` and
`{"order_id":"TG...","status":"paid","reference":"..."}`.
Swap the frontend invoice notes and remove demo mode once a gateway is connected.

## Risks / required before real money

- Real QRIS merchant account or gateway credentials; static QRIS must be authorised for
  dynamic amount conversion by the acquirer.
- Supplier account/API for automatic fulfillment; manual fulfillment is the launch path.
- Business entity, KYC, refund policy, tax, and customer support.
- Domain renewal and HTTPS on the custom domain before advertising the store.
