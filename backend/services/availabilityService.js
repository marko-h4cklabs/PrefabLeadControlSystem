const { pool } = require('../db/index');
const { schedulingSettingsRepository } = require('../db/repositories');
const { normalizeSchedulingSettings, workingHoursToDayMap } = require('./schedulingNormalizer');

const DAYS_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseHHMM(str) {
  const [h, m] = (str || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function padTwo(n) { return String(n).padStart(2, '0'); }
function minutesToHHMM(m) { return `${padTwo(Math.floor(m / 60))}:${padTwo(m % 60)}`; }

function getTZOffset(tz, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
    const localMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
    return localMs - date.getTime();
  } catch {
    return 60 * 60 * 1000;
  }
}

function localToUTC(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12, 0));
  const offset = getTZOffset(tz, ref);
  const targetAsUTC = Date.UTC(y, m - 1, d, h, min);
  return new Date(targetAsUTC - offset);
}

function todayInTZ(tz) {
  const now = new Date();
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return dtf.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${padTwo(dt.getMonth() + 1)}-${padTwo(dt.getDate())}`;
}

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAYS_ORDER[new Date(y, m - 1, d).getDay()];
}

function formatSlotLabel(dateStr, startTime, endTime, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dayName = dt.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dayName}, ${monthDay} • ${startTime}–${endTime}`;
}

/**
 * Fetch scheduled appointments in a window, supporting legacy scheduled_time fallback.
 */
async function getScheduledAppointments(companyId, fromUTC, toUTC, slotDurationMs) {
  const result = await pool.query(
    `SELECT
       COALESCE(start_at, scheduled_time) AS eff_start,
       COALESCE(end_at, scheduled_time + make_interval(mins := $4)) AS eff_end
     FROM appointments
     WHERE company_id = $1 AND status = 'scheduled'
       AND COALESCE(start_at, scheduled_time) < $3
       AND COALESCE(end_at, scheduled_time + make_interval(mins := $4)) > $2
     ORDER BY eff_start`,
    [companyId, fromUTC.toISOString(), toUTC.toISOString(), Math.round(slotDurationMs / 60000)]
  );
  return result.rows.map(r => ({
    start: new Date(r.eff_start).getTime(),
    end: new Date(r.eff_end).getTime(),
  }));
}

function slotsOverlap(slotStartMs, slotEndMs, appointments, bufferBeforeMs, bufferAfterMs) {
  for (const appt of appointments) {
    const blockStart = appt.start - bufferBeforeMs;
    const blockEnd = appt.end + bufferAfterMs;
    if (slotStartMs < blockEnd && slotEndMs > blockStart) return true;
  }
  return false;
}

/**
 * Core availability engine. Returns available slots for a company.
 */
async function getAvailability(companyId, opts = {}) {
  const raw = await schedulingSettingsRepository.get(companyId);
  const cfg = normalizeSchedulingSettings(raw);

  if (!cfg.enabled && !cfg.chatbotOfferBooking) {
    return {
      slots: [], timezone: cfg.timezone, slotDurationMinutes: cfg.slotDurationMinutes,
      settingsSummary: { enabled: cfg.enabled, timezone: cfg.timezone, slotDurationMinutes: cfg.slotDurationMinutes },
      debug: { hasWorkingHours: false, reason: 'scheduling_disabled' },
    };
  }

  const dayMap = workingHoursToDayMap(cfg.workingHours);
  const limit = Math.min(opts.limit || 10, 50);
  const today = todayInTZ(cfg.timezone);
  const startDate = opts.startDate || today;
  const endDate = opts.endDate || addDays(today, cfg.maxDaysAhead);
  const enabledDays = Object.keys(dayMap).filter(d => dayMap[d].length > 0);

  const summary = { enabled: cfg.enabled, timezone: cfg.timezone, slotDurationMinutes: cfg.slotDurationMinutes };

  if (enabledDays.length === 0) {
    return {
      slots: [], timezone: cfg.timezone, slotDurationMinutes: cfg.slotDurationMinutes,
      settingsSummary: summary,
      debug: { hasWorkingHours: false, reason: 'no_enabled_days' },
    };
  }

  const bufferBeforeMs = cfg.bufferBeforeMinutes * 60000;
  const bufferAfterMs = cfg.bufferAfterMinutes * 60000;
  const minNoticeMs = cfg.minNoticeHours * 3600000;
  const slotDurationMs = cfg.slotDurationMinutes * 60000;

  const windowStart = localToUTC(startDate, '00:00', cfg.timezone);
  const windowEnd = localToUTC(addDays(endDate, 1), '00:00', cfg.timezone);
  const appointments = await getScheduledAppointments(companyId, windowStart, windowEnd, slotDurationMs);

  const nowMs = Date.now();
  const earliestMs = nowMs + minNoticeMs;
  const slots = [];
  const seenKeys = new Set();
  let daysScanned = 0;
  let slotsGenerated = 0;
  let conflictsSkipped = 0;
  let pastSkipped = 0;
  let dupesSkipped = 0;

  let cursor = startDate;
  while (cursor <= endDate && slots.length < limit) {
    const weekday = dayOfWeek(cursor);
    const ranges = dayMap[weekday] || [];
    daysScanned++;

    for (const range of ranges) {
      const rangeStartMin = parseHHMM(range.start);
      const rangeEndMin = parseHHMM(range.end);
      let t = rangeStartMin;

      while (t + cfg.slotDurationMinutes <= rangeEndMin && slots.length < limit) {
        const startTime = minutesToHHMM(t);
        const endTime = minutesToHHMM(t + cfg.slotDurationMinutes);
        const slotStartUTC = localToUTC(cursor, startTime, cfg.timezone);
        const slotEndUTC = localToUTC(cursor, endTime, cfg.timezone);
        const slotStartMs = slotStartUTC.getTime();
        const slotEndMs = slotEndUTC.getTime();
        slotsGenerated++;

        if (slotStartMs < earliestMs) { pastSkipped++; t += cfg.slotDurationMinutes; continue; }
        if (slotsOverlap(slotStartMs, slotEndMs, appointments, bufferBeforeMs, bufferAfterMs)) {
          conflictsSkipped++; t += cfg.slotDurationMinutes; continue;
        }

        const isoStart = slotStartUTC.toISOString();
        const isoEnd = slotEndUTC.toISOString();
        const dedupeKey = `${isoStart}|${isoEnd}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          slots.push({
            id: `${cursor}_${startTime}`.replace(/:/g, ''),
            label: formatSlotLabel(cursor, startTime, endTime, cfg.timezone),
            startAt: isoStart,
            start_at: isoStart,
            endAt: isoEnd,
            end_at: isoEnd,
            date: cursor,
            startTime,
            endTime,
            timezone: cfg.timezone,
            appointmentType: opts.appointmentType || 'call',
            appointment_type: opts.appointmentType || 'call',
          });
        } else {
          dupesSkipped++;
        }
        t += cfg.slotDurationMinutes;
      }
    }
    cursor = addDays(cursor, 1);
  }

  // Sort ascending by startAt (should already be, but guarantee it)
  slots.sort((a, b) => a.startAt.localeCompare(b.startAt));

  let reason = null;
  if (slots.length === 0) {
    if (slotsGenerated === 0) reason = 'no_slots_in_range';
    else if (pastSkipped > 0 && conflictsSkipped === 0) reason = 'all_past_or_too_soon';
    else if (conflictsSkipped > 0) reason = 'all_conflicted';
    else reason = 'no_slots_in_range';
  }

  console.info('[availability]', {
    companyId, enabledDays, daysScanned, slotsGenerated,
    conflictsSkipped, pastSkipped, dupesSkipped, returned: slots.length, reason,
  });

  return {
    slots,
    timezone: cfg.timezone,
    slotDurationMinutes: cfg.slotDurationMinutes,
    settingsSummary: summary,
    debug: {
      hasWorkingHours: enabledDays.length > 0,
      reason,
      enabledDays,
      daysScanned,
      slotsGenerated,
      conflictsSkipped,
      pastSkipped,
      dupesSkipped,
      scannedFrom: startDate,
      scannedTo: endDate,
    },
  };
}

/**
 * Check if a specific slot is still available (for double-booking prevention).
 */
async function isSlotAvailable(companyId, startAtISO, endAtISO) {
  const raw = await schedulingSettingsRepository.get(companyId);
  const cfg = normalizeSchedulingSettings(raw);
  const bufferBeforeMs = cfg.bufferBeforeMinutes * 60000;
  const bufferAfterMs = cfg.bufferAfterMinutes * 60000;
  const slotDurationMs = cfg.slotDurationMinutes * 60000;

  const startMs = new Date(startAtISO).getTime();
  const endMs = endAtISO ? new Date(endAtISO).getTime() : startMs + slotDurationMs;

  const appointments = await getScheduledAppointments(
    companyId,
    new Date(startMs - bufferBeforeMs - 86400000),
    new Date(endMs + bufferAfterMs + 86400000),
    slotDurationMs
  );

  return !slotsOverlap(startMs, endMs, appointments, bufferBeforeMs, bufferAfterMs);
}

module.exports = { getAvailability, isSlotAvailable };
