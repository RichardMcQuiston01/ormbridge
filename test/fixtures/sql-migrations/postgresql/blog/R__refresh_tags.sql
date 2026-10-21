-- A repeatable Flyway migration runs after every versioned one. It only changes data, so nothing is replayed.
INSERT INTO tag (label, slug) VALUES ('repeatable', 'repeatable');
