-- Add qualification_prompt column to chatbot_quote_fields
-- Stores AI-driven qualification instructions per field (e.g. "minimum budget €5000 to qualify")
ALTER TABLE chatbot_quote_fields
  ADD COLUMN IF NOT EXISTS qualification_prompt TEXT DEFAULT NULL;
