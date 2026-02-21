const { pool } = require('../index');

const DEFAULTS = {
  email_enabled: false,
  email_recipients: [],
  notify_new_inquiry_inbox: true,
  notify_new_inquiry_simulation: false,
};

function toPlain(row) {
  if (!row) return null;
  const recipients = row.email_recipients;
  return {
    email_enabled: row.email_enabled ?? DEFAULTS.email_enabled,
    email_recipients: Array.isArray(recipients) ? recipients : (recipients && typeof recipients === 'string' ? JSON.parse(recipients) : []),
    notify_new_inquiry_inbox: row.notify_new_inquiry_inbox ?? DEFAULTS.notify_new_inquiry_inbox,
    notify_new_inquiry_simulation: row.notify_new_inquiry_simulation ?? DEFAULTS.notify_new_inquiry_simulation,
    updated_at: row.updated_at,
  };
}

async function get(companyId) {
  const result = await pool.query(
    'SELECT email_enabled, email_recipients, notify_new_inquiry_inbox, notify_new_inquiry_simulation, updated_at FROM notification_settings WHERE company_id = $1',
    [companyId]
  );
  const row = result.rows[0];
  if (!row) {
    return {
      ...DEFAULTS,
      updated_at: null,
    };
  }
  return toPlain(row);
}

async function upsert(companyId, data) {
  const recipients = Array.isArray(data.email_recipients) ? data.email_recipients : [];
  const result = await pool.query(
    `INSERT INTO notification_settings (company_id, email_enabled, email_recipients, notify_new_inquiry_inbox, notify_new_inquiry_simulation, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       email_enabled = EXCLUDED.email_enabled,
       email_recipients = EXCLUDED.email_recipients,
       notify_new_inquiry_inbox = EXCLUDED.notify_new_inquiry_inbox,
       notify_new_inquiry_simulation = EXCLUDED.notify_new_inquiry_simulation,
       updated_at = NOW()
     RETURNING email_enabled, email_recipients, notify_new_inquiry_inbox, notify_new_inquiry_simulation, updated_at`,
    [
      companyId,
      data.email_enabled ?? DEFAULTS.email_enabled,
      JSON.stringify(recipients),
      data.notify_new_inquiry_inbox ?? DEFAULTS.notify_new_inquiry_inbox,
      data.notify_new_inquiry_simulation ?? DEFAULTS.notify_new_inquiry_simulation,
    ]
  );
  return toPlain(result.rows[0]);
}

module.exports = {
  get,
  upsert,
  DEFAULTS,
};
