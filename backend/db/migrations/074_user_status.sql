-- Migration 074: User status state machine + email verification codes
-- Replaces boolean email_verified gating with status-based access control

-- 1. Add status column
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'active';

-- 2. Add verification code columns (bcrypt-hashed 6-digit codes)
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_attempts INT DEFAULT 0;

-- 3. CHECK constraint for valid status values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_status_check
      CHECK (status IN ('email_unverified','pending_onboarding','active','team_pending','team_active'));
  END IF;
END $$;

-- 4. Backfill existing users based on email_verified + account_type
UPDATE users SET status = 'active' WHERE email_verified = true AND account_type = 'owner';
UPDATE users SET status = 'team_active' WHERE email_verified = true AND account_type = 'team_member';
UPDATE users SET status = 'email_unverified' WHERE email_verified = false AND account_type = 'owner';
UPDATE users SET status = 'team_pending' WHERE email_verified = false AND account_type = 'team_member';

-- 5. Index for status-based lookups
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
