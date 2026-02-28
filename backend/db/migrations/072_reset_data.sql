-- Migration 072: Full data reset for fresh start
-- Keeps schema intact, drops all records

-- Disable FK checks by truncating in dependency order
TRUNCATE TABLE reply_suggestions CASCADE;
TRUNCATE TABLE chat_messages CASCADE;
TRUNCATE TABLE chat_conversation_state CASCADE;
TRUNCATE TABLE chat_conversations CASCADE;
TRUNCATE TABLE conversations CASCADE;
TRUNCATE TABLE notifications CASCADE;
TRUNCATE TABLE notification_channels CASCADE;
TRUNCATE TABLE lead_activities CASCADE;
TRUNCATE TABLE lead_notes CASCADE;
TRUNCATE TABLE hot_lead_alerts CASCADE;
TRUNCATE TABLE warming_enrollments CASCADE;
TRUNCATE TABLE warming_sequence_steps CASCADE;
TRUNCATE TABLE warming_sequences CASCADE;
TRUNCATE TABLE deals CASCADE;
TRUNCATE TABLE appointments CASCADE;
TRUNCATE TABLE scheduling_requests CASCADE;
TRUNCATE TABLE setter_metrics CASCADE;
TRUNCATE TABLE setter_performance CASCADE;
TRUNCATE TABLE team_members CASCADE;
TRUNCATE TABLE team_invites CASCADE;
TRUNCATE TABLE leads CASCADE;
TRUNCATE TABLE chatbot_personas CASCADE;
TRUNCATE TABLE chatbot_behavior CASCADE;
TRUNCATE TABLE chatbot_company_info CASCADE;
TRUNCATE TABLE chatbot_quote_fields CASCADE;
TRUNCATE TABLE users CASCADE;
TRUNCATE TABLE companies CASCADE;
