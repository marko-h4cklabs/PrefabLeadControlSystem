-- CRM foundation: activity timeline, notes, tasks
-- Migration: 026_crm_foundation

-- 1) lead_activities
CREATE TABLE IF NOT EXISTS lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system', 'ai', 'user', 'owner', 'admin', 'sales')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source TEXT,
  channel VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_company_lead_created
  ON lead_activities (company_id, lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_activities_company_event_created
  ON lead_activities (company_id, event_type, created_at DESC);

-- 2) lead_notes
CREATE TABLE IF NOT EXISTS lead_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_notes_company_lead_created
  ON lead_notes (company_id, lead_id, created_at DESC);

-- 3) lead_tasks
CREATE TABLE IF NOT EXISTS lead_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  due_at TIMESTAMPTZ,
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_tasks_company_lead_status_due
  ON lead_tasks (company_id, lead_id, status, due_at NULLS LAST, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_tasks_company_status_due
  ON lead_tasks (company_id, status, due_at NULLS LAST);
