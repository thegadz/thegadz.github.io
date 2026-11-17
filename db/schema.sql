PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  unit TEXT NOT NULL DEFAULT '',
  short TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '🎮',
  color TEXT NOT NULL DEFAULT '#0f766e',
  image TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT 'player',
  requires_zone INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, active, sort);

CREATE TABLE IF NOT EXISTS denominations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  label TEXT NOT NULL,
  price INTEGER NOT NULL,
  compare_at INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL UNIQUE,
  supplier_code TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_denominations_product ON denominations(product_id, active, sort);

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

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL,
  product_slug TEXT NOT NULL,
  product_name TEXT NOT NULL,
  denomination_id INTEGER NOT NULL,
  denomination_label TEXT NOT NULL,
  player_id TEXT NOT NULL,
  zone_id TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'QRIS',
  status TEXT NOT NULL DEFAULT 'pending',
  qr_payload TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  fulfilled_at TEXT,
  supplier_ref TEXT,
  proof_data TEXT,
  proof_mime TEXT NOT NULL DEFAULT '',
  proof_size INTEGER NOT NULL DEFAULT 0,
  proof_sender TEXT NOT NULL DEFAULT '',
  proof_note TEXT NOT NULL DEFAULT '',
  proof_uploaded_at TEXT,
  proof_rejected_at TEXT,
  proof_reject_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(status, expires_at);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
