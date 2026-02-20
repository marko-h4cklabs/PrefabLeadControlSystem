-- Seed default lead statuses for existing companies
-- Migration: 013_seed_default_company_lead_statuses

-- Ensure only one default per company (keep "New" as default)
UPDATE company_lead_statuses
SET is_default = false
WHERE name != 'New' AND is_default = true;

UPDATE company_lead_statuses
SET is_default = true
WHERE name = 'New';

-- Insert missing statuses for each company (ON CONFLICT DO NOTHING)
INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'New', 10, true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'New')
ON CONFLICT (company_id, name) DO NOTHING;

INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'Qualified', 20, false
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'Qualified')
ON CONFLICT (company_id, name) DO NOTHING;

INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'Disqualified', 30, false
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'Disqualified')
ON CONFLICT (company_id, name) DO NOTHING;

INSERT INTO company_lead_statuses (company_id, name, sort_order, is_default)
SELECT c.id, 'Pending review', 40, false
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM company_lead_statuses cls WHERE cls.company_id = c.id AND cls.name = 'Pending review')
ON CONFLICT (company_id, name) DO NOTHING;
