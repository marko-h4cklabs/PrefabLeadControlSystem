-- One-time seed: insert default warming sequences for every company that has none.

INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
SELECT c.id, 'Pre-Call Warming', 'call_booked', true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM warming_sequences ws WHERE ws.company_id = c.id AND ws.trigger_event = 'call_booked');

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 1, 60, 'Hey {name}! Just wanted to confirm we''re all set for our call. Looking forward to connecting with you 🙌'
FROM warming_sequences ws WHERE ws.trigger_event = 'call_booked'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 1);

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 2, 1440, 'Hey {name}, just a reminder about our call tomorrow. If anything comes up, just let me know!'
FROM warming_sequences ws WHERE ws.trigger_event = 'call_booked'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 2);

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 3, 1380, 'Hey {name}! Our call is in about an hour. Here''s the link: {booking_link}. See you soon!'
FROM warming_sequences ws WHERE ws.trigger_event = 'call_booked'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 3);

INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
SELECT c.id, 'No-Show Recovery', 'no_show_detected', true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM warming_sequences ws WHERE ws.company_id = c.id AND ws.trigger_event = 'no_show_detected');

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 1, 30, 'Hey {name}, looks like we missed each other! Totally fine — want to reschedule?'
FROM warming_sequences ws WHERE ws.trigger_event = 'no_show_detected'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 1);

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 2, 1440, 'Hey {name}, still open to connecting when you''re ready. Just say the word and we''ll find a time.'
FROM warming_sequences ws WHERE ws.trigger_event = 'no_show_detected'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 2);

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 3, 4320, 'Hey {name}, last follow-up from me — if you''re still interested in {company_name}, I''m here. No pressure at all.'
FROM warming_sequences ws WHERE ws.trigger_event = 'no_show_detected'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 3);

INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
SELECT c.id, 'Cold Lead Re-engagement', 'no_reply_72h', true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM warming_sequences ws WHERE ws.company_id = c.id AND ws.trigger_event = 'no_reply_72h');

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 1, 0, 'Hey {name}! Just checking in — did you have any questions I can help with?'
FROM warming_sequences ws WHERE ws.trigger_event = 'no_reply_72h'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 1);

INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template)
SELECT ws.id, 2, 1440, 'Hey {name}, I know things get busy. Happy to pick up where we left off whenever works for you.'
FROM warming_sequences ws WHERE ws.trigger_event = 'no_reply_72h'
AND NOT EXISTS (SELECT 1 FROM warming_steps wst WHERE wst.sequence_id = ws.id AND wst.step_order = 2);
