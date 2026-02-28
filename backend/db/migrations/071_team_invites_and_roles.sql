-- Migration 071: Team invites, roles, setter availability, DM disposition, notification channels
-- Part of Co-Pilot v2: Team System

-- 1. Add 'owner' and 'setter' to users.role CHECK constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner','admin','sales','member','setter'));

-- 2. Team invites table
CREATE TABLE IF NOT EXISTS team_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(8) NOT NULL UNIQUE,
  role VARCHAR(50) NOT NULL DEFAULT 'setter',
  created_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  max_uses INT DEFAULT NULL,
  used_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_invites_code ON team_invites(code) WHERE is_active = true;

-- 3. Setter availability + capacity on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS setter_status VARCHAR(20) DEFAULT 'offline';
ALTER TABLE users ADD COLUMN IF NOT EXISTS setter_status_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_concurrent_dms INT DEFAULT 20;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) DEFAULT 'owner';

-- 4. Company assignment config
ALTER TABLE companies ADD COLUMN IF NOT EXISTS assignment_mode VARCHAR(20) DEFAULT 'manual';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_max_concurrent_dms INT DEFAULT 20;

-- 5. DM disposition on leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_status VARCHAR(20) DEFAULT 'active';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_status_updated_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_status_updated_by UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_leads_dm_status ON leads(company_id, dm_status);

-- 6. Notification channel preferences
CREATE TABLE IF NOT EXISTS notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type VARCHAR(30) NOT NULL,
  channel_config JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, channel_type)
);
