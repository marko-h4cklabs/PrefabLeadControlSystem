/**
 * Per-company rate limiting using Redis INCR with per-minute sliding window.
 * Prevents one abusive tenant from exhausting limits for all others.
 */
const logger = require('../lib/logger');
const { getRedisClient } = require('../lib/redis');

const DEFAULT_LIMIT = 100; // per minute

async function companyRateLimit(req, res, next) {
  const companyId = req.tenantId || req.companyId;
  if (!companyId) return next();

  const redis = getRedisClient();
  if (!redis) return next(); // No Redis = no per-company limiting

  try {
    const window = Math.floor(Date.now() / 60000);
    const key = `ratelimit:${companyId}:${window}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120);

    const limit = DEFAULT_LIMIT;
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));

    if (count > limit) {
      logger.warn({ companyId, count, limit }, 'Company rate limit exceeded');
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please wait before retrying.',
        retry_after: 60,
      });
    }
  } catch (err) {
    // If Redis fails, allow the request (fail open)
    logger.warn({ err, companyId }, 'Company rate limit check failed');
  }

  next();
}

module.exports = companyRateLimit;
