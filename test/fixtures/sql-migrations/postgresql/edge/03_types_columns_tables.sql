ALTER TYPE level ADD VALUE 'mid' BEFORE 'high';
ALTER TYPE level RENAME VALUE 'low' TO 'minimal';
ALTER TYPE level RENAME TO tier;
ALTER TABLE member ALTER COLUMN rank SET DEFAULT 'mid';
ALTER TABLE member RENAME COLUMN rank TO tier;

ALTER TABLE member ADD COLUMN notes text, ADD COLUMN flags integer[] DEFAULT '{}', ADD COLUMN created timestamp without time zone DEFAULT now();
ALTER TABLE member ALTER COLUMN notes TYPE varchar(400);
ALTER TABLE member ALTER COLUMN flags TYPE smallint[] USING flags::smallint[];
ALTER TABLE member DROP COLUMN nick, DROP COLUMN created;

CREATE TABLE temp_data (id integer PRIMARY KEY, org_id integer REFERENCES org (id));
CREATE INDEX temp_data_org_idx ON temp_data (org_id);
ALTER TABLE temp_data RENAME TO scratch_data;
DROP TABLE scratch_data;
DROP TABLE IF EXISTS scratch_data;

ALTER TABLE member ADD CONSTRAINT member_id_key UNIQUE (id);
CREATE TABLE audit (id serial PRIMARY KEY, member_id integer NOT NULL REFERENCES member (id));
ALTER TABLE audit ADD COLUMN reviewer_id integer;
ALTER TABLE audit ADD CONSTRAINT audit_reviewer_fk FOREIGN KEY (reviewer_id) REFERENCES member (id) ON DELETE SET NULL;
