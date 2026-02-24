const express = require('express');
const router = express.Router();
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const { pool } = require('../../../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PREMADE_VOICES = [
  {
    voice_id: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Sarah',
    category: 'premade',
    description: 'Soft, warm American female voice. Great for friendly conversations.',
    labels: { gender: 'female', age: 'young', accent: 'american' },
  },
  {
    voice_id: 'onwK4e9ZLuTAKqWW03F9',
    name: 'Daniel',
    category: 'premade',
    description: 'Deep, authoritative British male voice. Professional and credible.',
    labels: { gender: 'male', age: 'middle_aged', accent: 'british' },
  },
  {
    voice_id: 'pFZP5JQG7iQjIQuC4Bku',
    name: 'Lily',
    category: 'premade',
    description: 'Upbeat, energetic British female voice. Engaging and conversational.',
    labels: { gender: 'female', age: 'young', accent: 'british' },
  },
];

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
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.json({ voices: PREMADE_VOICES });
  }
  try {
    const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      timeout: 10000,
    });
    const voices = response.data.voices || [];
    const all = [...PREMADE_VOICES.filter((p) => !voices.find((v) => v.voice_id === p.voice_id)), ...voices];
    res.json({ voices: all });
  } catch (err) {
    res.json({ voices: PREMADE_VOICES });
  }
});

router.get('/usage', async (req, res) => {
  res.json({ characters_used: 0, character_limit: 10000 });
});

router.get('/clones', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      'SELECT voice_id, name, description, sample_count FROM voice_clones WHERE company_id = $1 ORDER BY created_at DESC',
      [companyId]
    );
    res.json({ clones: result.rows || [] });
  } catch (err) {
    res.json({ clones: [] });
  }
});

router.post('/clone', upload.array('samples', 5), async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(400).json({
      error:
        'ElevenLabs API key not configured. Add ELEVENLABS_API_KEY to your Railway environment variables.',
    });
  }
  try {
    const companyId = req.tenantId;
    const { name, description } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'At least one audio sample is required' });
    }

    const form = new FormData();
    form.append('name', String(name).trim());
    if (description) form.append('description', String(description).trim());
    req.files.forEach((file, i) => {
      form.append(
        'files',
        file.buffer,
        { filename: file.originalname || `sample_${i}.mp3`, contentType: file.mimetype || 'audio/mpeg' }
      );
    });
    form.append('remove_background_noise', 'false');

    const response = await axios.post('https://api.elevenlabs.io/v1/voices/add', form, {
      headers: { ...form.getHeaders(), 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      timeout: 60000,
    });

    const voiceId = response.data.voice_id;

    await pool.query(
      `INSERT INTO voice_clones (id, company_id, voice_id, name, description, sample_count, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (company_id, voice_id) DO UPDATE SET name = $3, description = $4, sample_count = $5`,
      [companyId, voiceId, String(name).trim(), description || '', req.files.length]
    );

    await pool.query(
      'UPDATE companies SET voice_selected_id = $1, voice_selected_name = $2 WHERE id = $3',
      [voiceId, String(name).trim(), companyId]
    );

    res.json({ success: true, voice_id: voiceId, name: String(name).trim() });
  } catch (err) {
    console.error('[voice/clone]', err.response?.data || err.message);
    const msg =
      err.response?.data?.detail?.message || err.response?.data?.detail || err.message;
    res.status(500).json({ error: msg || 'Voice cloning failed' });
  }
});

router.post('/preview', async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(400).json({ error: 'ElevenLabs not configured' });
  }
  res.status(503).json({ error: 'ElevenLabs not configured' });
});

router.post('/test', async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(400).json({ error: 'ElevenLabs not configured' });
  }
  res.status(503).json({ error: 'ElevenLabs not configured' });
});

router.delete('/clone/:id', async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
