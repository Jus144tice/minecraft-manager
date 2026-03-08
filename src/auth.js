// Authentication module: OIDC (Google + Microsoft) and local password fallback.
// Provides session middleware, auth router, and requireSession guard.
//
// Required env vars (when OIDC is used):
//   APP_URL              - Public base URL, e.g. https://mc.example.com
//   ALLOWED_EMAILS       - Comma-separated allowlist, e.g. alice@gmail.com,bob@outlook.com
//   GOOGLE_CLIENT_ID     - From Google Cloud Console
//   GOOGLE_CLIENT_SECRET
//   MICROSOFT_CLIENT_ID  - From Azure App Registration
//   MICROSOFT_CLIENT_SECRET
//   MICROSOFT_TENANT     - Azure tenant (default: "common" for personal + work accounts)
//   SESSION_SECRET       - Random secret for signing session cookies (required in non-demo mode)
//
// Optional env vars:
//   LOCAL_PASSWORD       - Plain-text fallback password (rate-limited; OIDC preferred)
//   TRUST_PROXY          - Set to "1" when behind a reverse proxy (enables secure cookies)

import { Router } from 'express';
import session from 'express-session';
import { Issuer, generators } from 'openid-client';
import crypto from 'crypto';
import { audit } from './audit.js';

const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// ---- Allowlist ----

function parseAllowlist() {
  const raw = process.env.ALLOWED_EMAILS || '';
  if (!raw.trim()) return null; // null = no allowlist; all successfully authenticated users allowed
  return new Set(raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

function isEmailAllowed(email, allowlist) {
  if (!allowlist) return true;
  return allowlist.has(email.toLowerCase());
}

// ---- Session middleware factory ----

export function buildSessionMiddleware(config) {
  let secret = process.env.SESSION_SECRET;

  if (!secret) {
    if (!config.demoMode) {
      console.error(
        'FATAL: SESSION_SECRET environment variable is required in production mode.\n' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
        'Then add SESSION_SECRET=<value> to your .env or systemd service file.',
      );
      process.exit(1);
    }
    // Demo mode only: generate a temporary secret (sessions don't survive restarts)
    secret = crypto.randomBytes(48).toString('hex');
    console.warn(
      '[Auth] SESSION_SECRET not set — using a temporary secret. ' +
      'Sessions will not survive restarts. Set SESSION_SECRET in .env for persistence.',
    );
  }

  return session({
    secret,
    name: 'mcm.sid',           // custom name avoids fingerprinting as express-session
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.TRUST_PROXY === '1',  // true = only sent over HTTPS
      sameSite: 'lax',          // lax (not strict) allows OIDC redirect-back to include cookie
      maxAge: SESSION_MAX_AGE,
    },
  });
}

// ---- Auth router factory (async — discovers OIDC issuers at startup) ----

export async function buildAuthRouter(config) {
  const router = Router();
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const allowlist = parseAllowlist();
  const oidcClients = {};

  // --- Google OIDC ---
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    if (!appUrl) {
      console.error('[Auth] GOOGLE_CLIENT_ID set but APP_URL is missing. OIDC requires a public base URL.');
    } else {
      try {
        const issuer = await Issuer.discover('https://accounts.google.com');
        oidcClients.google = new issuer.Client({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uris: [`${appUrl}/auth/callback/google`],
          response_types: ['code'],
        });
        console.log('[Auth] Google OIDC configured');
      } catch (err) {
        console.error('[Auth] Failed to configure Google OIDC:', err.message);
      }
    }
  }

  // --- Microsoft OIDC ---
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    if (!appUrl) {
      console.error('[Auth] MICROSOFT_CLIENT_ID set but APP_URL is missing.');
    } else {
      try {
        const tenant = process.env.MICROSOFT_TENANT || 'common';
        const issuer = await Issuer.discover(
          `https://login.microsoftonline.com/${tenant}/v2.0`,
        );
        oidcClients.microsoft = new issuer.Client({
          client_id: process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          redirect_uris: [`${appUrl}/auth/callback/microsoft`],
          response_types: ['code'],
        });
        console.log('[Auth] Microsoft OIDC configured');
      } catch (err) {
        console.error('[Auth] Failed to configure Microsoft OIDC:', err.message);
      }
    }
  }

  const hasOidc = Object.keys(oidcClients).length > 0;
  const hasLocalPassword = !!(process.env.LOCAL_PASSWORD || config.webPassword);
  const isDemo = !!config.demoMode;

  if (!isDemo && !hasOidc && !hasLocalPassword) {
    console.error(
      'FATAL: No authentication method configured.\n' +
      'Set GOOGLE_CLIENT_ID/MICROSOFT_CLIENT_ID with their secrets,\n' +
      'or set LOCAL_PASSWORD,\n' +
      'or enable demoMode in config.json.',
    );
    process.exit(1);
  }

  // --- Internal helper: complete a successful login ---
  function loginUser(req, userInfo, onDone) {
    // Regenerate session ID to prevent session fixation attacks.
    req.session.regenerate((err) => {
      if (err) return onDone(err);
      req.session.user = { ...userInfo, loginAt: Date.now() };
      req.session.save((saveErr) => {
        if (saveErr) return onDone(saveErr);
        audit('LOGIN', { email: userInfo.email, provider: userInfo.provider, ip: req.ip });
        onDone(null);
      });
    });
  }

  // --- OIDC routes (initiate + callback) for a given provider key ---
  function registerOidcRoutes(providerKey) {
    // Initiate OIDC login: generate PKCE verifier + state, redirect to provider
    router.get(`/${providerKey}`, (req, res) => {
      const client = oidcClients[providerKey];
      if (!client) return res.status(404).send('OIDC provider not configured.');

      const codeVerifier = generators.codeVerifier();
      const codeChallenge = generators.codeChallenge(codeVerifier);
      const state = generators.state();

      req.session.oidc = { codeVerifier, state, provider: providerKey };
      req.session.save(() => {
        const url = client.authorizationUrl({
          scope: 'openid email profile',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
        });
        res.redirect(url);
      });
    });

    // OIDC callback: validate state, exchange code, enforce allowlist, set session
    router.get(`/callback/${providerKey}`, async (req, res) => {
      const client = oidcClients[providerKey];
      if (!client) return res.status(404).send('OIDC provider not configured.');

      const oidc = req.session.oidc;
      if (!oidc || oidc.provider !== providerKey) {
        return res.status(400).send(
          'Invalid or expired login session. Please return to the login page and try again.',
        );
      }

      try {
        const params = client.callbackParams(req);
        const tokenSet = await client.callback(
          `${appUrl}/auth/callback/${providerKey}`,
          params,
          { code_verifier: oidc.codeVerifier, state: oidc.state },
        );
        const claims = tokenSet.claims();
        // Microsoft may put the email in preferred_username for some account types
        const email = claims.email || claims.preferred_username;

        if (!email) {
          audit('LOGIN_DENIED', { provider: providerKey, reason: 'no_email_claim', ip: req.ip });
          return res.status(403).send(
            'No email address in token. Ensure your account has a verified email.',
          );
        }

        if (!isEmailAllowed(email, allowlist)) {
          audit('LOGIN_DENIED', { email, provider: providerKey, reason: 'not_in_allowlist', ip: req.ip });
          return res.status(403).send(
            `Access denied: ${email} is not in the allowed email list. Contact the server administrator.`,
          );
        }

        delete req.session.oidc;
        loginUser(req, { email, name: claims.name || email, provider: providerKey }, (err) => {
          if (err) return res.status(500).send('Session error during login. Please try again.');
          res.redirect('/');
        });
      } catch (err) {
        audit('LOGIN_ERROR', { provider: providerKey, error: err.message, ip: req.ip });
        res.status(500).send(`Authentication failed: ${err.message}`);
      }
    });
  }

  registerOidcRoutes('google');
  registerOidcRoutes('microsoft');

  // --- Local password login (fallback / demo) ---
  router.post('/local', (req, res) => {
    const { password } = req.body || {};
    const ip = req.ip;

    // Demo mode with no other auth configured: accept any non-empty password
    if (isDemo && !hasOidc && !hasLocalPassword) {
      if (!password) return res.status(401).json({ error: 'Enter any password to enter demo mode.' });
      loginUser(req, { email: 'demo@local', name: 'Demo User', provider: 'local' }, (err) => {
        if (err) return res.status(500).json({ error: 'Session error.' });
        res.json({ ok: true });
      });
      return;
    }

    const expected = process.env.LOCAL_PASSWORD || config.webPassword;
    if (!expected) return res.status(404).json({ error: 'Local password auth not configured.' });
    if (!password) return res.status(401).json({ error: 'Password required.' });

    // Timing-safe comparison to prevent password-length oracle attacks
    if (!timingSafeEqual(password, expected)) {
      audit('LOGIN_FAILED', { provider: 'local', ip });
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    loginUser(req, { email: 'admin@local', name: 'Admin', provider: 'local' }, (err) => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      res.json({ ok: true });
    });
  });

  // --- Logout ---
  router.post('/logout', (req, res) => {
    const email = req.session?.user?.email;
    const ip = req.ip;
    req.session.destroy(() => {
      audit('LOGOUT', { email, ip });
      res.clearCookie('mcm.sid');
      res.json({ ok: true });
    });
  });

  return {
    router,
    // What the login page should show:
    providers: {
      google: !!oidcClients.google,
      microsoft: !!oidcClients.microsoft,
      local: hasLocalPassword || (isDemo && !hasOidc),
      demo: isDemo,
    },
  };
}

// ---- requireSession middleware ----
// Apply to all routes that require a logged-in user.

export function requireSession(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Authentication required' });
}

// ---- Utilities ----

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) {
      // Burn similar time even on length mismatch to avoid length oracle
      crypto.timingSafeEqual(ba, ba);
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
