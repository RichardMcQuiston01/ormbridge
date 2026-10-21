DROP INDEX post_headline_idx;
ALTER TABLE tag DROP CONSTRAINT tag_created_by_fk;
ALTER TABLE tag DROP COLUMN created_by;
ALTER TABLE post DROP COLUMN legacy_flag;
ALTER TABLE writer DROP CONSTRAINT writer_email_key;
DROP TABLE IF EXISTS scratch;
TRUNCATE tag CASCADE;
