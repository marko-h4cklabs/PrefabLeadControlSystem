/**
 * Email notification service with Resend provider.
 * Does not crash if env vars missing; logs warning and skips sending.
 */

let resendClient = null;

function initResend() {
  if (resendClient !== null) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    if (!process.env.EMAIL_PROVIDER) return null;
    console.warn('[emailService] RESEND_API_KEY or EMAIL_FROM not set; email notifications disabled');
    return null;
  }
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    return resendClient;
  } catch (err) {
    console.warn('[emailService] Resend init failed:', err.message);
    return null;
  }
}

function getFrom() {
  return process.env.EMAIL_FROM || 'notifications@example.com';
}

function formatCollectedValue(c) {
  if (c.type === 'pictures') {
    const urls = Array.isArray(c.value) ? c.value : [];
    const links = c.links || urls.map((url, i) => ({ label: `Picture ${i + 1}`, url }));
    return links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(', ') || '-';
  }
  if (Array.isArray(c.value)) {
    return c.value.map((v) => escapeHtml(String(v))).join(', ');
  }
  return escapeHtml(String(c.value ?? '-'));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function humanizeFieldName(name) {
  return String(name ?? '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build HTML email body with lead info and collected highlights.
 */
function buildEmailHtml(lead, opts = {}) {
  const { baseUrl, collectedInfos = [] } = opts;
  const source = lead.source ?? 'inbox';
  const leadName = lead.name ?? lead.external_id ?? 'Unknown';
  const channel = lead.channel ?? '-';
  const status = lead.status_name ?? lead.status ?? '-';
  const createdAt = lead.created_at
    ? new Date(lead.created_at).toLocaleString()
    : new Date().toLocaleString();

  const viewUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/inbox/${lead.id}` : null;

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New inquiry received</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;font-size:15px;line-height:1.5;color:#333;background:#f5f5f5;">
  <div style="max-width:560px;margin:24px auto;padding:0 16px;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden;">
      <div style="background:#2563eb;color:#fff;padding:20px 24px;">
        <h1 style="margin:0;font-size:20px;font-weight:600;">New inquiry received</h1>
        <p style="margin:8px 0 0;font-size:14px;opacity:0.9;">${escapeHtml(source === 'inbox' ? 'Inbox' : 'Simulation')}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:600;color:#64748b;width:120px;">Lead</td><td style="padding:8px 0;">${escapeHtml(leadName)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:600;color:#64748b;">Channel</td><td style="padding:8px 0;">${escapeHtml(channel)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:600;color:#64748b;">Source</td><td style="padding:8px 0;">${escapeHtml(source)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:600;color:#64748b;">Status</td><td style="padding:8px 0;">${escapeHtml(status)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:600;color:#64748b;">Created</td><td style="padding:8px 0;">${escapeHtml(createdAt)}</td></tr>
        </table>`;

  if (collectedInfos.length > 0) {
    html += `
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid #e2e8f0;">
          <h2 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#1e293b;">Collected info</h2>
          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:6px;">
            <tbody>`;
    for (const c of collectedInfos) {
      const label = humanizeFieldName(c.name);
      const value = formatCollectedValue(c);
      html += `
            <tr>
              <td style="padding:12px 16px;font-weight:500;color:#475569;border-bottom:1px solid #e2e8f0;">${escapeHtml(label)}</td>
              <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">${value}</td>
            </tr>`;
    }
    html += `
            </tbody>
          </table>
        </div>`;
  }

  if (viewUrl) {
    html += `
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid #e2e8f0;text-align:center;">
          <a href="${escapeHtml(viewUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;">View inquiry</a>
        </div>`;
  }

  html += `
      </div>
    </div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Build plain text fallback.
 */
function buildEmailText(lead, opts = {}) {
  const { baseUrl, collectedInfos = [] } = opts;
  const source = lead.source ?? 'inbox';
  const leadName = lead.name ?? lead.external_id ?? 'Unknown';
  const channel = lead.channel ?? '-';
  const status = lead.status_name ?? lead.status ?? '-';
  const createdAt = lead.created_at
    ? new Date(lead.created_at).toLocaleString()
    : new Date().toLocaleString();

  let text = `New inquiry received (${source === 'inbox' ? 'Inbox' : 'Simulation'})\n\n`;
  text += `Lead: ${leadName}\n`;
  text += `Channel: ${channel}\n`;
  text += `Source: ${source}\n`;
  text += `Status: ${status}\n`;
  text += `Created: ${createdAt}\n`;

  if (collectedInfos.length > 0) {
    text += `\n--- Collected info ---\n`;
    for (const c of collectedInfos) {
      const label = humanizeFieldName(c.name);
      let val = c.value;
      if (c.type === 'pictures' && Array.isArray(c.value)) {
        val = c.value.join(', ');
      } else if (Array.isArray(val)) {
        val = val.join(', ');
      }
      text += `${label}: ${val ?? '-'}\n`;
    }
  }

  if (baseUrl) {
    text += `\nView: ${baseUrl.replace(/\/+$/, '')}/inbox/${lead.id}\n`;
  }

  return text;
}

/**
 * Send new inquiry email. Does not throw; logs errors.
 * @param {string[]} to - recipient emails
 * @param {object} lead - { id, name, external_id, channel, source, status_name, created_at }
 * @param {object} [opts] - { baseUrl?, collectedInfos? }
 */
async function sendNewLeadEmail(to, lead, opts = {}) {
  if (!to || to.length === 0) return;
  const client = initResend();
  if (!client) return;

  const source = lead.source ?? 'inbox';
  const subject = `New inquiry received (${source === 'inbox' ? 'Inbox' : 'Simulation'})`;
  const baseUrl = typeof opts === 'string' ? opts : opts?.baseUrl;
  const collectedInfos = opts?.collectedInfos ?? [];
  const options = { baseUrl, collectedInfos };

  const html = buildEmailHtml(lead, options);
  const text = buildEmailText(lead, options);

  try {
    const { error } = await client.emails.send({
      from: getFrom(),
      to,
      subject,
      html,
      text,
    });
    if (error) {
      console.error('[emailService] Resend error:', error);
    }
  } catch (err) {
    console.error('[emailService] Send failed:', err.message);
  }
}

module.exports = {
  sendNewLeadEmail,
  initResend,
};
