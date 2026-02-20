-- Lead name column + conversation quote snapshot
-- Migration: 014_lead_name_and_conversation_snapshot

-- 1) Add nullable name column to leads (human name, letters + spaces)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT;

-- 2) Add quote snapshot to conversations (snapshot of quote fields when conversation started)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS quote_snapshot JSONB;
