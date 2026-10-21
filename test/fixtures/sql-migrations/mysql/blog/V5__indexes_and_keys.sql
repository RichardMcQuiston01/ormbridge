CREATE INDEX post_headline_idx ON post (headline);
CREATE UNIQUE INDEX tag_label_key ON tag (label);
CREATE INDEX post_writer_status_idx ON post (author_id, status DESC);
ALTER TABLE tag ADD COLUMN created_by int NULL;
ALTER TABLE tag ADD CONSTRAINT tag_created_by_fk FOREIGN KEY (created_by) REFERENCES writer (id) ON DELETE SET NULL;
CREATE TABLE post_tag (
  post_id int NOT NULL,
  tag_id int NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  CONSTRAINT post_tag_post_fk FOREIGN KEY (post_id) REFERENCES post (id) ON DELETE CASCADE,
  CONSTRAINT post_tag_tag_fk FOREIGN KEY (tag_id) REFERENCES tag (id) ON DELETE CASCADE
) ENGINE=InnoDB;
