-- Fix role constraint (allow owner, admin, sales, member) and enforce global email uniqueness
-- Required for signup/login without companyId

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin', 'sales', 'member'));

-- Drop per-company email unique so we can enforce global uniqueness
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_company_id_email_key;

-- Global unique email (case-insensitive)
-- Fails with duplicate key error if duplicate emails exist - resolve manually before running
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_lower_idx ON users (LOWER(email));
