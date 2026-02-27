/**
 * Google Calendar two-way sync.
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (e.g. https://your-railway-url/api/integrations/google/callback)
 */
const logger = require('../lib/logger');
const { google } = require('googleapis');
const { pool } = require('../../db');

logger.info('[googleCalendar] Config check:', {
  hasClientId: !!process.env.GOOGLE_CLIENT_ID,
  hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
});

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(companyId) {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    state: companyId,
  });
}

async function getTokensFromCode(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function getAuthenticatedClient(company) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: company.google_access_token,
    refresh_token: company.google_refresh_token,
    expiry_date: company.google_token_expiry
      ? new Date(company.google_token_expiry).getTime()
      : null,
  });
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await updateCompanyGoogleTokens(company.id, tokens);
    }
  });
  return oauth2Client;
}

async function createCalendarEvent(company, appointment, lead) {
  const auth = await getAuthenticatedClient(company);
  const calendar = google.calendar({ version: 'v3', auth });
  const startTime = new Date(appointment.start_at || appointment.startAt);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  const event = {
    summary: `Call with ${lead.name || lead.channel || 'Lead'}`,
    description: `Lead from Instagram DM\nLead ID: ${lead.id}\nBudget: ${lead.budget_detected || 'Unknown'}\nScore: ${lead.intent_score ?? '—'}/100`,
    start: { dateTime: startTime.toISOString() },
    end: { dateTime: endTime.toISOString() },
    conferenceData: {
      createRequest: {
        requestId: appointment.id,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    attendees: lead.email ? [{ email: lead.email }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 1440 },
        { method: 'popup', minutes: 60 },
      ],
    },
  };
  const response = await calendar.events.insert({
    calendarId: company.google_calendar_id || 'primary',
    resource: event,
    conferenceDataVersion: 1,
  });
  return {
    google_event_id: response.data.id,
    google_meet_link: response.data.hangoutLink || null,
  };
}

async function updateCalendarEvent(company, appointment, lead) {
  if (!appointment.google_event_id) return;
  const auth = await getAuthenticatedClient(company);
  const calendar = google.calendar({ version: 'v3', auth });
  const startTime = new Date(appointment.start_at || appointment.startAt);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  await calendar.events.patch({
    calendarId: company.google_calendar_id || 'primary',
    eventId: appointment.google_event_id,
    resource: {
      summary: `Call with ${lead.name || lead.channel || 'Lead'}`,
      start: { dateTime: startTime.toISOString() },
      end: { dateTime: endTime.toISOString() },
      status: appointment.status === 'cancelled' ? 'cancelled' : 'confirmed',
    },
  });
}

async function deleteCalendarEvent(company, googleEventId) {
  if (!googleEventId) return;
  const auth = await getAuthenticatedClient(company);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: company.google_calendar_id || 'primary',
    eventId: googleEventId,
  });
}

async function getUpcomingEvents(company, days = 30) {
  const auth = await getAuthenticatedClient(company);
  const calendar = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  logger.info('[googleCalendar] Fetching events from', now.toISOString(), 'to', future.toISOString());
  const response = await calendar.events.list({
    calendarId: company.google_calendar_id || 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return response.data.items || [];
}

async function getBusySlots(company, date) {
  const auth = await getAuthenticatedClient(company);
  const calendar = google.calendar({ version: 'v3', auth });
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  const response = await calendar.freebusy.query({
    resource: {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      items: [{ id: company.google_calendar_id || 'primary' }],
    },
  });
  const busySlots = response.data.calendars?.[company.google_calendar_id || 'primary']?.busy || [];
  return busySlots;
}

/**
 * After a new appointment is created, sync to Google Calendar if company is connected.
 * Updates the appointment row with google_event_id, google_meet_link, synced_to_google.
 */
async function syncNewAppointmentToGoogle(companyId, appointment, lead) {
  if (!companyId || !appointment?.id || !lead) return;
  const companyRow = (await pool.query(
    'SELECT id, google_calendar_connected, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
    [companyId]
  )).rows[0];
  if (!companyRow?.google_calendar_connected) return;
  try {
    const { google_event_id, google_meet_link } = await createCalendarEvent(companyRow, appointment, lead);
    await pool.query(
      'UPDATE appointments SET google_event_id = $1, google_meet_link = $2, synced_to_google = true, sync_error = NULL WHERE id = $3 AND company_id = $4',
      [google_event_id, google_meet_link, appointment.id, companyId]
    );
    logger.info('[googleCalendar] Event created:', google_event_id);
  } catch (err) {
    logger.error('[googleCalendar] Sync failed:', err.message);
    await pool.query('UPDATE appointments SET sync_error = $1 WHERE id = $2 AND company_id = $3', [err.message, appointment.id, companyId]).catch(() => {});
  }
}

async function updateCompanyGoogleTokens(companyId, tokens) {
  await pool.query(
    `UPDATE companies SET
      google_access_token = $1,
      google_refresh_token = COALESCE($2, google_refresh_token),
      google_token_expiry = $3,
      google_calendar_connected = true
    WHERE id = $4`,
    [
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      companyId,
    ]
  );
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  getAuthenticatedClient,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getUpcomingEvents,
  getBusySlots,
  updateCompanyGoogleTokens,
  syncNewAppointmentToGoogle,
};
