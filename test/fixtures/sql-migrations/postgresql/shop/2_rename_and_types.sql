-- The foreign keys, the composite key and the check follow the renames.
ALTER TABLE orders RENAME TO purchase;
ALTER TABLE purchase RENAME COLUMN id TO purchase_id;
ALTER TABLE purchase RENAME COLUMN state TO status;
ALTER TABLE order_line RENAME COLUMN order_id TO purchase_ref;

ALTER TABLE customer ALTER COLUMN email TYPE varchar(320);
ALTER TABLE product ALTER COLUMN price TYPE numeric(12, 2) USING price::numeric(12, 2);
ALTER TABLE product ADD COLUMN IF NOT EXISTS legacy_code varchar(20);
ALTER TABLE product ALTER COLUMN tags SET DEFAULT '{}';
ALTER TABLE purchase ALTER COLUMN status DROP DEFAULT;
ALTER TABLE customer ALTER COLUMN full_name DROP NOT NULL;
