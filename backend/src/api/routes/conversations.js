/**
 * Conversations API - voice messages, reply suggestions (copilot), and related endpoints.
 */

const logger = require('../../lib/logger');
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { pool } = require('../../../db');
const { decrypt } = require('../../lib/encryption');
const {
  leadRepository,
  conversationRepository,
  chatConversationRepository,
  chatMessagesRepository,
  chatbotQuoteFieldsRepository,
} = require('../../../db/repositories');
const whisperService = require('../../../services/whisperService');
const elevenLabsService = require('../../../services/elevenLabsService');
const aiReplyService = require('../../../services/aiReplyService');
const replySuggestionsService = require('../../../services/replySuggestionsService');
const { logLeadActivity } = require('../../../services/activityLogger');
const { errorJson } = require('../middleware/errors');
const { publish: publishEvent } = require('../../lib/eventBus');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = [
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
];

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const mt = file.mimetype || '';
    if (!ALLOWED_AUDIO_TYPES.includes(mt)) {
      return cb(new Error(`Invalid mime type. Allowed: ${ALLOWED_AUDIO_TYPES.join(', ')}`));
    }
    cb(null, true);
  },
});

function handleMulterError(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Audio file too large (max 25MB)');
    }
    if (err.message && err.message.includes('Invalid mime')) {
      return errorJson(res, 400, 'VALIDATION_ERROR', err.message);
    }
    return errorJson(res, 400, 'VALIDATION_ERROR', err.message || 'Invalid upload');
  }
  next();
}

/**
 * POST /api/conversations/:id/voice-message
 * Accept voice message, transcribe, optionally generate AI voice reply.
 */
router.post(
  '/:id/voice-message',
  voiceUpload.single('audio'),
  handleMulterError,
  async (req, res) => {
    try {
      const leadId = req.params.id;
      const companyId = req.tenantId;

      if (!leadId || !UUID_REGEX.test(leadId)) {
        return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid lead ID required');
      }

      const lead = await leadRepository.findById(companyId, leadId);
      if (!lead) {
        return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
      }

      const file = req.file;
      if (!file || !file.buffer) {
        return errorJson(res, 400, 'VALIDATION_ERROR', 'Audio file is required (field: audio)');
      }

      const transcription = await whisperService.transcribeAudio(file.buffer, file.mimetype);
      const transcriptionText = transcription.text || '';

      const chatConv = await chatConversationRepository.getOrCreateByLead(companyId, leadId);

      await chatMessagesRepository.appendMessage(chatConv.id, 'user', transcriptionText, {
        has_audio: true,
        audio_url: null,
        audio_duration_seconds: transcription.duration ? Math.round(transcription.duration) : null,
      });

      await conversationRepository.appendMessage(leadId, 'user', transcriptionText);

      await logLeadActivity({
        companyId,
        leadId,
        eventType: 'voice_message_received',
        actorType: 'system',
        source: 'voice',
        channel: lead.channel,
        metadata: {},
      }).catch(() => {});

      let aiReply = null;
      const quoteFields = await chatbotQuoteFieldsRepository.list(companyId);
      const enabledFields = (quoteFields || []).filter((f) => f && f.is_enabled);
      const hasChatbot = enabledFields.length > 0;
      const hasElevenLabs = !!process.env.ELEVENLABS_API_KEY;

      if (hasChatbot && hasElevenLabs) {
        try {
          const result = await aiReplyService.generateAiReply(companyId, leadId);
          const replyText = result.assistant_message || '';

          await conversationRepository.appendMessage(leadId, 'assistant', replyText);

          const merged = result.parsed_fields ?? result.field_updates ?? {};
          const curr = await conversationRepository.getByLeadId(leadId);
          if (JSON.stringify(merged) !== JSON.stringify(curr?.parsed_fields ?? {}) && Object.keys(merged).length > 0) {
            await conversationRepository.updateParsedFields(leadId, merged);
          }

          const audioBuffer = await elevenLabsService.textToSpeech(replyText);
          const audioBase64 = audioBuffer.toString('base64');

          await chatMessagesRepository.appendMessage(chatConv.id, 'assistant', replyText, {
            has_audio: true,
            audio_url: null,
          });

          aiReply = { text: replyText, audio_base64: audioBase64 };
        } catch (err) {
          logger.error('[conversations/voice-message] AI reply error:', err.message);
        }
      }

      res.json({
        message: 'ok',
        transcription: transcriptionText,
        ai_reply: aiReply,
      });
    } catch (err) {
      errorJson(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /api/conversations/:conversationId/suggestions
 * Generate 3 reply suggestions (copilot mode). Returns suggestions array.
 */
router.post('/:conversationId/suggestions', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const conversationId = req.params.conversationId;
    if (!conversationId || !UUID_REGEX.test(conversationId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid conversation ID required');
    }
    const convRow = await pool.query(
      'SELECT c.id, c.lead_id, c.messages FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1 AND l.company_id = $2',
      [conversationId, companyId]
    );
    const conv = convRow.rows[0];
    if (!conv) {
      return errorJson(res, 404, 'NOT_FOUND', 'Conversation not found');
    }
    const behavior = (await require('../../../db/repositories').chatbotBehaviorRepository.get(companyId, 'copilot')) ?? {};
    const result = await replySuggestionsService.generateSuggestions(
      conv.lead_id,
      conversationId,
      companyId,
      conv.messages ?? [],
      behavior
    );
    // result is now { suggestion_id, suggestions }
    const suggestions = result?.suggestions || result || [];
    const suggestion_id = result?.suggestion_id || null;
    res.json({ suggestion_id, suggestions });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/conversations/:conversationId/suggestions/:suggestionId/send
 * Body: { suggestion_index: 0|1|2 }. Sends that suggestion via ManyChat and marks it used.
 */
router.post('/:conversationId/suggestions/:suggestionId/send', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { suggestionId } = req.params;
    const suggestionIndex = req.body?.suggestion_index;
    if (suggestionId && !UUID_REGEX.test(suggestionId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid suggestion ID required');
    }
    if (typeof suggestionIndex !== 'number' || suggestionIndex < 0 || suggestionIndex > 2) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'suggestion_index must be 0, 1, or 2');
    }
    const result = await replySuggestionsService.sendSuggestion(suggestionId, suggestionIndex, companyId);
    if (!result) {
      return errorJson(res, 404, 'NOT_FOUND', 'Suggestion not found or already used');
    }
    res.json(result);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/conversations/:conversationId/suggestions/:suggestionId/send-edited
 * Send a user-edited version of a suggestion. Body: { text: "edited message" }
 */
router.post('/:conversationId/suggestions/:suggestionId/send-edited', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { suggestionId } = req.params;
    const { text } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'text is required');
    }
    if (suggestionId && !UUID_REGEX.test(suggestionId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid suggestion ID required');
    }

    // Try to find the suggestion row (may already be used — that's okay)
    const sugRow = await pool.query(
      `SELECT rs.id, rs.lead_id, rs.used_at FROM reply_suggestions rs
       JOIN leads l ON l.id = rs.lead_id
       WHERE rs.id = $1 AND l.company_id = $2`,
      [suggestionId, companyId]
    );
    const suggestion = sugRow.rows[0];

    // Resolve leadId: from suggestion if found, otherwise from conversation
    let leadId;
    if (suggestion) {
      leadId = suggestion.lead_id;
    } else {
      const convRow = await pool.query(
        'SELECT c.lead_id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1 AND l.company_id = $2',
        [req.params.conversationId, companyId]
      );
      if (!convRow.rows[0]) {
        return errorJson(res, 404, 'NOT_FOUND', 'Conversation not found');
      }
      leadId = convRow.rows[0].lead_id;
    }

    // Get lead + ManyChat API key for sending
    const leadRow = await pool.query(
      `SELECT l.external_id, c.manychat_api_key FROM leads l
       JOIN companies c ON c.id = l.company_id
       WHERE l.id = $1 AND l.company_id = $2`,
      [leadId, companyId]
    );
    const lead = leadRow.rows[0];
    if (!lead?.external_id || !lead?.manychat_api_key) {
      return errorJson(res, 400, 'SEND_FAILED', 'Lead missing external ID or ManyChat API key');
    }

    const { sendInstagramMessage } = require('../../services/manychatService');
    await sendInstagramMessage(lead.external_id, text.trim(), decrypt(lead.manychat_api_key));

    // Append to conversation history
    await conversationRepository.appendMessage(leadId, 'assistant', text.trim());

    // Mark suggestion as used (if not already)
    if (suggestion && !suggestion.used_at) {
      await pool.query(
        `UPDATE reply_suggestions SET used_at = NOW(), used_suggestion_index = -1 WHERE id = $1`,
        [suggestionId]
      );
    }

    // Emit SSE event with full message data so frontend can display instantly
    publishEvent(companyId, {
      type: 'new_message',
      leadId,
      conversationId: req.params.conversationId,
      preview: text.trim().slice(0, 100),
      role: 'assistant',
      content: text.trim(),
      messageTimestamp: new Date().toISOString(),
    }).catch(() => {});

    res.json({ success: true, message_sent: text.trim() });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
