-- Company scheduling settings for appointment availability and chatbot booking config
-- Migration: 029_company_scheduling_settings

CREATE TABLE IF NOT EXISTS company_scheduling_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT NOT NULL DEFAULT 'Europe/Zagreb',
  working_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  min_notice_hours INTEGER NOT NULL DEFAULT 2,
  max_days_ahead INTEGER NOT NULL DEFAULT 30,
  allowed_appointment_types JSONB NOT NULL DEFAULT '["call"]'::jsonb,
  allow_manual_booking_from_lead BOOLEAN NOT NULL DEFAULT true,
  chatbot_offer_booking BOOLEAN NOT NULL DEFAULT false,
  reminder_defaults JSONB NOT NULL DEFAULT '{"email":true,"inApp":true,"minutesBefore":60}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_scheduling_settings_company
  ON company_scheduling_settings (company_id);
