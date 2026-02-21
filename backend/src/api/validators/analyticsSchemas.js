const { z } = require('zod');

const RANGE_OPTIONS = ['7', '30', '90'];
const SOURCE_OPTIONS = ['all', 'inbox', 'simulation'];
const CHANNEL_OPTIONS = ['all', 'whatsapp', 'messenger', 'instagram', 'telegram', 'email', 'web'];

const analyticsQuerySchema = z.object({
  range: z.preprocess(
    (v) => (v != null ? String(v).trim() : undefined),
    z.enum(RANGE_OPTIONS).optional().default('30')
  ),
  source: z.preprocess(
    (v) => (v != null ? String(v).trim().toLowerCase() : undefined),
    z.enum(SOURCE_OPTIONS).optional().default('all')
  ),
  channel: z.preprocess(
    (v) => {
      const s = v != null ? String(v).trim() : undefined;
      return (s === '' || s === null || s === undefined) ? undefined : s;
    },
    z.string().optional().default('all')
  ),
}).transform((o) => {
  const days = parseInt(o.range, 10) || 30;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return {
    ...o,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
});

module.exports = { analyticsQuerySchema, RANGE_OPTIONS, SOURCE_OPTIONS, CHANNEL_OPTIONS };
