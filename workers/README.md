# Cloudflare Worker deployment

The API runs as a single Cloudflare Worker (`worker/store-worker.js`) backed by a D1 database. Deployment uses the Cloudflare HTTP API from PowerShell, so Node, npm, and Wrangler are not required.

## Prerequisites

- Windows PowerShell 5.1 or PowerShell 7+.
- A Cloudflare API token with **Workers Scripts: Edit** and **D1: Edit** permissions for the account.
- A D1 database. Create it once in the Cloudflare dashboard or with Wrangler:

  ```bash
  wrangler d1 create gadzstore
  ```

  Copy the database UUID into `.env` as `D1_DATABASE_ID`.

- The Worker name must be available in the account. The scripts default to `gadzstore-api`.

## Environment

Create `.env` in the repository root. It is ignored by git and must never be committed.

```dotenv
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
D1_DATABASE_ID=...

WORKER_NAME=gadzstore-api
ADMIN_TOKEN=...                 # long random string
QRIS_WEBHOOK_SECRET=...         # long random string
QRIS_FEE_PERCENT=0
ORDER_TTL_SECONDS=900
DEMO_MODE=0
STORE_NAME=thegadzstore
ALLOWED_ORIGINS=https://thegadz.github.io
QRIS_STATIC_PAYLOAD=            # optional, static QRIS string from the merchant
QRIS_IMAGE=assets/qris/gopay-standee.png  # QR image shown for every order
```

Generate secrets with a password manager or:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

`QRIS_STATIC_PAYLOAD` is only bound when non-empty. It must be a complete static QRIS payload with a valid CRC; the Worker verifies it when converting a total to a dynamic QR.

## Deploy

```powershell
powershell -ExecutionPolicy Bypass -File workers\deploy-store.ps1
```

The script:

1. Applies `db/schema.sql` through the D1 HTTP query endpoint.
2. Applies `db/seed.sql` (idempotent upserts) unless `-SkipSeed` is passed.
3. Uploads the Worker module with D1 and secret/plain-text bindings.
4. Enables the `workers.dev` subdomain.
5. Prints the API, admin, and health URLs.

Re-running is safe: the schema uses `IF NOT EXISTS`, the seed uses `ON CONFLICT`, and Worker upload replaces the current script version.

```powershell
# Schema/Worker only, keep existing catalog rows
powershell -ExecutionPolicy Bypass -File workers\deploy-store.ps1 -SkipSeed
```

The script reads SQL and `.env` as UTF-8 explicitly. This matters because the catalog contains emoji and non-ASCII descriptions, and Windows PowerShell 5.1 otherwise assumes the ANSI code page.

## Test

```powershell
powershell -ExecutionPolicy Bypass -File tests\api.tests.ps1
```

The suite hits the deployed Worker, creates real orders in D1, and checks:

- Health, config, catalog, and product shapes.
- Input validation and server-side pricing.
- Expiry/status transitions, demo-paid gating, and idempotency.
- Admin authentication and paid/fulfill flows.
- Webhook HMAC rejection and signed settlement.
- Static QRIS amount injection with CRC16 validation.

Expected output ends with `Result: 25 passed, 0 failed`. The tests leave fulfilled orders in the database; delete them manually if a clean production database is required.

## Production launch checklist

1. **Turn off demo mode.** Set `DEMO_MODE=0`, then redeploy. This disables `POST /api/orders/:id/demo-paid`.
2. **Connect a QRIS gateway.** Put the merchant static QRIS payload in `QRIS_STATIC_PAYLOAD`, or replace the QRIS seam with the gateway's dynamic QR API. Configure the gateway to call `POST /api/webhooks/qris` with the HMAC signature.
3. **Set the webhook secret.** Use a long random `QRIS_WEBHOOK_SECRET` and configure the same value at the gateway.
4. **Rotate the admin token.** Use a unique `ADMIN_TOKEN`; never reuse the demo value.
5. **Restrict origins if needed.** The Worker currently sends CORS headers. `ALLOWED_ORIGINS` is reserved for a future allow-list; public catalog reads are safe, but tighten it if the API is abused.
6. **Fulfillment.** Orders are fulfilled manually in `/admin` until a supplier API adapter is added. The `supplier_ref` field records the supplier transaction.
7. **Custom domain.** The frontend currently runs at `https://thegadz.github.io/`. The old `thegadz.store` domain is expired; renew it and add a `CNAME` only after DNS is under control.
8. **Backups.** D1 exposes time-travel/export features; schedule exports before real transaction volume.

## Files

| File | Purpose |
| --- | --- |
| `worker/store-worker.js` | Worker router, D1 queries, QRIS TLV/CRC16, HMAC webhook, inline admin UI |
| `db/schema.sql` | Tables and indexes |
| `db/seed.sql` | 5 categories, 24 products, ~100 denominations |
| `workers/deploy-store.ps1` | Schema/seed/Worker deployment over the Cloudflare HTTP API |
| `tests/api.tests.ps1` | PowerShell contract and integration tests |
| `docs/api.md` | Endpoint contract |
