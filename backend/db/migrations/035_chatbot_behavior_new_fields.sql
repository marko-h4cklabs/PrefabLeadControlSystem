-- Migration 035: chatbot_behavior new customization fields

ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS agent_name VARCHAR(100) DEFAULT 'Jarvis',
  ADD COLUMN IF NOT EXISTS agent_backstory TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS opener_style VARCHAR(20) DEFAULT 'casual',
  ADD COLUMN IF NOT EXISTS conversation_goal VARCHAR(30) DEFAULT 'collect_quote',
  ADD COLUMN IF NOT EXISTS handoff_trigger VARCHAR(20) DEFAULT 'after_quote',
  ADD COLUMN IF NOT EXISTS follow_up_style VARCHAR(20) DEFAULT 'soft',
  ADD COLUMN IF NOT EXISTS human_fallback_message TEXT DEFAULT 'Let me get someone from the team to follow up with you directly.',
  ADD COLUMN IF NOT EXISTS bot_deny_response TEXT DEFAULT 'Nope, real person here 😄 What can I help you with?';
