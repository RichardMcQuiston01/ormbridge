-- The canonical blog schema as PostgreSQL DDL.
CREATE TYPE post_status AS ENUM ('draft', 'published');

CREATE TABLE blog_user (
    id serial PRIMARY KEY
);

CREATE TABLE blog_category (
    id serial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    name varchar(100) NOT NULL UNIQUE,
    slug varchar(50) NOT NULL,
    parent_id integer REFERENCES blog_category (id) ON DELETE SET NULL
);

CREATE TABLE blog_tag (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label varchar(50) NOT NULL
);

CREATE TABLE blog_post (
    id serial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    title varchar(200) NOT NULL,
    body text NOT NULL,
    status post_status NOT NULL DEFAULT 'draft',
    rating numeric(4, 2),
    view_count integer NOT NULL DEFAULT 0,
    is_featured boolean NOT NULL DEFAULT false,
    published_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    author_id integer NOT NULL REFERENCES blog_user (id) ON DELETE CASCADE,
    editor_id integer REFERENCES blog_user (id) ON DELETE SET NULL,
    category_id integer NOT NULL,
    CONSTRAINT blog_post_author_id_title_key UNIQUE (author_id, title)
);

ALTER TABLE blog_post
    ADD CONSTRAINT blog_post_category_id_fkey FOREIGN KEY (category_id)
    REFERENCES blog_category (id) ON DELETE RESTRICT;

CREATE INDEX blog_post_title_idx ON blog_post (title);
CREATE INDEX post_pub_status_idx ON blog_post (published_at, status);

CREATE TABLE blog_profile (
    id serial PRIMARY KEY,
    bio text,
    avatar varchar(100),
    user_id integer NOT NULL UNIQUE REFERENCES blog_user (id) ON DELETE CASCADE
);

CREATE TABLE blog_post_tags (
    post_id integer NOT NULL REFERENCES blog_post (id) ON DELETE CASCADE,
    tag_id integer NOT NULL REFERENCES blog_tag (id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
);

COMMENT ON TABLE blog_post IS 'Posts written by users';
COMMENT ON COLUMN blog_post.title IS 'The headline';
