-- The output of SHOW CREATE ALL TYPES and SHOW CREATE ALL TABLES on CockroachDB v26.3.2 for a small shop schema.
CREATE TYPE public.status AS ENUM ('draft', 'published');
CREATE SEQUENCE public.order_seq MINVALUE 1 MAXVALUE 9223372036854775807 INCREMENT 1 START 1;
CREATE TABLE public.accounts (
	id INT8 NOT NULL DEFAULT unique_rowid(),
	email STRING NOT NULL,
	display_name STRING(60) NULL,
	age INT4 NULL,
	level INT2 NOT NULL DEFAULT 1:::INT8,
	score FLOAT8 NULL,
	ratio FLOAT4 NULL,
	balance DECIMAL(12,2) NOT NULL DEFAULT 0:::DECIMAL,
	active BOOL NOT NULL DEFAULT true,
	avatar BYTES NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now():::TIMESTAMPTZ,
	uid UUID NOT NULL DEFAULT gen_random_uuid(),
	prefs JSONB NULL,
	tags STRING[] NULL,
	ip INET NULL,
	state public.status NOT NULL DEFAULT 'draft':::public.status,
	CONSTRAINT accounts_pkey PRIMARY KEY (id ASC),
	UNIQUE INDEX accounts_email_key (email ASC),
	INDEX accounts_age_idx (age DESC) STORING (display_name),
	INVERTED INDEX accounts_prefs_idx (prefs),
	INDEX accounts_created_idx (created_at ASC) WHERE active
) WITH (schema_locked = true);
CREATE TABLE public.orders (
	id INT4 NOT NULL DEFAULT nextval('public.order_seq'::REGCLASS),
	account_id INT8 NOT NULL,
	placed TIMESTAMP NOT NULL DEFAULT now():::TIMESTAMP,
	note STRING NULL DEFAULT 'none':::STRING,
	CONSTRAINT orders_pkey PRIMARY KEY (id ASC),
	UNIQUE INDEX orders_account_id_placed_key (account_id ASC, placed ASC)
) WITH (schema_locked = true);
CREATE TABLE public.order_lines (
	order_id INT4 NOT NULL,
	line INT2 NOT NULL,
	sku STRING NOT NULL,
	crdb_internal_sku_shard_4 INT8 NOT VISIBLE NOT NULL AS (mod(fnv32(md5(crdb_internal.datums_to_bytes(sku))), 4:::INT8)) VIRTUAL,
	CONSTRAINT order_lines_pkey PRIMARY KEY (order_id ASC, line ASC),
	INDEX order_lines_sku_idx (sku ASC) USING HASH WITH (bucket_count=4)
) WITH (schema_locked = true);
CREATE TABLE public.events (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	payload JSONB NOT NULL DEFAULT '{}':::JSONB,
	at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp():::TIMESTAMPTZ,
	kind INT4 NOT NULL DEFAULT 0:::INT8,
	doubled INT4 NULL AS (kind * 2:::INT8) STORED,
	CONSTRAINT events_pkey PRIMARY KEY (id ASC)
) WITH (schema_locked = true);
ALTER TABLE public.orders ADD CONSTRAINT orders_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public.order_lines ADD CONSTRAINT order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);
-- Validate foreign key constraints. These can fail if there was unvalidated data during the SHOW CREATE ALL TABLES
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_account_id_fkey;
ALTER TABLE public.order_lines VALIDATE CONSTRAINT order_lines_order_id_fkey;
