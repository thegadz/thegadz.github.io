# TheGadz Store API

Base URL: `https://gadzstore-api.blueicespeed.workers.dev`

All responses are JSON except `GET /admin`, which serves the admin console. Requests and responses use UTF-8. Public endpoints send permissive CORS headers so the GitHub Pages storefront can call the Worker directly.

Currency is integer rupiah (IDR). Timestamps are ISO-8601 UTC strings. Order IDs match `^TG[A-Z0-9]{6,12}$`.

## Public endpoints

### `GET /api/health`

```json
{ "ok": true, "db": "ok", "time": "2026-11-15T01:00:00.000Z" }
```

Returns `503` with `{ "ok": false, "db": "error" }` when D1 is unreachable.

### `GET /api/config`

```json
{
  "store": { "name": "TheGadz Store", "currency": "IDR", "locale": "id-ID" },
  "qris": {
    "mode": "image",
    "image": "assets/qris/gopay-standee.png",
    "amount_in_payload": false,
    "fee_percent": 0,
    "payment_method": "QRIS"
  },
  "payment": {
    "mode": "manual",
    "methods": ["QRIS"],
    "proof_upload": true,
    "max_proof_bytes": 687194
  },
  "demo": false,
  "order_ttl_seconds": 86400
}
```

`qris.mode` is `static` when `QRIS_STATIC_PAYLOAD` is configured (the Worker then re-encodes a per-order amount into that payload), `image` when only a QR image is configured (`QRIS_IMAGE`, default `assets/qris/gopay-standee.png`), and `demo` when neither is set. `qris.image` is the QR the storefront displays for every order; `qris.amount_in_payload` is true only in `static` mode. `demo` is true only when `DEMO_MODE=1`.

`payment.mode` is `manual` when a QR is configured (`static` or `image`) **and** `DEMO_MODE=0`; otherwise `demo`. In `manual` mode the storefront hides the demo button, shows the shop QR image plus the proof upload form, and holds pending orders for `PAYMENT_HOLD_SECONDS` (default 86400) instead of `ORDER_TTL_SECONDS` (default 900). `payment.max_proof_bytes` is the effective cap after the D1 row limit is applied — the smallest of `MAX_PROOF_BYTES` and `floor(900 KiB / 1.34)`.

### `GET /api/catalog`

Returns active categories and their active products, already sorted.

```json
{
  "categories": [
    {
      "slug": "top-up-game",
      "name": "Top Up Game",
      "sort": 1,
      "products": [
        {
          "id": 1,
          "slug": "mobile-legends",
          "name": "Mobile Legends",
          "category_slug": "top-up-game",
          "category_name": "Top Up Game",
          "unit": "Diamond",
          "short": "MLBB",
          "icon": "⚔️",
          "color": "#1e3a8a",
          "target_type": "player",
          "requires_zone": true,
          "description": "Top up Diamond Mobile Legends instan, aman, dan murah.",
          "min_price": 22000,
          "denomination_count": 6
        }
      ]
    }
  ]
}
```

`target_type` is one of `player`, `phone`, or `account`.

### `GET /api/products/:slug`

```json
{
  "product": { "id": 1, "slug": "mobile-legends", "name": "Mobile Legends", "requires_zone": true, "...": "..." },
  "denominations": [
    { "id": 1, "label": "86 Diamond", "price": 22000, "compare_at": 24000, "sku": "MLBB-86" }
  ]
}
```

Returns `404 product_not_found` for unknown or inactive products.

### `POST /api/orders`

Request:

```json
{
  "product_slug": "mobile-legends",
  "denomination_id": 2,
  "player_id": "123456789",
  "zone_id": "1234",
  "nickname": "Player"
}
```

The server ignores any client-provided price, fee, or total. It looks up the product and denomination, validates the target, computes the fee and total, generates a public order ID, and stores the order with status `pending`.

Pricing:

```text
subtotal = denomination price
fee      = round(subtotal * QRIS_FEE_PERCENT / 100)
total    = subtotal + fee
```

Responses:

- `201` with `{ "order": { ... } }` on success.
- `400 invalid_product` / `invalid_denomination` / `invalid_target` / `invalid_zone`.
- `500 qris_config_error` if the configured static QRIS payload is invalid.

### `GET /api/orders/:publicId`

Returns the order plus its event timeline. Pending orders past `expires_at` are lazily marked `expired` before the response is returned.

```json
{
  "order": {
    "public_id": "TGK3M9XQ2AB",
    "product_slug": "mobile-legends",
    "product_name": "Mobile Legends",
    "denomination_label": "86 Diamond",
    "player_id": "123456789",
    "zone_id": "1234",
    "nickname": "Player",
    "subtotal": 22000,
    "fee": 154,
    "total": 22154,
    "payment_method": "QRIS",
    "status": "pending",
    "qr_payload": null,
    "expires_at": "2026-11-15T01:15:00.000Z",
    "paid_at": null,
    "fulfilled_at": null,
    "supplier_ref": null,
    "proof": {
      "url": "/api/orders/TGK3M9XQ2AB/proof",
      "mime": "image/jpeg",
      "size": 84213,
      "sender": "Budi",
      "uploaded_at": "2026-11-15T01:07:12.000Z"
    },
    "proof_rejection": null,
    "created_at": "2026-11-15T01:00:00.000Z",
    "events": [
      { "type": "created", "message": "Pesanan dibuat. Menunggu pembayaran QRIS.", "created_at": "2026-11-15T01:00:00.000Z" }
    ]
  }
}
```

`qr_payload` is `null` in manual mode: the buyer scans the standee QR and types the total manually, so no amount-bearing payload is issued. `proof` is `null` until a proof is uploaded. `proof_rejection` carries `{ "rejected_at": "...", "reason": "..." }` after an admin rejects a proof, and is cleared when the buyer uploads again.

Returns `404 order_not_found` when the ID does not exist.

### `POST /api/orders/:publicId/proof`

Uploads payment proof for a pending order. Body is the raw file bytes; the type is sniffed from magic bytes (JPG, PNG, WEBP, PDF) and the client `Content-Type` is never trusted.

```text
Content-Type: image/jpeg
X-Proof-Sender: Budi   (optional, max 60 chars)
```

Responses:

- `200` with the updated order (same shape as the lookup above).
- `404 order_not_found`.
- `409 invalid_status` if the order is no longer awaiting payment.
- `413 proof_too_large` if the body exceeds `payment.max_proof_bytes`.
- `415 proof_unsupported_type` for anything that is not JPG/PNG/WEBP/PDF.
- `400 proof_empty` for an empty body.
- `403 proof_disabled` when not in manual mode.

Re-uploading replaces the previous proof and clears any rejection. Proof bytes live in D1, so the cap exists to stay under D1's ~1 MB row limit.

### `GET /api/orders/:publicId/proof`

Streams the stored proof for the buyer and the admin console. Returns `404 proof_not_found` when no proof is attached.

### `DELETE /api/orders/:publicId/proof`

Removes the attached proof, returning the order to an uploadable state. Same status guards as the upload.


### `POST /api/orders/:publicId/demo-paid`

Demo-only shortcut that marks a pending order `paid`. Returns `403 demo_disabled` unless `DEMO_MODE=1`. Idempotent for orders already `paid` or `fulfilled`; returns `409 invalid_status` for `expired` or `cancelled` orders.

This endpoint exists only to exercise the checkout flow before a real QRIS gateway is connected. Disable it in production with `DEMO_MODE=0`.

## Status model

```text
pending ──► paid ──► fulfilled
   │          │
   │          └──► cancelled
   ├──► expired
   └──► cancelled
```

- Totals and status transitions are server-authoritative.
- Duplicate `paid` and `fulfill` calls are idempotent.
- `fulfilled` orders cannot be cancelled through the API.
- A webhook can still settle an expired order; this is recorded with the message `Pembayaran diterima setelah kedaluwarsa.`

## Webhook

### `POST /api/webhooks/qris`

Headers:

```text
X-Signature: <lowercase hex HMAC-SHA256 of the raw request body>
```

Body:

```json
{ "order_id": "TGK3M9XQ2AB", "status": "paid", "reference": "GATEWAY-REF-123" }
```

Supported statuses: `paid` and `expired`. The signature is calculated with `QRIS_WEBHOOK_SECRET` over the exact raw body. Invalid or missing signatures return `401 unauthorized`.

## Admin endpoints

All `/api/admin/*` routes require:

```text
Authorization: Bearer <ADMIN_TOKEN>
```

Missing or incorrect tokens return `401 unauthorized`.

### `GET /api/admin/orders?status=pending&limit=50`

Lists orders, newest first. `status` is optional and must be one of `pending`, `paid`, `fulfilled`, `expired`, or `cancelled`. `limit` is clamped to `1..200` and defaults to `50`. The request also sweeps pending orders whose expiry has passed to `expired`.

### `GET /api/admin/orders/:publicId`

Returns one order with its event timeline.

### `POST /api/admin/orders/:publicId/paid`

Body (optional): `{ "reference": "BANK-REF-123" }`

Marks a pending order paid and appends an event. Safe to repeat.

### `POST /api/admin/orders/:publicId/fulfill`

Body (optional): `{ "supplier_ref": "SUPPLIER-REF-123" }`

Marks a paid order fulfilled and records the supplier reference. Requires the order to be `paid`; returns `409 invalid_status` otherwise. Safe to repeat for already-fulfilled orders.

### `POST /api/admin/orders/:publicId/cancel`

Cancels a non-fulfilled order and appends an event. Returns `409 invalid_status` when the order is already fulfilled.

### `POST /api/admin/orders/:publicId/reject-proof`

Body: `{ "reason": "Nominal tidak sesuai" }`

Rejects the attached proof so the buyer can upload a corrected one. The proof bytes are cleared, `proof_rejected_at` and `proof_reject_reason` are recorded, and the rejection reason is returned to the buyer as `proof_rejection`. Returns `409 invalid_status` when there is no proof to reject or the order is no longer pending.

In manual mode the normal admin flow is: review the proof → either `reject-proof` (buyer re-uploads) or `paid` → `fulfill`. The admin order list includes `proof_uploaded_at`, `proof_rejected_at`, and `proof_reject_reason` (never the bytes); proof bytes are fetched through `GET /api/orders/:publicId/proof`.

### `POST /api/admin/qris/preview`

Body:

```json
{ "amount": 22154, "payload": "000201010211..." }
```

Converts a static QRIS payload into a dynamic one by inserting/replacing tag `54` and recalculating CRC16-CCITT. If `payload` is omitted, `QRIS_STATIC_PAYLOAD` is used. Returns:

```json
{ "payload": "000201...6304ABCD", "amount": 22154, "crc": "ABCD", "crc_valid": true }
```

Malformed payloads return `400 invalid_qris`.

## Error shape

```json
{ "error": "invalid_target", "message": "Player ID harus 5–20 angka." }
```

Common status codes: `400` validation, `401` authentication, `404` not found, `409` invalid status transition, `413` oversized body, `500` server/configuration error.

## Admin console

`GET /admin` serves a self-contained HTML console. The token is kept in `sessionStorage` and sent as a bearer token. The console polls the order list every 15 seconds and supports marking paid, fulfilling with a supplier reference, cancelling, and filtering by status.
