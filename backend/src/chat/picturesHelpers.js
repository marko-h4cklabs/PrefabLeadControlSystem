/**
 * Normalize pictures from parsed_fields to collected format (value + links).
 * Handles both legacy (array of URLs) and new format (array of {label, url}).
 * @param {Array} raw - parsed_fields.pictures: array of URLs or [{label, url}]
 * @returns {{ value: string[], links: {label: string, url: string}[] }}
 */
function picturesToCollected(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const links = arr.map((item, i) => {
    if (typeof item === 'object' && item && item.url) {
      return { label: item.label || `Picture ${i + 1}`, url: item.url };
    }
    return { label: `Picture ${i + 1}`, url: String(item) };
  });
  const value = links.map((l) => l.url);
  return { value, links };
}

/**
 * Build pictures collected format from attachments.
 * @param {Array} attachments - from chatAttachmentRepository.getByLeadId
 * @param {string} baseUrl - backend base URL
 * @returns {{ value: string[], links: {label: string, url: string}[] }}
 */
function attachmentsToPicturesCollected(attachments, baseUrl) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const links = (attachments ?? []).map((a, i) => ({
    label: `Picture ${i + 1}`,
    url: `${base}/public/attachments/${a.id}/${a.public_token}`,
  }));
  const value = links.map((l) => l.url);
  return { value, links };
}

/**
 * Append a new picture to existing parsed_fields.pictures.
 * Normalizes existing items to {label, url} and appends the new one.
 * @param {Array} existing - current parsed_fields.pictures
 * @param {string} url - new picture URL
 * @returns {Array} [{label, url}, ...]
 */
function appendPictureToParsed(existing, url) {
  const arr = Array.isArray(existing) ? existing : [];
  const normalized = arr.map((item, i) => {
    if (typeof item === 'object' && item && item.url) {
      return { label: item.label || `Picture ${i + 1}`, url: item.url };
    }
    return { label: `Picture ${i + 1}`, url: String(item) };
  });
  normalized.push({ label: `Picture ${normalized.length + 1}`, url });
  return normalized;
}

module.exports = {
  picturesToCollected,
  attachmentsToPicturesCollected,
  appendPictureToParsed,
};
