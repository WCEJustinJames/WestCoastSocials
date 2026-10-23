-- Atomic claim support for batch sends: prevents two sync windows from
-- double-sending the same item. 'sending' marks an item claimed by one
-- worker; claimed_at lets a crashed worker's in-flight item be reclaimed.
ALTER TYPE inbox_batch_item_status ADD VALUE IF NOT EXISTS 'sending';
ALTER TABLE inbox_batch_items ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
