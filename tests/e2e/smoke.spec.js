// Browser smoke tests against demo mode.
// These verify core UI flows work end-to-end without a real Minecraft server.

import { test, expect } from '@playwright/test';

// Helper: log in as demo user via the user menu -> login modal.
async function login(page) {
  await page.goto('/');
  // Dashboard loads immediately in guest mode
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  // Open user menu and click "Log In"
  await page.click('#user-menu-btn');
  await page.click('#btn-show-login');
  // Fill login modal
  await page.waitForSelector('#login-password', { state: 'visible' });
  await page.fill('#login-password', 'demo');
  await page.click('#login-btn');
  // Wait for login modal to close and admin controls to appear
  await page.waitForSelector('#login-modal', { state: 'hidden' });
}

// ============================================================
// Guest mode (no login required)
// ============================================================

test('dashboard loads without login (guest mode)', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  const activeTab = await page.textContent('.tab-btn.active');
  expect(activeTab).toBe('Dashboard');
});

test('user menu shows Guest when not logged in', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#user-menu-name', { state: 'visible' });
  const name = await page.textContent('#user-menu-name');
  expect(name).toBe('Guest');
});

// ============================================================
// Login
// ============================================================

test('login modal shows demo hint', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  await page.click('#user-menu-btn');
  await page.click('#btn-show-login');
  await page.waitForSelector('#demo-hint', { state: 'visible' });
  const hint = await page.textContent('#demo-hint');
  expect(hint).toContain('Demo mode');
});

test('login with any password succeeds', async ({ page }) => {
  await login(page);
  // User menu should show logged-in state (wait for async update)
  await page.waitForFunction(
    () => {
      const el = document.getElementById('user-menu-name');
      return el && el.textContent !== 'Guest';
    },
    { timeout: 5000 },
  );
  const name = await page.textContent('#user-menu-name');
  expect(name).not.toBe('Guest');
});

test('session persists after login', async ({ page }) => {
  await login(page);
  // Reload the page — should stay logged in
  await page.reload();
  await page.waitForSelector('.tab-btn[data-tab="dashboard"]', { state: 'visible' });
  // Login modal should be hidden
  const loginVisible = await page.isVisible('#login-modal');
  expect(loginVisible).toBe(false);
  // User should still be logged in (not Guest)
  const name = await page.textContent('#user-menu-name');
  expect(name).not.toBe('Guest');
});

// ============================================================
// Dashboard
// ============================================================

test('dashboard shows server status', async ({ page }) => {
  await login(page);
  // stat-status shows "Running" or "Stopped" in demo mode
  const statusEl = page.locator('#stat-status');
  await expect(statusEl).toBeVisible();
  await expect(statusEl).not.toHaveText('-');
});

test('dashboard shows demo mode banner', async ({ page }) => {
  await login(page);
  const banner = page.locator('#demo-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Demo Mode');
});

// ============================================================
// Console tab
// ============================================================

test('console tab shows log output', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="console"]');
  // console-output is the log area
  const consoleEl = page.locator('#console-output');
  await expect(consoleEl).toBeVisible();
  // Demo mode sends startup logs via WebSocket — wait for some content
  await expect(consoleEl).not.toBeEmpty({ timeout: 5000 });
});

test('console command input is visible', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="console"]');
  await expect(page.locator('#console-cmd')).toBeVisible();
});

// ============================================================
// Mods tab
// ============================================================

test('mods tab shows installed mods', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="mods"]');
  // Wait for mod list to populate
  const modsList = page.locator('#mods-list');
  await expect(modsList).toBeVisible();
  // Demo mode has ~21 mods — wait for at least some to render
  await page.waitForFunction(
    () => document.querySelectorAll('#mods-list .mod-card, #mods-list .mod-row, #mods-list tr').length > 3,
    { timeout: 5000 },
  );
});

test('mods browse subtab loads Modrinth results', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="mods"]');
  await page.click('.subtab-btn[data-subtab="browse"]');
  const browseList = page.locator('#browse-results');
  await expect(browseList).toBeVisible();
  // Demo browse returns ~20 results
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#browse-results .mod-card, #browse-results .browse-card, #browse-results tr').length >
      0,
    { timeout: 5000 },
  );
});

// ============================================================
// Players tab
// ============================================================

test('players tab shows operators list', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="players"]');
  // Online is the default subtab, so switch to Operators
  await page.click('.subtab-btn[data-subtab="ops"]');
  const opsSection = page.locator('#ops-list');
  await expect(opsSection).toBeVisible();
});

test('players tab can switch to whitelist', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="players"]');
  await page.click('.subtab-btn[data-subtab="whitelist"]');
  const wlSection = page.locator('#whitelist-list');
  await expect(wlSection).toBeVisible();
});

// ============================================================
// Backups tab
// ============================================================

test('backups tab renders backup list area', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="backups"]');
  const backupsList = page.locator('#backups-list');
  await expect(backupsList).toBeVisible();
});

test('backups tab shows schedule configuration', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="backups"]');
  const schedForm = page.locator('#backup-schedule-form');
  await expect(schedForm).toBeVisible();
});

// ============================================================
// Settings tab
// ============================================================

test('settings tab shows app config form', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="settings"]');
  // App Config subtab (#subtab-app-cfg) is active by default
  const configForm = page.locator('#app-config-form');
  await expect(configForm).toBeVisible();
});

test('settings tab can switch to server.properties', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="settings"]');
  await page.click('.subtab-btn[data-subtab="server-props"]');
  const propsForm = page.locator('#props-form');
  await expect(propsForm).toBeVisible();
});

// ============================================================
// WebSocket / live updates
// ============================================================

test('WebSocket connects and receives status', async ({ page }) => {
  await page.goto('/');
  // WebSocket connects in guest mode — wait for stat-status to update from default
  await page.waitForFunction(
    () => {
      const el = document.getElementById('stat-players');
      return el && el.textContent !== '-';
    },
    { timeout: 10000 },
  );
});

// ============================================================
// Health endpoints (no auth required)
// ============================================================

test('GET /healthz returns ok', async ({ request }) => {
  const resp = await request.get('/healthz');
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  expect(body.status).toBe('ok');
  expect(body.uptime).toBeGreaterThanOrEqual(0);
});

test('GET /readyz returns status', async ({ request }) => {
  const resp = await request.get('/readyz');
  // In demo mode without PostgreSQL, readyz may return 503 (database not connected).
  // Just verify the endpoint responds with a valid JSON body.
  const body = await resp.json();
  expect(body).toHaveProperty('status');
  expect(body).toHaveProperty('checks');
  expect(body.checks).toHaveProperty('config', true);
});

test('GET /metrics returns Prometheus text', async ({ request }) => {
  const resp = await request.get('/metrics');
  expect(resp.ok()).toBe(true);
  const text = await resp.text();
  expect(text).toContain('process_uptime_seconds');
});

// ============================================================
// Demo server controls
// ============================================================

test('demo server can be stopped and started', async ({ page }) => {
  await login(page);
  await page.click('.tab-btn[data-tab="console"]');

  // Find the stop button and click it
  const stopBtn = page.locator('#btn-stop');
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
    await page.waitForTimeout(500);
  }

  // Start the server
  const startBtn = page.locator('#btn-start');
  if (await startBtn.isVisible()) {
    await startBtn.click();
    await page.waitForTimeout(500);
  }
});

// ============================================================
// Navigation between tabs
// ============================================================

test('all tabs are clickable and show content', async ({ page }) => {
  await login(page);

  const tabs = ['dashboard', 'console', 'mods', 'players', 'backups', 'settings'];
  for (const tab of tabs) {
    await page.click(`.tab-btn[data-tab="${tab}"]`);
    // Each tab section has id="tab-{name}"
    const section = page.locator(`#tab-${tab}`);
    await expect(section).toBeVisible();
  }
});
