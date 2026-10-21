--liquibase formatted sql

--changeset shop:cleanup-1
ALTER TABLE product DROP COLUMN IF EXISTS legacy_code;
DROP INDEX IF EXISTS order_line_sku_idx;
CREATE INDEX IF NOT EXISTS order_line_sku_idx ON order_line (sku, quantity);
--rollback DROP INDEX order_line_sku_idx;

--changeset shop:cleanup-2
ALTER TABLE customer DROP CONSTRAINT customer_referred_by_fkey;
ALTER TABLE customer DROP COLUMN referred_by;
ALTER TABLE customer ADD COLUMN referred_by bigint;
ALTER TABLE customer ADD CONSTRAINT customer_referred_fk FOREIGN KEY (referred_by) REFERENCES customer (id) ON DELETE CASCADE;
CREATE TABLE audit_log (id serial PRIMARY KEY, note text);
DROP TABLE audit_log;
ALTER TABLE product ADD CONSTRAINT product_title_key UNIQUE (title);
ALTER TABLE product DROP CONSTRAINT product_title_key;
ALTER TABLE purchase DROP CONSTRAINT orders_state_check;
ALTER TABLE product DROP CONSTRAINT product_price_check;
