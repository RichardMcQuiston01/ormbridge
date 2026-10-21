CREATE TABLE customer (
  id INT8 PRIMARY KEY DEFAULT unique_rowid(),
  email STRING(255) NOT NULL,
  full_name STRING,
  referred_by INT8 REFERENCES customer (id) ON DELETE SET NULL,
  CONSTRAINT customer_email_key UNIQUE (email)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id INT8 NOT NULL REFERENCES customer (id),
  state STRING NOT NULL DEFAULT 'new',
  total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  INDEX orders_customer_idx (customer_id)
);

CREATE INDEX orders_state_idx ON orders (state);
