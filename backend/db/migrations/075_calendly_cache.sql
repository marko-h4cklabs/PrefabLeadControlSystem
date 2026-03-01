-- Cache Calendly user info so GET doesn't need to call Calendly API every time
ALTER TABLE companies ADD COLUMN IF NOT EXISTS calendly_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS calendly_email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS calendly_scheduling_url TEXT;
