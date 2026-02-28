/**
 * Calendly API integration - fetch scheduled events (booked calls).
 */

const logger = require('../src/lib/logger');

const CALENDLY_BASE = 'https://api.calendly.com';

/**
 * Make an authenticated request to the Calendly API.
 */
async function calendlyRequest(path, apiToken) {
  const url = path.startsWith('http') ? path : `${CALENDLY_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Calendly API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Get the current Calendly user URI (needed for fetching events).
 */
async function getCurrentUser(apiToken) {
  const data = await calendlyRequest('/users/me', apiToken);
  return data?.resource?.uri || null;
}

/**
 * Fetch scheduled events from Calendly.
 * @param {string} apiToken - Calendly personal access token
 * @param {object} opts - { minDate, maxDate, status }
 * @returns {Array} events with invitee info
 */
async function getScheduledEvents(apiToken, opts = {}) {
  if (!apiToken) throw new Error('Calendly API token not configured');

  // Get user URI
  const userUri = await getCurrentUser(apiToken);
  if (!userUri) throw new Error('Could not determine Calendly user');

  // Build query params
  const params = new URLSearchParams({ user: userUri, count: '100' });

  if (opts.minDate) {
    params.set('min_start_time', new Date(opts.minDate).toISOString());
  } else {
    // Default: show events from 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    params.set('min_start_time', thirtyDaysAgo.toISOString());
  }

  if (opts.maxDate) {
    params.set('max_start_time', new Date(opts.maxDate).toISOString());
  } else {
    // Default: show events up to 60 days from now
    const sixtyDaysOut = new Date();
    sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
    params.set('max_start_time', sixtyDaysOut.toISOString());
  }

  if (opts.status && ['active', 'canceled'].includes(opts.status)) {
    params.set('status', opts.status);
  }

  params.set('sort', 'start_time:asc');

  const data = await calendlyRequest(`/scheduled_events?${params.toString()}`, apiToken);
  const events = data?.collection || [];

  // Fetch invitees for each event (batched, max 10 concurrent)
  const enriched = [];
  const batchSize = 10;
  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (event) => {
        let invitees = [];
        try {
          const invData = await calendlyRequest(`${event.uri}/invitees`, apiToken);
          invitees = (invData?.collection || []).map((inv) => ({
            name: inv.name || '',
            email: inv.email || '',
            status: inv.status || 'active',
          }));
        } catch (err) {
          logger.warn({ eventUri: event.uri }, '[calendly] Failed to fetch invitees');
        }

        // Extract event type name from the URI
        let eventTypeName = '';
        try {
          if (event.event_type) {
            const etData = await calendlyRequest(event.event_type, apiToken);
            eventTypeName = etData?.resource?.name || '';
          }
        } catch { /* ok - just use empty */ }

        return {
          id: event.uri?.split('/').pop() || '',
          uri: event.uri,
          name: event.name || eventTypeName || 'Call',
          event_type: eventTypeName || event.name || 'Call',
          start_time: event.start_time,
          end_time: event.end_time,
          status: event.status || 'active',
          location: event.location?.location || event.location?.join_url || '',
          created_at: event.created_at,
          invitees,
          invitee_name: invitees[0]?.name || '',
          invitee_email: invitees[0]?.email || '',
        };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') enriched.push(r.value);
    }
  }

  return enriched;
}

/**
 * Validate a Calendly API token by making a test request.
 */
async function validateToken(apiToken) {
  try {
    const data = await calendlyRequest('/users/me', apiToken);
    return {
      valid: true,
      name: data?.resource?.name || '',
      email: data?.resource?.email || '',
      scheduling_url: data?.resource?.scheduling_url || '',
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = { getScheduledEvents, validateToken, getCurrentUser };
