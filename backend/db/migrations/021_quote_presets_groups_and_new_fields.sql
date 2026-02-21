-- Quote presets: groups (basic/detailed), new fields, unique constraint
-- Migration: 021_quote_presets_groups_and_new_fields (idempotent)

-- 1) Ensure columns exist
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 10;

-- 2) Expand type CHECK to include boolean
ALTER TABLE chatbot_quote_fields DROP CONSTRAINT IF EXISTS chatbot_quote_fields_type_check;
ALTER TABLE chatbot_quote_fields ADD CONSTRAINT chatbot_quote_fields_type_check
  CHECK (type IN ('text', 'number', 'select', 'boolean', 'select_multi', 'composite_dimensions'));

-- 3) Unique constraint on (company_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chatbot_quote_fields_company_name
  ON chatbot_quote_fields (company_id, name);

-- 4) Add quote_snapshot to chat_conversations for snapshot-per-conversation
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS quote_snapshot JSONB;

-- 5) Update existing presets: add group to config, adjust priority for DETAILED
UPDATE chatbot_quote_fields SET config = config || '{"group":"basic"}'::jsonb, priority = 10
WHERE name = 'budget' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"basic"}'::jsonb, priority = 20
WHERE name = 'location' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"basic"}'::jsonb, priority = 40
WHERE name = 'email_address' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"basic"}'::jsonb, priority = 50
WHERE name = 'phone_number' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"basic"}'::jsonb, priority = 60
WHERE name = 'full_name' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"basic"}'::jsonb, priority = 70
WHERE name = 'additional_notes' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"detailed"}'::jsonb, priority = 200
WHERE name = 'doors' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"detailed"}'::jsonb, priority = 210
WHERE name = 'windows' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"detailed"}'::jsonb, priority = 220
WHERE name = 'colors' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"detailed"}'::jsonb, priority = 230
WHERE name = 'dimensions' AND (config->>'group') IS NULL;

UPDATE chatbot_quote_fields SET config = config || '{"group":"detailed"}'::jsonb, priority = 240
WHERE name = 'roof' AND (config->>'group') IS NULL;

-- 6) Seed new presets (idempotent)
INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'time_window', 'select_multi', NULL, 30, true, false,
  '{"options":[],"group":"basic"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'time_window');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'pictures', 'boolean', NULL, 80, true, false, '{"group":"basic"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'pictures');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'object_type', 'select_multi', NULL, 90, true, false, '{"options":[],"group":"basic"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'object_type');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'ground_condition', 'select_multi', NULL, 250, true, false, '{"options":[],"group":"detailed"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'ground_condition');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'utility_connections', 'select_multi', NULL, 260, true, false, '{"options":[],"group":"detailed"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'utility_connections');

INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
SELECT c.id, 'completion_level', 'select_multi', NULL, 270, true, false,
  '{"options":["Structural phase","Fully finished turnkey"],"group":"detailed"}'::jsonb
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chatbot_quote_fields q WHERE q.company_id = c.id AND q.name = 'completion_level');
