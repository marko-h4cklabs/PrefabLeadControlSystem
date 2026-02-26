-- Add full_name column to users table (used by signup and Google OAuth)
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT NULL;
