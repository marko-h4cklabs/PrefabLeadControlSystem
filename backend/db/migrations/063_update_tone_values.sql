-- Migrate old tone values to new ones
UPDATE chatbot_behavior SET persona_style = 'professional' WHERE persona_style IN ('direct', 'busy');
UPDATE chatbot_behavior SET persona_style = 'friendly' WHERE persona_style IN ('casual', 'empathetic');
UPDATE chatbot_behavior SET persona_style = 'confident' WHERE persona_style = 'humorous';
