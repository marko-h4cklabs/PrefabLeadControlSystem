-- Add company-level knowledge base for global context across all conversations
ALTER TABLE companies ADD COLUMN IF NOT EXISTS knowledge_base TEXT DEFAULT '';
