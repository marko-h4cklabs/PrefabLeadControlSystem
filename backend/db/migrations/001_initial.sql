-- ============================================
-- Prefab Lead Control System - Initial Schema
-- Migration: 001_initial
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================
-- TENANT ROOT
-- ============================================
CREATE TABLE companies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    contact_email   VARCHAR(255),
    contact_phone   VARCHAR(50),
    chatbot_style   JSONB DEFAULT '{}',
    scoring_config  JSONB DEFAULT '{}',
    channels_enabled JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- USERS (tenant-scoped, for auth & assignment)
-- ============================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'sales')),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, email)
);

CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_users_email ON users(email);

-- ============================================
-- LEADS (tenant-scoped)
-- status: controlled by scoringEngine; do not edit manually outside system logic
-- ============================================
CREATE TABLE leads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel         VARCHAR(50) NOT NULL,
    external_id     VARCHAR(255),
    score           INTEGER DEFAULT 0 CHECK (score >= 0 AND score <= 100),
    status          VARCHAR(50) DEFAULT 'new',  -- scoringEngine-controlled; no manual edits
    assigned_sales  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, channel, external_id)
);

CREATE INDEX idx_leads_company ON leads(company_id);
CREATE INDEX idx_leads_company_status ON leads(company_id, status);
CREATE INDEX idx_leads_company_score ON leads(company_id, score DESC);
CREATE INDEX idx_leads_company_created ON leads(company_id, created_at DESC);

-- ============================================
-- QUALIFICATION FIELDS (dynamic, per-company)
-- ============================================
CREATE TABLE qualification_fields (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    field_name      VARCHAR(100) NOT NULL,
    field_key       VARCHAR(100) NOT NULL,
    field_type      VARCHAR(50) NOT NULL,
    units           VARCHAR(50),
    required        BOOLEAN DEFAULT false,
    scoring_weight  INTEGER DEFAULT 0,
    dependencies    JSONB DEFAULT '[]',
    validation_rules JSONB DEFAULT '{}',
    display_order   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, field_key)
);

CREATE INDEX idx_qualification_fields_company ON qualification_fields(company_id);
CREATE INDEX idx_qualification_fields_company_order ON qualification_fields(company_id, display_order);

-- ============================================
-- CONVERSATIONS
-- ============================================
CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    messages        JSONB DEFAULT '[]',
    current_step    INTEGER DEFAULT 0,
    parsed_fields   JSONB DEFAULT '{}',
    last_updated    TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_lead ON conversations(lead_id);

-- ============================================
-- APPOINTMENTS
-- ============================================
CREATE TABLE appointments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    scheduled_time  TIMESTAMPTZ,
    status          VARCHAR(50) DEFAULT 'pending',
    calendar_id     VARCHAR(255),
    booking_url     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_appointments_lead ON appointments(lead_id);
CREATE INDEX idx_appointments_status ON appointments(lead_id, status);

-- ============================================
-- ANALYTICS SNAPSHOTS
-- ============================================
CREATE TABLE analytics_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    snapshot_date   DATE NOT NULL,
    metrics         JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, snapshot_date)
);

CREATE INDEX idx_analytics_company_date ON analytics_snapshots(company_id, snapshot_date DESC);

-- ============================================
-- SEED DATA
-- ============================================

-- One company
INSERT INTO companies (id, name, contact_email, chatbot_style, scoring_config, channels_enabled)
VALUES (
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'Acme Prefab',
    'contact@acmeprefab.example',
    '{"tone": "professional", "forbidden_topics": [], "response_duration": "concise"}',
    '{"threshold_hot": 70, "threshold_warm": 40, "formula_type": "weighted_sum"}',
    '["messenger", "instagram", "email"]'
);

-- One admin user (password: "password" - MUST change in production)
INSERT INTO users (id, company_id, email, password_hash, role)
VALUES (
    'b1ffcd99-9c0b-4ef8-bb6d-6bb9bd380a22',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'admin@acmeprefab.example',
    '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    'admin'
);

-- Two qualification fields: budget and timeline
INSERT INTO qualification_fields (company_id, field_name, field_key, field_type, units, required, scoring_weight, display_order)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Budget', 'budget', 'currency', 'USD', true, 40, 1),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Timeline', 'timeline', 'text', NULL, true, 30, 2);
