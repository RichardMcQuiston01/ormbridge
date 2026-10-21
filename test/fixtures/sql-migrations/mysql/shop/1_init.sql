CREATE TABLE customer (
  id bigint NOT NULL AUTO_INCREMENT,
  email varchar(255) NOT NULL,
  full_name varchar(200) NOT NULL,
  referred_by bigint DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY email (email),
  KEY referred_by (referred_by),
  CONSTRAINT customer_ibfk_1 FOREIGN KEY (referred_by) REFERENCES customer (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE product (
  sku varchar(20) NOT NULL,
  title varchar(120) NOT NULL,
  price decimal(10, 2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (sku),
  CONSTRAINT product_price_chk CHECK (price >= 0)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id int NOT NULL AUTO_INCREMENT,
  customer_id bigint NOT NULL,
  placed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state varchar(10) NOT NULL DEFAULT 'new',
  PRIMARY KEY (id),
  FOREIGN KEY (customer_id) REFERENCES customer (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE order_line (
  order_id int NOT NULL,
  line_no int NOT NULL,
  sku varchar(20) NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, line_no),
  KEY order_line_sku_idx (sku),
  CONSTRAINT fk_line_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_line_sku FOREIGN KEY (sku) REFERENCES product (sku)
) ENGINE=InnoDB;
