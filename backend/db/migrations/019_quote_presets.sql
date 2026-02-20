-- Quote Requirements: preset-only system with is_enabled + config
-- Migration: 019_quote_presets

-- 1) Add columns
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2) Expand type CHECK
ALTER TABLE chatbot_quote_fields DROP CONSTRAINT IF EXISTS chatbot_quote_fields_type_check;
ALTER TABLE chatbot_quote_fields ADD CONSTRAINT chatbot_quote_fields_type_check
  CHECK (type IN ('text', 'number', 'select', 'boolean', 'select_multi', 'composite_dimensions'));

-- 3) Unique per company+name
CREATE UNIQUE INDEX IF NOT EXISTS idx_chatbot_quote_fields_company_name
  ON chatbot_quote_fields (company_id, name);

-- 4) Seed 11 presets for every existing company (idempotent)
INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'budget', 'number', NULL, 10, true, false,
  '{"units":["EUR","USD"],"defaultUnit":"EUR"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'budget');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'location', 'select_multi', NULL, 20, true, false, '{"options":[]}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'location');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'email_address', 'text', NULL, 30, true, false, '{}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'email_address');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'phone_number', 'text', NULL, 40, true, false, '{}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'phone_number');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'full_name', 'text', NULL, 50, true, false, '{}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'full_name');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'additional_notes', 'text', NULL, 60, true, false, '{}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'additional_notes');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'doors', 'select_multi', NULL, 70, true, false, '{"options":[]}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'doors');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'windows', 'select_multi', NULL, 80, true, false, '{"options":[]}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'windows');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'colors', 'select_multi', NULL, 90, true, false, '{"options":[]}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'colors');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'dimensions', 'composite_dimensions', 'm', 95, true, false,
  '{"enabledParts":["length","width","height"],"unit":"m"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'dimensions');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'roof', 'select_multi', NULL, 100, true, false, '{"options":[]}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'roof');
