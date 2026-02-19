-- Chatbot configuration tables (tenant-scoped)

CREATE TABLE chatbot_company_info (
    company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    website_url         TEXT,
    business_description TEXT,
    additional_notes    TEXT,
    last_scrape_requested_at TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chatbot_behavior (
    company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    tone                TEXT NOT NULL DEFAULT 'professional' CHECK (tone IN ('professional', 'friendly')),
    response_length     TEXT NOT NULL DEFAULT 'medium' CHECK (response_length IN ('short', 'medium', 'long')),
    emojis_enabled      BOOLEAN NOT NULL DEFAULT false,
    persona_style       TEXT NOT NULL DEFAULT 'explanational' CHECK (persona_style IN ('busy', 'explanational')),
    forbidden_topics    TEXT[] NOT NULL DEFAULT '{}'::text[],
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chatbot_quote_fields (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('text', 'number', 'select', 'boolean')),
    units       TEXT,
    priority    INT NOT NULL DEFAULT 100 CHECK (priority >= 0),
    required    BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chatbot_quote_fields_company_priority ON chatbot_quote_fields(company_id, priority, created_at);
