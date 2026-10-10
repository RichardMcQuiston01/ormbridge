-- The canonical blog schema as SQLite DDL.
PRAGMA foreign_keys = ON;

CREATE TABLE blog_user (
    id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE blog_category (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL,
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(50) NOT NULL,
    parent_id INTEGER REFERENCES blog_category (id) ON DELETE SET NULL
);

CREATE TABLE blog_tag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label VARCHAR(50) NOT NULL
);

CREATE TABLE blog_post (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL,
    public_id CHAR(36) NOT NULL UNIQUE,
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    rating DECIMAL(4, 2),
    view_count INTEGER NOT NULL DEFAULT 0,
    is_featured BOOLEAN NOT NULL DEFAULT 0,
    published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSON NOT NULL DEFAULT '{}',
    author_id INTEGER NOT NULL REFERENCES blog_user (id) ON DELETE CASCADE,
    editor_id INTEGER REFERENCES blog_user (id) ON DELETE SET NULL,
    category_id INTEGER NOT NULL REFERENCES blog_category (id) ON DELETE RESTRICT,
    UNIQUE (author_id, title)
);

CREATE INDEX blog_post_title_idx ON blog_post (title);
CREATE INDEX post_pub_status_idx ON blog_post (published_at, status);

CREATE TABLE blog_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bio TEXT,
    avatar VARCHAR(100),
    user_id INTEGER NOT NULL UNIQUE REFERENCES blog_user (id) ON DELETE CASCADE
);

CREATE TABLE blog_post_tags (
    post_id INTEGER NOT NULL REFERENCES blog_post (id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES blog_tag (id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
);
