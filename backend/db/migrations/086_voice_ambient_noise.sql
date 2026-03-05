-- Add configurable ambient background noise for voice messages (e.g. 'restaurant')
ALTER TABLE companies ADD COLUMN IF NOT EXISTS voice_ambient_noise VARCHAR DEFAULT NULL;
-- Volume level 1-10 (1 = barely audible, 10 = loud café)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS voice_ambient_level INTEGER DEFAULT 5;
