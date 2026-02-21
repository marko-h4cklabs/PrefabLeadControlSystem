-- Appointment reminder deduplication table
-- Migration: 028_appointment_reminders_sent

CREATE TABLE IF NOT EXISTS appointment_reminders_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  reminder_minutes_before INTEGER NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_reminder_dedupe
  ON appointment_reminders_sent (appointment_id, reminder_minutes_before);

CREATE INDEX IF NOT EXISTS idx_appt_reminder_sent_at
  ON appointment_reminders_sent (sent_at);
