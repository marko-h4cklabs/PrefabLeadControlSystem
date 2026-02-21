const { pool } = require('../db');
const { schedulingSettingsRepository } = require('../db/repositories');

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dateToStr(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Convert canonical workingHours array to per-day lookup:
 *   [{ day:"monday", start:"09:00", end:"17:00" }]
 *   → { monday: [{ start:"09:00", end:"17:00" }] }
 */
function arrayToDayMap(whArray) {
  const map = {};
  if (!Array.isArray(whArray)) return map;
  for (const entry of whArray) {
    if (!entry || !entry.day || !entry.start || !entry.end) continue;
    if (!map[entry.day]) map[entry.day] = [];
    map[entry.day].push({ start: entry.start, end: entry.end });
  }
  return map;
}

function buildSlotsForDay(dateStr, ranges, slotMins, tzOffset) {
  const slots = [];
  for (const range of ranges) {
    const startMin = parseHHMM(range.start);
    const endMin = parseHHMM(range.end);
    for (let t = startMin; t + slotMins <= endMin; t += slotMins) {
      const sh = String(Math.floor(t / 60)).padStart(2, '0');
      const sm = String(t % 60).padStart(2, '0');
      const eh = String(Math.floor((t + slotMins) / 60)).padStart(2, '0');
      const em = String((t + slotMins) % 60).padStart(2, '0');
      slots.push({
        startAt: `${dateStr}T${sh}:${sm}:00${tzOffset}`,
        endAt: `${dateStr}T${eh}:${em}:00${tzOffset}`,
      });
    }
  }
  return slots;
}

async function getAvailability(companyId, { from, to, appointmentType }) {
  const settings = await schedulingSettingsRepository.get(companyId);
  const tz = settings.timezone || 'Europe/Zagreb';
  const slotMins = settings.slotDurationMinutes || 30;
  const bufferBefore = settings.bufferBeforeMinutes || 0;
  const bufferAfter = settings.bufferAfterMinutes || 0;
  const minNoticeHours = settings.minNoticeHours || 2;
  const maxDaysAhead = settings.maxDaysAhead || 30;
  const workingHoursByDay = arrayToDayMap(settings.workingHours || []);

  const now = new Date();
  const minNoticeMs = minNoticeHours * 3600_000;

  const fromDate = from ? new Date(from) : new Date(dateToStr(now));
  const maxDate = addDays(now, maxDaysAhead);
  let toDate = to ? new Date(to) : addDays(fromDate, 7);
  if (toDate > maxDate) toDate = maxDate;
  const maxRange = addDays(fromDate, 31);
  if (toDate > maxRange) toDate = maxRange;

  const tzOffset = '+01:00';

  const existingRes = await pool.query(
    `SELECT start_at, end_at FROM appointments
     WHERE company_id = $1 AND status = 'scheduled'
       AND start_at >= $2::date AND start_at < ($3::date + interval '1 day')
     ORDER BY start_at`,
    [companyId, dateToStr(fromDate), dateToStr(toDate)]
  );
  const booked = existingRes.rows.map((r) => ({
    start: new Date(r.start_at).getTime() - bufferBefore * 60000,
    end: new Date(r.end_at).getTime() + bufferAfter * 60000,
  }));

  const days = [];
  let cursor = new Date(fromDate);
  while (cursor <= toDate) {
    const dayName = DAY_NAMES[cursor.getDay()];
    const dateStr = dateToStr(cursor);
    const ranges = workingHoursByDay[dayName];

    if (ranges && ranges.length > 0) {
      const allSlots = buildSlotsForDay(dateStr, ranges, slotMins, tzOffset);
      const available = allSlots.filter((slot) => {
        const sTime = new Date(slot.startAt).getTime();
        const eTime = new Date(slot.endAt).getTime();
        if (sTime < now.getTime() + minNoticeMs) return false;
        return !booked.some((b) => sTime < b.end && eTime > b.start);
      });
      days.push({ date: dateStr, slots: available });
    } else {
      days.push({ date: dateStr, slots: [] });
    }
    cursor = addDays(cursor, 1);
  }

  return {
    timezone: tz,
    slotDurationMinutes: slotMins,
    days,
  };
}

module.exports = { getAvailability };
