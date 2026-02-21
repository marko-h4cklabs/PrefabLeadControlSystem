-- Migration 030: scheduling_requests table + chatbot booking columns on scheduling settings

-- A) scheduling_requests table
CREATE TABLE IF NOT EXISTS scheduling_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id UUID NULL,
  source TEXT NOT NULL DEFAULT 'chatbot',
  status TEXT NOT NULL DEFAULT 'open',
  request_type TEXT NOT NULL DEFAULT 'call',
  preferred_date DATE NULL,
  preferred_time TEXT NULL,
  preferred_time_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  preferred_timezone TEXT NOT NULL DEFAULT 'Europe/Zagreb',
  availability_mode TEXT NOT NULL DEFAULT 'manual',
  selected_slot_start_at TIMESTAMPTZ NULL,
  selected_slot_end_at TIMESTAMPTZ NULL,
  notes TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  converted_appointment_id UUID NULL REFERENCES appointments(id) ON DELETE SET NULL,
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT scheduling_requests_source_check CHECK (source IN ('chatbot','manual')),
  CONSTRAINT scheduling_requests_status_check CHECK (status IN ('open','converted','closed','cancelled')),
  CONSTRAINT scheduling_requests_request_type_check CHECK (request_type IN ('call','site_visit','meeting','follow_up')),
  CONSTRAINT scheduling_requests_availability_mode_check CHECK (availability_mode IN ('manual','slot_selected'))
);

CREATE INDEX IF NOT EXISTS idx_scheduling_requests_company_lead_created
  ON scheduling_requests (company_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduling_requests_company_status_created
  ON scheduling_requests (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduling_requests_company_type_created
  ON scheduling_requests (company_id, request_type, created_at DESC);

-- B) Chatbot booking columns on company_scheduling_settings
ALTER TABLE company_scheduling_settings
  ADD COLUMN IF NOT EXISTS chatbot_booking_mode TEXT NOT NULL DEFAULT 'manual_request',
  ADD COLUMN IF NOT EXISTS chatbot_booking_prompt_style TEXT NOT NULL DEFAULT 'neutral',
  ADD COLUMN IF NOT EXISTS chatbot_collect_booking_after_quote BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chatbot_booking_requires_name BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chatbot_booking_requires_phone BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chatbot_booking_default_type TEXT NOT NULL DEFAULT 'call',
  ADD COLUMN IF NOT EXISTS chatbot_allow_user_proposed_time BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chatbot_show_slots_when_available BOOLEAN NOT NULL DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chatbot_booking_mode_check'
  ) THEN
    ALTER TABLE company_scheduling_settings
      ADD CONSTRAINT chatbot_booking_mode_check
      CHECK (chatbot_booking_mode IN ('off','manual_request','direct_booking'));
  END IF;
END $$;
