const axios = require('axios');

/** Safe numeric parsing — returns fallback for null, undefined, NaN */
const numOrDefault = (val, fallback) => { const n = parseFloat(val); return Number.isFinite(n) ? n : fallback; };
const intOrDefault = (val, fallback) => { const n = parseInt(val, 10); return Number.isFinite(n) ? n : fallback; };

function getElevenLabsKey() {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key || key.length < 10) return null;
  return key;
}

function isElevenLabsConfigured() {
  return !!getElevenLabsKey();
}

async function elevenLabsRequest(method, path, data = null, extraHeaders = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured. Check ELEVENLABS_API_KEY in Railway.');

  const config = {
    method,
    url: `https://api.elevenlabs.io/v1${path}`,
    headers: {
      'xi-api-key': key,
      ...extraHeaders,
    },
    timeout: 60000,
  };
  if (data) config.data = data;

  const response = await axios(config);
  return response.data;
}

async function getUsage() {
  const data = await elevenLabsRequest('GET', '/user/subscription');
  return {
    characters_used: data.character_count || 0,
    character_limit: data.character_limit || 10000,
  };
}

async function getVoices() {
  const data = await elevenLabsRequest('GET', '/voices');
  return data.voices || [];
}

/**
 * Preprocess text for ElevenLabs TTS.
 * Converts informal pause markers to SSML <break> tags.
 * Supported on eleven_turbo_v2_5 and eleven_flash_v2_5 models.
 */
function preprocessForTTS(text) {
  return text
    .replace(/\.{3,}|…/g, '. <break time="0.6s" />')
    .replace(/--/g, ' <break time="0.4s" /> ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function textToSpeech(voiceId, text, settings = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured');

  const speed = Math.min(1.2, Math.max(0.7, numOrDefault(settings.speed, 1.0)));
  const data = {
    text: preprocessForTTS(text),
    model_id: settings.model || 'eleven_turbo_v2_5',
    voice_settings: {
      stability: settings.stability ?? 0.5,
      similarity_boost: settings.similarity_boost ?? 0.75,
      style: settings.style ?? 0,
      use_speaker_boost: settings.speaker_boost === true,
      speed,
    },
  };

  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    data,
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return {
    audio_base64: Buffer.from(response.data).toString('base64'),
    content_type: 'audio/mpeg',
  };
}

/**
 * Convert raw PCM buffer to WAV format by prepending a 44-byte header.
 */
function pcmToWav(pcmBuffer, sampleRate = 22050, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Generate procedural restaurant ambient noise (crowd murmur).
 * Low-pass filtered noise with slow amplitude modulation = distant crowd chatter.
 * Returns raw (un-normalized) Float64Array — normalized in generateAmbientNoise().
 */
function generateRestaurantAmbience(numSamples, sampleRate = 22050) {
  const samples = new Float64Array(numSamples);
  let lp1 = 0, lp2 = 0;
  const alpha1 = 0.06;  // ~200Hz murmur band
  const alpha2 = 0.12;  // ~400Hz upper murmur

  for (let i = 0; i < numSamples; i++) {
    const noise = Math.random() * 2 - 1;
    lp1 += alpha1 * (noise - lp1);
    lp2 += alpha2 * (lp1 - lp2);
    const t = i / sampleRate;
    // Slow amplitude modulation — mimics waves of crowd chatter
    const mod = 0.55
      + 0.20 * Math.sin(2 * Math.PI * 0.35 * t)
      + 0.13 * Math.sin(2 * Math.PI * 0.73 * t)
      + 0.08 * Math.sin(2 * Math.PI * 1.4 * t);
    samples[i] = lp2 * mod;
  }
  return samples;
}

/**
 * Street/traffic noise — deep rumble with sporadic bursts (passing cars).
 * Returns raw (un-normalized) Float64Array.
 */
function generateTrafficNoise(numSamples, sampleRate = 22050) {
  const samples = new Float64Array(numSamples);
  let lp1 = 0, lp2 = 0;
  const alpha1 = 0.02;  // ~45Hz — very deep road rumble
  const alpha2 = 0.04;  // ~90Hz — engine drone

  // Pre-generate random "car pass" events
  const carPasses = [];
  const avgGap = sampleRate * 3;
  let pos = Math.floor(Math.random() * avgGap);
  while (pos < numSamples) {
    carPasses.push({ center: pos, width: sampleRate * (0.8 + Math.random() * 1.5) });
    pos += Math.floor(avgGap * (0.5 + Math.random()));
  }

  for (let i = 0; i < numSamples; i++) {
    const noise = Math.random() * 2 - 1;
    lp1 += alpha1 * (noise - lp1);
    lp2 += alpha2 * (lp1 - lp2);

    let carBoost = 0;
    for (const car of carPasses) {
      const dist = Math.abs(i - car.center);
      if (dist < car.width) {
        carBoost = Math.max(carBoost, 1.8 * (1 - dist / car.width));
      }
    }

    samples[i] = lp2 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.15 * (i / sampleRate)) + carBoost);
  }
  return samples;
}

/**
 * White noise — flat-spectrum hiss.
 * Returns raw (un-normalized) Float64Array.
 */
function generateWhiteNoise(numSamples) {
  const samples = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.random() * 2 - 1;
  }
  return samples;
}

/**
 * Normalize a Float64Array to a target RMS, then write to 16-bit PCM buffer.
 * This ensures ALL noise types are equally loud regardless of their filter characteristics.
 */
function normalizeToBuffer(samples, targetRms) {
  // Calculate current RMS
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const currentRms = Math.sqrt(sumSq / samples.length);

  const scale = currentRms > 0 ? targetRms / currentRms : 0;
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const val = Math.round(samples[i] * scale);
    buffer.writeInt16LE(Math.max(-32767, Math.min(32767, val)), i * 2);
  }
  return buffer;
}

/**
 * Dispatcher — generates ambient noise, normalizes all types to consistent volume.
 * @param {string} type - One of: restaurant, street, white_noise
 * @param {number} numSamples
 * @param {number} sampleRate
 * @param {number} level - 1-10
 * @returns {Buffer|null} PCM 16-bit mono buffer, or null if type is unknown/null
 */
function generateAmbientNoise(type, numSamples, sampleRate = 22050, level = 5) {
  let rawSamples;
  switch (type) {
    case 'restaurant': rawSamples = generateRestaurantAmbience(numSamples, sampleRate); break;
    case 'street':     rawSamples = generateTrafficNoise(numSamples, sampleRate); break;
    case 'white_noise': rawSamples = generateWhiteNoise(numSamples); break;
    default:           return null;
  }
  // Target RMS: level 1 = 400, level 10 = 5000 (out of 32767 max)
  // This gives noise that's clearly audible but not overwhelming at high levels
  const targetRms = 400 + (level - 1) * 510;
  return normalizeToBuffer(rawSamples, targetRms);
}

/**
 * Add silence padding and natural fade-out to PCM audio.
 * Optionally mixes in ambient background noise (e.g. restaurant ambience).
 *
 * Fixes:
 * 1. Prepends ~250ms silence so the first words aren't cut off by the player
 * 2. Applies a gradual volume fade-out over the last ~1s so the voice
 *    trails off naturally (like real human speech)
 * 3. Appends ~400ms silence so the last word isn't clipped
 * 4. (Optional) Mixes restaurant ambient noise throughout
 */
function processVoiceAudio(pcmBuffer, sampleRate = 22050, ambientNoise = null, ambientLevel = 5) {
  const bytesPerSample = 2; // 16-bit PCM

  // 1. Silence padding
  const leadSilenceMs = 250;
  const trailSilenceMs = 400;
  const leadBytes = Math.floor(sampleRate * (leadSilenceMs / 1000)) * bytesPerSample;
  const trailBytes = Math.floor(sampleRate * (trailSilenceMs / 1000)) * bytesPerSample;
  const leadSilence = Buffer.alloc(leadBytes, 0);
  const trailSilence = Buffer.alloc(trailBytes, 0);

  // 2. Fade-out on the last ~1 second of actual audio (natural voice trailing)
  const fadeOutMs = 1000;
  const fadeOutSamples = Math.floor(sampleRate * (fadeOutMs / 1000));
  const totalSamples = Math.floor(pcmBuffer.length / bytesPerSample);
  const fadeStartSample = Math.max(0, totalSamples - fadeOutSamples);

  // Work on a copy so we don't mutate the original
  const audioData = Buffer.from(pcmBuffer);

  for (let i = fadeStartSample; i < totalSamples; i++) {
    const progress = (i - fadeStartSample) / (totalSamples - fadeStartSample); // 0 -> 1
    // Cosine fade: smooth curve from 1.0 down to 0.35 (don't go to zero, just quieter)
    const multiplier = 0.35 + 0.65 * (0.5 * (1 + Math.cos(Math.PI * progress)));
    const offset = i * bytesPerSample;
    if (offset + 1 < audioData.length) {
      const sample = audioData.readInt16LE(offset);
      audioData.writeInt16LE(Math.round(sample * multiplier), offset);
    }
  }

  // 3. Combine lead silence + voice + trail silence
  const combined = Buffer.concat([leadSilence, audioData, trailSilence]);

  // 4. Mix ambient noise if requested
  if (ambientNoise) {
    const totalCombinedSamples = Math.floor(combined.length / bytesPerSample);
    const clampedLevel = Math.max(1, Math.min(10, parseInt(ambientLevel) || 5));
    const ambient = generateAmbientNoise(ambientNoise, totalCombinedSamples, sampleRate, clampedLevel);
    if (ambient) {
      for (let i = 0; i < combined.length - 1; i += bytesPerSample) {
        const voice = combined.readInt16LE(i);
        const noise = ambient.readInt16LE(i);
        combined.writeInt16LE(Math.max(-32767, Math.min(32767, voice + noise)), i);
      }
    }
  }

  return combined;
}

/**
 * Generate TTS audio in WAV format (for ManyChat Instagram voice messages).
 * Requests PCM from ElevenLabs and wraps in a WAV header.
 */
async function textToSpeechWav(voiceId, text, settings = {}) {
  const key = getElevenLabsKey();
  if (!key) throw new Error('ElevenLabs API key not configured');

  const speed = Math.min(1.2, Math.max(0.7, numOrDefault(settings.speed, 1.0)));
  const data = {
    text: preprocessForTTS(text),
    model_id: settings.model || 'eleven_turbo_v2_5',
    voice_settings: {
      stability: settings.stability ?? 0.5,
      similarity_boost: settings.similarity_boost ?? 0.75,
      style: settings.style ?? 0,
      use_speaker_boost: settings.speaker_boost === true,
      speed,
    },
  };

  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    params: { output_format: 'pcm_22050' },
    data,
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const pcmBuffer = Buffer.from(response.data);

  // Apply silence padding (prevents first/last word cutoff), natural fade-out, and optional ambient noise
  const processedPcm = processVoiceAudio(pcmBuffer, 22050, settings.ambientNoise || null, intOrDefault(settings.ambientLevel, 5));
  const wavBuffer = pcmToWav(processedPcm, 22050);

  return {
    audio_base64: wavBuffer.toString('base64'),
    content_type: 'audio/wav',
  };
}

/**
 * Humanize text for TTS by injecting filler words and speech disfluencies.
 * Uses Claude Haiku for fast, cheap rewriting (~300-500ms).
 * Falls back to original text on any error.
 *
 * @param {string} text - Original message text
 * @param {string|null} stylePrompt - Optional voice_style_prompt from company settings
 * @returns {Promise<string>} Humanized text
 */
async function humanizeTextForTTS(text, stylePrompt = null) {
  const logger = require('../lib/logger');
  try {
    const { anthropic } = require('./claudeWithRetry');

    const systemParts = [
      'You are a speech writer for text-to-speech voice messages. Your job is to rewrite text so it sounds like a real human speaking naturally into their phone — not reading from a script.',
      '',
      'CONTEXT: This text is an Instagram DM reply from a business to a potential customer. It should sound warm, conversational, and authentic — like a real person casually voice-messaging someone back.',
      '',
      'RULES:',
      '- Add 1-3 filler words per message ("um", "uh", "like", "you know", "I mean", "so", "honestly", "actually") — but ONLY where a real person would naturally pause or think.',
      '- Add occasional self-corrections that sound natural (e.g. "we can — well, actually we could").',
      '- Use SSML break tags for natural pauses: <break time="0.4s" /> for short pauses, <break time="0.8s" /> for longer thinking pauses. Use 2-4 per message.',
      '- For short messages (under 15 words), expand slightly into warmer, more conversational phrasing. Don\'t let it sound curt.',
      '- Vary sentence length. Mix short punchy sentences with longer flowing ones.',
      '- DO NOT change the meaning, facts, names, numbers, prices, or intent.',
      '- DO NOT add greetings or sign-offs that weren\'t in the original.',
      '- DO NOT use ellipsis "..." — use <break> tags instead.',
      '- DO NOT wrap output in quotes or add any explanation.',
      '- Return ONLY the rewritten text with SSML break tags.',
    ];
    if (stylePrompt) {
      systemParts.push('', `VOICE STYLE: ${stylePrompt}`);
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251022',
      max_tokens: 600,
      system: systemParts.join('\n'),
      messages: [{ role: 'user', content: text }],
    });

    const result = (response.content?.[0]?.text ?? '').trim();
    if (result) {
      logger.info({ original: text.substring(0, 100), humanized: result.substring(0, 100) }, '[humanize] Text humanized for TTS');
    }
    return result || text;
  } catch (err) {
    logger.warn({ err: err.message }, '[humanize] Failed to humanize text, using original');
    return text;
  }
}

module.exports = { getElevenLabsKey, isElevenLabsConfigured, elevenLabsRequest, getUsage, getVoices, textToSpeech, textToSpeechWav, humanizeTextForTTS };
