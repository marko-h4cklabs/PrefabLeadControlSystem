const { z } = require('zod');

const RANGE_OPTIONS = ['7', '30', '90'];
const SOURCE_OPTIONS = ['all', 'inbox', 'simulation'];
const CHANNEL_OPTIONS = ['all', 'whatsapp', 'messenger', 'instagram', 'telegram', 'email', 'web'];

const analyticsQuerySchema = z.object({
  range: z.preprocess(
    (v) => {
      if (v == null) return undefined;
      const n = parseInt(String(v).trim(), 10);
      if ([7, 30, 90].includes(n)) return String(n);
      const s = String(v).trim();
      return s === '' ? undefined : s;
    },
    z.enum(RANGE_OPTIONS).optional().default('30')
  ),
  source: z.preprocess(
    (v) => {
      const s = v != null ? String(v).trim().toLowerCase() : undefined;
      if (!s || s === '') return undefined;
      if (['all', 'inbox', 'simulation'].includes(s)) return s;
      return undefined;
    },
    z.enum(SOURCE_OPTIONS).optional().default('all')
  ),
  channel: z.preprocess(
    (v) => {
      const s = v != null ? String(v).trim().toLowerCase() : undefined;
      if (!s || s === '' || s === 'all' || s === 'all channels') return undefined;
      return s;
    },
    z.string().optional().default('all')
  ),
}).transform((o) => {
  const days = parseInt(o.range, 10) || 30;
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  return {
    ...o,
    days,
    startDate,
    endDate,
  };
});

module.exports = { analyticsQuerySchema, RANGE_OPTIONS, SOURCE_OPTIONS, CHANNEL_OPTIONS };
