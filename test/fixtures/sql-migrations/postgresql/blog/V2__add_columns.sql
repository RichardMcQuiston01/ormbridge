ALTER TABLE author ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE post ADD COLUMN summary text, ADD COLUMN rating numeric(4, 2);
ALTER TABLE tag ADD COLUMN slug varchar(60);
UPDATE tag SET slug = lower(label);
