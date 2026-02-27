-- Expand tone CHECK constraint to include values used by personas
ALTER TABLE chatbot_behavior DROP CONSTRAINT IF EXISTS chatbot_behavior_tone_check;
ALTER TABLE chatbot_behavior ADD CONSTRAINT chatbot_behavior_tone_check
  CHECK (tone IN ('professional', 'friendly', 'confident', 'relatable'));
