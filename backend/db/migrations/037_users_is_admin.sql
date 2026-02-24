-- Migration 037: Add is_admin flag to users for super-admin access to /api/admin/*
-- After running this migration, set your user as admin (run once):
--   UPDATE users SET is_admin = true WHERE email = 'kcasni@gmail.com';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin) WHERE is_admin = true;
