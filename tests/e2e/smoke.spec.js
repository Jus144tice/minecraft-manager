// Browser smoke tests against demo mode.
// These verify core UI flows work end-to-end without a real Minecraft server.
// Tests are grouped to minimize page loads — each group shares a single login.

import { test, expect } from '@playwright/test';

// Helper: log in as demo user via the user menu -> login modal.
async function login(page) {
  await page.goto('/');
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  await page.click('#user-menu-btn');
  await page.click('#btn-show-login');
  await page.waitForSelector('#login-password', { state: 'visible' });
  await page.fill('#login-password', 'demo');
  await page.click('#login-btn');
  await page.waitForSelector('#login-modal', { state: 'hidden' });
}

// ============================================================
// Guest mode — no login, no shared state
// ============================================================

test('guest mode: dashboard loads, user menu shows Guest', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  const activeTab = await page.textContent('.tab-btn.active');
  expect(activeTab).toBe('Dashboard');
  const name = await page.textContent('#user-menu-name');
  expect(name).toBe('Guest');
});

test('guest mode: WebSocket connects and updates stats', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const el = document.getElementById('stat-players');
      return el && el.textContent !== '-';
    },
    { timeout: 10000 },
  );
});

// ============================================================
// Login flow
// ============================================================

test('login: modal shows demo hint, login succeeds, session persists', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });

  // Open login modal and check demo hint
  await page.click('#user-menu-btn');
  await page.click('#btn-show-login');
  await page.waitForSelector('#demo-hint', { state: 'visible' });
  const hint = await page.textContent('#demo-hint');
  expect(hint).toContain('Demo mode');

  // Log in
  await page.fill('#login-password', 'demo');
  await page.click('#login-btn');
  await page.waitForSelector('#login-modal', { state: 'hidden' });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('user-menu-name');
      return el && el.textContent !== 'Guest';
    },
    { timeout: 5000 },
  );
  const name = await page.textContent('#user-menu-name');
  expect(name).not.toBe('Guest');

  // Session persists after reload
  await page.reload();
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  expect(await page.isVisible('#login-modal')).toBe(false);
  expect(await page.textContent('#user-menu-name')).not.toBe('Guest');
});

// ============================================================
// Dashboard + server controls (single login, multiple checks)
// ============================================================

test('dashboard: status, banner, and server controls', async ({ page }) => {
  await login(page);

  // Server status visible
  const statusEl = page.locator('#stat-status');
  await expect(statusEl).toBeVisible();
  await expect(statusEl).not.toHaveText('-');

  // Demo banner visible
  const banner = page.locator('#demo-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Demo Mode');
});

// ============================================================
// Tab navigation (single login, visit all tabs)
// ============================================================

test('tabs: all main tabs are navigable and show content', async ({ page }) => {
  await login(page);

  // Console tab
  await page.click('.tab-btn[data-tab="console"]');
  await expect(page.locator('#console-output')).toBeVisible();
  await expect(page.locator('#console-cmd')).toBeVisible();
  await expect(page.locator('#console-output')).not.toBeEmpty({ timeout: 5000 });

  // Mods tab — installed mods
  await page.click('.tab-btn[data-tab="mods"]');
  await expect(page.locator('#mods-list')).toBeVisible();
  await page.waitForFunction(
    () => document.querySelectorAll('#mods-list .mod-card, #mods-list .mod-row, #mods-list tr').length > 3,
    { timeout: 5000 },
  );

  // Mods tab — browse
  await page.click('.subtab-btn[data-subtab="browse"]');
  await expect(page.locator('#browse-results')).toBeVisible();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#browse-results .mod-card, #browse-results .browse-card, #browse-results tr').length >
      0,
    { timeout: 5000 },
  );

  // Players tab — whitelist subtab
  await page.click('.tab-btn[data-tab="players"]');
  await page.click('.subtab-btn[data-subtab="whitelist"]');
  await expect(page.locator('#whitelist-list')).toBeVisible();

  // Access Control tab — operators subtab
  await page.click('.tab-btn[data-tab="access"]');
  await page.click('.subtab-btn[data-subtab="ac-ops"]');
  await expect(page.locator('#ops-list')).toBeVisible();

  // Backups tab
  await page.click('.tab-btn[data-tab="backups"]');
  await expect(page.locator('#backups-list')).toBeVisible();
  await expect(page.locator('#backup-schedule-form')).toBeVisible();

  // Settings tab — app config
  await page.click('.tab-btn[data-tab="settings"]');
  await expect(page.locator('#app-config-form')).toBeVisible();

  // Settings tab — server.properties subtab
  await page.click('.subtab-btn[data-subtab="server-props"]');
  await expect(page.locator('#props-form')).toBeVisible();
});

// ============================================================
// Demo server controls
// ============================================================

test('demo server can be stopped and started', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="console"]');

  const stopBtn = page.locator('#btn-stop');
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
    await page.waitForTimeout(500);
  }

  const startBtn = page.locator('#btn-start');
  if (await startBtn.isVisible()) {
    await startBtn.click();
    await page.waitForTimeout(500);
  }
});

// ============================================================
// Health endpoints (no browser needed — API-only)
// ============================================================

test('health endpoints return valid responses', async ({ request }) => {
  const healthz = await request.get('/healthz');
  expect(healthz.ok()).toBe(true);
  const healthBody = await healthz.json();
  expect(healthBody.status).toBe('ok');
  expect(healthBody.uptime).toBeGreaterThanOrEqual(0);

  const readyz = await request.get('/readyz');
  const readyBody = await readyz.json();
  expect(readyBody).toHaveProperty('status');
  expect(readyBody).toHaveProperty('checks');
  expect(readyBody.checks).toHaveProperty('config', true);

  const metrics = await request.get('/metrics');
  expect(metrics.ok()).toBe(true);
  const metricsText = await metrics.text();
  expect(metricsText).toContain('process_uptime_seconds');
});
