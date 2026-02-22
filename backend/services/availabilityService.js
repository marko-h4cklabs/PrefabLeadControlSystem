const { pool } = require('../db/index');
const { schedulingSettingsRepository } = require('../db/repositories');

const DAYS_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_TO_FULL = { mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' };

function fullDayName(d) {
  if (!d) return '';
  const lower = d.toLowerCase().trim();
  return SHORT_TO_FULL[lower] || lower;
}

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

function arrayToDayMap(arr) {
  const map = {};
  for (const entry of (arr || [])) {
    const day = fullDayName(entry.day);
    if (!day) continue;
    if (!map[day]) map[day] = [];
    if (entry.start && entry.end) {
      map[day].push({ start: entry.start, end: entry.end });
    } else if (Array.isArray(entry.ranges)) {
      for (const r of entry.ranges) {
        if (r.start && r.end) map[day].push({ start: r.start, end: r.end });
      }
    }
  }
  return map;
}

function formatSlotLabel(dateStr, startTime, endTime, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dayName = dt.toLocaleDateString('en-US', { weekday: 'short' });
  const monthName = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dayName} ${monthName}, ${startTime}–${endTime} (${tz})`;
}

async function getScheduledAppointments(companyId, fromUTC, toUTC) {
  const result = await pool.query(
    `SELECT start_at, end_at FROM appointments
     WHERE company_id = $1 AND status = 'scheduled'
       AND start_at < $3 AND end_at > $2
     ORDER BY start_at`,
    [companyId, fromUTC.toISOString(), toUTC.toISOString()]
  );
  return result.rows.map(r => ({
    start: new Date(r.start_at).getTime(),
    end: new Date(r.end_at).getTime(),
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
 * @param {string} companyId
 * @param {Object} opts - { startDate?, endDate?, appointmentType?, limit? }
 * @returns {{ slots, timezone, slotDurationMinutes, debug }}
 */
async function getAvailability(companyId, opts = {}) {
  const settings = await schedulingSettingsRepository.get(companyId);
  const tz = settings.timezone || settings.tz || 'Europe/Zagreb';
  const slotDuration = settings.slotDurationMinutes || settings.slot_duration_minutes || 30;
  const bufferBefore = (settings.bufferBeforeMinutes || settings.buffer_before_minutes || 0) * 60000;
  const bufferAfter = (settings.bufferAfterMinutes || settings.buffer_after_minutes || 0) * 60000;
  const minNotice = (settings.minNoticeHours || settings.min_notice_hours || 2) * 3600000;
  const maxDays = settings.maxDaysAhead || settings.max_days_ahead || 30;
  const wh = settings.workingHours || settings.working_hours || [];
  const dayMap = arrayToDayMap(wh);
  const limit = Math.min(opts.limit || 10, 50);

  const today = todayInTZ(tz);
  const startDate = opts.startDate || today;
  const endDate = opts.endDate || addDays(today, maxDays);

  const enabledDays = Object.keys(dayMap).filter(d => dayMap[d].length > 0);
  if (enabledDays.length === 0) {
    return {
      slots: [], timezone: tz, slotDurationMinutes: slotDuration,
      debug: { reason: 'no_enabled_days', enabledDays: [], scannedFrom: startDate, scannedTo: endDate },
    };
  }

  const windowStart = localToUTC(startDate, '00:00', tz);
  const windowEnd = localToUTC(addDays(endDate, 1), '00:00', tz);
  const appointments = await getScheduledAppointments(companyId, windowStart, windowEnd);

  const nowMs = Date.now();
  const earliestMs = nowMs + minNotice;
  const slots = [];
  let daysScanned = 0;
  let slotsGenerated = 0;
  let conflictsSkipped = 0;
  let pastSkipped = 0;

  let cursor = startDate;
  while (cursor <= endDate && slots.length < limit) {
    const weekday = dayOfWeek(cursor);
    const ranges = dayMap[weekday] || [];
    daysScanned++;

    for (const range of ranges) {
      const rangeStartMin = parseHHMM(range.start);
      const rangeEndMin = parseHHMM(range.end);
      let t = rangeStartMin;

      while (t + slotDuration <= rangeEndMin && slots.length < limit) {
        const startTime = minutesToHHMM(t);
        const endTime = minutesToHHMM(t + slotDuration);
        const slotStartUTC = localToUTC(cursor, startTime, tz);
        const slotEndUTC = localToUTC(cursor, endTime, tz);
        const slotStartMs = slotStartUTC.getTime();
        const slotEndMs = slotEndUTC.getTime();
        slotsGenerated++;

        if (slotStartMs < earliestMs) { pastSkipped++; t += slotDuration; continue; }
        if (slotsOverlap(slotStartMs, slotEndMs, appointments, bufferBefore, bufferAfter)) { conflictsSkipped++; t += slotDuration; continue; }

        slots.push({
          id: `slot-${slots.length}`,
          label: formatSlotLabel(cursor, startTime, endTime, tz),
          startAt: slotStartUTC.toISOString(),
          endAt: slotEndUTC.toISOString(),
          date: cursor,
          startTime,
          endTime,
          timezone: tz,
        });
        t += slotDuration;
      }
    }
    cursor = addDays(cursor, 1);
  }

  let reason = null;
  if (slots.length === 0) {
    if (pastSkipped > 0 && conflictsSkipped === 0) reason = 'all_past_or_too_soon';
    else if (conflictsSkipped > 0) reason = 'all_conflicted';
    else reason = 'outside_working_hours';
  }

  return {
    slots,
    timezone: tz,
    slotDurationMinutes: slotDuration,
    debug: {
      reason,
      enabledDays,
      daysScanned,
      slotsGenerated,
      conflictsSkipped,
      pastSkipped,
      scannedFrom: startDate,
      scannedTo: endDate,
    },
  };
}

/**
 * Check if a specific slot is still available (for double-booking prevention).
 */
async function isSlotAvailable(companyId, startAtISO, endAtISO) {
  const settings = await schedulingSettingsRepository.get(companyId);
  const bufferBefore = (settings.bufferBeforeMinutes || settings.buffer_before_minutes || 0) * 60000;
  const bufferAfter = (settings.bufferAfterMinutes || settings.buffer_after_minutes || 0) * 60000;

  const startMs = new Date(startAtISO).getTime();
  const endMs = endAtISO ? new Date(endAtISO).getTime() : startMs + (settings.slotDurationMinutes || 30) * 60000;

  const appointments = await getScheduledAppointments(
    companyId,
    new Date(startMs - bufferBefore - 86400000),
    new Date(endMs + bufferAfter + 86400000)
  );

  return !slotsOverlap(startMs, endMs, appointments, bufferBefore, bufferAfter);
}

module.exports = { getAvailability, isSlotAvailable };
