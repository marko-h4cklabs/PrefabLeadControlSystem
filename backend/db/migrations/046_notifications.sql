-- Extend notifications: message (alias for body), metadata. Types: hot_lead, new_lead, booking_confirmed, booking_cancelled, deal_logged, ai_error, message_limit_warning, trial_ending

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_notifications_company_unread
  ON notifications(company_id, is_read, created_at DESC);
