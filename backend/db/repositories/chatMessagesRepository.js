const { pool } = require('../index');

async function appendMessage(conversationId, role, content) {
  const result = await pool.query(
    `INSERT INTO chat_messages (conversation_id, role, content)
     VALUES ($1, $2, $3)
     RETURNING id, conversation_id, role, content, created_at`,
    [conversationId, role, content]
  );
  return result.rows[0];
}

async function getRecentMessages(conversationId, limit = 20) {
  const result = await pool.query(
    `SELECT id, role, content, created_at
     FROM chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows.reverse();
}

module.exports = { appendMessage, getRecentMessages };
