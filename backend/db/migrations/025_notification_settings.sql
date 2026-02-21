-- Notification settings (tenant-scoped, per company)
-- Migration: 025_notification_settings

CREATE TABLE IF NOT EXISTS notification_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  email_enabled BOOLEAN NOT NULL DEFAULT false,
  email_recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  notify_new_inquiry_inbox BOOLEAN NOT NULL DEFAULT true,
  notify_new_inquiry_simulation BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
