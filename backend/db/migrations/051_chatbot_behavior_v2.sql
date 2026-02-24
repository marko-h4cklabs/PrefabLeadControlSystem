-- Chatbot behavior v2: additional customization fields for natural, human-like conversation

ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS prohibited_topics TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS competitor_mentions VARCHAR(20) DEFAULT 'deflect',
  ADD COLUMN IF NOT EXISTS price_reveal VARCHAR(20) DEFAULT 'ask_first',
  ADD COLUMN IF NOT EXISTS closing_style VARCHAR(20) DEFAULT 'soft',
  ADD COLUMN IF NOT EXISTS language_code VARCHAR(10) DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS response_delay_seconds INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_messages_before_handoff INTEGER DEFAULT 20,
  ADD COLUMN IF NOT EXISTS urgency_style VARCHAR(20) DEFAULT 'genuine',
  ADD COLUMN IF NOT EXISTS social_proof_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS social_proof_examples TEXT DEFAULT NULL;
