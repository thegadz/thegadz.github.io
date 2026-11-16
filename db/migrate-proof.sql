-- Manual payment proof columns (GoPay QRIS static mode).
-- SQLite has no ADD COLUMN IF NOT EXISTS, so this file is a readable record of the
-- migration only. workers/deploy-store.ps1 applies it idempotently: it reads
-- PRAGMA table_info(orders) and runs each ALTER only for columns that are missing.
ALTER TABLE orders ADD COLUMN proof_data TEXT;
ALTER TABLE orders ADD COLUMN proof_mime TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN proof_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN proof_sender TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN proof_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN proof_uploaded_at TEXT;
ALTER TABLE orders ADD COLUMN proof_rejected_at TEXT;
ALTER TABLE orders ADD COLUMN proof_reject_reason TEXT NOT NULL DEFAULT '';
