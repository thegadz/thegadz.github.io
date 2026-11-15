# Tokogame-style Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real full-stack Indonesian game top-up storefront (tokogame-inspired) with a Cloudflare Worker + D1 backend, QRIS-only checkout, order tracking, and an admin console.

**Architecture:** Static SPA on GitHub Pages calls a single Cloudflare Worker API backed by D1. Orders are priced server-side; QRIS is demo/static-dynamic until a gateway is connected; fulfillment is manual via token-protected admin endpoints and UI.

**Tech Stack:** HTML/CSS/vanilla JS, vendored `qrcode-generator`, Cloudflare Workers (ES module), D1, PowerShell deployment/test scripts.

**Spec:** `docs/superpowers/specs/2026-11-15-tokogame-store-design.md`

## Status (2026-11-15)

- Worker, D1 schema/seed, admin console, webhook, and QRIS conversion are deployed.
- API contract suite: `25 passed, 0 failed`.
- Storefront implemented and exercised in a browser against the live API: catalog → product → order → demo payment → admin fulfillment → tracking. Direct search/order links, anchor navigation, validation, 404s, and status polling verified.
- QRIS remains in demo mode and fulfillment remains manual until merchant/gateway and supplier credentials are available.
- Frontend is on `master` via GitHub Pages; see `README.md` for live URLs.

## Global Constraints

- No Node/npm/Python; verification runs through PowerShell HTTP calls.
- API base: `https://gadzstore-api.blueicespeed.workers.dev`.
- Frontend base: `https://thegadz.github.io/`.
- Never copy tokogame.com artwork, logo, or copy.
- Secrets only from `.env`; worker secrets use `secret_text` bindings.
- Currency is integer rupiah; timestamps are ISO-8601 UTC.
- Order IDs match `^TG[A-Z0-9]{6,12}$`.

## Review Focus

- A stale/expired order must not be payable: `GET`/demo-paid/admin confirm must surface `expired`.
- Amount tampering: the client may not set price, fee, or total; the server recomputes them.
- Invalid player/zone input must be rejected before an order exists.
- Admin endpoints must reject missing/wrong tokens and must not leak whether the token was close.
- Static QRIS conversion must preserve existing TLV fields, replace tag 54, and produce a valid CRC16.
- Concurrent/duplicate payment callbacks must be idempotent and never double-fulfill.

---

### Task 1: API contract tests

**Files:**
- Create: `tests/api.tests.ps1`
- Create: `docs/api.md`

**Interfaces:**
- Produces: executable contract for every endpoint in the spec.

- [x] **Step 1: Write the failing contract test**

PowerShell test harness with `Assert-Equal`, `Assert-True`, `Invoke-Api`. Cover: health, config, catalog shape, product detail, order creation validation, server-side pricing, order lookup, admin auth rejection, admin paid/fulfill flow, demo-paid disabled when not demo, webhook signature rejection.

- [x] **Step 2: Run it against the stub worker**

Run: `powershell -ExecutionPolicy Bypass -File tests\api.tests.ps1`
Expected: FAIL — `/api/health` returns `db-bound`, not JSON.

- [x] **Step 3: Commit the test harness**

```bash
git add tests/api.tests.ps1 docs/api.md
git commit -m "test: define store API contract"
```

---

### Task 2: Worker core, schema, catalog

**Files:**
- Create: `worker/store-worker.js`
- Create: `db/schema.sql`
- Create: `db/seed.sql`
- Modify: `tests/api.tests.ps1`

**Interfaces:**
- Produces: `GET /api/health`, `/api/config`, `/api/catalog`, `/api/products/:slug` with JSON shapes the tests assert.

- [x] **Step 1: Add catalog tests to the harness and run (FAIL)**
- [x] **Step 2: Implement router, JSON/CORS helpers, D1 queries, expiry sweep**
- [x] **Step 3: Write schema + seed (5 categories, 24 products, 4–6 denominations each)**
- [x] **Step 4: Deploy schema/seed through the D1 HTTP API**
- [x] **Step 5: Deploy worker and run tests (PASS for catalog)**

---

### Task 3: Orders and QRIS

**Files:**
- Modify: `worker/store-worker.js`
- Modify: `tests/api.tests.ps1`

**Interfaces:**
- Produces: `POST /api/orders`, `GET /api/orders/:publicId`, demo-paid, server-side fee/total, expiry, event timeline, QRIS static conversion + CRC16.

- [x] **Step 1: Add failing order tests** (valid creation, invalid player, invalid zone, price tamper ignored, expired order, demo-paid gate)
- [x] **Step 2: Implement order creation + lookup + lazy expiry**
- [x] **Step 3: Implement QRIS static-to-dynamic conversion with CRC16 and a preview endpoint**
- [x] **Step 4: Implement demo-paid (only when demo mode)**
- [x] **Step 5: Deploy and run tests (PASS)**

---

### Task 4: Admin and webhook

**Files:**
- Modify: `worker/store-worker.js`
- Modify: `tests/api.tests.ps1`

**Interfaces:**
- Produces: bearer-auth admin list/paid/fulfill/cancel, idempotent transitions, signed webhook.

- [x] **Step 1: Add failing admin/webhook tests** (401, wrong token, paid→fulfill, duplicate callback idempotent, bad signature 401)
- [x] **Step 2: Implement auth, transitions, event logging**
- [x] **Step 3: Implement HMAC-SHA256 webhook verification**
- [x] **Step 4: Deploy and run tests (PASS)**

---

### Task 5: Storefront

**Files:**
- Modify: `index.html` (replace with new storefront)
- Create: `store.css`
- Create: `store.js`
- Create: `vendor/qrcode.min.js`
- Create: `vendor/README.md`

**Interfaces:**
- Consumes: public API above. Produces: hash routes `#/`, `#/produk/:slug`, `#/pesanan/:id`, `#/lacak`.

- [x] **Step 1: Build the tokogame-style shell** (utility bar, header, search, category nav, hero, rails, promo/how-to, footer)
- [x] **Step 2: Implement catalog + product page + account form + denomination selection**
- [x] **Step 3: Implement checkout/invoice with QR rendering, countdown, status polling**
- [x] **Step 4: Implement order tracking + empty/error/loading states**
- [ ] **Step 5: Responsive pass (360px, 768px, 1280px) via browser verification** — desktop viewport checked (no horizontal overflow, 4-column grid); 360/768 checks remain

---

### Task 6: Admin UI

**Files:**
- Modify: `worker/store-worker.js`

- [x] **Step 1: Inline `/admin` page with token prompt, status filters, order table, paid/fulfill/cancel actions**
- [x] **Step 2: Browser verify login, filter, action, and token rejection**

---

### Task 7: Deploy and verify

**Files:**
- Create: `workers/deploy-store.ps1`
- Create: `workers/README.md`
- Modify: `.gitignore`, `.env` (secrets, untracked)

- [x] **Step 1: Deploy script applies schema/seed, uploads worker with D1 + secret bindings, enables workers.dev**
- [x] **Step 2: Run full API tests (all pass)**
- [x] **Step 3: Push frontend to GitHub Pages and verify live**
- [x] **Step 4: End-to-end browser flow: catalog → product → order → invoice → admin paid → tracking**
- [x] **Step 5: Commit**
