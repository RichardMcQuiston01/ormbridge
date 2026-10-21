-- The foreign keys and the composite key follow the renames.
RENAME TABLE orders TO purchase;
ALTER TABLE purchase RENAME COLUMN id TO purchase_id;
ALTER TABLE purchase RENAME COLUMN state TO status;
ALTER TABLE order_line CHANGE order_id purchase_ref int NOT NULL;

ALTER TABLE customer MODIFY email varchar(320) NOT NULL;
ALTER TABLE product MODIFY price decimal(12, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE product ADD COLUMN (legacy_code varchar(20), is_active tinyint(1) NOT NULL DEFAULT 1);
ALTER TABLE purchase ALTER COLUMN status DROP DEFAULT;
ALTER TABLE customer MODIFY full_name varchar(200) NULL AFTER email;
