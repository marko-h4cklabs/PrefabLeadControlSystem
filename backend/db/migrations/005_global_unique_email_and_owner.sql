-- Global unique email (case-insensitive) + owner role for signup
-- Drop per-company email unique, add global unique on LOWER(email)
-- Add 'owner' to allowed roles

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_company_id_email_key;
CREATE UNIQUE INDEX users_email_lower_unique ON users (LOWER(email));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sales', 'owner'));
