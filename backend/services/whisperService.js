/**
 * OpenAI Whisper API - transcribe audio to text.
 * Supports direct buffer or download from URL (e.g. Instagram/ManyChat voice message URLs).
 */

const FormData = require('form-data');
const fetch = require('node-fetch');
const axios = require('axios');

async function transcribeAudio(audioBuffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for transcription');
  }

  console.log('[whisper] transcribing audio, length:', audioBuffer?.length ?? 0, 'bytes');

  const form = new FormData();
  form.append('file', audioBuffer, {
    filename: `audio.${mimeTypeToExt(mimeType)}`,
    contentType: mimeType || 'audio/webm',
  });
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API failed: ${res.status} ${errText}`);
  }

  const json = await res.json();
  const text = typeof json.text === 'string' ? json.text.trim() : '';

  return {
    text,
    duration: json.duration ?? null,
  };
}

/**
 * Download audio from URL (e.g. Instagram voice message) and transcribe.
 * @param {string} audioUrl - Public URL of the audio file
 * @returns {Promise<string|null>} Transcribed text or null on failure
 */
async function transcribeAudioFromUrl(audioUrl) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  if (!audioUrl || typeof audioUrl !== 'string') {
    throw new Error('No audio URL provided');
  }

  try {
    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 25 * 1024 * 1024, // 25MB
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PrefabLeadControl/1.0)',
      },
    });

    const buffer = Buffer.from(response.data);
    const contentType = (response.headers['content-type'] || '').split(';')[0].trim() || 'audio/mpeg';
    const result = await transcribeAudio(buffer, contentType);
    return result.text || null;
  } catch (err) {
    console.error('[whisper] Transcription from URL error:', err.message);
    return null;
  }
}

function mimeTypeToExt(mimeType) {
  const map = {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
  };
  return map[mimeType] || 'webm';
}

module.exports = { transcribeAudio, transcribeAudioFromUrl };
