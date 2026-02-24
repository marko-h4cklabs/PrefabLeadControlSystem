const express = require('express');
const router = express.Router();

// Stub voice routes so the frontend does not get 404. ElevenLabs implementation can be added later.

router.get('/settings', async (req, res) => {
  res.json({
    voice_enabled: false,
    voice_mode: 'match',
    selected_voice_id: null,
    selected_voice_name: null,
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    speaker_boost: true,
    voice_model: 'eleven_turbo_v2_5',
  });
});

router.put('/settings', async (req, res) => {
  res.json({ success: true });
});

router.get('/voices', async (req, res) => {
  res.json({ voices: [] });
});

router.get('/usage', async (req, res) => {
  res.json({ characters_used: 0, character_limit: 10000 });
});

router.get('/clones', async (req, res) => {
  res.json({ clones: [] });
});

router.post('/preview', async (req, res) => {
  res.status(503).json({ error: 'ElevenLabs not configured' });
});

router.post('/test', async (req, res) => {
  res.status(503).json({ error: 'ElevenLabs not configured' });
});

router.post('/clone', async (req, res) => {
  res.status(503).json({ error: 'ElevenLabs not configured' });
});

router.delete('/clone/:id', async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
