// thegadzstore API worker.
// Cloudflare Worker + D1. Public storefront API, admin API, QRIS payments.
//
// Two payment modes:
//   manual - the shop's own GoPay QRIS standee image is shown for every order
//            (QRIS_STATIC_PAYLOAD is optional; when set, the shop QR is also
//            re-encoded with the order amount injected). The buyer types the
//            total in their payment app, uploads proof, the admin verifies it
//            and marks the order paid. No gateway, no callback, no fees.
//   demo   - nothing paid configured: QR payload is a placeholder and payments
//            can only be simulated. Never used in production.
//
// Bindings expected:
//   DB (D1), ADMIN_TOKEN (secret), QRIS_WEBHOOK_SECRET (secret),
//   QRIS_STATIC_PAYLOAD (optional static QR string), QRIS_IMAGE (image path for
//   the storefront), QRIS_FEE_PERCENT, ORDER_TTL_SECONDS, DEMO_MODE, STORE_NAME,
//   PAYMENT_HOLD_SECONDS, MAX_PROOF_BYTES

const JSON_TYPE = "application/json; charset=utf-8";
const ORDER_STATUSES = ["pending", "paid", "fulfilled", "expired", "cancelled"];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-signature",
    "access-control-max-age": "86400",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "content-type": JSON_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...cors(),
    },
  });
}

function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envNumber(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function storeName(env) {
  return String(env.STORE_NAME || "thegadzstore");
}

function feePercent(env) {
  return Math.max(0, envNumber(env, "QRIS_FEE_PERCENT", 0.7));
}

function orderTtlSeconds(env) {
  return Math.max(60, Math.floor(envNumber(env, "ORDER_TTL_SECONDS", 900)));
}

function demoMode(env) {
  return String(env.DEMO_MODE || "1") === "1";
}

function qrisImage(env) {
  return String(env.QRIS_IMAGE || "assets/qris/gopay-standee.png").trim();
}

// A shop QR is always available: the uploaded standee image, or a static payload
// that can be re-encoded per order. Either one enables real manual payments.
function qrisMode(env) {
  if (String(env.QRIS_STATIC_PAYLOAD || "").trim()) return "static";
  return qrisImage(env) ? "image" : "demo";
}

function paymentMode(env) {
  if (qrisMode(env) === "demo") return "demo";
  return demoMode(env) ? "demo" : "manual";
}

function proofsEnabled(env) {
  return paymentMode(env) === "manual";
}

function paymentHoldSeconds(env) {
  return Math.max(60, Math.floor(envNumber(env, "PAYMENT_HOLD_SECONDS", 86400)));
}

// Effective cap is the env value, but never more than a D1 row can hold once base64 encoded.
function maxProofBytes(env) {
  const configured = Math.floor(envNumber(env, "MAX_PROOF_BYTES", 900 * 1024));
  const d1Safe = Math.floor((900 * 1024) / 1.34);
  return Math.min(d1Safe, Math.max(4096, configured));
}

function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let diff = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function isAdmin(request, env) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !env.ADMIN_TOKEN) return false;
  return safeEqual(match[1], env.ADMIN_TOKEN);
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 20000) throw new HttpError(413, "payload_too_large", "Payload terlalu besar.");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_json", "Body harus berupa JSON yang valid.");
  }
}

async function dbAll(env, sql, params) {
  const stmt = env.DB.prepare(sql);
  const bound = params && params.length ? stmt.bind(...params) : stmt;
  const result = await bound.all();
  return result.results || [];
}

async function dbFirst(env, sql, params) {
  const stmt = env.DB.prepare(sql);
  const bound = params && params.length ? stmt.bind(...params) : stmt;
  return bound.first();
}

async function dbRun(env, sql, params) {
  const stmt = env.DB.prepare(sql);
  const bound = params && params.length ? stmt.bind(...params) : stmt;
  return bound.run();
}

async function addEvent(env, orderId, type, message) {
  await dbRun(
    env,
    "INSERT INTO order_events (order_id, type, message, created_at) VALUES (?, ?, ?, ?)",
    [orderId, type, String(message || ""), nowIso()]
  );
}

function sanitizeText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, max || 80);
}

function validateTarget(product, playerId, zoneId) {
  const targetType = product.target_type || "player";
  if (targetType === "phone") {
    if (!/^[0-9]{8,15}$/.test(playerId)) {
      throw new HttpError(400, "invalid_target", "Nomor HP harus 8–15 angka.");
    }
  } else if (targetType === "account") {
    if (!/^[A-Za-z0-9._@+\-]{3,60}$/.test(playerId)) {
      throw new HttpError(400, "invalid_target", "User ID / email tidak valid.");
    }
  } else if (!/^[0-9]{5,20}$/.test(playerId)) {
    throw new HttpError(400, "invalid_target", "Player ID harus 5–20 angka.");
  }
  if (product.requires_zone && !/^[0-9]{1,6}$/.test(zoneId)) {
    throw new HttpError(400, "invalid_zone", "Server / Zone ID wajib diisi 1–6 angka.");
  }
}

function makePublicId() {
  // Random, unguessable public order ID. Avoids exposing timestamp/sequence
  // information and makes enumeration of order lookups impractical.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return "TG" + body;
}

function proofJson(row) {
  return {
    uploaded_at: row.proof_uploaded_at,
    mime: row.proof_mime,
    size: row.proof_size,
    sender: row.proof_sender,
    url: "/api/orders/" + row.public_id + "/proof",
  };
}

function rejectionJson(row) {
  if (!row.proof_rejected_at) return null;
  return { rejected_at: row.proof_rejected_at, reason: row.proof_reject_reason || "" };
}

function orderJson(row, events) {
  const data = {
    public_id: row.public_id,
    product_slug: row.product_slug,
    product_name: row.product_name,
    denomination_label: row.denomination_label,
    player_id: row.player_id,
    zone_id: row.zone_id,
    nickname: row.nickname,
    subtotal: row.subtotal,
    fee: row.fee,
    total: row.total,
    payment_method: row.payment_method,
    status: row.status,
    qr_payload: row.qr_payload,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    fulfilled_at: row.fulfilled_at,
    supplier_ref: row.supplier_ref,
    created_at: row.created_at,
    proof: row.proof_uploaded_at ? proofJson(row) : null,
    proof_rejection: rejectionJson(row),
  };
  if (events) {
    data.events = events.map((event) => ({
      type: event.type,
      message: event.message,
      created_at: event.created_at,
    }));
  }
  return data;
}

function productJson(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category_slug: row.category_slug,
    category_name: row.category_name,
    unit: row.unit,
    short: row.short,
    icon: row.icon,
    color: row.color,
    image: row.image || "",
    target_type: row.target_type || "player",
    requires_zone: !!row.requires_zone,
    description: row.description,
    min_price: row.min_price || 0,
    denomination_count: row.denomination_count || 0,
  };
}

/* ------------------------------------------------------------------ QRIS */

function crc16Ccitt(input) {
  let crc = 0xffff;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function parseTlv(input) {
  if (typeof input !== "string" || input.length < 8) throw new Error("QRIS terlalu pendek.");
  const out = [];
  let index = 0;
  while (index < input.length) {
    if (index + 4 > input.length) throw new Error("TLV terpotong.");
    const tag = input.slice(index, index + 2);
    const lengthText = input.slice(index + 2, index + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) throw new Error("Tag TLV tidak valid.");
    const length = parseInt(lengthText, 10);
    const value = input.slice(index + 4, index + 4 + length);
    if (value.length !== length) throw new Error("Panjang TLV tidak cocok.");
    out.push({ tag, value });
    index += 4 + length;
  }
  return out;
}

function packTlv(items) {
  return items
    .map((item) => item.tag + String(item.value.length).padStart(2, "0") + item.value)
    .join("");
}

function injectQrisAmount(payload, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Nominal tidak valid.");
  const items = parseTlv(payload);
  if (!items.length || items[0].tag !== "00" || items[0].value !== "01") {
    throw new Error("Payload bukan QRIS statis.");
  }
  const last = items[items.length - 1];
  if (last.tag !== "63" || last.value.length !== 4) throw new Error("CRC QRIS tidak ditemukan.");
  const body = items.slice(0, -1);
  const checksumBase = packTlv(body) + "6304";
  const expected = crc16Ccitt(checksumBase);
  if (expected !== last.value.toUpperCase()) throw new Error("CRC QRIS tidak valid.");

  const withoutAmount = body.filter((item) => item.tag !== "54");
  const amountItem = { tag: "54", value: String(amount) };
  const insertAt = withoutAmount.findIndex((item) => ["58", "59", "60", "61", "62"].includes(item.tag));
  if (insertAt === -1) withoutAmount.push(amountItem);
  else withoutAmount.splice(insertAt, 0, amountItem);

  const withoutCrc = packTlv(withoutAmount) + "6304";
  const crc = crc16Ccitt(withoutCrc);
  return { payload: withoutCrc + crc, crc };
}

function buildQrPayload(env, total, publicId) {
  const staticPayload = String(env.QRIS_STATIC_PAYLOAD || "").trim();
  // Without a static payload there is no amount-injected QR: the storefront shows
  // the shop's QRIS image instead, so the payload stays empty on purpose.
  if (!staticPayload) return "";
  return injectQrisAmount(staticPayload, total).payload;
}

/* ------------------------------------------------------------------ routes */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    try {
      if (url.pathname.startsWith("/api/admin/") && !(await isAdmin(request, env))) {
        return json({ error: "unauthorized", message: "Token admin tidak valid." }, 401, env);
      }
      const response = await route(request, env, url);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors())) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code, message: error.message }, error.status, env);
      }
      console.error("unhandled", error && error.stack ? error.stack : error);
      return json({ error: "internal_error", message: "Terjadi kesalahan pada server." }, 500, env);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/" && method === "GET") {
    return json({ name: storeName(env), api: "/api/health", admin: "/admin" }, 200, env);
  }
  if (path === "/admin" && method === "GET") {
    return html(adminPage());
  }
  if (path === "/api/health" && method === "GET") {
    try {
      await dbFirst(env, "SELECT 1 AS ok");
      return json({ ok: true, db: "ok", time: nowIso() }, 200, env);
    } catch (error) {
      return json({ ok: false, db: "error", message: String(error) }, 503, env);
    }
  }
  if (path === "/api/config" && method === "GET") {
    return json(
      {
        store: { name: storeName(env), currency: "IDR", locale: "id-ID" },
        qris: {
          mode: qrisMode(env),
          image: qrisImage(env),
          amount_in_payload: qrisMode(env) === "static",
          fee_percent: feePercent(env),
          payment_method: "QRIS",
        },
        payment: {
          mode: paymentMode(env),
          methods: paymentMode(env) === "manual" ? ["QRIS"] : ["QRIS", "DEMO"],
          proof_upload: proofsEnabled(env),
          max_proof_bytes: maxProofBytes(env),
          hold_seconds: paymentHoldSeconds(env),
        },
        demo: demoMode(env),
        order_ttl_seconds: orderTtlSeconds(env),
      },
      200,
      env
    );
  }
  if (path === "/api/catalog" && method === "GET") {
    return handleCatalog(env);
  }
  const productMatch = path.match(/^\/api\/products\/([a-z0-9-]+)$/);
  if (productMatch && method === "GET") {
    return handleProduct(env, productMatch[1]);
  }
  if (path === "/api/orders" && method === "POST") {
    return handleCreateOrder(request, env);
  }
  const demoPaidMatch = path.match(/^\/api\/orders\/(TG[A-Z0-9]{6,12})\/demo-paid$/);
  if (demoPaidMatch && method === "POST") {
    return handleDemoPaid(env, demoPaidMatch[1]);
  }
  const proofMatch = path.match(/^\/api\/orders\/(TG[A-Z0-9]{6,12})\/proof$/);
  if (proofMatch && method === "POST") {
    return handleUploadProof(request, env, proofMatch[1]);
  }
  if (proofMatch && method === "GET") {
    return handleGetProof(env, proofMatch[1]);
  }
  if (proofMatch && method === "DELETE") {
    return handleDeleteProof(env, proofMatch[1]);
  }
  const orderMatch = path.match(/^\/api\/orders\/(TG[A-Z0-9]{6,12})$/);
  if (orderMatch && method === "GET") {
    return handleGetOrder(env, orderMatch[1]);
  }
  if (path === "/api/webhooks/qris" && method === "POST") {
    return handleWebhook(request, env);
  }
  if (path === "/api/admin/orders" && method === "GET") {
    return handleAdminList(env, url);
  }
  const adminOrderMatch = path.match(/^\/api\/admin\/orders\/(TG[A-Z0-9]{6,12})$/);
  if (adminOrderMatch && method === "GET") {
    return handleAdminOrder(env, adminOrderMatch[1]);
  }
  const adminActionMatch = path.match(
    /^\/api\/admin\/orders\/(TG[A-Z0-9]{6,12})\/(paid|reject-proof|cancel|fulfill)$/
  );
  if (adminActionMatch && method === "POST") {
    return handleAdminAction(request, env, adminActionMatch[1], adminActionMatch[2]);
  }
  if (path === "/api/admin/qris/preview" && method === "POST") {
    return handleQrisPreview(request, env);
  }
  return json({ error: "not_found", message: "Endpoint tidak ditemukan." }, 404, env);
}

/* ------------------------------------------------------------------ catalog */

async function handleCatalog(env) {
  const rows = await dbAll(
    env,
    `SELECT c.slug AS category_slug, c.name AS category_name, c.sort AS category_sort,
            p.id, p.slug, p.name, p.unit, p.short, p.icon, p.color, p.image, p.target_type,
            p.requires_zone, p.description, p.sort AS product_sort
     FROM categories c
     JOIN products p ON p.category_id = c.id AND p.active = 1
     WHERE c.active = 1
     ORDER BY c.sort, p.sort, p.id`
  );
  const prices = await dbAll(
    env,
    `SELECT product_id, MIN(price) AS min_price, COUNT(*) AS denomination_count
     FROM denominations WHERE active = 1 GROUP BY product_id`
  );
  const priceMap = {};
  for (const row of prices) priceMap[row.product_id] = row;

  const categories = [];
  const categoryMap = {};
  for (const row of rows) {
    if (!categoryMap[row.category_slug]) {
      categoryMap[row.category_slug] = {
        slug: row.category_slug,
        name: row.category_name,
        sort: row.category_sort,
        products: [],
      };
      categories.push(categoryMap[row.category_slug]);
    }
    const price = priceMap[row.id] || {};
    categoryMap[row.category_slug].products.push(
      productJson({
        ...row,
        category_slug: row.category_slug,
        category_name: row.category_name,
        min_price: price.min_price || 0,
        denomination_count: price.denomination_count || 0,
      })
    );
  }
  return json({ categories }, 200, env);
}

async function handleProduct(env, slug) {
  const product = await dbFirst(
    env,
    `SELECT p.*, c.slug AS category_slug, c.name AS category_name
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.slug = ? AND p.active = 1 AND c.active = 1`,
    [slug]
  );
  if (!product) throw new HttpError(404, "product_not_found", "Produk tidak ditemukan.");
  const denominations = await dbAll(
    env,
    `SELECT id, label, price, compare_at, sku
     FROM denominations WHERE product_id = ? AND active = 1 ORDER BY sort, id`,
    [product.id]
  );
  return json(
    {
      product: productJson(product),
      denominations: denominations.map((row) => ({
        id: row.id,
        label: row.label,
        price: row.price,
        compare_at: row.compare_at,
        sku: row.sku,
      })),
    },
    200,
    env
  );
}

/* ------------------------------------------------------------------ orders */

async function handleCreateOrder(request, env) {
  const body = await readJson(request);
  const productSlug = sanitizeText(body.product_slug, 80);
  const denominationId = Number(body.denomination_id);
  const playerId = sanitizeText(body.player_id, 60);
  const zoneId = sanitizeText(body.zone_id, 10);
  const nickname = sanitizeText(body.nickname, 40);

  if (!productSlug) throw new HttpError(400, "invalid_product", "Produk wajib dipilih.");
  if (!Number.isInteger(denominationId) || denominationId <= 0) {
    throw new HttpError(400, "invalid_denomination", "Nominal tidak valid.");
  }

  const item = await dbFirst(
    env,
    `SELECT p.id AS product_id, p.slug, p.name, p.requires_zone, p.target_type,
            d.id AS denomination_id, d.label, d.price
     FROM products p JOIN denominations d ON d.product_id = p.id
     WHERE p.slug = ? AND d.id = ? AND p.active = 1 AND d.active = 1`,
    [productSlug, denominationId]
  );
  if (!item) throw new HttpError(400, "invalid_denomination", "Nominal tidak tersedia untuk produk ini.");

  validateTarget(item, playerId, zoneId);

  const subtotal = item.price;
  const fee = Math.round((subtotal * feePercent(env)) / 100);
  const total = subtotal + fee;
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + (proofsEnabled(env) ? paymentHoldSeconds(env) : orderTtlSeconds(env)) * 1000
  ).toISOString();

  let publicId = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = makePublicId();
    const exists = await dbFirst(env, "SELECT 1 AS found FROM orders WHERE public_id = ?", [candidate]);
    if (!exists) {
      publicId = candidate;
      break;
    }
  }
  if (!publicId) throw new HttpError(500, "id_generation_failed", "Gagal membuat ID pesanan.");

  let qrPayload;
  try {
    qrPayload = buildQrPayload(env, total, publicId);
  } catch (error) {
    console.error("qris config", error);
    throw new HttpError(500, "qris_config_error", "Konfigurasi QRIS tidak valid. Hubungi admin.");
  }

  const inserted = await dbRun(
    env,
    `INSERT INTO orders
       (public_id, product_id, product_slug, product_name, denomination_id, denomination_label,
        player_id, zone_id, nickname, subtotal, fee, total, payment_method, status, qr_payload,
        expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QRIS', 'pending', ?, ?, ?, ?)`,
    [
      publicId,
      item.product_id,
      item.slug,
      item.name,
      item.denomination_id,
      item.label,
      playerId,
      zoneId,
      nickname || "Player",
      subtotal,
      fee,
      total,
      qrPayload,
      expiresAt,
      createdAt,
      createdAt,
    ]
  );
  const orderId = inserted.meta && inserted.meta.last_row_id;
  await addEvent(env, orderId, "created", "Pesanan dibuat. Menunggu pembayaran QRIS.");
  const row = await getOrderRow(env, publicId);
  return json({ order: orderJson(row, await getOrderEvents(env, row.id)) }, 201, env);
}

async function getOrderRow(env, publicId) {
  return dbFirst(env, "SELECT * FROM orders WHERE public_id = ?", [publicId]);
}

async function getOrderEvents(env, orderId) {
  return dbAll(
    env,
    "SELECT type, message, created_at FROM order_events WHERE order_id = ? ORDER BY id",
    [orderId]
  );
}

async function expireIfNeeded(env, order) {
  if (!order || order.status !== "pending") return order;
  if (Date.parse(order.expires_at) > Date.now()) return order;
  const now = nowIso();
  const changed = await dbRun(
    env,
    "UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'",
    [now, order.id]
  );
  if (changed.meta && changed.meta.changes > 0) {
    await addEvent(env, order.id, "expired", "Pesanan kedaluwarsa karena tidak dibayar.");
  }
  return { ...order, status: "expired", updated_at: now };
}

async function handleGetOrder(env, publicId) {
  let order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");
  order = await expireIfNeeded(env, order);
  return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
}

async function handleDemoPaid(env, publicId) {
  if (paymentMode(env) !== "demo") {
    throw new HttpError(403, "demo_disabled", "Pembayaran demo tidak aktif.");
  }
  let order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");
  order = await expireIfNeeded(env, order);
  if (order.status === "paid" || order.status === "fulfilled") {
    return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
  }
  if (order.status !== "pending") {
    throw new HttpError(409, "invalid_status", "Pesanan tidak bisa dibayar pada status ini.");
  }
  const now = nowIso();
  await dbRun(
    env,
    "UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    [now, now, order.id]
  );
  await addEvent(env, order.id, "paid", "Pembayaran QRIS disimulasikan (mode demo).");
  order = await getOrderRow(env, publicId);
  return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
}

async function transitionPaid(env, order, message) {
  if (order.status === "paid" || order.status === "fulfilled") return order;
  if (order.status === "cancelled") {
    throw new HttpError(409, "invalid_status", "Pesanan sudah dibatalkan.");
  }
  if (order.status === "expired") {
    throw new HttpError(409, "invalid_status", "Pesanan sudah kedaluwarsa. Buat pesanan baru.");
  }
  const now = nowIso();
  await dbRun(
    env,
    "UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    [now, now, order.id]
  );
  await addEvent(env, order.id, "paid", message || "Pembayaran QRIS dikonfirmasi.");
  return getOrderRow(env, order.public_id);
}

/* ------------------------------------------------------------ proof upload */

// Buyers upload proof themselves, so this is stored as bytes in D1 (base64).
// D1 caps a row at ~1 MB of JSON, so the hard limit stays well below that.
const PROOF_MIME_BYTES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": null, // RIFF....WEBP
  "application/pdf": [0x25, 0x50, 0x44, 0x46],
};
const PROOF_D1_LIMIT = 900 * 1024; // base64 payload must stay under D1's ~1 MB row value

function detectProofType(bytes) {
  if (bytes.length < 12) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  return "";
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadUploadableOrder(env, publicId) {
  let order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");
  order = await expireIfNeeded(env, order);
  if (order.status === "pending" || order.status === "paid") return order;
  if (order.status === "expired") {
    throw new HttpError(409, "order_expired", "Waktu pembayaran habis. Silakan buat pesanan baru.");
  }
  throw new HttpError(409, "invalid_status", "Pesanan tidak bisa diubah pada status ini.");
}

async function handleUploadProof(request, env, publicId) {
  if (!proofsEnabled(env)) {
    throw new HttpError(403, "proof_disabled", "Unggah bukti pembayaran tidak aktif.");
  }
  const upload = await request.formData();
  const file = upload.get("proof");
  const sender = upload.get("sender");
  const note = upload.get("note");
  if (!file || typeof file === "string") {
    throw new HttpError(400, "missing_proof", "Pilih foto bukti pembayaran terlebih dahulu.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, "empty_proof", "File bukti kosong.");
  if (bytes.length > maxProofBytes(env)) {
    throw new HttpError(
      413,
      "proof_too_large",
      "Ukuran bukti terlalu besar. Maksimal " + Math.round(maxProofBytes(env) / 1024) + " KB."
    );
  }
  const mime = detectProofType(bytes);
  if (!mime) {
    throw new HttpError(415, "unsupported_proof", "Format harus JPG, PNG, WEBP, atau PDF.");
  }

  const order = await loadUploadableOrder(env, publicId);
  const now = nowIso();
  await dbRun(
    env,
    `UPDATE orders SET proof_data = ?, proof_mime = ?, proof_size = ?, proof_sender = ?, proof_note = ?,
       proof_uploaded_at = ?, proof_rejected_at = NULL, proof_reject_reason = '', updated_at = ?
     WHERE id = ?`,
    [
      bytesToBase64(bytes),
      mime,
      bytes.length,
      sanitizeText(sender, 60),
      sanitizeText(note, 200),
      now,
      now,
      order.id,
    ]
  );
  await addEvent(
    env,
    order.id,
    "proof_uploaded",
    "Bukti pembayaran diunggah. Menunggu verifikasi admin."
  );
  const row = await getOrderRow(env, publicId);
  return json({ order: orderJson(row, await getOrderEvents(env, row.id)) }, 200, env);
}

async function handleGetProof(env, publicId) {
  const order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");
  if (!order.proof_data) throw new HttpError(404, "proof_not_found", "Belum ada bukti pembayaran.");
  return new Response(base64ToBytes(order.proof_data), {
    status: 200,
    headers: {
      "content-type": order.proof_mime || "application/octet-stream",
      "content-disposition": 'inline; filename="bukti-' + order.public_id + '"',
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      ...cors(),
    },
  });
}

async function handleDeleteProof(env, publicId) {
  const order = await loadUploadableOrder(env, publicId);
  if (order.status !== "pending" || !order.proof_data) {
    throw new HttpError(409, "invalid_status", "Bukti tidak bisa dihapus pada status ini.");
  }
  const now = nowIso();
  await dbRun(
    env,
    `UPDATE orders SET proof_data = NULL, proof_mime = '', proof_size = 0, proof_sender = '',
       proof_note = '', proof_uploaded_at = NULL, proof_rejected_at = NULL, proof_reject_reason = '',
       updated_at = ? WHERE id = ?`,
    [now, order.id]
  );
  await addEvent(env, order.id, "proof_removed", "Bukti pembayaran dihapus untuk diunggah ulang.");
  const row = await getOrderRow(env, publicId);
  return json({ order: orderJson(row, await getOrderEvents(env, row.id)) }, 200, env);
}

async function handleWebhook(request, env) {
  const raw = await request.text();
  const signature = request.headers.get("x-signature") || "";
  if (!env.QRIS_WEBHOOK_SECRET || !signature) {
    throw new HttpError(401, "unauthorized", "Signature webhook tidak ada.");
  }
  const expected = await hmacHex(env.QRIS_WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, signature.trim().toLowerCase())) {
    throw new HttpError(401, "unauthorized", "Signature webhook tidak valid.");
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "Body webhook bukan JSON.");
  }
  const publicId = sanitizeText(body.order_id, 20);
  const status = sanitizeText(body.status, 20).toLowerCase();
  if (!/^TG[A-Z0-9]{6,12}$/.test(publicId)) {
    throw new HttpError(400, "invalid_order", "order_id tidak valid.");
  }
  let order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");

  if (status === "paid") {
    if (order.status === "expired") {
      const now = nowIso();
      await dbRun(
        env,
        "UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?",
        [now, now, order.id]
      );
      await addEvent(env, order.id, "paid", "Pembayaran diterima setelah kedaluwarsa.");
      order = await getOrderRow(env, publicId);
    } else {
      order = await transitionPaid(
        env,
        order,
        "Pembayaran dikonfirmasi gateway." + (body.reference ? " Ref: " + sanitizeText(body.reference, 80) : "")
      );
    }
  } else if (status === "expired") {
    order = await expireIfNeeded(env, order);
  } else {
    throw new HttpError(400, "invalid_status", "Status webhook tidak didukung.");
  }

  return json({ ok: true, order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
}

/* ------------------------------------------------------------------ admin */

async function handleAdminList(env, url) {
  const status = sanitizeText(url.searchParams.get("status"), 20);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const now = nowIso();
  await dbRun(
    env,
    "UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?",
    [now, now]
  );

  let sql =
    "SELECT id, public_id, product_slug, product_name, denomination_label, player_id, zone_id, nickname, " +
    "subtotal, fee, total, payment_method, status, qr_payload, expires_at, paid_at, fulfilled_at, supplier_ref, " +
    "created_at, proof_mime, proof_size, proof_sender, proof_uploaded_at, proof_rejected_at, proof_reject_reason " +
    "FROM orders";
  const params = [];
  if (ORDER_STATUSES.includes(status)) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  const orders = await dbAll(env, sql, params);
  return json({ orders: orders.map((order) => orderJson(order)) }, 200, env);
}

async function handleAdminOrder(env, publicId) {
  let order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");
  order = await expireIfNeeded(env, order);
  return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
}

async function handleAdminAction(request, env, publicId, action) {
  const body = await readJson(request);
  let order = await getOrderRow(env, publicId);
  if (!order) throw new HttpError(404, "order_not_found", "Pesanan tidak ditemukan.");
  order = await expireIfNeeded(env, order);

  if (action === "paid") {
    const reference = sanitizeText(body.reference, 80);
    order = await transitionPaid(
      env,
      order,
      "Pembayaran QRIS dikonfirmasi admin." + (reference ? " Ref: " + reference : "")
    );
  } else if (action === "fulfill") {
    if (order.status === "fulfilled") {
      return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
    }
    if (order.status !== "paid") {
      throw new HttpError(409, "invalid_status", "Pesanan harus lunas sebelum diproses.");
    }
    const supplierRef = sanitizeText(body.supplier_ref, 80);
    const now = nowIso();
    await dbRun(
      env,
      "UPDATE orders SET status = 'fulfilled', fulfilled_at = ?, supplier_ref = ?, updated_at = ? WHERE id = ? AND status = 'paid'",
      [now, supplierRef, now, order.id]
    );
    await addEvent(env, order.id, "fulfilled", "Pesanan diproses." + (supplierRef ? " Ref supplier: " + supplierRef : ""));
    order = await getOrderRow(env, publicId);
  } else if (action === "reject-proof") {
    if (!order.proof_data && !order.proof_uploaded_at) {
      throw new HttpError(409, "proof_not_found", "Belum ada bukti pembayaran untuk ditolak.");
    }
    if (order.status === "fulfilled" || order.status === "cancelled") {
      throw new HttpError(409, "invalid_status", "Bukti tidak bisa ditolak pada status ini.");
    }
    const reason = sanitizeText(body.reason, 200) || "Bukti pembayaran tidak sesuai. Silakan unggah ulang.";
    const now = nowIso();
    await dbRun(
      env,
      `UPDATE orders SET proof_data = NULL, proof_mime = '', proof_size = 0, proof_sender = '', proof_note = '',
         proof_uploaded_at = NULL, proof_rejected_at = ?, proof_reject_reason = ?, updated_at = ?
       WHERE id = ?`,
      [now, reason, now, order.id]
    );
    await addEvent(env, order.id, "proof_rejected", "Bukti pembayaran ditolak: " + reason);
    order = await getOrderRow(env, publicId);
  } else if (action === "cancel") {
    if (order.status === "cancelled") {
      return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
    }
    if (order.status === "fulfilled") {
      throw new HttpError(409, "invalid_status", "Pesanan selesai tidak bisa dibatalkan.");
    }
    const now = nowIso();
    await dbRun(
      env,
      "UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?",
      [now, order.id]
    );
    await addEvent(env, order.id, "cancelled", "Pesanan dibatalkan admin.");
    order = await getOrderRow(env, publicId);
  } else {
    throw new HttpError(404, "not_found", "Aksi tidak dikenal.");
  }

  return json({ order: orderJson(order, await getOrderEvents(env, order.id)) }, 200, env);
}

async function handleQrisPreview(request, env) {
  const body = await readJson(request);
  const amount = Number(body.amount);
  const payload = String(body.payload || env.QRIS_STATIC_PAYLOAD || "").trim();
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, "invalid_amount", "Nominal tidak valid.");
  }
  try {
    const result = injectQrisAmount(payload, amount);
    return json({ payload: result.payload, amount, crc: result.crc, crc_valid: true }, 200, env);
  } catch (error) {
    throw new HttpError(400, "invalid_qris", "Payload QRIS tidak valid: " + error.message);
  }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ admin UI */

function adminPage() {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin — thegadzstore</title>
<style>
  :root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f8fafc;--card:#fff;--green:#0f9f5f;--green-2:#047857;--amber:#b45309;--red:#b91c1c;--blue:#1d4ed8}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  [hidden]{display:none!important}button{font:inherit;cursor:pointer}
  header{background:#0b1220;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  header b{font-size:16px}header small{color:#94a3b8}header button{background:#1e293b;color:#fff;border:1px solid #334155;border-radius:8px;padding:7px 12px}
  main{max-width:1100px;margin:0 auto;padding:20px}
  .login{max-width:420px;margin:60px auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
  .login h1{margin:0 0 6px;font-size:20px}.login p{margin:0 0 16px;color:var(--muted)}
  input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:9px;font:inherit}
  .primary{width:100%;margin-top:12px;padding:12px;border:0;border-radius:9px;background:var(--green);color:#fff;font-weight:700}
  .err{color:var(--red);font-size:13px;margin-top:10px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .stat small{color:var(--muted);font-size:12px}.stat b{display:block;font-size:24px;margin-top:2px}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .filters button{background:#fff;border:1px solid var(--line);border-radius:999px;padding:7px 13px;color:var(--muted)}
  .filters button.on{background:var(--ink);border-color:var(--ink);color:#fff}
  .notice{min-height:20px;color:var(--muted);font-size:13px;margin:0 0 8px}
  .orders{display:grid;gap:10px}
  .order{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .order .top{display:flex;justify-content:space-between;gap:10px;align-items:center}
  .order .id{font-weight:800;font-family:ui-monospace,Consolas,monospace}
  .order p{margin:5px 0;color:var(--muted);font-size:13px}
  .order .total{color:var(--ink);font-weight:800;font-size:16px}
  .badge{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;padding:4px 9px;border-radius:999px;background:#e2e8f0;color:#475569}
  .badge.pending{background:#fef3c7;color:var(--amber)}.badge.paid{background:#d1fae5;color:var(--green-2)}
  .badge.fulfilled{background:#dbeafe;color:var(--blue)}.badge.expired{background:#fee2e2;color:var(--red)}
  .badge.cancelled{background:#f1f5f9;color:#64748b}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .actions button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 11px}
  .actions .go{background:var(--green);border-color:var(--green);color:#fff;font-weight:700}
  .actions .done{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:700}
  .actions .no{color:var(--red)}
  .proof{margin-top:10px;padding:10px;border:1px dashed var(--line);border-radius:10px;background:#f8fafc;display:flex;gap:12px;align-items:flex-start}
  .proof img{width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#fff;display:block}
  .proof .pdf{width:96px;height:96px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:#fff;font-weight:800;color:var(--red);font-size:12px}
  .proof .meta{flex:1;min-width:0}.proof .meta b{font-size:13px}
  .proof .meta div{font-size:12px;color:var(--muted);margin-top:2px;word-break:break-word}
  .proof .meta a{color:var(--blue)}
  .proof.waiting{border-color:#fcd34d;background:#fffbeb}
  .rej{margin-top:8px;font-size:12px;color:var(--red)}
  .empty{background:#fff;border:1px dashed var(--line);border-radius:12px;padding:32px;text-align:center;color:var(--muted)}
  @media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}main{padding:14px}}
</style>
</head>
<body>
<header>
  <div><b>thegadzstore</b> <small>Admin pesanan</small></div>
  <button id="logout" hidden>Keluar</button>
</header>
<main>
  <section class="login" id="login">
    <h1>Masuk admin</h1>
    <p>Masukkan token admin untuk mengelola pesanan QRIS.</p>
    <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password" />
    <button class="primary" id="loginBtn" type="button">Masuk</button>
    <p class="err" id="loginErr" hidden></p>
  </section>

  <section id="dashboard" hidden>
    <div class="stats">
      <div class="stat"><small>Menunggu bayar</small><b id="s-pending">0</b></div>
      <div class="stat"><small>Lunas</small><b id="s-paid">0</b></div>
      <div class="stat"><small>Selesai</small><b id="s-fulfilled">0</b></div>
      <div class="stat"><small>Kedaluwarsa</small><b id="s-expired">0</b></div>
    </div>
    <div class="filters" id="filters">
      <button data-status="" class="on">Semua</button>
      <button data-status="pending">Menunggu</button>
      <button data-status="paid">Lunas</button>
      <button data-status="fulfilled">Selesai</button>
      <button data-status="expired">Kedaluwarsa</button>
      <button data-status="cancelled">Batal</button>
    </div>
    <p class="notice" id="notice"></p>
    <div class="orders" id="orders"></div>
  </section>
</main>
<script>
(function () {
  var token = sessionStorage.getItem("gadz_admin_token") || "";
  var status = "";
  var timer = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function rupiah(n) { return "Rp" + Number(n || 0).toLocaleString("id-ID"); }
  function when(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
  }
  function label(s) {
    return { pending: "Menunggu", paid: "Lunas", fulfilled: "Selesai", expired: "Kedaluwarsa", cancelled: "Batal" }[s] || s;
  }
  function api(path, method, body) {
    return fetch(path, {
      method: method || "GET",
      headers: { "authorization": "Bearer " + token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.message || "Request gagal");
        return data;
      });
    });
  }
  function showLogin(message) {
    $("login").hidden = false;
    $("dashboard").hidden = true;
    $("logout").hidden = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (message) { $("loginErr").textContent = message; $("loginErr").hidden = false; }
  }
  function showDashboard() {
    $("login").hidden = true;
    $("dashboard").hidden = false;
    $("logout").hidden = false;
    $("loginErr").hidden = true;
    if (timer) clearInterval(timer);
    timer = setInterval(load, 15000);
  }
  function actionButtons(o) {
    var html = "";
    var proof = o.proof || null;
    if (o.status === "pending") {
      if (proof) html += '<button class="go" data-act="paid" data-id="' + esc(o.public_id) + '">Tandai lunas</button>';
      if (proof) html += '<button data-act="reject-proof" data-id="' + esc(o.public_id) + '">Tolak bukti</button>';
      html += '<button class="no" data-act="cancel" data-id="' + esc(o.public_id) + '">Batalkan</button>';
    } else if (o.status === "paid") {
      html += '<button class="done" data-act="fulfill" data-id="' + esc(o.public_id) + '">Proses / kirim</button>';
      html += '<button class="no" data-act="cancel" data-id="' + esc(o.public_id) + '">Batalkan</button>';
    }
    return html;
  }
  function proofBlock(o) {
    var p = o.proof;
    var rej = o.proof_rejection;
    if (!p) {
      if (rej && o.status === "pending") {
        return '<div class="rej">Bukti terakhir ditolak ' + esc(when(rej.rejected_at)) + ': ' + esc(rej.reason) + '</div>';
      }
      return "";
    }
    var isPdf = /pdf/i.test(p.mime || "");
    var media = isPdf
      ? '<a class="pdf" href="' + esc(p.url) + '" target="_blank" rel="noopener">PDF</a>'
      : '<a href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.url) + '" alt="Bukti pembayaran" loading="lazy" /></a>';
    var sizeKb = Math.max(1, Math.round((p.size || 0) / 1024));
    return '<div class="proof' + (o.status === "pending" ? " waiting" : "") + '">' + media +
      '<div class="meta"><b>Bukti pembayaran</b>' +
      '<div>Dikirim: ' + esc(when(p.uploaded_at)) + ' · ' + sizeKb + ' KB</div>' +
      '<div>Nama pengirim: ' + esc(p.sender || "-") + '</div>' +
      (p.note ? '<div>Catatan: ' + esc(p.note) + '</div>' : '') +
      '<div><a href="' + esc(p.url) + '" target="_blank" rel="noopener">Buka file asli</a></div>' +
      '</div></div>';
  }
  function card(o) {
    var target = esc(o.player_id) + (o.zone_id ? " · Zone " + esc(o.zone_id) : "");
    return '<article class="order">' +
      '<div class="top"><span class="id">' + esc(o.public_id) + '</span><span class="badge ' + esc(o.status) + '">' + esc(label(o.status)) + '</span></div>' +
      '<p>' + esc(o.product_name) + ' · ' + esc(o.denomination_label) + '</p>' +
      '<p>Tujuan: ' + target + (o.nickname ? ' · ' + esc(o.nickname) : '') + '</p>' +
      '<p>' + when(o.created_at) + (o.expires_at && o.status === 'pending' ? ' · kedaluwarsa ' + when(o.expires_at) : '') + '</p>' +
      '<p class="total">' + rupiah(o.total) + '</p>' +
      proofBlock(o) +
      '<div class="actions">' + actionButtons(o) + '</div>' +
    '</article>';
  }
  function render(orders) {
    var counts = { pending: 0, paid: 0, fulfilled: 0, expired: 0 };
    orders.forEach(function (o) { if (counts[o.status] != null) counts[o.status]++; });
    Object.keys(counts).forEach(function (k) { $("s-" + k).textContent = counts[k]; });
    if (!orders.length) {
      $("orders").innerHTML = '<div class="empty">Belum ada pesanan untuk filter ini.</div>';
    } else {
      $("orders").innerHTML = orders.map(card).join("");
    }
    $("notice").textContent = "Diperbarui " + new Date().toLocaleTimeString("id-ID") + " · refresh otomatis 15 detik";
  }
  function load() {
    $("notice").textContent = "Memuat pesanan...";
    var path = "/api/admin/orders?limit=200" + (status ? "&status=" + encodeURIComponent(status) : "");
    api(path).then(function (data) {
      showDashboard();
      render(data.orders || []);
    }).catch(function (err) {
      if (/token|unauthorized/i.test(err.message)) {
        sessionStorage.removeItem("gadz_admin_token");
        token = "";
        showLogin("Token ditolak. Coba lagi.");
      } else {
        $("notice").textContent = "Gagal memuat: " + err.message;
      }
    });
  }
  function runAction(act, id) {
    var body = {};
    if (act === "fulfill") {
      var ref = prompt("Referensi supplier / catatan (opsional):", "");
      if (ref === null) return;
      body.supplier_ref = ref;
    }
    if (act === "reject-proof") {
      var reason = prompt("Alasan bukti ditolak (dilihat pembeli):", "Nominal tidak sesuai / bukti tidak terbaca");
      if (reason === null) return;
      body.reason = reason;
    }
    if (act === "cancel" && !confirm("Batalkan pesanan " + id + "?")) return;
    $("notice").textContent = "Memproses " + id + "...";
    api("/api/admin/orders/" + encodeURIComponent(id) + "/" + act, "POST", body)
      .then(function () { $("notice").textContent = "Pesanan " + id + " diperbarui."; load(); })
      .catch(function (err) { $("notice").textContent = "Gagal: " + err.message; });
  }

  $("loginBtn").addEventListener("click", function () {
    token = $("token").value.trim();
    if (!token) { showLogin("Token wajib diisi."); return; }
    sessionStorage.setItem("gadz_admin_token", token);
    load();
  });
  $("token").addEventListener("keydown", function (e) { if (e.key === "Enter") $("loginBtn").click(); });
  $("logout").addEventListener("click", function () {
    sessionStorage.removeItem("gadz_admin_token");
    token = "";
    showLogin("");
  });
  $("filters").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-status]");
    if (!btn) return;
    status = btn.getAttribute("data-status");
    Array.prototype.forEach.call($("filters").children, function (b) { b.classList.toggle("on", b === btn); });
    load();
  });
  $("orders").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    runAction(btn.getAttribute("data-act"), btn.getAttribute("data-id"));
  });

  if (token) load(); else showLogin("");
})();
</script>
</body>
</html>`;
}
