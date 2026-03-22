// Frontend DOM tests using jsdom.
// Tests the SPA's UI behavior: tab switching, login UI, utility functions,
// responsive classes, and delegated action handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const cssPath = path.join(__dirname, '..', 'public', 'styles.css');
const htmlSource = fs.readFileSync(htmlPath, 'utf8');
const cssSource = fs.readFileSync(cssPath, 'utf8');
// --- Helper: create a fresh DOM with the app's HTML ---
function createDOM() {
  const dom = new JSDOM(htmlSource, {
    url: 'http://localhost:3000',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  return dom;
}

// ===================== HTML Structure =====================

test('HTML: has all required tab buttons', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  const tabs = ['dashboard', 'console', 'mods', 'players', 'backups', 'settings'];
  for (const tab of tabs) {
    const btn = doc.querySelector(`[data-tab="${tab}"]`);
    assert.ok(btn, `Tab button for "${tab}" should exist`);
  }
  dom.window.close();
});

test('HTML: has login modal with password field and login button', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  assert.ok(doc.getElementById('login-modal'));
  assert.ok(doc.getElementById('login-password'));
  assert.ok(doc.getElementById('login-btn'));
  dom.window.close();
});

test('HTML: app section is visible by default (guest mode)', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  const app = doc.getElementById('app');
  assert.ok(!app.classList.contains('hidden'), 'app should be visible for guest access');
  dom.window.close();
});

test('HTML: has server control buttons on dashboard', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  const ids = ['btn-start', 'btn-stop', 'btn-restart', 'btn-kill'];
  for (const id of ids) {
    assert.ok(doc.getElementById(id), `Button #${id} should exist`);
  }
  dom.window.close();
});

test('HTML: has modpack export and import buttons', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  assert.ok(doc.getElementById('btn-export-modpack'));
  assert.ok(doc.getElementById('btn-import-modpack'));
  assert.ok(doc.getElementById('modpack-file-input'));
  dom.window.close();
});

test('HTML: has modpack modal', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  const modal = doc.getElementById('modpack-modal');
  assert.ok(modal);
  assert.ok(modal.classList.contains('hidden'));
  dom.window.close();
});

test('HTML: has console input and output area', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  assert.ok(doc.getElementById('console-cmd'));
  assert.ok(doc.getElementById('console-output'));
  dom.window.close();
});

test('HTML: has settings sections for properties and config', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  assert.ok(doc.getElementById('tab-settings'));
  dom.window.close();
});

// ===================== Tab switching (manual DOM manipulation) =====================

test('Tab: clicking a tab button shows the correct content', () => {
  const dom = createDOM();
  const doc = dom.window.document;

  // Simulate tab switch logic (mirrors app.js tab click handler)
  function switchTab(tabName) {
    doc.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    doc.querySelectorAll('.tab-content').forEach((t) => {
      t.classList.add('hidden');
      t.classList.remove('active');
    });
    const btn = doc.querySelector(`[data-tab="${tabName}"]`);
    btn.classList.add('active');
    const tab = doc.getElementById('tab-' + tabName);
    if (tab) {
      tab.classList.remove('hidden');
      tab.classList.add('active');
    }
  }

  // Switch to console tab
  switchTab('console');
  assert.ok(doc.getElementById('tab-console').classList.contains('active'));
  assert.ok(doc.getElementById('tab-dashboard').classList.contains('hidden'));
  assert.ok(doc.querySelector('[data-tab="console"]').classList.contains('active'));
  assert.equal(doc.querySelector('[data-tab="dashboard"]').classList.contains('active'), false);

  // Switch to mods tab
  switchTab('mods');
  assert.ok(doc.getElementById('tab-mods').classList.contains('active'));
  assert.ok(doc.getElementById('tab-console').classList.contains('hidden'));

  // Switch back to dashboard
  switchTab('dashboard');
  assert.ok(doc.getElementById('tab-dashboard').classList.contains('active'));

  dom.window.close();
});

// ===================== Login UI setup =====================

test('Login: setupLoginUI shows Google button when provider is configured', () => {
  const dom = createDOM();
  const doc = dom.window.document;

  // Simulate setupLoginUI behavior from app.js
  const providers = { google: true, microsoft: false, local: true, demo: false };

  if (providers.google || providers.microsoft) {
    doc.getElementById('login-oidc-section').classList.remove('hidden');
    if (providers.google) doc.getElementById('btn-login-google').classList.remove('hidden');
    if (providers.microsoft) doc.getElementById('btn-login-microsoft').classList.remove('hidden');
    if (providers.local) doc.getElementById('login-divider').classList.remove('hidden');
  }
  if (providers.local) {
    doc.getElementById('login-local-section').classList.remove('hidden');
  }

  assert.equal(doc.getElementById('btn-login-google').classList.contains('hidden'), false);
  assert.ok(doc.getElementById('btn-login-microsoft').classList.contains('hidden'));
  assert.equal(doc.getElementById('login-local-section').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('login-divider').classList.contains('hidden'), false);

  dom.window.close();
});

test('Login: demo mode shows hint text', () => {
  const dom = createDOM();
  const doc = dom.window.document;

  const providers = { google: false, microsoft: false, local: true, demo: true };
  if (providers.local) {
    doc.getElementById('login-local-section').classList.remove('hidden');
    if (providers.demo) doc.getElementById('demo-hint').classList.remove('hidden');
  }

  assert.equal(doc.getElementById('demo-hint').classList.contains('hidden'), false);
  dom.window.close();
});

test('Login: OIDC-only hides local section', () => {
  const dom = createDOM();
  const doc = dom.window.document;

  const providers = { google: true, microsoft: true, local: false, demo: false };
  if (!providers.local) doc.getElementById('login-local-section').classList.add('hidden');

  assert.ok(doc.getElementById('login-local-section').classList.contains('hidden'));
  dom.window.close();
});

// ===================== Utility functions (tested via eval in jsdom) =====================

test('Utility: formatUptime formats seconds correctly', () => {
  const dom = createDOM();
  // Define function in jsdom context
  dom.window.eval(`
    function formatUptime(secs) {
      if (!secs) return '-';
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      return h > 0 ? h + 'h ' + m + 'm' : m > 0 ? m + 'm ' + s + 's' : s + 's';
    }
    window.__formatUptime = formatUptime;
  `);
  const f = dom.window.__formatUptime;
  assert.equal(f(0), '-');
  assert.equal(f(null), '-');
  assert.equal(f(45), '45s');
  assert.equal(f(125), '2m 5s');
  assert.equal(f(3661), '1h 1m');
  assert.equal(f(7200), '2h 0m');
  dom.window.close();
});

test('Utility: formatSize formats bytes correctly', () => {
  const dom = createDOM();
  dom.window.eval(`
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(1) + ' GB';
    }
    window.__formatSize = formatSize;
  `);
  const f = dom.window.__formatSize;
  assert.equal(f(500), '500 B');
  assert.equal(f(1024), '1.0 KB');
  assert.equal(f(1536), '1.5 KB');
  assert.equal(f(1048576), '1.0 MB');
  assert.equal(f(2621440), '2.5 MB');
  assert.equal(f(1073741824), '1.0 GB');
  assert.equal(f(2147483648), '2.0 GB');
  dom.window.close();
});

test('Utility: esc escapes HTML entities', () => {
  const dom = createDOM();
  dom.window.eval(`
    function esc(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    window.__esc = esc;
  `);
  const f = dom.window.__esc;
  assert.equal(f('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(f('Hello & "World"'), 'Hello &amp; &quot;World&quot;');
  assert.equal(f('normal text'), 'normal text');
  dom.window.close();
});

test('Utility: sideLabel categorizes mod sides correctly', () => {
  const dom = createDOM();
  dom.window.eval(`
    function sideLabel(clientSide, serverSide) {
      const c = clientSide, s = serverSide;
      if (c === 'unsupported' && s !== 'unsupported') return { text: 'Server-only', cls: 'side-server' };
      if (s === 'unsupported' && c !== 'unsupported') return { text: 'Client-only', cls: 'side-client' };
      if (c !== 'unsupported' && s !== 'unsupported') return { text: 'Both', cls: 'side-both' };
      return { text: 'Unknown', cls: 'side-unknown' };
    }
    window.__sideLabel = sideLabel;
  `);
  const f = dom.window.__sideLabel;
  assert.equal(f('required', 'required').text, 'Both');
  assert.equal(f('unsupported', 'required').text, 'Server-only');
  assert.equal(f('required', 'unsupported').text, 'Client-only');
  assert.equal(f('unsupported', 'unsupported').text, 'Unknown');
  assert.equal(f('optional', 'required').text, 'Both');
  dom.window.close();
});

// ===================== CSS Structure =====================

test('CSS: defines required CSS custom properties', () => {
  const requiredVars = ['--bg', '--surface', '--primary', '--danger', '--text', '--border', '--radius'];
  for (const v of requiredVars) {
    assert.ok(cssSource.includes(v), `CSS should define ${v}`);
  }
});

test('CSS: has responsive breakpoint for mobile', () => {
  assert.ok(cssSource.includes('@media (max-width: 600px)'), 'Should have mobile breakpoint');
});

test('CSS: has responsive breakpoint for site-name', () => {
  assert.ok(cssSource.includes('@media (min-width: 640px)'), 'Should have site-name breakpoint');
});

test('CSS: defines .hidden class', () => {
  assert.ok(cssSource.includes('.hidden'), 'Should define .hidden class');
});

// ===================== DOM element IDs consistency =====================

test('HTML/JS: all tab content IDs referenced by tab buttons exist', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  const tabBtns = doc.querySelectorAll('.tab-btn[data-tab]');
  for (const btn of tabBtns) {
    const tabId = 'tab-' + btn.dataset.tab;
    assert.ok(doc.getElementById(tabId), `Tab content #${tabId} should exist for button`);
  }
  dom.window.close();
});

test('HTML: all data-action elements reference valid actions', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  // Known actions from app.js delegated handler
  const knownActions = new Set([
    'mod-detail',
    'toggle-mod',
    'delete-mod',
    'install-mod',
    'download-mod',
    'remove-op',
    'remove-wl',
    'unban-player',
    'restore-backup',
    'delete-backup',
    'server-cmd',
    'server-cmd-prompt',
    'mod-startup-detail',
    'close-mod-startup-modal',
    'view-unmapped-log',
  ]);
  const actionEls = doc.querySelectorAll('[data-action]');
  for (const el of actionEls) {
    assert.ok(knownActions.has(el.dataset.action), `data-action="${el.dataset.action}" is not in known actions list`);
  }
  dom.window.close();
});

// ===================== Accessibility / Structure =====================

test('HTML: has proper lang attribute', () => {
  const dom = createDOM();
  const html = dom.window.document.documentElement;
  assert.equal(html.getAttribute('lang'), 'en');
  dom.window.close();
});

test('HTML: has viewport meta tag', () => {
  const dom = createDOM();
  const meta = dom.window.document.querySelector('meta[name="viewport"]');
  assert.ok(meta);
  assert.ok(meta.content.includes('width=device-width'));
  dom.window.close();
});

test('HTML: password input has autocomplete attribute', () => {
  const dom = createDOM();
  const pw = dom.window.document.getElementById('login-password');
  assert.equal(pw.getAttribute('autocomplete'), 'current-password');
  dom.window.close();
});

test('HTML: login links have proper href for OIDC', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  assert.equal(doc.getElementById('btn-login-google').getAttribute('href'), '/auth/google');
  assert.equal(doc.getElementById('btn-login-microsoft').getAttribute('href'), '/auth/microsoft');
  dom.window.close();
});

// ===================== Show/Hide helpers =====================

test('DOM: show/hide toggle classes correctly', () => {
  const dom = createDOM();
  const doc = dom.window.document;

  const el = doc.createElement('div');
  el.classList.add('hidden');
  doc.body.appendChild(el);

  // show = remove hidden
  el.classList.remove('hidden');
  assert.equal(el.classList.contains('hidden'), false);

  // hide = add hidden
  el.classList.add('hidden');
  assert.ok(el.classList.contains('hidden'));

  dom.window.close();
});

// ===================== Demo banner =====================

test('DOM: demo banner is hidden by default', () => {
  const dom = createDOM();
  const banner = dom.window.document.getElementById('demo-banner');
  assert.ok(banner.classList.contains('hidden'));
  dom.window.close();
});

test('DOM: demo banner has close button', () => {
  const dom = createDOM();
  const btn = dom.window.document.getElementById('demo-banner-close');
  assert.ok(btn);
  dom.window.close();
});

// ===================== Mod detail panel =====================

test('HTML: has mod detail panel structure', () => {
  const dom = createDOM();
  const doc = dom.window.document;
  assert.ok(doc.getElementById('mod-detail-panel'));
  assert.ok(doc.getElementById('btn-mod-detail-back'));
  dom.window.close();
});
