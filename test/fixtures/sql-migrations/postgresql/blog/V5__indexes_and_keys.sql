CREATE INDEX post_headline_idx ON post (headline);
CREATE UNIQUE INDEX tag_label_key ON tag (label);
CREATE INDEX post_writer_status_idx ON post (author_id, status DESC);
ALTER TABLE tag ADD COLUMN created_by integer;
ALTER TABLE tag ADD CONSTRAINT tag_created_by_fk FOREIGN KEY (created_by) REFERENCES writer (id) ON DELETE SET NULL;
CREATE TABLE post_tag (
  post_id integer NOT NULL REFERENCES post (id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
