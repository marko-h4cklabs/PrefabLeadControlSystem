-- Chat attachments for pictures quote preset (MVP: store in Postgres)
-- Migration: 022_chat_attachments

CREATE TABLE IF NOT EXISTS chat_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL DEFAULT 'pictures',
  mime_type TEXT NOT NULL,
  file_name TEXT,
  byte_size INT NOT NULL,
  data BYTEA NOT NULL,
  public_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_company_lead_created
  ON chat_attachments (company_id, lead_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_attachments_public_token
  ON chat_attachments (public_token);
