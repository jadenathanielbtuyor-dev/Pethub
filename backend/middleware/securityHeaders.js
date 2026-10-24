const { API_PREFIXES, RETIRED_API_PREFIXES } = require('../constants/apiRoutes');

// HTTP security headers on every reply (OWASP HTTP Security Response Headers Cheat Sheet). API replies are JSON only,
// so their Content-Security-Policy lets nothing load from or frame them, and replies to signed-in requests are never
// stored by a browser or proxy cache. The frontend pages this server also serves for local development get the basic
// headers; on Vercel the pages get their own policy from frontend/vercel.json.
const API_PATH_PREFIXES = Object.freeze([...API_PREFIXES, ...RETIRED_API_PREFIXES]);
const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function isApiPath(path) {
  return API_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  // Railway serves HTTPS only; req.secure comes from its proxy's X-Forwarded-Proto (app.set('trust proxy', 1))
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (isApiPath(req.path)) {
    res.set('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
    if (req.headers.authorization) res.set('Cache-Control', 'no-store');
  }
  next();
}

module.exports = securityHeaders;
