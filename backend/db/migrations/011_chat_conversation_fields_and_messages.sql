-- chat_conversation_fields: normalized field storage per conversation
CREATE TABLE IF NOT EXISTS chat_conversation_fields (
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  field_value_text TEXT,
  field_value_number NUMERIC,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number')),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_chat_conversation_fields_conversation ON chat_conversation_fields(conversation_id);

-- chat_messages: message history per conversation
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created ON chat_messages(conversation_id, created_at);
