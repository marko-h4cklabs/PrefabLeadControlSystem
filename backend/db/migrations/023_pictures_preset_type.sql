-- Pictures preset: change type from boolean to pictures (attachments-only, never extracted by Claude)
-- Migration: 023_pictures_preset_type

-- 1) Expand type CHECK to include 'pictures'
ALTER TABLE chatbot_quote_fields DROP CONSTRAINT IF EXISTS chatbot_quote_fields_type_check;
ALTER TABLE chatbot_quote_fields ADD CONSTRAINT chatbot_quote_fields_type_check
  CHECK (type IN ('text', 'number', 'select', 'boolean', 'select_multi', 'composite_dimensions', 'pictures'));

-- 2) Update existing pictures rows from boolean to pictures
UPDATE chatbot_quote_fields
SET type = 'pictures'
WHERE name = 'pictures' AND type = 'boolean';
