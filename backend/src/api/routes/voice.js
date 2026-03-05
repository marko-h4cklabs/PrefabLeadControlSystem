const logger = require('../../lib/logger');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const { pool } = require('../../../db');
const { isElevenLabsConfigured, getElevenLabsKey, getUsage, getVoices, textToSpeech } = require('../../utils/elevenLabsClient');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const numOrDefault = (val, fb) => { const n = parseFloat(val); return Number.isFinite(n) ? n : fb; };
const intOrDefault = (val, fb) => { const n = parseInt(val, 10); return Number.isFinite(n) ? n : fb; };

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
  try {
    const result = await pool.query(
      `SELECT voice_enabled, voice_mode, voice_model, voice_selected_id,
              voice_selected_name, voice_stability, voice_similarity_boost,
              voice_style, voice_speaker_boost, voice_style_prompt, voice_speed,
              voice_ambient_noise, voice_ambient_level
       FROM companies WHERE id = $1`,
      [req.tenantId]
    );
    const row = result.rows[0] || {};
    res.json({
      voice_enabled: row.voice_enabled || false,
      voice_mode: row.voice_mode || 'match',
      voice_model: row.voice_model || 'eleven_turbo_v2_5',
      selected_voice_id: row.voice_selected_id || null,
      selected_voice_name: row.voice_selected_name || null,
      stability: numOrDefault(row.voice_stability, 0.5),
      similarity_boost: numOrDefault(row.voice_similarity_boost, 0.75),
      style: numOrDefault(row.voice_style, 0),
      speaker_boost: row.voice_speaker_boost === true,
      voice_style_prompt: row.voice_style_prompt || '',
      voice_speed: numOrDefault(row.voice_speed, 1.0),
      voice_ambient_noise: row.voice_ambient_noise || null,
      voice_ambient_level: intOrDefault(row.voice_ambient_level, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const {
      voice_enabled,
      voice_mode,
      voice_model,
      selected_voice_id,
      selected_voice_name,
      stability,
      similarity_boost,
      style,
      speaker_boost,
      voice_style_prompt,
      voice_speed,
      voice_ambient_noise,
      voice_ambient_level,
    } = req.body ?? {};

    const setParts = [];
    const values = [];
    let idx = 1;
    const addField = (col, val) => {
      if (val !== undefined) {
        setParts.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };
    addField('voice_enabled', voice_enabled);
    addField('voice_mode', voice_mode);
    addField('voice_model', voice_model);
    addField('voice_selected_id', selected_voice_id);
    addField('voice_selected_name', selected_voice_name);
    addField('voice_stability', stability);
    addField('voice_similarity_boost', similarity_boost);
    addField('voice_style', style);
    addField('voice_speaker_boost', speaker_boost);
    addField('voice_style_prompt', voice_style_prompt);
    addField('voice_speed', voice_speed);
    addField('voice_ambient_noise', voice_ambient_noise);
    addField('voice_ambient_level', voice_ambient_level);

    if (setParts.length === 0) return res.json({ success: true });

    values.push(req.tenantId);
    await pool.query(`UPDATE companies SET ${setParts.join(', ')} WHERE id = $${idx}`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/voices', async (req, res) => {
  if (!isElevenLabsConfigured()) return res.json({ voices: PREMADE_VOICES });
  try {
    const voices = await getVoices();
    const merged = [...PREMADE_VOICES.filter((p) => !voices.find((v) => v.voice_id === p.voice_id)), ...voices];
    res.json({ voices: merged });
  } catch (err) {
    res.json({ voices: PREMADE_VOICES });
  }
});

router.get('/usage', async (req, res) => {
  if (!isElevenLabsConfigured()) {
    return res.json({ characters_used: 0, character_limit: 10000, configured: false });
  }
  try {
    const usage = await getUsage();
    res.json({ ...usage, configured: true });
  } catch (err) {
    res.json({ characters_used: 0, character_limit: 10000, configured: false, error: err.message });
  }
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

router.post('/clone', (req, res, next) => {
  upload.array('samples', 5)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum 25MB per file.' });
      }
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!isElevenLabsConfigured()) {
    return res.status(503).json({
      error: 'ElevenLabs API key not configured. Add ELEVENLABS_API_KEY to your Railway environment variables.',
      configured: false,
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
      headers: { ...form.getHeaders(), 'xi-api-key': getElevenLabsKey() },
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
    logger.error('[voice/clone]', err.response?.data || err.message);
    const msg =
      err.response?.data?.detail?.message || err.response?.data?.detail || err.message;
    res.status(500).json({ error: msg || 'Voice cloning failed' });
  }
});

router.post('/preview', async (req, res) => {
  if (!isElevenLabsConfigured()) return res.status(503).json({ error: 'ElevenLabs not configured', configured: false });
  try {
    const { voice_id, text } = req.body ?? {};
    const audio = await textToSpeech(voice_id, text || 'Hi! This is a preview of how I sound.');
    res.json(audio);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test', async (req, res) => {
  if (!isElevenLabsConfigured()) return res.status(503).json({ error: 'ElevenLabs not configured', configured: false });
  try {
    const { text } = req.body ?? {};
    const companyRow = await pool.query(
      'SELECT voice_selected_id, voice_stability, voice_similarity_boost, voice_style, voice_speaker_boost, voice_model, voice_speed FROM companies WHERE id = $1',
      [req.tenantId]
    );
    const c = companyRow.rows[0] || {};
    if (!c.voice_selected_id) return res.status(400).json({ error: 'No voice selected' });
    const audio = await textToSpeech(c.voice_selected_id, text || 'Hi! This is a test.', {
      model: c.voice_model,
      stability: c.voice_stability,
      similarity_boost: c.voice_similarity_boost,
      style: c.voice_style,
      speaker_boost: c.voice_speaker_boost,
      speed: numOrDefault(c.voice_speed, 1.0),
    });
    res.json(audio);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/compare', async (req, res) => {
  if (!isElevenLabsConfigured()) return res.status(503).json({ error: 'ElevenLabs not configured', configured: false });
  try {
    const { text, voice_a, voice_b } = req.body ?? {};
    if (!text || !voice_a?.voice_id || !voice_b?.voice_id) {
      return res.status(400).json({ error: 'text, voice_a, and voice_b are required' });
    }
    const [audioA, audioB] = await Promise.all([
      textToSpeech(voice_a.voice_id, text, {
        stability: voice_a.stability ?? 0.5,
        similarity_boost: voice_a.similarity_boost ?? 0.75,
        style: voice_a.style ?? 0,
        speaker_boost: voice_a.speaker_boost ?? true,
      }),
      textToSpeech(voice_b.voice_id, text, {
        stability: voice_b.stability ?? 0.5,
        similarity_boost: voice_b.similarity_boost ?? 0.75,
        style: voice_b.style ?? 0,
        speaker_boost: voice_b.speaker_boost ?? true,
      }),
    ]);
    res.json({ audio_a: audioA, audio_b: audioB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/clone/:id', async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
