-- Support multiple chatbot languages instead of a single language_code
ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS language_codes TEXT[] DEFAULT '{en}';

-- Migrate existing language_code values into the new array column
UPDATE chatbot_behavior
SET language_codes = ARRAY[language_code]
WHERE language_code IS NOT NULL AND language_code != 'en';
