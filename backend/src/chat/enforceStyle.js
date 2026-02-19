/**
 * Enforce chatbot behavior settings on assistant message.
 * Run on every assistant draft before returning to client.
 */
function stripEmojis(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
}

const GREETING_PATTERNS = /\b(hi|hello|hey|welcome|greetings|good (morning|afternoon|evening)|thanks for (reaching out|contacting|writing)|great (question|choice|to hear)|glad (you|to)\b)/gi;
const APOLOGY_FILLER_PATTERNS = /\b(got it|noted|gotcha|understood|sure thing|no problem|of course|absolutely|certainly|thanks|thank you|sorry|apologize|apologies|unfortunately|I'm afraid)\b/gi;

function removeGreetingsAndFiller(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text
    .replace(GREETING_PATTERNS, '')
    .replace(APOLOGY_FILLER_PATTERNS, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[,.\s\-]+/, '').trim();
  return s;
}

function limitToShort(text) {
  if (!text || typeof text !== 'string') return text;
  const raw = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const sentences = raw.filter((s) => s.replace(/[.!?,\s\-]+/g, '').length > 0);
  if (sentences.length <= 2) return text.trim();
  const bulletMatch = text.match(/^[•\-\*]\s+.+$/gm);
  if (bulletMatch && bulletMatch.length <= 3) return text.trim();
  const limited = sentences.slice(0, 2).join(' ');
  const lastPeriod = limited.lastIndexOf('.');
  return lastPeriod > 0 ? limited.slice(0, lastPeriod + 1) : limited;
}

function enforceForbiddenTopics(text, forbiddenTopics, replacement) {
  if (!text || !Array.isArray(forbiddenTopics) || forbiddenTopics.length === 0) return text;
  const lower = text.toLowerCase();
  const hit = forbiddenTopics.some((t) => {
    const term = (t || '').toLowerCase().trim();
    return term && lower.includes(term);
  });
  if (!hit) return text;
  return replacement || "I can't help with that. What is your [next required field]?";
}

function enforceStyle(text, behavior, options = {}) {
  let result = text || '';
  const beh = behavior ?? {};
  const { nextRequiredField, forbiddenReplacement } = options;

  if (beh.emojis_enabled === false) {
    result = stripEmojis(result);
  }

  if (beh.persona_style === 'busy') {
    result = removeGreetingsAndFiller(result);
  }

  if (beh.response_length === 'short') {
    result = limitToShort(result);
  }

  if (beh.forbidden_topics && beh.forbidden_topics.length > 0) {
    const repl = nextRequiredField
      ? `What is your ${nextRequiredField}?`
      : forbiddenReplacement || "I can't help with that.";
    result = enforceForbiddenTopics(result, beh.forbidden_topics, repl);
  }

  return result.trim() || text;
}

module.exports = { enforceStyle, stripEmojis, removeGreetingsAndFiller, limitToShort };
