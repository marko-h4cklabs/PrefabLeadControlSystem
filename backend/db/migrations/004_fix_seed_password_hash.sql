-- Fix seeded user password_hash to bcrypt-compatible format
-- Target: users with plaintext or invalid hash (not bcrypt $2...)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE users
SET password_hash = crypt('password', gen_salt('bf', 10))
WHERE email IN ('admin@acmeprefab.example')
  AND (password_hash IS NULL OR password_hash NOT LIKE '$2%');
