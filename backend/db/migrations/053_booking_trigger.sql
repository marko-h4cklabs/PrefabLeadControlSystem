-- Booking trigger: chatbot can offer to book when enough info collected
-- Migration: 053_booking_trigger

ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS booking_trigger_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS booking_trigger_score INTEGER DEFAULT 60,
  ADD COLUMN IF NOT EXISTS booking_platform VARCHAR(20) DEFAULT 'google_calendar',
  ADD COLUMN IF NOT EXISTS calendly_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS booking_offer_message TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS booking_required_fields TEXT[] DEFAULT ARRAY['full_name', 'email_address'];

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS calendly_url TEXT DEFAULT NULL;
