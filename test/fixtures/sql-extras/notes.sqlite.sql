-- SQLite: a .dump-like script with type affinity names and quoting styles.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE "notebook" (
  "id" INTEGER PRIMARY KEY,
  "title" TEXT NOT NULL,
  "created" DATETIME DEFAULT (datetime('now')),
  "archived" BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE [note] (
  id integer primary key autoincrement,
  notebook_id integer not null references notebook(id) on delete cascade,
  body,
  priority integer default 3 check (priority between 1 and 5),
  kind text check (kind in ('todo', 'idea', 'quote')),
  weight real,
  price numeric(8,2),
  flags UNSIGNED BIG INT,
  `attachment` BLOB,
  fingerprint VARYING CHARACTER(24),
  word_count integer GENERATED ALWAYS AS (length(body)) VIRTUAL,
  due DATE DEFAULT CURRENT_DATE
);

CREATE TABLE tag (
  name TEXT PRIMARY KEY NOT NULL,
  colour CHARACTER(7) DEFAULT '#ffffff'
) WITHOUT ROWID;

CREATE TABLE note_tag (
  note_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag),
  FOREIGN KEY (note_id) REFERENCES note (id) ON DELETE CASCADE,
  FOREIGN KEY (tag) REFERENCES tag (name) ON DELETE CASCADE ON UPDATE CASCADE
) WITHOUT ROWID;

INSERT INTO notebook VALUES (1, 'Inbox; today', '2024-01-01', 0);

CREATE UNIQUE INDEX idx_note_kind_priority ON note (kind, priority DESC);
CREATE INDEX idx_note_open ON note (due) WHERE kind IS NOT NULL;

CREATE TRIGGER note_ai AFTER INSERT ON note
BEGIN
  UPDATE notebook SET title = title WHERE id = NEW.notebook_id;
  INSERT INTO tag (name) VALUES ('auto');
END;

COMMIT;
