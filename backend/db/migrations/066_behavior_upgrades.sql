-- Human Error Style fields
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS human_error_enabled BOOLEAN DEFAULT false;
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS human_error_types TEXT[] DEFAULT '{}';
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS human_error_random BOOLEAN DEFAULT false;

-- Randomized Delay fields
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS delay_min_seconds INTEGER DEFAULT 0;
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS delay_max_seconds INTEGER DEFAULT 0;
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS delay_random_enabled BOOLEAN DEFAULT false;
