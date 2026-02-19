-- Webhook events: raw payload storage for inbound capture
CREATE TABLE webhook_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel     VARCHAR(50) NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhook_events_company ON webhook_events(company_id);
CREATE INDEX idx_webhook_events_created ON webhook_events(company_id, created_at DESC);
