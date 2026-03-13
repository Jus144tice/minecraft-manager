// Security middleware: Helmet headers, rate limiting, origin validation, access control.

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// ---- Security headers via Helmet ----

export function buildHelmet() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:      ["'self'"],
        scriptSrc:       ["'self'", "'unsafe-inline'"],
        styleSrc:        ["'self'", "'unsafe-inline'"],
        imgSrc:          ["'self'", 'https:', 'data:', 'blob:'],
        connectSrc:      ["'self'", 'ws:', 'wss:'],
        frameAncestors:  ["'none'"],
        upgradeInsecureRequests: process.env.TRUST_PROXY === '1' ? [] : null,
      },
    },
    // Not needed for this app; causes issues with some browsers on WebSocket
    crossOriginEmbedderPolicy: false,
  });
}

// ---- Rate limiters ----

// Auth endpoints: strict — 20 attempts per 15 minutes per IP, failed requests only.
export function buildAuthLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
  });
}

// API routes: generous — 300 requests per minute per IP (admin-only traffic).
export function buildApiLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please slow down.' },
  });
}

// ---- CSRF token check for mutating API requests ----
// Validates the X-CSRF-Token header against the session-stored token.
// Apply after requireSession so req.session is always populated.
// GET/HEAD/OPTIONS are safe methods and are always skipped.

export function buildCsrfCheck() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    const token = req.headers['x-csrf-token'];
    if (!token || !req.session?.csrfToken || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'CSRF token missing or invalid' });
    }
    next();
  };
}

// ---- Same-origin check for mutating requests ----
// Defence-in-depth alongside SameSite=Lax cookies. Rejects cross-origin POST/PUT/DELETE
// requests that include an Origin header pointing to a different host.

export function buildSameOriginCheck(appUrl) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    const origin = req.headers.origin;
    if (!origin) return next(); // same-origin requests from the SPA may omit Origin

    try {
      const expectedHost = appUrl ? new URL(appUrl).host : req.headers.host;
      if (new URL(origin).host !== expectedHost) {
        return res.status(403).json({ error: 'Cross-origin request denied' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin header' });
    }
    next();
  };
}

// ---- WebSocket origin check ----
// Returns null if the origin is allowed, or a rejection reason string.
// When appUrl is set, only that origin is allowed.
// When appUrl is unset, any origin matching the Host header is allowed (dev/LAN mode).

export function checkWsOrigin(origin, host, appUrl) {
  if (!origin) return null; // browser same-origin WS omits Origin; non-browser clients too

  try {
    const originHost = new URL(origin).host;
    if (appUrl) {
      const allowed = new URL(appUrl).host;
      return originHost === allowed ? null : `Origin ${origin} does not match APP_URL (${appUrl})`;
    }
    // No APP_URL — allow if origin matches the Host header
    if (host && originHost === host) return null;
    return `Origin ${origin} does not match Host header (${host})`;
  } catch {
    return `Invalid Origin header: ${origin}`;
  }
}

// ---- Admin access guard ----
// Requires the logged-in user to have adminLevel >= 1.
// Apply after requireSession so req.session.user is always populated.

export function requireAdmin(req, res, next) {
  if ((req.session.user?.adminLevel || 0) >= 1) return next();
  res.status(403).json({ error: 'Admin access required' });
}
