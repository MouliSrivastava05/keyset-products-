-- Enable pgcrypto for gen_random_uuid() if on older Postgres versions (Postgres 13+ has it built-in)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for global (unfiltered) keyset pagination: newest first
CREATE INDEX IF NOT EXISTS idx_products_created_id
  ON products (created_at DESC, id DESC);

-- Index for category-filtered keyset pagination: newest first within category
CREATE INDEX IF NOT EXISTS idx_products_category_created_id
  ON products (category, created_at DESC, id DESC);
