-- Custom quote fields: is_custom, variable_name, field_type, label
-- Migration: 052_custom_quote_fields

ALTER TABLE chatbot_quote_fields
  ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS variable_name VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS field_type VARCHAR(20) DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS label VARCHAR(255) DEFAULT NULL;

-- Auto-generate variable names for existing (preset) fields if not set
UPDATE chatbot_quote_fields
SET variable_name = LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '_', 'g'))
WHERE variable_name IS NULL;
