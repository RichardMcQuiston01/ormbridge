-- No constraint or index below is named: PostgreSQL names them, and later migrations use those names.
CREATE TYPE level AS ENUM ('low', 'high');

CREATE TABLE public.org (
  id integer PRIMARY KEY,
  slug text UNIQUE,
  title text NOT NULL
);

CREATE TABLE public.member (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id integer REFERENCES public.org (id),
  alt_org_id integer REFERENCES public.org (id) ON DELETE SET NULL,
  email text NOT NULL,
  nick text,
  score integer CHECK (score >= 0),
  rank level NOT NULL DEFAULT 'low',
  UNIQUE (org_id, email)
);

CREATE INDEX ON public.member (nick);
CREATE INDEX ON public.member (org_id, score);
CREATE UNIQUE INDEX ON public.member (alt_org_id, nick);
