/**
 * Build collected_infos for a lead (from conversation parsed_fields + attachments).
 */

const { conversationRepository, chatAttachmentRepository } = require('../db/repositories');
const { computeFieldsState } = require('../src/chat/fieldsState');
const { picturesToCollected, attachmentsToPicturesCollected } = require('../src/chat/picturesHelpers');

function parsedFieldsToCollected(parsedFields, quoteFields) {
  const quoteByName = Object.fromEntries((quoteFields ?? []).map((f) => [f.name, f]));
  return Object.entries(parsedFields ?? {})
    .filter(([, v]) => {
      if (v == null) return false;
      if (Array.isArray(v)) return v.length > 0;
      return String(v).trim() !== '';
    })
    .map(([name, value]) => {
      const qf = quoteByName[name];
      const type = name === 'pictures' ? 'pictures' : (qf?.type ?? 'text');
      const base = { name, type, units: qf?.units ?? null, priority: qf?.priority ?? 100 };
      if (name === 'pictures') {
        const { value: urls, links } = picturesToCollected(value);
        return { ...base, value: urls, links };
      }
      return { ...base, value };
    });
}

async function getCollectedInfosForLead(companyId, leadId) {
  const conversation = await conversationRepository.getByLeadId(leadId);
  const snapshot = conversation?.quote_snapshot ?? null;
  const orderedSnapshot = Array.isArray(snapshot) ? snapshot : (snapshot?.fields ? snapshot.fields : []);
  const parsedFields = conversation?.parsed_fields ?? {};
  let collectedFromParsed = parsedFieldsToCollected(parsedFields, orderedSnapshot);

  const picturesPreset = (orderedSnapshot ?? []).find((f) => f?.name === 'pictures' && f?.is_enabled !== false);
  if (picturesPreset) {
    const hasPictures = collectedFromParsed.some((c) => c.name === 'pictures');
    if (!hasPictures) {
      const attachments = await chatAttachmentRepository.getByLeadId(companyId, leadId);
      if (attachments.length > 0) {
        const baseUrl = process.env.BACKEND_URL || process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || 'http://localhost:3000';
        const { value: urls, links } = attachmentsToPicturesCollected(attachments, baseUrl);
        collectedFromParsed = [...collectedFromParsed, { name: 'pictures', value: urls, links, type: 'pictures', units: null, priority: picturesPreset.priority ?? 100 }];
      }
    }
  }

  const { collected_infos } = computeFieldsState(orderedSnapshot, collectedFromParsed);
  return (collected_infos ?? []).map((c) => ({
    name: c.name,
    type: c.type ?? 'text',
    value: c.value,
    units: c.units ?? null,
    ...(c.links && { links: c.links }),
  }));
}

module.exports = { getCollectedInfosForLead };
