/**
 * Copilot AI Persona Generator
 *
 * Parses uploaded files (IG DM JSON exports, plain text transcripts, .docx, .xlsx)
 * and uses Claude to analyze the setter's communication style across all inputs,
 * then generates a comprehensive persona configuration for all 14 behavior fields.
 */

const logger = require('../src/lib/logger');
const { claudeWithRetry } = require('../src/utils/claudeWithRetry');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

/**
 * Parse a single file buffer based on its extension/mimetype.
 * Returns extracted text or null if unsupported.
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @param {string} originalname
 * @param {string|null} senderName  — when set, filter JSON DM exports to only this sender's messages
 */
async function parseFileToText(buffer, mimetype, originalname, senderName) {
  const ext = (originalname || '').split('.').pop().toLowerCase();

  // Plain text — read directly
  if (ext === 'txt' || mimetype === 'text/plain') {
    return buffer.toString('utf8');
  }

  // IG DM JSON export (or generic JSON transcript)
  if (ext === 'json' || mimetype === 'application/json') {
    try {
      const raw = buffer.toString('utf8');
      const data = JSON.parse(raw);

      // Helper: check if a sender_name matches the target (case-insensitive partial match)
      const matchesSender = (msgSender) => {
        if (!senderName) return true; // no filter — include everyone
        if (!msgSender) return false;
        return msgSender.toLowerCase().includes(senderName.toLowerCase());
      };

      // Instagram DM export format: { participants: [...], messages: [{ sender_name, content, timestamp_ms }] }
      if (data.messages && Array.isArray(data.messages)) {
        const participants = (data.participants || []).map((p) => p.name).join(', ');
        const header = participants ? `[Conversation between: ${participants}]\n\n` : '';

        if (senderName) {
          // Include ALL messages for context but mark the target sender's messages clearly
          const lines = data.messages
            .filter((m) => m.content && typeof m.content === 'string' && m.content.trim())
            .map((m) => {
              const isSetter = matchesSender(m.sender_name);
              const label = isSetter ? `[SETTER] ${m.sender_name || 'Unknown'}` : (m.sender_name || 'Lead');
              return `${label}: ${m.content.trim()}`;
            });
          if (lines.length > 0) return header + lines.join('\n');
        } else {
          const lines = data.messages
            .filter((m) => m.content && typeof m.content === 'string' && m.content.trim())
            .map((m) => `${m.sender_name || 'Unknown'}: ${m.content.trim()}`);
          if (lines.length > 0) return header + lines.join('\n');
        }
      }

      // Generic JSON array of message objects
      if (Array.isArray(data)) {
        const lines = data
          .filter((m) => m && (m.content || m.text || m.message))
          .map((m) => {
            const sender = m.sender || m.from || m.author || m.sender_name || '';
            const text = m.content || m.text || m.message || '';
            return sender ? `${sender}: ${text}` : text;
          })
          .filter(Boolean);
        if (lines.length > 0) return lines.join('\n');
      }

      // Fallback: stringify for Claude to make sense of
      return JSON.stringify(data, null, 2).slice(0, 50000);
    } catch {
      return buffer.toString('utf8').slice(0, 50000);
    }
  }

  // .docx and .xlsx — delegate to documentParser
  const { parseDocument } = require('../src/services/documentParser');
  return parseDocument(buffer, mimetype, originalname);
}

/**
 * Build the comprehensive persona analysis prompt.
 */
const ANALYSIS_PROMPT = `You are an expert sales communication analyst building AI persona profiles.

You have been given transcripts, DM exports, or documents from a salesperson / setter (the person selling or qualifying leads). Your job is to analyze their communication style in depth and output a precise persona configuration.

IMPORTANT: Focus ONLY on the business representative / setter — not on the leads they talk to. Identify who is the seller from context (usually the person initiating, asking questions, pitching) and extract ONLY their style.

Analyze carefully:
1. TONE — Is it professional, friendly, confident, or relatable?
2. MESSAGE LENGTH — Do they write short (1-2 sentences), medium (2-4), or long (6+) messages?
3. EMOJI USAGE — Do they use emojis? Frequently or sparingly?
4. PUNCTUATION — Do they end messages with a period? Do they use ellipses, no punctuation at all?
5. CAPITALIZATION — Always capitalized? Sometimes start lowercase? Mixed?
6. SHORT FORMS — Do they write "ur", "u", "gonna", "wanna", "rn", "ngl", "tbh"?
7. TYPOS — Are there occasional small intentional-feeling typos or is it always clean?
8. SPLIT MESSAGES — Do they send multiple short messages vs one long one?
9. APPROACH — Do they push straight toward qualifying/collecting info (field-focused) or warm up the lead with rapport first (rapport-building)?
10. FOLLOW-UP ENERGY — Gentle nudges, persistent CTAs, or leading with value?
11. CLOSING STYLE — Soft / assumptive / direct?
12. PERSONA NAME — What first name fits this person's vibe?
13. BOT RESPONSE — If a lead asked "are you a bot?", how would this person respond in their natural style?

Based on your analysis, generate the complete persona configuration. Return ONLY valid JSON:

{
  "agent_name": "a fitting first name for this persona",
  "agent_backstory": "2-3 paragraphs describing this person's sales personality, background, communication style, and approach — written so an AI can adopt this exact persona",
  "tone": "professional" or "friendly" or "confident" or "relatable",
  "response_length": "short" or "medium" or "long",
  "emojis_enabled": true or false,
  "opener_style": "casual" or "formal" or "question" or "statement" or "greeting" or "direct" or "professional",
  "conversation_approach": "field_focused" or "rapport_building",
  "follow_up_style": "gentle" or "persistent" or "value_first",
  "closing_style": "soft" or "direct" or "assumptive",
  "human_error_enabled": true or false,
  "human_error_types": ["typos", "no_periods", "lowercase_starts", "short_forms"],
  "human_error_random": true or false,
  "no_trailing_period": true or false,
  "bot_deny_response": "the exact response this persona would give if asked 'are you a bot?'",
  "style_summary": "2-3 sentences capturing the essence of this person's communication style — what makes them distinctive"
}

Rules:
- "human_error_types" should only contain types you actually observed: typos, no_periods, lowercase_starts, short_forms
- "human_error_enabled" should be true only if you found 2+ clear patterns
- "no_trailing_period" should be true if they consistently skip end periods
- "human_error_random" should be true if the imperfections are inconsistent/random
- Choose "rapport_building" if the conversations show warmth before business; "field_focused" if they get to the point quickly`;

/**
 * Generate a full persona configuration from an array of file buffers.
 *
 * @param {Array<{buffer: Buffer, mimetype: string, originalname: string}>} files
 * @param {string|null} senderName  — name of the setter to focus on (optional)
 * @returns {Promise<{ persona: Object, style_summary: string }>}
 */
async function generatePersonaFromFiles(files, senderName = null) {
  if (!files || files.length === 0) {
    throw new Error('At least one file is required');
  }

  // Parse all files to text
  const textParts = [];
  for (const f of files) {
    try {
      const text = await parseFileToText(f.buffer, f.mimetype, f.originalname, senderName);
      if (text && text.trim().length > 0) {
        textParts.push(`--- FILE: ${f.originalname} ---\n${text.trim()}`);
      }
    } catch (err) {
      logger.warn({ file: f.originalname, err: err.message }, '[personaGenerator] Failed to parse file, skipping');
    }
  }

  if (textParts.length === 0) {
    throw new Error('Could not extract text from any of the uploaded files. Try .txt, .json, .docx, or .xlsx files.');
  }

  const combinedText = textParts.join('\n\n');

  // Trim to ~80k chars to stay within token limits (Claude handles ~100k context)
  const truncated = combinedText.length > 80000 ? combinedText.slice(0, 80000) + '\n\n[...truncated for analysis...]' : combinedText;

  // Build user message — inject sender name hint when provided
  const senderHint = senderName
    ? `The person you must analyze is named "${senderName}". In the conversations below, their messages are marked with [SETTER] or simply appear under their name. ONLY model the style of "${senderName}" — completely ignore all other participants.\n\n`
    : '';

  const { content } = await claudeWithRetry({
    model,
    max_tokens: 2500,
    system: ANALYSIS_PROMPT,
    messages: [{ role: 'user', content: `${senderHint}Here are the conversations and documents to analyze:\n\n${truncated}\n\nGenerate the persona JSON now.` }],
  });

  const raw = content ?? '';
  let parsed;
  try {
    const match = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.agent_backstory) {
    logger.error({ raw: raw.slice(0, 500) }, '[personaGenerator] Failed to parse Claude JSON response');
    throw new Error('Analysis failed — could not extract persona from the provided files. Try adding more conversation examples.');
  }

  // Validate and sanitize
  const VALID_TONES = ['professional', 'friendly', 'confident', 'relatable'];
  const VALID_LENGTHS = ['short', 'medium', 'long'];
  const VALID_OPENERS = ['casual', 'formal', 'question', 'statement', 'greeting', 'direct', 'professional'];
  const VALID_APPROACHES = ['field_focused', 'rapport_building'];
  const VALID_FOLLOWUPS = ['gentle', 'persistent', 'value_first'];
  const VALID_CLOSINGS = ['soft', 'direct', 'assumptive'];
  const VALID_ERROR_TYPES = ['typos', 'no_periods', 'lowercase_starts', 'short_forms'];

  const persona = {
    agent_name: String(parsed.agent_name || 'Alex').slice(0, 50),
    agent_backstory: String(parsed.agent_backstory || '').slice(0, 3000),
    tone: VALID_TONES.includes(parsed.tone) ? parsed.tone : 'friendly',
    response_length: VALID_LENGTHS.includes(parsed.response_length) ? parsed.response_length : 'medium',
    emojis_enabled: Boolean(parsed.emojis_enabled),
    opener_style: VALID_OPENERS.includes(parsed.opener_style) ? parsed.opener_style : 'casual',
    conversation_approach: VALID_APPROACHES.includes(parsed.conversation_approach) ? parsed.conversation_approach : 'rapport_building',
    follow_up_style: VALID_FOLLOWUPS.includes(parsed.follow_up_style) ? parsed.follow_up_style : 'gentle',
    closing_style: VALID_CLOSINGS.includes(parsed.closing_style) ? parsed.closing_style : 'soft',
    human_error_enabled: Boolean(parsed.human_error_enabled),
    human_error_types: Array.isArray(parsed.human_error_types)
      ? parsed.human_error_types.filter((t) => VALID_ERROR_TYPES.includes(t))
      : [],
    human_error_random: Boolean(parsed.human_error_random),
    no_trailing_period: Boolean(parsed.no_trailing_period),
    bot_deny_response: String(parsed.bot_deny_response || "I'm a real person, just quick at responding!").slice(0, 300),
    style_summary: String(parsed.style_summary || '').slice(0, 500),
  };

  logger.info({
    agent_name: persona.agent_name,
    tone: persona.tone,
    response_length: persona.response_length,
    conversation_approach: persona.conversation_approach,
    human_error_enabled: persona.human_error_enabled,
    fileCount: files.length,
  }, '[personaGenerator] Persona generated successfully');

  return { persona, style_summary: persona.style_summary };
}

module.exports = { generatePersonaFromFiles };
