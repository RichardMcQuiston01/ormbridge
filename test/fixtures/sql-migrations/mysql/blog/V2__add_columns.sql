ALTER TABLE author ADD COLUMN created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE post ADD COLUMN summary varchar(100), ADD COLUMN rating decimal(4, 2) AFTER views;
ALTER TABLE tag ADD COLUMN slug varchar(60) FIRST;
UPDATE tag SET slug = lower(label);
