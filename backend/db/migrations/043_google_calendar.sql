-- Google Calendar integration: company OAuth tokens and appointment sync fields
-- Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (e.g. https://your-railway-url/api/integrations/google/callback)

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS google_access_token TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS google_refresh_token TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS google_token_expiry TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS google_calendar_id TEXT DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS google_calendar_connected BOOLEAN DEFAULT false;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS google_event_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS google_meet_link TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS synced_to_google BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS sync_error TEXT DEFAULT NULL;
