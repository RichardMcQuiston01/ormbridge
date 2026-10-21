CREATE TABLE customer (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  full_name text NOT NULL,
  referred_by bigint REFERENCES customer (id) ON DELETE SET NULL,
  CONSTRAINT customer_email_key UNIQUE (email)
);

CREATE TABLE product (
  sku varchar(20) PRIMARY KEY,
  title varchar(120) NOT NULL,
  price numeric(10, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  tags text[]
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customer (id) ON DELETE RESTRICT,
  placed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state varchar(10) NOT NULL DEFAULT 'new',
  CONSTRAINT orders_state_check CHECK (state IN ('new', 'paid', 'shipped'))
);

CREATE TABLE order_line (
  order_id integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  sku varchar(20) NOT NULL REFERENCES product (sku),
  quantity integer NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, line_no)
);

CREATE INDEX order_line_sku_idx ON order_line (sku);
