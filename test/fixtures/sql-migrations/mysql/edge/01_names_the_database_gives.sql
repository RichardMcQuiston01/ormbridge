-- Nothing below is named: MySQL names unique keys and indexes after their first column, and foreign keys
-- <table>_ibfk_<n>. Later migrations use those names.
CREATE TABLE org (
  id int NOT NULL,
  slug varchar(50) UNIQUE,
  title varchar(100) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE member (
  id int NOT NULL AUTO_INCREMENT,
  org_id int,
  alt_org_id int,
  email varchar(100) NOT NULL,
  nick varchar(50),
  score int,
  grade enum('low', 'high') NOT NULL DEFAULT 'low',
  PRIMARY KEY (id),
  UNIQUE (email, org_id),
  KEY (nick),
  KEY (org_id, score),
  FOREIGN KEY (org_id) REFERENCES org (id),
  FOREIGN KEY (alt_org_id) REFERENCES org (id) ON DELETE SET NULL
) ENGINE=InnoDB;
