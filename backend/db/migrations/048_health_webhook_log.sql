-- ManyChat webhook call log for monitoring
CREATE TABLE IF NOT EXISTS manychat_webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  subscriber_id VARCHAR(255),
  message_preview TEXT,
  processing_time_ms INTEGER,
  success BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manychat_webhook_log_created ON manychat_webhook_log(created_at DESC);
