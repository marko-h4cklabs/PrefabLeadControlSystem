-- Voice clones table + companies voice columns
CREATE TABLE IF NOT EXISTS voice_clones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voice_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sample_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, voice_id)
);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS voice_selected_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voice_selected_name TEXT DEFAULT NULL;

-- Social proof images for chatbot
CREATE TABLE IF NOT EXISTS social_proof_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  caption TEXT,
  send_when_asked BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
