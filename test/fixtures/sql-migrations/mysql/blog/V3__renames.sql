RENAME TABLE author TO writer;
ALTER TABLE writer RENAME COLUMN name TO full_name;
ALTER TABLE post CHANGE COLUMN title headline varchar(250) NOT NULL;
ALTER TABLE writer RENAME INDEX author_email_key TO writer_email_key;
