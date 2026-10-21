-- liquibase formatted sql

-- changeset shop:cleanup-1
ALTER TABLE product DROP COLUMN legacy_code;
CREATE INDEX order_line_sku_qty_idx ON order_line (sku, quantity);
DROP INDEX order_line_sku_idx ON order_line;
-- rollback DROP INDEX order_line_sku_qty_idx ON order_line;

-- changeset shop:cleanup-2
ALTER TABLE customer DROP FOREIGN KEY customer_ibfk_1;
ALTER TABLE customer DROP INDEX referred_by;
ALTER TABLE customer ADD CONSTRAINT customer_referred_fk FOREIGN KEY (referred_by) REFERENCES customer (id) ON DELETE CASCADE;
CREATE TABLE audit_log (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, note text);
DROP TABLE audit_log;
ALTER TABLE product DROP CHECK product_price_chk;
ALTER TABLE order_line DROP PRIMARY KEY, ADD PRIMARY KEY (purchase_ref, line_no, sku);
