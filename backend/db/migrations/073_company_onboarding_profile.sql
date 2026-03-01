-- Add onboarding profile columns to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_type VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS team_size VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS monthly_lead_volume VARCHAR(20);
