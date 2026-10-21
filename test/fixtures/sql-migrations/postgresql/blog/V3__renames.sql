ALTER TABLE author RENAME TO writer;
ALTER TABLE writer RENAME COLUMN name TO full_name;
ALTER TABLE post RENAME COLUMN title TO headline;
ALTER TABLE post RENAME CONSTRAINT post_author_fk TO post_writer_fk;
ALTER INDEX author_email_key RENAME TO writer_email_key;
