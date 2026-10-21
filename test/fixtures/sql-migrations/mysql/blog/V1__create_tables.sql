-- Flyway migration 1: the first tables.
CREATE TABLE author (
  id int NOT NULL AUTO_INCREMENT,
  name varchar(100) NOT NULL,
  email varchar(200) NOT NULL,
  bio text,
  PRIMARY KEY (id),
  UNIQUE KEY author_email_key (email)
) ENGINE=InnoDB;

CREATE TABLE post (
  id int NOT NULL AUTO_INCREMENT,
  author_id int NOT NULL,
  title varchar(200) NOT NULL,
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  views int NOT NULL DEFAULT 0,
  legacy_flag tinyint(1) DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT post_author_fk FOREIGN KEY (author_id) REFERENCES author (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE tag (
  id int NOT NULL AUTO_INCREMENT,
  label varchar(50) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE scratch (
  id int NOT NULL,
  note text,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT INTO tag (label) VALUES ('first'), ('second');
