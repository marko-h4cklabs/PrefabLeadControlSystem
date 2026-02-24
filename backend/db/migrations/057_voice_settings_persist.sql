-- Voice settings persistence on companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_mode VARCHAR(20) DEFAULT 'match',
  ADD COLUMN IF NOT EXISTS voice_model VARCHAR(50) DEFAULT 'eleven_turbo_v2_5',
  ADD COLUMN IF NOT EXISTS voice_selected_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voice_selected_name TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voice_stability NUMERIC(3,2) DEFAULT 0.50,
  ADD COLUMN IF NOT EXISTS voice_similarity_boost NUMERIC(3,2) DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS voice_style NUMERIC(3,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS voice_speaker_boost BOOLEAN DEFAULT true;

-- Ensure chatbot_behavior has unique company constraint (for ON CONFLICT)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chatbot_behavior_company_id_key'
  ) THEN
    ALTER TABLE chatbot_behavior ADD CONSTRAINT chatbot_behavior_company_id_key UNIQUE (company_id);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Ensure chatbot_quote_fields has unique (company_id, name) for upserts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chatbot_quote_fields_company_name_key'
  ) THEN
    ALTER TABLE chatbot_quote_fields ADD CONSTRAINT chatbot_quote_fields_company_name_key UNIQUE (company_id, name);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
