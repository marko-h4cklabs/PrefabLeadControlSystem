-- Company-configurable lead statuses
-- Migration: 012_lead_statuses

-- 1) Create company_lead_statuses table
CREATE TABLE IF NOT EXISTS company_lead_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_company_lead_statuses_company ON company_lead_statuses(company_id);
CREATE INDEX IF NOT EXISTS idx_company_lead_statuses_sort ON company_lead_statuses(company_id, sort_order);

-- 2) Add status_id to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status_id UUID REFERENCES company_lead_statuses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_status_id ON leads(company_id, status_id);

-- 3) Seed default statuses per existing company
INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'New', 10, true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'New'
);

INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'Qualified', 20, false
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'Qualified'
);

INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'Disqualified', 30, false
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'Disqualified'
);

INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'Pending review', 40, false
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'Pending review'
);

-- 4) Set leads with status_id null to company's default status
UPDATE leads l
SET status_id = (
  SELECT cls.id FROM company_lead_statuses cls
  WHERE cls.company_id = l.company_id AND cls.is_default = true
  LIMIT 1
)
WHERE l.status_id IS NULL;
