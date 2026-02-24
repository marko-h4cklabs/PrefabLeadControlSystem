const { pool } = require('../index');

async function appendMessage(conversationId, role, content, options = {}) {
  const {
    has_audio = false,
    audio_url = null,
    audio_duration_seconds = null,
    is_voice = false,
    transcription = null,
  } = options;
  const result = await pool.query(
    `INSERT INTO chat_messages (conversation_id, role, content, has_audio, audio_url, audio_duration_seconds, is_voice, transcription)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, conversation_id, role, content, created_at, has_audio, audio_url, audio_duration_seconds`,
    [conversationId, role, content, has_audio, audio_url, audio_duration_seconds, is_voice, transcription]
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

async function countByRole(conversationId, role) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_messages WHERE conversation_id = $1 AND role = $2`,
    [conversationId, role]
  );
  return result.rows[0]?.n ?? 0;
}

async function countAssistantSince(conversationId, sinceISO) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_messages
     WHERE conversation_id = $1 AND role = 'assistant' AND created_at > $2::timestamptz`,
    [conversationId, sinceISO]
  );
  return result.rows[0]?.n ?? 0;
}

module.exports = { appendMessage, getRecentMessages, countByRole, countAssistantSince };
