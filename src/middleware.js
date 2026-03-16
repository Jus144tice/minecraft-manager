// Security middleware: Helmet headers, rate limiting, origin validation, access control.

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getCapabilitiesForRole, getRoleLevel } from './permissions.js';

// ---- Security headers via Helmet ----

export function buildHelmet(appUrl) {
  // Compute the allowed WebSocket origin from APP_URL or the request's Host header.
  // CSP 'self' does not cover ws:/wss: protocols, so we must specify them explicitly.
  const wsConnectSrc = (req) => {
    if (appUrl) {
      const u = new URL(appUrl);
      const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${u.host}`;
    }
    // Dev/LAN: derive from the request's Host header
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'wss:' : 'ws:';
    return `${proto}//${req.headers.host}`;
  };

  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'https:', 'data:', 'blob:'],
        connectSrc: ["'self'", (req) => wsConnectSrc(req)],
        frameAncestors: ["'none'"],
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

// ---- Capability-based access guard ----
// Checks that the logged-in user's role grants ALL of the listed capabilities.
// Returns 401 if not logged in, 403 if missing a required capability.

export function requireCapability(...capabilities) {
  return (req, res, next) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const role = req.session.user.role || 'viewer';
    const userCaps = getCapabilitiesForRole(role);
    for (const cap of capabilities) {
      if (!userCaps.has(cap)) {
        return res.status(403).json({ error: 'Insufficient permissions', required: cap });
      }
    }
    next();
  };
}

// ---- Legacy admin access guard ----
// Kept for backward compatibility. Checks role level >= 3 (admin/owner).
// Prefer requireCapability() for new code.

export function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
  const role = req.session.user.role || 'viewer';
  if (getRoleLevel(role) >= 3) return next();
  res.status(403).json({ error: 'Admin access required' });
}
