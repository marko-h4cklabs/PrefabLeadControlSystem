-- Appointments upgrade: add tenant scoping, rich scheduling fields, types, constraints
-- Migration: 027_appointments_upgrade
-- Evolves existing appointments table from 001_initial.sql

-- 1) Add company_id for tenant scoping (nullable first for backfill, then NOT NULL)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- Backfill company_id from the linked lead
UPDATE appointments SET company_id = (SELECT company_id FROM leads WHERE leads.id = appointments.lead_id)
WHERE company_id IS NULL AND lead_id IS NOT NULL;

-- Now make it NOT NULL (only safe if all rows have been backfilled)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'appointments' AND column_name = 'company_id' AND is_nullable = 'YES') THEN
    ALTER TABLE appointments ALTER COLUMN company_id SET NOT NULL;
  END IF;
END $$;

-- 2) Add scheduling fields
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_type TEXT NOT NULL DEFAULT 'call';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Zagreb';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_minutes_before INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- 3) Backfill start_at from legacy scheduled_time where missing
UPDATE appointments SET start_at = scheduled_time WHERE start_at IS NULL AND scheduled_time IS NOT NULL;
UPDATE appointments SET end_at = start_at + interval '30 minutes' WHERE end_at IS NULL AND start_at IS NOT NULL;

-- 4) Update status values: migrate 'pending' → 'scheduled'
UPDATE appointments SET status = 'scheduled' WHERE status = 'pending';

-- 5) Add CHECK constraints
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_type_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_type_check
  CHECK (appointment_type IN ('call', 'site_visit', 'meeting', 'follow_up'));

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show'));

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_source_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_source_check
  CHECK (source IN ('manual', 'chatbot', 'google_sync'));

-- 6) Default status to 'scheduled' for new rows
ALTER TABLE appointments ALTER COLUMN status SET DEFAULT 'scheduled';

-- 7) Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_appointments_company_start
  ON appointments (company_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_company_status_start
  ON appointments (company_id, status, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_lead_start
  ON appointments (lead_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_company_source_start
  ON appointments (company_id, source, start_at);
