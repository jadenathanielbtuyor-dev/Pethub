const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { RATE_LIMITS } = require('../constants/rateLimits');

// Fixed-window request counter kept in memory (constants/rateLimits.js explains the limits).
// Each named limit has its own count per client, so a burst of logins does not use up the registration allowance.

const counters = new Map();
// Expired windows are dropped now and then, so the map can't grow without bound
const SWEEP_EVERY_REQUESTS = 500;
let requestsSinceSweep = 0;

function sweepExpired(now) {
  counters.forEach((entry, key) => {
    if (entry.resetAt <= now) counters.delete(key);
  });
}

// IP address for public endpoints (Express reads it from the proxy header because server.js trusts one proxy hop);
// the verified account id for signed-in ones
function byClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function byAuthUser(req) {
  return req.authUserId ? `user:${req.authUserId}` : byClientIp(req);
}

function rateLimit(name, { keyFor = byClientIp } = {}) {
  const limit = RATE_LIMITS[name];
  if (!limit) throw new Error(`Unknown rate limit: ${name}`);
  const windowMs = limit.windowMinutes * 60 * 1000;

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    requestsSinceSweep += 1;
    if (requestsSinceSweep >= SWEEP_EVERY_REQUESTS) {
      requestsSinceSweep = 0;
      sweepExpired(now);
    }

    const key = `${name}:${keyFor(req)}`;
    let entry = counters.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      counters.set(key, entry);
    }

    entry.count += 1;
    if (entry.count <= limit.max) return next();

    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const minutes = Math.ceil(retryAfterSeconds / 60);
    // The limit name and path only: client addresses and request bodies are not logged
    logger.warn('rate_limit.blocked', { limit: name, path: req.originalUrl || req.url });
    res.set('Retry-After', String(retryAfterSeconds));
    return apiResponse.error(res, `Too many attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`, 429);
  };
}

module.exports = {
  rateLimit,
  byAuthUser
};
