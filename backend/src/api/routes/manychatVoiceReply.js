/**
 * Endpoint for ManyChat External Request (Dynamic Block).
 * Called by ManyChat's "Voice Reply" flow to get the pending audio URL
 * for a subscriber and return it in ManyChat's message format.
 *
 * POST /api/manychat/voice-reply-content
 */

const express = require('express');
const router = express.Router();
const voiceReplyStore = require('../../services/voiceReplyStore');

router.post('/', express.json(), (req, res) => {
  try {
    // ManyChat "Full Contact Data" sends subscriber ID as "id"
    const subscriberId = req.body?.subscriber_id || req.body?.id || req.query?.subscriber_id;
    console.log('[voice-reply-content] Request from ManyChat. subscriber_id:', subscriberId, 'body keys:', Object.keys(req.body || {}));

    if (!subscriberId) {
      console.warn('[voice-reply-content] No subscriber_id in request');
      return res.json({ version: 'v2', content: { type: 'instagram', messages: [{ type: 'text', text: '' }] } });
    }

    const audioUrl = voiceReplyStore.get(subscriberId);
    console.log('[voice-reply-content] Pending audio for subscriber', subscriberId, ':', audioUrl ? 'FOUND' : 'NOT FOUND');

    if (!audioUrl) {
      // No pending audio — return empty (ManyChat will send nothing meaningful)
      return res.json({ version: 'v2', content: { type: 'instagram', messages: [] } });
    }

    // Remove from store (one-time use)
    voiceReplyStore.remove(subscriberId);

    // Return audio in ManyChat's response format
    // The flow engine should process this the same way as the static Audio block
    console.log('[voice-reply-content] Returning audio URL:', audioUrl);
    res.json({
      version: 'v2',
      content: {
        type: 'instagram',
        messages: [
          {
            type: 'audio',
            url: audioUrl,
          },
        ],
      },
    });
  } catch (err) {
    console.error('[voice-reply-content] Error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
