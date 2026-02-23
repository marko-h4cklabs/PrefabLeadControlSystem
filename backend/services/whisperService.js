/**
 * OpenAI Whisper API - transcribe audio to text.
 */

const FormData = require('form-data');
const fetch = require('node-fetch');

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

module.exports = { transcribeAudio };
