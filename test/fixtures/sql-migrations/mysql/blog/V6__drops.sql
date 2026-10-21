DROP INDEX post_headline_idx ON post;
ALTER TABLE tag DROP FOREIGN KEY tag_created_by_fk;
ALTER TABLE tag DROP INDEX tag_created_by_fk, DROP COLUMN created_by;
ALTER TABLE post DROP COLUMN legacy_flag;
ALTER TABLE writer DROP INDEX writer_email_key;
DROP TABLE IF EXISTS scratch;
TRUNCATE TABLE post_tag;
DELETE FROM tag;
