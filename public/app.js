/* global openModDetail, toggleMod, deleteMod, openVersionModal, downloadMod, removeOp, removeWl, unbanPlayer */
// Minecraft Manager - Frontend Application
'use strict';

// --- Delegated error handler for mod icons ---
// Replaces broken <img class="mod-icon"> with a placeholder div.
// Using a delegated listener (capture phase) instead of inline onerror= because
// CSP 'unsafe-inline' may not cover event handlers injected via innerHTML in all browsers.
document.addEventListener(
  'error',
  (e) => {
    const el = e.target;
    if (el.tagName === 'IMG' && el.classList.contains('mod-icon')) {
      const placeholder = document.createElement('div');
      placeholder.className = 'mod-icon-placeholder';
      el.replaceWith(placeholder);
    }
  },
  true,
); // capture=true so it fires even if the element has no bubbling listener

// --- Delegated action handler ---
// Replaces all inline onclick= handlers in dynamic HTML (blocked by CSP script-src-attr 'none').
// Add data-action="..." to any element; its data-* attributes serve as arguments.
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'mod-detail':
      openModDetail(el.dataset.id, el.dataset.source, {
        filename: el.dataset.filename || undefined,
        author: el.dataset.author || '',
      });
      break;
    case 'mod-startup-detail':
      openModStartupDetail(el.dataset.filename);
      break;
    case 'close-mod-startup-modal':
      hide('mod-startup-modal');
      break;
    case 'toggle-mod':
      await toggleMod(el);
      break;
    case 'delete-mod':
      await deleteMod(el);
      if (el.dataset.closeDetail) closeModDetail();
      break;
    case 'install-mod':
      openVersionModal(el);
      break;
    case 'download-mod':
      downloadMod(el);
      break;
    case 'remove-op':
      removeOp(el);
      break;
    case 'remove-wl':
      removeWl(el);
      break;
    case 'unban-player':
      unbanPlayer(el);
      break;
    case 'restore-backup':
      openRestoreModal(el.dataset.filename);
      break;
    case 'delete-backup':
      await deleteBackup(el.dataset.filename);
      break;
    case 'server-cmd':
      await runServerAction(el);
      break;
    case 'server-cmd-prompt':
      await runServerActionPrompt(el);
      break;
    case 'player-profile':
      openPlayerProfile(el.dataset.name);
      break;
    case 'unlink-discord':
      await unlinkDiscordFromProfile(el.dataset.discordId, el.dataset.name);
      break;
    case 'unlink-from-profile':
      await unlinkFromUserProfile(el.dataset.discordId, el.dataset.name);
      break;
    case 'kick-player':
      await kickPlayerFromList(el.dataset.name);
      break;
    case 'ban-from-list':
      await banPlayerFromList(el.dataset.name);
      break;
    case 'op-from-list':
      await opPlayerFromList(el.dataset.name);
      break;
    case 'whitelist-from-list':
      await whitelistPlayerFromList(el.dataset.name);
      break;
    case 'show-link-instructions':
      show('link-instructions-modal');
      break;
    case 'show-panel-link-instructions':
      show('panel-link-instructions-modal');
      break;
    case 'start-mc-link':
      await startMcLink();
      break;
    case 'unlink-mc-self':
      await unlinkMcSelf();
      break;
    case 'check-mc-link-status':
      await checkMcLinkStatus();
      break;
  }
});

// --- State ---
let ws = null;
let wsReconnectTimer = null;
let currentModData = {}; // filename -> modrinth data from lookup
const BROWSE_PAGE_SIZE = 10; // items shown per display page
let browsePage = 0; // current page (0-indexed)
let browseFilteredTotal = 0; // estimated total after filtering
let browseExhausted = false; // true when API has no more results
let browseLoading = false; // true while fetching from API
const browseCache = new Map(); // pageNumber -> { hits, nextOffset }
const browseVersionCache = new Map(); // versionId -> { versionNumber, fileSize }
let modDetailState = null; // { source: 'installed'|'browse', filename?, author? }
let modStartupStatuses = {}; // { filename: { status, messages[] } }
let modsPage = 0;
const MODS_PAGE_SIZE = 10;
let statusInterval = null; // guard against duplicate setInterval on re-login

// --- Environment state ---
let envList = []; // [{ id, name, isActive, minecraftVersion, serverPath }]
let selectedEnvId = null; // currently selected environment in the UI
let activeEnvId = null; // currently deployed/running environment

// --- Generic pagination bar ---
// Creates a controller for a prev/next pagination bar.
// Call .update(page, totalPages, totalCount, label) to refresh the UI.
// To switch to infinite scroll later: replace createPagination with a different factory
// and both tabs update automatically.
function createPagination({ prevId, nextId, infoId, containerId }) {
  return {
    update(page, totalPages, totalCount, label = 'items', { hasMore = false } = {}) {
      if (totalPages < 1) {
        hide(containerId);
        return;
      }
      show(containerId);
      const countStr = typeof totalCount === 'string' ? totalCount : totalCount.toLocaleString();
      $(infoId).textContent = `Page ${page} of ${totalPages}${hasMore ? '+' : ''} (${countStr} ${label})`;
      $(prevId).disabled = page <= 1;
      $(nextId).disabled = page >= totalPages && !hasMore;
    },
    hide() {
      hide(containerId);
    },
  };
}

// Both subtabs share one pagination bar — only one subtab is ever visible at a time.
const modsPager = createPagination({
  prevId: 'tab-page-prev',
  nextId: 'tab-page-next',
  infoId: 'tab-page-info',
  containerId: 'mods-tab-pagination',
});
const browsePager = modsPager; // same object; alias makes call-sites self-documenting
let csrfToken = ''; // fetched after login; sent as X-CSRF-Token on all mutating requests
let isLoggedIn = false; // true when a valid session exists
let userRole = 'viewer'; // current user's role name
let userCapabilities = new Set(); // current user's capability set

/** Check if the current user has a specific capability. */
function can(capability) {
  return userCapabilities.has(capability);
}

// --- API helpers ---
// Session cookie is sent automatically by the browser (same-origin, httpOnly).
// Mutating requests also include the X-CSRF-Token header (defence-in-depth).
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    opts.headers['X-CSRF-Token'] = csrfToken;
  }
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) {
    // Session expired or not logged in — show login modal
    showLoginModal();
    throw new Error('Please log in to perform this action.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET = (path) => api('GET', path);
const POST = (path, body) => api('POST', path, body);
const PUT = (path, body) => api('PUT', path, body);
const DEL = (path) => api('DELETE', path);

// --- Utilities ---
function $(id) {
  return document.getElementById(id);
}
function show(el) {
  (typeof el === 'string' ? $(el) : el).classList.remove('hidden');
}
function hide(el) {
  (typeof el === 'string' ? $(el) : el).classList.add('hidden');
}
function flash(id, msg, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? 'control-msg error-msg' : 'control-msg ok-msg';
  setTimeout(() => {
    el.textContent = '';
    el.className = 'control-msg';
  }, 4000);
}
function formatUptime(secs) {
  if (!secs) return '-';
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60),
    s = secs % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
function sideLabel(clientSide, serverSide) {
  const c = clientSide,
    s = serverSide;
  if (c === 'unsupported' && s !== 'unsupported') return { text: 'Server-only', cls: 'side-server' };
  if (s === 'unsupported' && c !== 'unsupported') return { text: 'Client-only', cls: 'side-client' };
  if (c !== 'unsupported' && s !== 'unsupported') return { text: 'Both', cls: 'side-both' };
  return { text: 'Unknown', cls: 'side-unknown' };
}
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Login modal setup ---

function setupLoginUI(providers) {
  // Show OIDC buttons for any configured providers
  if (providers.google || providers.microsoft) {
    show('login-oidc-section');
    if (providers.google) show('btn-login-google');
    if (providers.microsoft) show('btn-login-microsoft');
    // Show divider only if both OIDC and local are available
    if (providers.local) show('login-divider');
  }

  // Show local password form for local password or demo mode
  if (providers.local) {
    show('login-local-section');
    if (providers.demo) show('demo-hint');
  }

  // If only OIDC (no local), make sure local section is hidden
  if (!providers.local) hide('login-local-section');
}

function showLoginModal() {
  // Load providers fresh so login buttons are correct
  fetch('/api/auth/providers')
    .then((r) => r.json())
    .then(setupLoginUI)
    .catch(() => {});
  $('login-error').classList.add('hidden');
  $('login-password').value = '';
  show('login-modal');
}

function hideLoginModal() {
  hide('login-modal');
}

// --- Login modal event handlers ---
$('login-btn').addEventListener('click', login);
$('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
$('login-modal-close').addEventListener('click', hideLoginModal);
$('btn-show-login').addEventListener('click', () => {
  hideUserMenu();
  showLoginModal();
});

// Close login modal on backdrop click
$('login-modal').addEventListener('click', (e) => {
  if (e.target.id === 'login-modal') hideLoginModal();
});

async function login() {
  const pw = $('login-password').value;
  const errEl = $('login-error');
  errEl.classList.add('hidden');
  try {
    await fetch('/auth/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
    });
    hideLoginModal();
    // Refresh session state after login
    await refreshSession();
    // Re-fetch CSRF token now that we have a session
    try {
      const { token } = await GET('/csrf-token');
      csrfToken = token;
    } catch {
      /* non-fatal */
    }
    applyRoleVisibility();
    updateUserMenu();
  } catch (err) {
    errEl.textContent = err.message || 'Login failed.';
    errEl.classList.remove('hidden');
  }
}

// --- Logout ---
$('logout-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  isLoggedIn = false;
  userRole = 'viewer';
  userCapabilities = new Set();
  csrfToken = '';
  hideUserMenu();
  applyRoleVisibility();
  updateUserMenu();
});

// --- User menu ---
function hideUserMenu() {
  $('user-menu-dropdown').classList.add('hidden');
}

$('user-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('user-menu-dropdown').classList.toggle('hidden');
});

// Close user menu on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu-container')) {
    hideUserMenu();
  }
});

function updateUserMenu() {
  if (isLoggedIn) {
    hide('user-menu-guest');
    show('user-menu-authed');
    $('user-menu-name').textContent = window._userName || 'User';
    $('user-menu-email').textContent = window._userEmail || '';
  } else {
    show('user-menu-guest');
    hide('user-menu-authed');
    $('user-menu-name').textContent = 'Guest';
  }
}

// --- Session helper ---
async function refreshSession() {
  try {
    const session = await fetch('/api/session').then((r) => r.json());
    if (session.loggedIn) {
      isLoggedIn = true;
      userRole = session.role || 'viewer';
      userCapabilities = new Set(session.capabilities || []);
      window._userName = session.name;
      window._userEmail = session.email;
      window._userProvider = session.provider || null;
      window._userAdminLevel = session.adminLevel || 0;
      window._userRole = userRole;
      window._userLoginAt = session.loginAt || null;
    } else {
      isLoggedIn = false;
      userRole = 'viewer';
      userCapabilities = new Set();
      window._userName = null;
      window._userEmail = null;
      window._userProvider = null;
      window._userAdminLevel = 0;
      window._userRole = 'viewer';
      window._userLoginAt = null;
    }
  } catch {
    isLoggedIn = false;
    userRole = 'viewer';
    userCapabilities = new Set();
  }
}

// --- Startup: always show dashboard, check session in background ---
(async () => {
  await refreshSession();
  initApp();
  updateUserMenu();
})();

// Demo banner dismiss
$('demo-banner-close').addEventListener('click', () => hide('demo-banner'));

// Server address bar — renders independently of status updates so it appears immediately
function updateServerAddressBar() {
  const urlBar = $('server-url-bar');
  if (!urlBar || !window._serverAddress) return;
  $('server-url-text').textContent = window._serverAddress;
  const vcBubble = $('voice-chat-bubble');
  if (window._voiceChatPort) {
    $('voice-chat-text').textContent = `${window._serverAddress.replace(/:.*$/, '')}:${window._voiceChatPort} UDP`;
    show(vcBubble);
  } else {
    hide(vcBubble);
  }
  show(urlBar);
}

// Server URL copy button
$('btn-copy-server-url').addEventListener('click', () => {
  const addr = window._serverAddress;
  if (!addr) return;
  navigator.clipboard.writeText(addr).then(() => {
    const btn = $('btn-copy-server-url');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 2000);
  });
});
$('btn-copy-voice-url').addEventListener('click', () => {
  const text = $('voice-chat-text').textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('btn-copy-voice-url');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 2000);
  });
});

// --- Tab navigation ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.add('hidden'));
    btn.classList.add('active');
    const tab = $('tab-' + btn.dataset.tab);
    if (tab) tab.classList.remove('hidden');
    onTabActivate(btn.dataset.tab);
  });
});

document.querySelectorAll('.subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const parent = btn.closest('.tab-content');
    parent.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
    parent.querySelectorAll('.subtab-content').forEach((t) => t.classList.add('hidden'));
    btn.classList.add('active');
    const el = parent.querySelector(`#subtab-${btn.dataset.subtab}`);
    if (el) el.classList.remove('hidden');
    onSubtabActivate(btn.dataset.subtab);
  });
});

function onTabActivate(tab) {
  if (tab === 'mods') loadMods();
  if (tab === 'players') {
    loadOnlinePlayers();
  }
  if (tab === 'backups') {
    loadBackups();
    loadBackupSchedule();
  }
  if (tab === 'access') {
    loadRoleReference();
    if (can('panel.manage_users')) loadAccessControlUsers();
    if (can('players.manage_ops')) loadOps();
    checkDiscordTabVisibility();
    if (can('panel.configure')) loadPermissionPolicy();
  }
  if (tab === 'settings') {
    loadAppConfig();
    loadServerProps();
    loadJvmArgs();
    loadVoicechat();
  }
}

let activeModsSubtab = 'installed';

const subtabHandlers = {
  online: () => loadOnlinePlayers(),
  'all-players': () => loadAllPlayers(),
  whitelist: () => loadWhitelist(),
  'ac-roles': () => loadRoleReference(),
  'ac-users': () => loadAccessControlUsers(),
  'ac-ops': () => loadOps(),
  'ac-discord': () => loadDiscordRoles(),
  'ac-policy': () => loadPermissionPolicy(),
  bans: () => loadBans(),
  'server-props': () => loadServerProps(),
  'app-cfg': () => loadAppConfig(),
  voicechat: () => loadVoicechat(),
  installed: () => {
    activeModsSubtab = 'installed';
    renderMods();
  },
  browse: () => {
    activeModsSubtab = 'browse';
    browseLoad();
  },
};

function onSubtabActivate(subtab) {
  const handler = subtabHandlers[subtab];
  if (handler) handler();
}

// --- App init ---
async function initApp() {
  // Fetch CSRF token so mutating requests include it (only if logged in)
  if (isLoggedIn) {
    try {
      const { token } = await GET('/csrf-token');
      csrfToken = token;
    } catch {
      /* non-fatal — CSRF check will reject mutating requests until resolved */
    }
  }

  connectWs();
  loadStatus(); // initial load; WebSocket takes over for live updates
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(loadStatus, 30000); // fallback poll in case WS drops
  // Show demo banner if in demo mode; stash config for UI decisions
  try {
    const cfg = await GET('/config');
    if (cfg.demoMode) {
      show('demo-banner');
      window._demoMode = true;
    } else {
      window._demoMode = false;
    }
    // Server address for the copy widget — render immediately
    window._serverAddress = cfg.serverAddress || '';
    updateServerAddressBar();
    // Load voice chat port for address bar display (non-blocking)
    GET('/settings/voicechat')
      .then((vc) => {
        if (vc && vc.port) {
          window._voiceChatPort = vc.port;
          updateServerAddressBar();
        }
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }

  // Load full environment details (non-blocking, requires login)
  if (isLoggedIn && can('environments.manage')) loadEnvironments();

  // Load preflight checks (non-blocking)
  loadPreflight();

  // Load Discord status (non-blocking)
  loadDiscordStatus();

  // Load dashboard stat cards (non-blocking)
  loadPlayerLinkCount();
  // Apply role-based visibility
  applyRoleVisibility();
}

// --- Preflight checks ---
async function loadPreflight() {
  try {
    const result = await GET('/preflight');
    renderPreflight(result);
  } catch {
    /* preflight is best-effort */
  }
}

function renderPreflight(result) {
  const checksEl = $('preflight-checks');
  const summaryEl = $('preflight-summary');

  // Only show if there are warnings or errors
  const issues = result.checks.filter((c) => c.level !== 'ok');
  if (issues.length === 0) {
    hide('preflight-panel');
    return;
  }

  const parts = [];
  if (result.failed > 0) parts.push(result.failed + ' error' + (result.failed > 1 ? 's' : ''));
  if (result.warned > 0) parts.push(result.warned + ' warning' + (result.warned > 1 ? 's' : ''));
  if (result.passed > 0) parts.push(result.passed + ' passed');
  summaryEl.textContent = parts.join(', ');

  const icons = { error: '\u2716', warn: '\u26A0', ok: '\u2714' };
  checksEl.innerHTML = issues
    .map(
      (c) =>
        `<div class="preflight-item preflight-${esc(c.level)}">` +
        `<span class="preflight-icon">${icons[c.level] || ''}</span>` +
        `<div><div class="preflight-title">${esc(c.title)}</div>` +
        (c.detail ? `<div class="preflight-detail">${esc(c.detail)}</div>` : '') +
        `</div></div>`,
    )
    .join('');

  show('preflight-panel');
}

// --- Role-based visibility ---
const ROLE_NAMES = { viewer: 'Viewer', operator: 'Operator', moderator: 'Moderator', admin: 'Admin', owner: 'Owner' };
const ROLE_LEVELS = { viewer: 0, operator: 1, moderator: 2, admin: 3, owner: 4 };

function applyRoleVisibility() {
  const level = ROLE_LEVELS[userRole] || 0;

  // admin-only: visible for admin role (level 3+) — preserves legacy behavior
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', level < 3);
  });

  // Operator-level elements (visible for operator+)
  document.querySelectorAll('.operator-up').forEach((el) => {
    el.classList.toggle('hidden', level < 1);
  });

  // Moderator-level elements (visible for moderator+)
  document.querySelectorAll('.moderator-up').forEach((el) => {
    el.classList.toggle('hidden', level < 2);
  });

  // Owner-only elements (visible for owner only)
  document.querySelectorAll('.owner-only').forEach((el) => {
    el.classList.toggle('hidden', level < 4);
  });

  // Capability-specific elements: data-cap="capability.name"
  document.querySelectorAll('[data-cap]').forEach((el) => {
    el.classList.toggle('hidden', !can(el.dataset.cap));
  });

  // Role badge in user menu dropdown
  const badge = $('role-badge');
  if (badge && isLoggedIn) {
    badge.textContent = ROLE_NAMES[userRole] || 'Viewer';
    badge.className = 'badge badge-role-' + userRole;
  }
}

// --- WebSocket (live console) ---
// Session cookie is sent automatically by the browser on same-origin WS upgrades.
function connectWs() {
  if (ws) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    clearTimeout(wsReconnectTimer);
    appendConsole('[Manager] Connected to server', 'info');
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'log') appendConsole(msg.line);
      if (msg.type === 'status') updateDashboard(msg);
      if (msg.type === 'crash') showCrashAlert(msg);
      if (msg.type === 'mrpack-progress') handleMrpackProgress(msg);
      if (msg.type === 'mrpack-complete') handleMrpackComplete(msg);
      if (msg.type === 'environment-switched') {
        loadStatus();
        loadEnvironments();
      }
      if (msg.type === 'mod-status-reset') {
        modStartupStatuses = {};
        if (activeModsSubtab === 'installed') renderMods();
      }
      if (msg.type === 'mod-status' && msg.filename) {
        if (!modStartupStatuses[msg.filename]) modStartupStatuses[msg.filename] = { status: msg.status, messages: [] };
        const entry = modStartupStatuses[msg.filename];
        const pri = { loaded: 0, warning: 1, error: 2, critical: 3 };
        if (pri[msg.status] >= pri[entry.status]) entry.status = msg.status;
        if (msg.message) entry.messages.push(msg.message);
        // Targeted DOM update for the visible card
        updateModStartupBadge(msg.filename);
      }
      if (msg.type === 'mod-status-complete') {
        modStartupStatuses = msg.statuses || {};
        if (activeModsSubtab === 'installed') renderMods();
      }
      if (msg.type === 'panel-link-verified') {
        // Auto-refresh MC link section if the user profile modal is open
        const mcContainer = document.getElementById('user-profile-mc-link');
        if (mcContainer && !$('user-profile-modal').classList.contains('hidden')) {
          loadUserProfileMcLink();
        }
      }
    } catch {
      /* ignore */
    }
  };

  ws.onclose = () => {
    ws = null;
    wsReconnectTimer = setTimeout(connectWs, 5000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

// --- Console ---
const consoleOutput = $('console-output');
const autoScrollCb = $('console-autoscroll');

function appendConsole(line, type = '') {
  const div = document.createElement('div');
  div.className = 'console-line' + (type ? ' console-' + type : '');
  if (line.includes('WARN') || line.includes('STDERR')) div.classList.add('console-warn');
  if (line.includes('ERROR') || line.includes('Exception')) div.classList.add('console-error');
  div.textContent = line;
  consoleOutput.appendChild(div);
  if (autoScrollCb.checked) consoleOutput.scrollTop = consoleOutput.scrollHeight;
  while (consoleOutput.children.length > 3000) consoleOutput.removeChild(consoleOutput.firstChild);
}

$('btn-clear-console').addEventListener('click', () => {
  consoleOutput.innerHTML = '';
});

$('btn-send-cmd').addEventListener('click', sendConsoleCmd);
$('console-cmd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendConsoleCmd();
});

async function sendConsoleCmd() {
  const input = $('console-cmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  try {
    await POST('/server/command', { command: cmd });
  } catch {
    // Fall back to stdin
    try {
      await POST('/server/stdin', { command: cmd });
    } catch (err) {
      appendConsole(`[Error] ${err.message}`, 'error');
    }
  }
}

// --- Quick Actions (Manage Server tab) ---
async function runServerAction(el) {
  const cmd = el.dataset.cmd;
  const label = el.dataset.label || cmd;
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  try {
    const r = await POST('/server/command', { command: cmd });
    flash('quick-action-msg', `${label}: ${r.result || 'OK'}`);
  } catch {
    try {
      await POST('/server/stdin', { command: cmd });
      flash('quick-action-msg', `${label}: sent via stdin`);
    } catch (err) {
      flash('quick-action-msg', err.message, true);
    }
  }
}

async function runServerActionPrompt(el) {
  const template = el.dataset.template;
  const label = el.dataset.label || template;
  // Parse prompt definitions: "player:Player name,reason:Reason (optional)"
  // If a prompt value contains pipes it's a select: "mode:Gamemode|survival|creative|adventure|spectator"
  const promptDefs = (el.dataset.prompts || '').split(',').map((p) => {
    const [key, ...rest] = p.split(':');
    const desc = rest.join(':');
    const parts = desc.split('|');
    return {
      key: key.trim(),
      label: parts[0].trim(),
      options: parts.length > 1 ? parts.slice(1) : null,
      optional: desc.toLowerCase().includes('optional'),
    };
  });

  const values = {};
  for (const def of promptDefs) {
    let val;
    if (def.options) {
      val = prompt(
        `${label}\n\nChoose ${def.label}:\n${def.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}\n\nType your choice:`,
      );
      if (val === null) return; // cancelled
      val = val.trim();
      // Accept both the number and the text
      const idx = parseInt(val, 10);
      if (idx >= 1 && idx <= def.options.length) val = def.options[idx - 1];
      // Validate against options
      if (val && !def.options.includes(val.toLowerCase())) {
        const lower = val.toLowerCase();
        const match = def.options.find((o) => o.toLowerCase() === lower);
        if (match) val = match;
      }
    } else {
      val = prompt(`${label}\n\n${def.label}:`);
      if (val === null) return; // cancelled
      val = val.trim();
    }
    if (!val && !def.optional) {
      flash('quick-action-msg', `${def.label} is required`, true);
      return;
    }
    values[def.key] = val;
  }

  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;

  // Build command from template, replacing {key} placeholders
  let cmd = template;
  for (const [key, val] of Object.entries(values)) {
    cmd = cmd.replace(`{${key}}`, val);
  }
  // Remove unfilled optional placeholders
  cmd = cmd.replace(/\s*\{[^}]+\}/g, '').trim();

  try {
    const r = await POST('/server/command', { command: cmd });
    flash('quick-action-msg', `${label}: ${r.result || 'OK'}`);
  } catch {
    try {
      await POST('/server/stdin', { command: cmd });
      flash('quick-action-msg', `${label}: sent via stdin`);
    } catch (err) {
      flash('quick-action-msg', err.message, true);
    }
  }
}

// --- Status & dashboard (live via WebSocket) ---

let lagAlertDismissed = false; // user can dismiss until next spike

function updateDashboard(s) {
  // Derive 4-state status: Stopped / Starting / Running / Stopping
  const isStopping = s.running && s.stopping;
  const isStarting = s.running && !s.stopping && s.rconConnected === false;
  const statusText = !s.running ? 'Stopped' : isStopping ? 'Stopping' : isStarting ? 'Starting' : 'Running';
  const statusClass = !s.running ? 'text-red' : isStopping || isStarting ? 'text-yellow' : 'text-green';
  const badgeClass = !s.running ? 'badge-stopped' : isStopping || isStarting ? 'badge-starting' : 'badge-running';

  // Header badge
  const badge = $('server-badge');
  badge.textContent = statusText;
  badge.className = 'badge ' + badgeClass;

  // Core stat cards
  $('stat-status').textContent = statusText;
  $('stat-status').className = 'stat-value ' + statusClass;
  $('stat-uptime').textContent = formatUptime(s.uptime);
  $('stat-players').textContent = s.running ? String(s.onlineCount ?? 0) : '-';

  const rconEl = $('stat-rcon');
  if (s.rconConnected != null) {
    rconEl.textContent = s.rconConnected ? 'Connected' : 'Disconnected';
    rconEl.className = 'stat-value ' + (s.rconConnected ? 'text-green' : 'text-yellow');
  }

  // Performance metrics
  const tpsEl = $('stat-tps');
  if (s.tps != null) {
    tpsEl.textContent = s.tps.toFixed(1);
    tpsEl.className = 'stat-value ' + (s.tps >= 18 ? 'text-green' : s.tps >= 15 ? 'text-yellow' : 'text-red');
  } else {
    tpsEl.textContent = s.running ? 'N/A' : '-';
    tpsEl.className = 'stat-value';
  }

  $('stat-cpu').textContent = s.cpuPercent != null ? s.cpuPercent.toFixed(1) + '%' : s.running ? 'N/A' : '-';
  $('stat-ram').textContent = s.memBytes != null ? formatSize(s.memBytes) : s.running ? 'N/A' : '-';
  $('stat-disk').textContent = s.diskBytes != null ? formatSize(s.diskBytes) : '-';

  // Mod count
  if (s.modCount != null) {
    const mc = s.modCount;
    if (typeof mc === 'object') {
      $('stat-mod-count').textContent = String(mc.total);
      $('stat-mod-detail').textContent = `${mc.enabled} enabled · ${mc.disabled} disabled`;
      $('stat-mod-count').className = 'stat-value';
    } else {
      $('stat-mod-count').textContent = String(mc);
      $('stat-mod-detail').textContent = '';
      $('stat-mod-count').className = 'stat-value';
    }
  }

  // Quick Broadcast: enable only when RCON is connected
  const broadcastReady = $('broadcast-ready');
  const broadcastBlocked = $('broadcast-blocked');
  if (broadcastReady && broadcastBlocked) {
    if (s.rconConnected) {
      hide(broadcastBlocked);
      show(broadcastReady);
    } else {
      hide(broadcastReady);
      show(broadcastBlocked);
    }
  }

  // MC Version card
  const mcVersionEl = $('stat-mc-version');
  if (s.running && s.minecraftVersion && s.minecraftVersion !== 'unknown') {
    mcVersionEl.textContent = s.minecraftVersion;
    mcVersionEl.className = 'stat-value';
  } else {
    mcVersionEl.textContent = s.running ? 'Unknown' : 'Not Running';
    mcVersionEl.className = 'stat-value' + (s.running ? '' : ' text-dim');
  }

  // Environment info from status
  if (s.environments && s.environments.length > 1) {
    envList = s.environments;
    activeEnvId = s.activeEnvironment || null;
    if (!selectedEnvId) selectedEnvId = s.selectedEnvironment || activeEnvId;
    renderEnvSelector();
    updateEnvBanner();
    updateEnvDisabledControls();
  } else if (s.environments) {
    envList = s.environments;
    activeEnvId = s.activeEnvironment || null;
    selectedEnvId = activeEnvId;
    hide('env-selector-container');
    hide('env-banner');
  }

  // Lag spike alert
  if (s.lagSpike && s.tps != null) {
    lagAlertDismissed = false; // new spike resets dismiss
    $('lag-alert-text').textContent = `Lag detected — TPS is ${s.tps.toFixed(1)} (threshold: ${s.tpsThreshold ?? 18})`;
    show('lag-alert');
  } else if (!s.lagSpike && !lagAlertDismissed) {
    hide('lag-alert');
  }

  // Clear crash alert once the server is back up
  if (s.running) hide('crash-alert');

  updateServerAddressBar();

  // Online players — auto-update from WebSocket data
  if (s.running && s.players) {
    renderOnlinePlayers(s.players);
  } else if (!s.running) {
    $('online-players-list').innerHTML = '<span class="dim">Server is stopped</span>';
  }
}

// Lag alert dismiss button
$('lag-alert-dismiss').addEventListener('click', () => {
  lagAlertDismissed = true;
  hide('lag-alert');
});

// --- Crash alert ---
function showCrashAlert(msg) {
  const el = $('crash-alert');
  $('crash-alert-text').textContent = msg.message;
  show(el);
  // Also log to console
  appendConsole(`[CRASH] ${msg.message}`, 'error');
  // Auto-hide after 60s if auto-restarting
  if (msg.autoRestarting) {
    setTimeout(() => hide(el), 60000);
  }
}

$('crash-alert-dismiss').addEventListener('click', () => {
  hide('crash-alert');
});

function renderOnlinePlayers(players) {
  const el = $('online-players-list');
  if (!players || players.length === 0) {
    el.innerHTML = '<span class="dim">No players online</span>';
    return;
  }
  el.innerHTML = players
    .map(
      (name) =>
        `<span class="chip clickable" data-action="player-profile" data-name="${esc(name)}">${esc(name)}${can('players.manage_bans') ? `<button class="chip-kick" data-name="${esc(name)}" title="Kick">&#10005;</button>` : ''}</span>`,
    )
    .join('');
  el.querySelectorAll('.chip-kick').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't open profile when kicking
      if (!confirm(`Kick ${btn.dataset.name}?`)) return;
      try {
        await POST('/players/kick', { name: btn.dataset.name });
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// Fallback: load full status via HTTP (used on init and as WS fallback)
async function loadStatus() {
  try {
    const s = await GET('/status');
    updateDashboard(s);
  } catch {
    /* ignore */
  }
}

// Server control
$('btn-start').addEventListener('click', async () => {
  try {
    const r = await POST('/server/start');
    flash('control-msg', r.message || 'Starting...');
  } catch (err) {
    flash('control-msg', err.message, true);
  }
});
$('btn-stop').addEventListener('click', async () => {
  if (!confirm('Stop the Minecraft server?')) return;
  try {
    const r = await POST('/server/stop');
    flash('control-msg', r.message || 'Stopping...');
  } catch (err) {
    flash('control-msg', err.message, true);
  }
});
$('btn-restart').addEventListener('click', async () => {
  if (!confirm('Restart the Minecraft server?')) return;
  try {
    const r = await POST('/server/restart');
    flash('control-msg', r.message || 'Restarting...');
  } catch (err) {
    flash('control-msg', err.message, true);
  }
});
$('btn-kill').addEventListener('click', async () => {
  if (!confirm('FORCE KILL the server process? Unsaved world data may be lost!')) return;
  try {
    await POST('/server/kill');
    flash('control-msg', 'Process killed.');
  } catch (err) {
    flash('control-msg', err.message, true);
  }
});

$('btn-regenerate-world').addEventListener('click', async () => {
  if (
    !confirm(
      'REGENERATE THE WORLD?\n\nThis will permanently delete the current world and all player builds. ' +
        'The server must be stopped first. A new world will be generated on next start.\n\nThis cannot be undone!',
    )
  )
    return;
  const typed = prompt('To confirm, type DELETE MY WORLD below:');
  if (typed !== 'DELETE MY WORLD') {
    if (typed !== null)
      flash('quick-action-msg', 'World regeneration cancelled — confirmation text did not match.', true);
    return;
  }
  try {
    const r = await POST('/server/regenerate-world');
    flash('quick-action-msg', r.message || 'World deleted.');
  } catch (err) {
    flash('quick-action-msg', err.message, true);
  }
});

$('btn-say').addEventListener('click', async () => {
  const msg = $('say-input').value.trim();
  if (!msg) return;
  try {
    await POST('/players/say', { message: msg });
    $('say-input').value = '';
    flash('control-msg', 'Message sent!');
  } catch (err) {
    flash('control-msg', err.message, true);
  }
});

// --- Discord Integration ---

async function loadDiscordStatus() {
  try {
    const ds = await GET('/discord/status');

    // Dashboard stat card (visible to all users)
    const statEl = $('stat-discord');
    if (!ds.enabled) {
      statEl.textContent = 'Disabled';
      statEl.className = 'stat-value text-dim';
    } else if (ds.connected) {
      statEl.textContent = 'Connected';
      statEl.className = 'stat-value text-green';
    } else {
      statEl.textContent = 'Disconnected';
      statEl.className = 'stat-value text-red';
    }

    // Discord panel (below stat cards) — requires discord.manage capability
    if (!can('discord.manage')) return;
    const panel = $('discord-panel');
    if (!ds.enabled) {
      hide(panel);
      return;
    }
    show(panel);

    const statusEl = $('discord-status');
    if (ds.connected) {
      statusEl.textContent = 'Connected';
      statusEl.className = 'discord-stat-value text-green';
    } else {
      statusEl.textContent = 'Disconnected';
      statusEl.className = 'discord-stat-value text-red';
    }

    $('discord-bot-name').textContent = ds.username || '-';
    $('discord-guild').textContent = ds.guildName || '-';
    $('discord-channel').textContent = ds.notificationChannelName || 'Not configured';
    $('discord-members').textContent = ds.memberCount != null ? String(ds.memberCount) : '-';

    // Check if sending is possible and show appropriate UI
    const sendReady = $('discord-send-ready');
    const sendBlocked = $('discord-send-blocked');
    const blockedMsg = $('discord-send-blocked-msg');

    if (!ds.connected) {
      hide(sendReady);
      show(sendBlocked);
      blockedMsg.innerHTML = 'Discord bot is not connected. Check bot token and configuration in Settings.';
    } else if (!ds.notificationChannelId) {
      hide(sendReady);
      show(sendBlocked);
      blockedMsg.innerHTML =
        'No notification channel configured. Set <strong>discordNotificationChannelId</strong> in Settings.';
    } else if (ds.canSend === false) {
      hide(sendReady);
      show(sendBlocked);
      blockedMsg.innerHTML =
        'The bot does not have <strong>Send Messages</strong> permission in ' +
        esc(ds.notificationChannelName || 'the notification channel') +
        '. Grant the bot Send Messages permission in Discord server settings.';
    } else {
      show(sendReady);
      hide(sendBlocked);
      $('btn-discord-send').disabled = false;
    }
  } catch {
    $('stat-discord').textContent = 'N/A';
    $('stat-discord').className = 'stat-value text-dim';
    if (can('discord.manage')) hide('discord-panel');
  }
}

async function loadPlayerLinkCount() {
  if (!can('identity.view_links')) {
    $('stat-player-links').textContent = '-';
    return;
  }
  try {
    const links = await GET('/panel-links');
    const count = Array.isArray(links) ? links.length : 0;
    const el = $('stat-player-links');
    el.textContent = count > 0 ? `${count} Linked` : 'None';
    el.className = 'stat-value' + (count > 0 ? '' : ' text-dim');
  } catch {
    $('stat-player-links').textContent = '-';
  }
}

$('btn-discord-send').addEventListener('click', async () => {
  const msg = $('discord-msg-input').value.trim();
  if (!msg) return;
  try {
    const result = await POST('/discord/send-message', { message: msg });
    if (result.ok) {
      $('discord-msg-input').value = '';
      flash('discord-msg-status', 'Message sent to Discord!');
    } else {
      flash('discord-msg-status', result.error || 'Failed to send', true);
    }
  } catch (err) {
    flash('discord-msg-status', err.message, true);
  }
});

$('discord-msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-discord-send').click();
});

// --- Mods ---
let allMods = [];

async function loadMods() {
  try {
    const data = await GET('/mods');
    allMods = data.mods;
    let needsLookup = false;
    for (const mod of allMods) {
      if (mod.modrinthData) {
        currentModData[mod.filename] = { modrinth: mod.modrinthData, enabled: mod.enabled };
      } else {
        needsLookup = true;
      }
    }
    renderMods();
    // Auto-enrich mods that lack Modrinth metadata
    if (needsLookup && allMods.length > 0) {
      enrichInstalledMods();
    }
    // Load startup status (non-blocking)
    loadModStartupStatuses().then(() => {
      if (activeModsSubtab === 'installed') renderMods();
    });
  } catch (err) {
    $('mods-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

async function enrichInstalledMods() {
  try {
    const data = await GET('/mods/lookup');
    currentModData = data;
    renderMods();
  } catch {
    /* best-effort — silently skip if lookup fails */
  }
}

function renderMods() {
  const filterText = $('mod-filter').value.toLowerCase();
  const sideFilter = $('mod-side-filter').value;
  const statusFilter = $('mod-status-filter').value;
  const startupFilter = $('mod-startup-filter').value;
  const sortOrder = $('mod-sort').value;

  let mods = allMods.filter((m) => {
    if (statusFilter === 'enabled' && !m.enabled) return false;
    if (statusFilter === 'disabled' && m.enabled) return false;
    if (filterText) {
      const md = currentModData[m.filename]?.modrinth;
      const title = (md?.projectTitle || m.filename).toLowerCase();
      if (!title.includes(filterText) && !m.filename.toLowerCase().includes(filterText)) return false;
    }
    const md = currentModData[m.filename]?.modrinth;
    if (sideFilter !== 'all') {
      if (!md) return sideFilter === 'unknown';
      const { cls } = sideLabel(md.clientSide, md.serverSide);
      if (sideFilter === 'both' && cls !== 'side-both') return false;
      if (sideFilter === 'server' && cls !== 'side-server') return false;
      if (sideFilter === 'client' && cls !== 'side-client') return false;
    }
    if (startupFilter !== 'all') {
      const ss = modStartupStatuses[m.filename]?.status || '';
      if (startupFilter === 'issues') {
        if (!ss || ss === 'loaded') return false;
      } else if (ss !== startupFilter) {
        return false;
      }
    }
    return true;
  });

  mods.sort((a, b) => {
    const mdA = currentModData[a.filename]?.modrinth;
    const mdB = currentModData[b.filename]?.modrinth;
    const nameA = (mdA?.projectTitle || a.filename).toLowerCase();
    const nameB = (mdB?.projectTitle || b.filename).toLowerCase();
    switch (sortOrder) {
      case 'name-asc':
        return nameA.localeCompare(nameB);
      case 'name-desc':
        return nameB.localeCompare(nameA);
      case 'size-desc':
        return b.size - a.size;
      case 'size-asc':
        return a.size - b.size;
      case 'enabled':
        return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0);
      default:
        return 0;
    }
  });

  if (mods.length === 0) {
    $('mods-list').innerHTML = '<p class="dim">No mods match your filters.</p>';
    modsPager.hide();
    return;
  }

  // Clamp page to valid range after filter changes
  const totalPages = Math.ceil(mods.length / MODS_PAGE_SIZE);
  modsPage = Math.min(modsPage, totalPages - 1);
  const pageMods = mods.slice(modsPage * MODS_PAGE_SIZE, (modsPage + 1) * MODS_PAGE_SIZE);
  modsPager.update(modsPage + 1, totalPages, mods.length, 'mods');

  $('mods-list').innerHTML = pageMods
    .map((mod) => {
      const md = currentModData[mod.filename]?.modrinth;
      const side = md ? sideLabel(md.clientSide, md.serverSide) : { text: 'Unknown', cls: 'side-unknown' };
      const title = md?.projectTitle || mod.filename.replace(/\.jar$/i, '');
      const desc = md?.projectDescription || '';
      const ver = md?.versionNumber || '';

      const downloads = md?.downloads != null ? Number(md.downloads).toLocaleString() : '';
      const follows = md?.follows != null ? Number(md.follows).toLocaleString() : '';
      const cats = (md?.categories || []).filter((c) => c !== 'forge').slice(0, 3);

      const hash = currentModData[mod.filename]?.hash;
      const iconSrc = hash ? `/api/mod-icon/${hash}` : md?.iconUrl;

      const isClientOnly = side.cls === 'side-client';
      return `<div class="mod-card ${mod.enabled ? '' : 'mod-disabled'}${isClientOnly ? ' mod-client-problem' : ''}">
      ${isClientOnly ? '<div class="mod-client-warning-banner">⚠ Client-only mod — should not be installed on a server. Disable or delete it.</div>' : ''}
      ${iconSrc ? `<img class="mod-icon" src="${esc(iconSrc)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mod-icon-placeholder'}))" />` : '<div class="mod-icon-placeholder"></div>'}
      <div class="mod-info">
        <div class="mod-title">
          ${
            md?.projectSlug || md?.projectId
              ? `<span class="mod-title-link" data-action="mod-detail" data-id="${esc(md.projectSlug || md.projectId)}" data-source="installed" data-filename="${esc(mod.filename)}" data-author="${esc(md.author || '')}">${esc(title)}</span>`
              : `<span>${esc(title)}</span>`
          }
          <span class="side-badge ${side.cls}">${side.text}</span>
          ${!mod.enabled ? '<span class="side-badge mod-off-badge">Disabled</span>' : ''}
          ${cats.map((c) => `<span class="cat-badge">${esc(c)}</span>`).join('')}
          ${renderStartupBadge(mod.filename)}
        </div>
        <div class="mod-desc">${desc ? esc(desc.slice(0, 160)) : '&nbsp;'}</div>
        <div class="mod-meta">
          ${md?.author ? `<span class="dim" title="Author">by <strong>${esc(md.author)}</strong></span>` : ''}
          ${downloads ? `<span class="dim" title="Downloads">&#11015; ${downloads}</span>` : ''}
          ${follows ? `<span class="dim" title="Followers">&#9829; ${follows}</span>` : ''}
          ${ver ? `<span class="dim">v${esc(ver)}</span>` : ''}
          <span class="dim">${formatSize(mod.size)}</span>
        </div>
      </div>
      ${
        can('server.manage_mods')
          ? `<div class="mod-actions">
        <button class="btn btn-sm ${mod.enabled ? 'btn-warning' : 'btn-success'}"
          data-action="toggle-mod" data-filename="${esc(mod.filename)}" data-enable="${!mod.enabled}">
          ${mod.enabled ? 'Disable' : 'Enable'}
        </button>
        <button class="btn btn-sm btn-danger"
          data-action="delete-mod" data-filename="${esc(mod.filename)}">
          Delete
        </button>
      </div>`
          : ''
      }
    </div>`;
    })
    .join('');
}

window.toggleMod = async function (btn) {
  const { filename } = btn.dataset;
  const enable = btn.dataset.enable === 'true';
  try {
    await POST('/mods/toggle', { filename, enable });
    await loadMods();
  } catch (err) {
    alert(err.message);
  }
};

window.deleteMod = async function (btn) {
  const { filename } = btn.dataset;
  if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
  try {
    await DEL(`/mods/${encodeURIComponent(filename)}`);
    await loadMods();
  } catch (err) {
    alert(err.message);
  }
};

$('mod-filter').addEventListener('input', () => {
  modsPage = 0;
  renderMods();
});
$('mod-side-filter').addEventListener('change', () => {
  modsPage = 0;
  renderMods();
});
$('mod-sort').addEventListener('change', () => {
  modsPage = 0;
  renderMods();
});
$('mod-status-filter').addEventListener('change', () => {
  modsPage = 0;
  renderMods();
});
$('mod-startup-filter').addEventListener('change', () => {
  modsPage = 0;
  renderMods();
});
$('btn-refresh-mods').addEventListener('click', loadMods);
$('btn-refresh-metadata').addEventListener('click', async () => {
  const btn = $('btn-refresh-metadata');
  btn.disabled = true;
  btn.textContent = 'Re-identifying...';
  try {
    await POST('/mods/cache/invalidate');
    currentModData = {};
    await loadMods();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-identify Mods';
  }
});

// --- Browse Modrinth ---
let browseLoaded = false;

$('btn-browse-search').addEventListener('click', () => {
  browseReset();
  browseSearch();
});
$('browse-query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    browseReset();
    browseSearch();
  }
});

function browseReset() {
  browsePage = 0;
  browseFilteredTotal = 0;
  browseExhausted = false;
  browseLoading = false;
  browseCache.clear();
  browseLoaded = false;
}

$('tab-page-prev').addEventListener('click', () => {
  if (activeModsSubtab === 'installed') {
    modsPage--;
    renderMods();
    return;
  }
  if (browsePage > 0) {
    browsePage--;
    renderBrowsePage();
  }
});
$('tab-page-next').addEventListener('click', () => {
  if (activeModsSubtab === 'installed') {
    modsPage++;
    renderMods();
    return;
  }
  if (browseLoading) return;
  browsePage++;
  renderBrowsePage();
});

// Build the excludeSlugs query param (installed mod slugs to filter out server-side)
function browseExcludeParam() {
  if ($('browse-show-installed').checked) return '';
  const slugs = [...getInstalledSlugs()];
  return slugs.length > 0 ? JSON.stringify(slugs) : '';
}

// Get the raw Modrinth offset to use for a given page request
function browseRawOffsetForPage(page) {
  if (page === 0) return 0;
  // Use the next_offset from the previous page
  const prev = browseCache.get(page - 1);
  return prev ? prev.nextOffset : 0;
}

// Fetch a single page of results from the backend (which handles over-fetching)
async function browseFetchPage(page) {
  if (browseLoading) return;
  browseLoading = true;
  try {
    const q = $('browse-query').value.trim();
    const rawOffset = browseRawOffsetForPage(page);
    const exclude = browseExcludeParam();
    const params = new URLSearchParams({ limit: BROWSE_PAGE_SIZE, rawOffset });
    if (q) {
      params.set('q', q);
      params.set('side', $('browse-side').value);
    }
    if (exclude) params.set('excludeSlugs', exclude);
    const endpoint = q ? 'search' : 'browse';
    const data = await GET(`/modrinth/${endpoint}?${params}`);
    browseFilteredTotal = data.filtered_total ?? data.total_hits ?? 0;
    browseExhausted = data.exhausted || false;
    browseCache.set(page, {
      hits: data.hits || [],
      nextOffset: data.next_offset ?? 0,
    });
    // If the API returned fewer than a full page, we've reached the end
    if ((data.hits || []).length < BROWSE_PAGE_SIZE) browseExhausted = true;
  } finally {
    browseLoading = false;
  }
}

async function browseLoad() {
  if (browseLoaded && !$('browse-query').value.trim()) {
    renderBrowsePage();
    return;
  }
  $('browse-heading').textContent = 'Popular server-compatible Forge mods';
  $('browse-results').innerHTML = '<p class="dim">Loading popular mods...</p>';
  browsePager.hide();
  browseReset();
  try {
    await browseFetchPage(0);
    renderBrowsePage();
    browseLoaded = true;
  } catch (err) {
    $('browse-results').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

async function browseSearch() {
  const q = $('browse-query').value.trim();
  if (!q) {
    browseReset();
    return browseLoad();
  }
  $('browse-heading').textContent = `Search results for "${q}"`;
  $('browse-results').innerHTML = '<p class="dim">Searching Modrinth...</p>';
  browsePager.hide();
  browseReset();
  try {
    await browseFetchPage(0);
    renderBrowsePage();
  } catch (err) {
    $('browse-results').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

$('browse-show-installed').addEventListener('change', () => {
  browseReset();
  browseLoad();
});

function updateBrowsePagination() {
  const totalPages = Math.max(1, Math.ceil(browseFilteredTotal / BROWSE_PAGE_SIZE));
  const page = browsePage + 1;
  browsePager.update(page, totalPages, browseFilteredTotal, 'mods');
}

// Returns a Set of Modrinth project slugs for all currently-installed mods.
// Works in both demo mode (modrinthData pre-populated) and real mode (after lookup).
function getInstalledSlugs() {
  const slugs = new Set();
  for (const data of Object.values(currentModData)) {
    const slug = data.modrinth?.projectSlug;
    if (slug) slugs.add(slug);
  }
  return slugs;
}

async function renderBrowsePage() {
  // If this page isn't cached yet, fetch it
  if (!browseCache.has(browsePage)) {
    if (browseExhausted) {
      // No more data — clamp to last valid page
      browsePage = Math.max(0, browsePage - 1);
      if (!browseCache.has(browsePage)) return;
    } else {
      $('browse-results').innerHTML = '<p class="dim">Loading mods...</p>';
      try {
        await browseFetchPage(browsePage);
      } catch (err) {
        $('browse-results').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
        return;
      }
    }
  }

  const cached = browseCache.get(browsePage);
  const pageHits = cached?.hits || [];
  const installed = getInstalledSlugs();

  updateBrowsePagination();

  if (pageHits.length === 0) {
    $('browse-results').innerHTML = '<p class="dim">No results found.</p>';
    return;
  }
  $('browse-results').innerHTML = pageHits
    .map((hit) => {
      const isInstalled = installed.has(hit.slug);
      const side = sideLabel(hit.client_side, hit.server_side);
      const downloads = Number(hit.downloads || 0).toLocaleString();
      const follows = Number(hit.follows || 0).toLocaleString();
      const cats = (hit.categories || []).filter((c) => c !== 'forge').slice(0, 3);
      // Populate from cache immediately if already fetched
      const cached = hit.latest_version ? browseVersionCache.get(hit.latest_version) : null;
      return `<div class="mod-card browse-card${isInstalled ? ' mod-disabled' : ''}" id="browse-card-${esc(hit.project_id)}">
      ${hit.icon_url ? `<img class="mod-icon" src="${esc(hit.icon_url)}" alt="" loading="lazy" />` : '<div class="mod-icon-placeholder"></div>'}
      <div class="mod-info">
        <div class="mod-title">
          <span class="mod-title-link" data-action="mod-detail" data-id="${esc(hit.project_id)}" data-source="browse" data-author="${esc(hit.author || '')}">${esc(hit.title)}</span>
          <span class="side-badge ${side.cls}">${side.text}</span>
          ${isInstalled ? '<span class="installed-badge">Installed</span>' : ''}
          ${cats.map((c) => `<span class="cat-badge">${esc(c)}</span>`).join('')}
        </div>
        <div class="mod-desc">${esc((hit.description || '').slice(0, 160))}</div>
        <div class="mod-meta">
          <span class="dim" title="Author">by <strong>${esc(hit.author)}</strong></span>
          <span class="dim" title="Downloads">&#11015; ${downloads}</span>
          <span class="dim" title="Followers">&#9829; ${follows}</span>
          <span class="dim browse-ver"${cached?.versionNumber ? '' : ' hidden'}>${cached?.versionNumber ? `v${esc(cached.versionNumber)}` : ''}</span>
          <span class="dim browse-size"${cached?.fileSize != null ? '' : ' hidden'}>${cached?.fileSize != null ? formatSize(cached.fileSize) : ''}</span>
        </div>
      </div>
      ${
        can('server.manage_mods')
          ? `<div class="mod-actions">
        ${
          isInstalled
            ? '<button class="btn btn-sm" disabled>Installed</button>'
            : `<button class="btn btn-sm btn-primary" data-action="install-mod" data-projectid="${esc(hit.project_id)}" data-title="${esc(hit.title)}">Install</button>`
        }
      </div>`
          : ''
      }
    </div>`;
    })
    .join('');

  // Async-enrich version number and file size for hits not yet cached
  enrichBrowseVersions(pageHits);
}

async function enrichBrowseVersions(hits) {
  const toFetch = hits
    .filter((h) => h.latest_version && !browseVersionCache.has(h.latest_version))
    .map((h) => h.latest_version);

  if (toFetch.length > 0) {
    try {
      const params = new URLSearchParams({ ids: JSON.stringify(toFetch) });
      const versions = await GET(`/modrinth/versions/batch?${params}`);
      for (const v of versions) {
        const primary = v.files?.find((f) => f.primary) ?? v.files?.[0];
        browseVersionCache.set(v.id, { versionNumber: v.version_number, fileSize: primary?.size ?? null });
      }
    } catch {
      /* best-effort — silently skip if batch fetch fails */
    }
  }

  // Update DOM for each hit that now has cached data
  for (const hit of hits) {
    if (!hit.latest_version) continue;
    const cached = browseVersionCache.get(hit.latest_version);
    if (!cached) continue;
    const card = document.getElementById(`browse-card-${hit.project_id}`);
    if (!card) continue;
    if (cached.versionNumber) {
      const el = card.querySelector('.browse-ver');
      if (el) {
        el.textContent = `v${cached.versionNumber}`;
        el.removeAttribute('hidden');
      }
    }
    if (cached.fileSize != null) {
      const el = card.querySelector('.browse-size');
      if (el) {
        el.textContent = formatSize(cached.fileSize);
        el.removeAttribute('hidden');
      }
    }
  }
}

$('btn-mod-detail-back').addEventListener('click', closeModDetail);

// --- Mod Startup Status ---

// Fetch startup status on initial mods load (for clients connecting after startup)
async function loadModStartupStatuses() {
  try {
    modStartupStatuses = await GET('/mods/startup-status');
  } catch {
    /* non-fatal */
  }
}

function renderStartupBadge(filename) {
  const s = modStartupStatuses[filename];
  if (!s) return '';
  const icons = { loaded: '●', warning: '⚠', error: '✖', critical: '💥' };
  const labels = { loaded: 'Loaded', warning: 'Warning', error: 'Error', critical: 'Critical' };
  const icon = icons[s.status] || '';
  const label = labels[s.status] || s.status;
  const count = s.messages?.length || 0;
  const countText = count > 1 ? ` (${count})` : '';
  if (s.status === 'loaded' && count === 0) {
    return `<span class="startup-badge startup-loaded" title="Loaded OK">${icon}</span>`;
  }
  return `<span class="startup-badge startup-${s.status}" data-action="mod-startup-detail" data-filename="${esc(filename)}" title="Startup: ${label}">${icon} ${label}${countText}</span>`;
}

function updateModStartupBadge(filename) {
  // Find the card with this filename and update just the badge (avoid full re-render)
  const cards = document.querySelectorAll('.mod-card');
  for (const card of cards) {
    const toggle = card.querySelector('[data-action="toggle-mod"]');
    if (toggle && toggle.dataset.filename === filename) {
      const existing = card.querySelector('.startup-badge');
      const badge = renderStartupBadge(filename);
      if (existing) {
        existing.outerHTML = badge;
      } else {
        // Append to the mod-title div
        const titleDiv = card.querySelector('.mod-title');
        if (titleDiv) titleDiv.insertAdjacentHTML('beforeend', badge);
      }
      break;
    }
  }
}

function openModStartupDetail(filename) {
  const s = modStartupStatuses[filename];
  if (!s) return;
  const md = currentModData[filename]?.modrinth;
  const title = md?.projectTitle || filename.replace(/\.jar$/i, '');
  $('mod-startup-modal-title').textContent =
    `${title} — Startup ${s.status.charAt(0).toUpperCase() + s.status.slice(1)}`;

  let html = '';
  if (s.messages.length === 0) {
    html = '<p class="dim">Mod loaded without any messages.</p>';
  } else {
    for (const msg of s.messages) {
      const levelCls = msg.level === 'ERROR' || msg.level === 'FATAL' ? 'startup-level-error' : 'startup-level-warn';
      html += `<div class="startup-message">
        <div class="startup-message-header">
          <span class="startup-level-badge ${levelCls}">${esc(msg.level)}</span>
          <span class="dim">${esc(msg.source)}</span>
        </div>
        <div class="startup-message-text">${esc(msg.text)}</div>`;
      if (msg.stackTrace && msg.stackTrace.length > 0) {
        html += `<details class="startup-stacktrace">
          <summary>Stack trace (${msg.stackTrace.length} lines)</summary>
          <pre>${esc(msg.stackTrace.join('\n'))}</pre>
        </details>`;
      }
      html += '</div>';
    }
  }
  $('mod-startup-modal-content').innerHTML = html;
  show('mod-startup-modal');
}

function closeModDetail() {
  hide('mod-detail-panel');
  if (modDetailState?.source === 'browse') {
    show('subtab-browse');
    activeModsSubtab = 'browse';
    renderBrowsePage();
  } else {
    show('subtab-installed');
    activeModsSubtab = 'installed';
    renderMods();
  }
  modDetailState = null;
}
window.closeModDetail = closeModDetail;

window.openModDetail = async function (idOrSlug, source, context = {}) {
  modDetailState = { source, ...context };

  // Hide subtab content and pagination; show detail panel
  hide('subtab-installed');
  hide('subtab-browse');
  modsPager.hide();
  show('mod-detail-panel');
  $('mod-detail-content').innerHTML = '<p class="dim">Loading mod details...</p>';

  try {
    const project = await GET(`/modrinth/project/${encodeURIComponent(idOrSlug)}`);
    renderModDetail(project, context);
  } catch (err) {
    $('mod-detail-content').innerHTML = `<p class="error-msg">Failed to load details: ${esc(err.message)}</p>`;
  }
};

function renderModDetail(project, context = {}) {
  // Check if this mod is currently installed
  let installedFile = null;
  let installedMod = null;
  for (const mod of allMods) {
    const md = currentModData[mod.filename]?.modrinth;
    if (md?.projectId === project.id || md?.projectSlug === project.slug) {
      installedFile = mod.filename;
      installedMod = mod;
      break;
    }
  }
  const isInstalled = !!installedFile;

  const side = sideLabel(project.client_side, project.server_side);
  const downloads = Number(project.downloads || 0).toLocaleString();
  const follows = Number(project.follows || 0).toLocaleString();
  const cats = (project.categories || []).filter((c) => c !== 'forge').slice(0, 6);
  const author = context.author || '';

  // External links
  const links = [
    `<a href="https://modrinth.com/mod/${encodeURIComponent(project.slug)}" target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Modrinth ↗</a>`,
    project.issues_url
      ? `<a href="${esc(project.issues_url)}"  target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Issues ↗</a>`
      : '',
    project.source_url
      ? `<a href="${esc(project.source_url)}"  target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Source ↗</a>`
      : '',
    project.wiki_url
      ? `<a href="${esc(project.wiki_url)}"    target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Wiki ↗</a>`
      : '',
    project.discord_url
      ? `<a href="${esc(project.discord_url)}" target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Discord ↗</a>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  // Gallery: sort by ordering, prefer featured first
  const gallery = (project.gallery || []).sort(
    (a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (a.ordering || 0) - (b.ordering || 0),
  );

  // Action buttons (requires server.manage_mods capability)
  const actionBtns = !can('server.manage_mods')
    ? ''
    : isInstalled
      ? `<button class="btn ${installedMod.enabled ? 'btn-warning' : 'btn-success'}"
         data-action="toggle-mod" data-filename="${esc(installedFile)}" data-enable="${!installedMod.enabled}">
         ${installedMod.enabled ? 'Disable' : 'Enable'}
       </button>
       <button class="btn btn-danger"
         data-action="delete-mod" data-filename="${esc(installedFile)}" data-close-detail="true">Delete</button>`
      : `<button class="btn btn-primary btn-lg"
         data-action="install-mod" data-projectid="${esc(project.id)}" data-title="${esc(project.title)}">Install</button>`;

  $('mod-detail-content').innerHTML = `
    <div class="mod-detail-header">
      <div class="mod-detail-hero">
        ${
          project.icon_url
            ? `<img class="mod-detail-icon" src="${esc(project.icon_url)}" alt="" />`
            : '<div class="mod-detail-icon mod-icon-placeholder"></div>'
        }
        <div class="mod-detail-info">
          <h2 class="mod-detail-title">${esc(project.title)}</h2>
          <div class="mod-meta">
            ${author ? `<span class="dim">by <strong>${esc(author)}</strong></span>` : ''}
            <span class="dim" title="Downloads">&#11015; ${downloads}</span>
            <span class="dim" title="Followers">&#9829; ${follows}</span>
          </div>
          <div class="mod-badges">
            <span class="side-badge ${side.cls}">${side.text}</span>
            ${isInstalled ? '<span class="installed-badge mod-detail-installed-badge">Installed</span>' : ''}
            ${cats.map((c) => `<span class="cat-badge">${esc(c)}</span>`).join('')}
          </div>
          <div class="mod-detail-links">${links}</div>
        </div>
        <div class="mod-detail-actions">${actionBtns}</div>
      </div>
      ${project.description ? `<p class="mod-detail-summary dim">${esc(project.description)}</p>` : ''}
    </div>
    ${
      gallery.length > 0
        ? `
      <section class="mod-detail-section">
        <h3>Gallery</h3>
        <div class="mod-gallery">
          ${gallery
            .map(
              (img) => `
            <img class="gallery-img" src="${esc(img.url)}" alt="${esc(img.title || '')}"
                 title="${esc(img.description || img.title || '')}" loading="lazy" />`,
            )
            .join('')}
        </div>
      </section>`
        : ''
    }
    ${
      project.bodyHtml
        ? `
      <section class="mod-detail-section">
        <h3>About</h3>
        <div class="mod-detail-body">${project.bodyHtml}</div>
      </section>`
        : ''
    }
  `;
}

window.openVersionModal = async function (btn) {
  const { projectid, title } = btn.dataset;
  $('modal-title').textContent = `Install: ${title}`;
  show('version-modal');
  $('modal-versions').innerHTML = '<p class="dim">Loading versions...</p>';
  try {
    const versions = await GET(`/modrinth/versions/${projectid}`);
    if (!versions.length) {
      $('modal-versions').innerHTML =
        '<p class="dim">No compatible versions found for your Minecraft version / Forge.</p>';
      return;
    }
    $('modal-versions').innerHTML = versions
      .slice(0, 15)
      .map((v) => {
        const file = v.files.find((f) => f.primary) || v.files[0];
        return `<div class="version-row">
        <div>
          <strong>${esc(v.name)}</strong>
          <span class="dim"> — ${esc(v.version_type)} — ${(v.game_versions || []).join(', ')}</span>
        </div>
        <div class="dim">${file ? formatSize(file.size) : ''}</div>
        <button class="btn btn-sm btn-success"
          data-action="download-mod" data-versionid="${esc(v.id)}">
          Download
        </button>
      </div>`;
      })
      .join('');
  } catch (err) {
    $('modal-versions').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
};

$('modal-close').addEventListener('click', () => hide('version-modal'));
$('version-modal').addEventListener('click', (e) => {
  if (e.target === $('version-modal')) hide('version-modal');
});

window.downloadMod = async function (btn) {
  const { versionid } = btn.dataset;
  btn.disabled = true;
  btn.textContent = 'Downloading...';
  try {
    await POST('/modrinth/download', { versionId: versionid });
    btn.textContent = 'Installed';
    btn.className = 'btn btn-sm btn-ghost';
    hide('version-modal');
    await loadMods();
    // Ensure Modrinth lookup completes so getInstalledSlugs() has the new mod's slug
    if (allMods.some((m) => !currentModData[m.filename])) {
      await enrichInstalledMods();
    }
    // Re-render browse results so the card shows "Installed" badge
    if (browseCache.size > 0) renderBrowsePage();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Download';
    alert('Download failed: ' + err.message);
  }
};

// --- Players: Online ---
async function fetchDiscordLinks() {
  if (!can('identity.view_links')) return {};
  try {
    const links = await GET('/players/discord-links');
    const map = {};
    for (const l of links) map[l.minecraftName.toLowerCase()] = l;
    return map;
  } catch {
    return {};
  }
}

function discordLinkCell(name, linksMap) {
  const link = linksMap[name.toLowerCase()];
  if (link) {
    return `<span class="discord-linked-badge" title="Discord ID: ${esc(link.discordId)}">Linked</span>`;
  }
  return '<span class="dim">-</span>';
}

async function fetchPanelLinks() {
  if (!can('identity.view_links')) return {};
  try {
    const links = await GET('/panel-links');
    const map = {};
    for (const l of links) map[l.minecraftName.toLowerCase()] = l;
    return map;
  } catch {
    return {};
  }
}

function panelLinkCell(name, panelMap) {
  const link = panelMap[name.toLowerCase()];
  if (link) {
    return `<span class="panel-linked-badge" title="${esc(link.email)}">${esc(link.email)}</span>`;
  }
  return '<span class="dim">-</span>';
}

function linkInstructionButtons() {
  return `<div style="margin-top:0.75rem;text-align:center;display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap">
    <button class="btn btn-sm btn-ghost" data-action="show-link-instructions">How to Link Discord</button>
    <button class="btn btn-sm btn-ghost" data-action="show-panel-link-instructions">How to Link Panel Account</button>
  </div>`;
}

async function loadOnlinePlayers() {
  const el = $('online-list');
  try {
    const [data, linksMap, panelMap] = await Promise.all([
      GET('/players/online'),
      fetchDiscordLinks(),
      fetchPanelLinks(),
    ]);

    const players = data.players || [];
    if (!players.length) {
      el.innerHTML = '<p class="dim">No players online.</p>';
      return;
    }
    const canKickBan = can('players.manage_bans');
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Player</th><th>Discord</th><th>Panel</th>${canKickBan ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${players
        .map(
          (name) => `
        <tr>
          <td>
            <div class="player-cell">
              <img class="player-avatar-sm" src="https://mc-heads.net/avatar/${esc(name)}/24" alt="" onerror="this.style.display='none'">
              <strong class="player-name-link" data-action="player-profile" data-name="${esc(name)}">${esc(name)}</strong>
            </div>
          </td>
          <td>${discordLinkCell(name, linksMap)}</td>
          <td>${panelLinkCell(name, panelMap)}</td>
          ${
            canKickBan
              ? `<td class="action-cell">
            <button class="btn btn-xs btn-warning" data-action="kick-player" data-name="${esc(name)}">Kick</button>
            <button class="btn btn-xs btn-danger" data-action="ban-from-list" data-name="${esc(name)}">Ban</button>
          </td>`
              : ''
          }
        </tr>`,
        )
        .join('')}
      </tbody>
    </table>
    ${linkInstructionButtons()}`;
  } catch (err) {
    el.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

// --- Players: All ---
async function loadAllPlayers() {
  const el = $('all-players-list');
  try {
    const [usercache, onlineData, ops, whitelist, bansData, linksMap, panelMap] = await Promise.all([
      GET('/players/all'),
      GET('/players/online').catch(() => ({ players: [] })),
      GET('/players/ops'),
      GET('/players/whitelist'),
      GET('/players/banned').catch(() => ({ players: [] })),
      fetchDiscordLinks(),
      fetchPanelLinks(),
    ]);

    if (!usercache.length) {
      el.innerHTML = '<p class="dim">No players have joined the server yet.</p>';
      return;
    }

    const onlineSet = new Set((onlineData.players || []).map((n) => n.toLowerCase()));
    const opMap = {};
    for (const o of ops) opMap[o.name.toLowerCase()] = o;
    const wlSet = new Set(whitelist.map((e) => e.name.toLowerCase()));
    const banSet = new Set((bansData.players || []).map((e) => e.name.toLowerCase()));

    // Sort: online first, then alphabetical
    const sorted = [...usercache].sort((a, b) => {
      const aOn = onlineSet.has(a.name.toLowerCase()) ? 0 : 1;
      const bOn = onlineSet.has(b.name.toLowerCase()) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.name.localeCompare(b.name);
    });

    const canBan = can('players.manage_bans');
    const canOp = can('players.manage_ops');
    const canWl = can('players.manage_whitelist');
    const canManagePlayers = canBan || canOp || canWl;
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Player</th><th>Status</th><th>Discord</th><th>Panel</th>${canManagePlayers ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${sorted
        .map((p) => {
          const lower = p.name.toLowerCase();
          const online = onlineSet.has(lower);
          const op = opMap[lower];
          const wl = wlSet.has(lower);
          const banned = banSet.has(lower);

          const badges = [];
          if (online) badges.push('<span class="profile-badge online">Online</span>');
          if (op) badges.push(`<span class="profile-badge op">Op ${op.level}</span>`);
          if (wl) badges.push('<span class="profile-badge whitelisted">WL</span>');
          if (banned) badges.push('<span class="profile-badge banned">Banned</span>');
          if (!online && !badges.length) badges.push('<span class="profile-badge offline">Offline</span>');

          const actions = [];
          if (canBan && online)
            actions.push(
              `<button class="btn btn-xs btn-warning" data-action="kick-player" data-name="${esc(p.name)}">Kick</button>`,
            );
          if (canBan && !banned)
            actions.push(
              `<button class="btn btn-xs btn-danger" data-action="ban-from-list" data-name="${esc(p.name)}">Ban</button>`,
            );
          if (canOp && !op)
            actions.push(
              `<button class="btn btn-xs btn-ghost" data-action="op-from-list" data-name="${esc(p.name)}">Op</button>`,
            );
          if (canWl && !wl)
            actions.push(
              `<button class="btn btn-xs btn-ghost" data-action="whitelist-from-list" data-name="${esc(p.name)}">WL</button>`,
            );

          return `
        <tr>
          <td>
            <div class="player-cell">
              <img class="player-avatar-sm" src="https://mc-heads.net/avatar/${esc(p.uuid || p.name)}/24" alt="" onerror="this.style.display='none'">
              <strong class="player-name-link" data-action="player-profile" data-name="${esc(p.name)}">${esc(p.name)}</strong>
            </div>
          </td>
          <td><div class="badge-row">${badges.join('')}</div></td>
          <td>${discordLinkCell(p.name, linksMap)}</td>
          <td>${panelLinkCell(p.name, panelMap)}</td>
          ${canManagePlayers ? `<td class="action-cell">${actions.join('')}</td>` : ''}
        </tr>`;
        })
        .join('')}
      </tbody>
    </table>
    ${linkInstructionButtons()}`;
  } catch (err) {
    el.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

// --- Players: Quick actions from lists ---
async function kickPlayerFromList(name) {
  const reason = prompt(`Kick ${name}? Enter reason (optional):`, 'Kicked by admin');
  if (reason === null) return;
  try {
    await POST('/players/kick', { name, reason: reason || 'Kicked by admin' });
    loadOnlinePlayers();
  } catch (err) {
    alert('Kick failed: ' + err.message);
  }
}

async function banPlayerFromList(name) {
  const reason = prompt(`Ban ${name}? Enter reason:`, 'Banned by admin');
  if (reason === null) return;
  try {
    await POST('/players/ban', { name, reason: reason || 'Banned by admin' });
    loadOnlinePlayers();
    loadBans();
  } catch (err) {
    alert('Ban failed: ' + err.message);
  }
}

async function opPlayerFromList(name) {
  if (!confirm(`Make ${name} an operator?`)) return;
  try {
    await POST('/players/op', { name, level: 1 });
    loadAllPlayers();
    loadOps();
  } catch (err) {
    alert('Op failed: ' + err.message);
  }
}

async function whitelistPlayerFromList(name) {
  try {
    await POST('/players/whitelist', { name });
    loadAllPlayers();
    loadWhitelist();
  } catch (err) {
    alert('Whitelist failed: ' + err.message);
  }
}

// --- Players: Ops ---
async function loadOps() {
  try {
    const ops = await GET('/players/ops');
    const el = $('ops-list');
    if (!ops.length) {
      el.innerHTML = '<p class="dim">No operators set.</p>';
      return;
    }
    const canManageOps = can('players.manage_ops');
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Name</th><th>Level</th><th>UUID</th>${canManageOps ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${ops
        .map(
          (op) => `
        <tr>
          <td><strong class="player-name-link" data-action="player-profile" data-name="${esc(op.name)}">${esc(op.name)}</strong></td>
          <td><span class="level-badge level-${op.level}">Level ${op.level}</span></td>
          <td class="dim small">${esc(op.uuid || '-')}</td>
          ${canManageOps ? `<td><button class="btn btn-sm btn-danger" data-action="remove-op" data-name="${esc(op.name)}">Remove</button></td>` : ''}
        </tr>`,
        )
        .join('')}
      </tbody>
    </table>`;
  } catch (err) {
    $('ops-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

$('btn-add-op').addEventListener('click', async () => {
  const name = $('op-name').value.trim();
  const level = parseInt($('op-level').value);
  if (!name) return alert('Enter a player name.');
  try {
    await POST('/players/op', { name, level });
    $('op-name').value = '';
    loadOps();
  } catch (err) {
    alert(err.message);
  }
});

window.removeOp = async function (btn) {
  if (!confirm(`Remove operator status from ${btn.dataset.name}?`)) return;
  try {
    await DEL(`/players/op/${encodeURIComponent(btn.dataset.name)}`);
    loadOps();
  } catch (err) {
    alert(err.message);
  }
};

// --- Players: Whitelist ---
async function loadWhitelist() {
  try {
    const list = await GET('/players/whitelist');
    const el = $('whitelist-list');
    if (!list.length) {
      el.innerHTML = '<p class="dim">Whitelist is empty.</p>';
      return;
    }
    const canManageWl = can('players.manage_whitelist');
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Name</th><th>UUID</th>${canManageWl ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${list
        .map(
          (e) => `
        <tr>
          <td><strong class="player-name-link" data-action="player-profile" data-name="${esc(e.name)}">${esc(e.name)}</strong></td>
          <td class="dim small">${esc(e.uuid || '-')}</td>
          ${canManageWl ? `<td><button class="btn btn-sm btn-danger" data-action="remove-wl" data-name="${esc(e.name)}">Remove</button></td>` : ''}
        </tr>`,
        )
        .join('')}
      </tbody>
    </table>`;
  } catch (err) {
    $('whitelist-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

$('btn-add-wl').addEventListener('click', async () => {
  const name = $('wl-name').value.trim();
  if (!name) return alert('Enter a player name.');
  try {
    await POST('/players/whitelist', { name });
    $('wl-name').value = '';
    loadWhitelist();
  } catch (err) {
    alert(err.message);
  }
});

window.removeWl = async function (btn) {
  if (!confirm(`Remove ${btn.dataset.name} from whitelist?`)) return;
  try {
    await DEL(`/players/whitelist/${encodeURIComponent(btn.dataset.name)}`);
    loadWhitelist();
  } catch (err) {
    alert(err.message);
  }
};

// --- Players: Bans ---
async function loadBans() {
  try {
    const data = await GET('/players/banned');
    const el = $('bans-list');
    const banned = data.players || [];
    if (!banned.length) {
      el.innerHTML = '<p class="dim">No banned players.</p>';
      return;
    }
    const canManageBans = can('players.manage_bans');
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Name</th><th>Reason</th>${canManageBans ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${banned
        .map(
          (e) => `
        <tr>
          <td><strong class="player-name-link" data-action="player-profile" data-name="${esc(e.name)}">${esc(e.name)}</strong></td>
          <td class="dim">${esc(e.reason || '-')}</td>
          ${canManageBans ? `<td><button class="btn btn-sm btn-success" data-action="unban-player" data-name="${esc(e.name)}">Unban</button></td>` : ''}
        </tr>`,
        )
        .join('')}
      </tbody>
    </table>`;
  } catch (err) {
    $('bans-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

$('btn-ban').addEventListener('click', async () => {
  const name = $('ban-name').value.trim();
  const reason = $('ban-reason').value.trim() || 'Banned by admin';
  if (!name) return alert('Enter a player name.');
  if (!confirm(`Ban ${name} for: "${reason}"?`)) return;
  try {
    await POST('/players/ban', { name, reason });
    $('ban-name').value = '';
    $('ban-reason').value = '';
    loadBans();
  } catch (err) {
    alert(err.message);
  }
});

window.unbanPlayer = async function (btn) {
  if (!confirm(`Unban ${btn.dataset.name}?`)) return;
  try {
    await DEL(`/players/ban/${encodeURIComponent(btn.dataset.name)}`);
    loadBans();
  } catch (err) {
    alert(err.message);
  }
};

// --- Settings: App config ---

// Build a command preview string from the launch fields
function updateLaunchPreview() {
  const exe = $('launch-executable').value.trim();
  const argsText = $('launch-args').value.trim();
  const args = argsText
    ? argsText
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  const parts = [exe, ...args].filter(Boolean);
  $('launch-preview').textContent =
    parts.map((p) => (p.includes(' ') ? '"' + p + '"' : p)).join(' ') || '(no command configured)';
}

$('launch-executable').addEventListener('input', updateLaunchPreview);
$('launch-args').addEventListener('input', updateLaunchPreview);

async function loadAppConfig() {
  try {
    const cfg = await GET('/config');
    const form = $('app-config-form');
    for (const [k, v] of Object.entries(cfg)) {
      if (k === 'launch') continue; // handled separately
      const el = form.elements[k];
      if (!el || el.type === 'password') continue;
      if (el.type === 'checkbox') {
        el.checked = !!v;
      } else {
        el.value = v;
      }
    }
    // Populate launch fields
    if (cfg.launch) {
      $('launch-executable').value = cfg.launch.executable || '';
      $('launch-args').value = (cfg.launch.args || []).join('\n');
      updateLaunchPreview();
    }
  } catch (err) {
    console.error('Config load failed', err);
  }
}

$('app-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else if (el.type === 'number' && el.value !== '') {
      data[el.name] = Number(el.value);
    } else if (el.value !== '') {
      data[el.name] = el.value;
    }
  }
  // Build structured launch config from the dedicated fields
  const exe = $('launch-executable').value.trim();
  const argsText = $('launch-args').value.trim();
  if (exe) {
    data.launch = {
      executable: exe,
      args: argsText
        ? argsText
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean)
        : [],
    };
  }
  try {
    await POST('/config', data);
    if (data.demoMode === false) {
      hide('demo-banner');
      flash(
        'app-cfg-msg',
        'Demo mode disabled. Restart the manager app (node server.js) to connect to your real server.',
      );
    } else if (data.demoMode === true) {
      show('demo-banner');
      flash('app-cfg-msg', 'Demo mode enabled. Restart the manager app to return to seed data.');
    } else {
      flash('app-cfg-msg', 'Config saved! Restart the manager for port/path changes to take effect.');
    }
  } catch (err) {
    flash('app-cfg-msg', err.message, true);
  }
});

$('btn-reconnect-rcon').addEventListener('click', async () => {
  try {
    const r = await POST('/rcon/connect');
    flash(
      'app-cfg-msg',
      r.connected ? 'RCON connected!' : 'RCON connection failed. Check password and server.properties.',
    );
  } catch (err) {
    flash('app-cfg-msg', err.message, true);
  }
});

// --- Settings: server.properties ---
const IMPORTANT_PROPS = [
  'enable-rcon',
  'rcon.port',
  'rcon.password',
  'white-list',
  'online-mode',
  'max-players',
  'server-port',
  'motd',
  'gamemode',
  'difficulty',
  'level-name',
  'pvp',
  'spawn-protection',
  'op-permission-level',
];

async function loadServerProps() {
  const el = $('props-fields');
  try {
    const props = await GET('/settings/properties');
    const entries = Object.entries(props);
    if (!entries.length) {
      el.innerHTML = '<p class="dim">Could not read server.properties.</p>';
      return;
    }

    entries.sort(([a], [b]) => {
      const ai = IMPORTANT_PROPS.indexOf(a),
        bi = IMPORTANT_PROPS.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });

    el.innerHTML = entries
      .map(([k, v]) => {
        const important = IMPORTANT_PROPS.includes(k);
        const inputType = v === 'true' || v === 'false' ? 'checkbox' : 'text';
        if (inputType === 'checkbox') {
          return `<div class="form-group ${important ? 'prop-important' : ''}">
          <label class="checkbox-label">
            <input type="checkbox" name="prop__${esc(k)}" ${v === 'true' ? 'checked' : ''} />
            <span>${esc(k)}</span>
            ${important ? '<span class="badge-important">Key Setting</span>' : ''}
          </label>
        </div>`;
        }
        return `<div class="form-group ${important ? 'prop-important' : ''}">
        <label>${esc(k)} ${important ? '<span class="badge-important">Key Setting</span>' : ''}</label>
        <input type="text" name="prop__${esc(k)}" value="${esc(v)}" />
      </div>`;
      })
      .join('');
  } catch (err) {
    el.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

$('props-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const props = {};
  for (const el of form.elements) {
    if (!el.name?.startsWith('prop__')) continue;
    const key = el.name.slice(6);
    props[key] = el.type === 'checkbox' ? String(el.checked) : el.value;
  }
  try {
    await POST('/settings/properties', props);
    flash('props-msg', 'server.properties saved! Restart the Minecraft server to apply changes.');
  } catch (err) {
    flash('props-msg', err.message, true);
  }
});

// --- Settings: JVM Arguments ---

async function loadJvmArgs() {
  const textarea = $('jvm-args-content');
  try {
    const data = await GET('/settings/jvm-args');
    if (data.content === null) {
      textarea.value = '';
      textarea.placeholder = 'No user_jvm_args.txt found in the server directory.';
    } else {
      textarea.value = data.content;
    }
    textarea.readOnly = !can('panel.configure');
  } catch (err) {
    textarea.value = '';
    textarea.placeholder = 'Could not load JVM arguments: ' + err.message;
  }
}

async function saveJvmArgs() {
  const content = $('jvm-args-content').value;
  await POST('/settings/jvm-args', { content });
}

$('jvm-args-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await saveJvmArgs();
    flash('jvm-args-msg', 'JVM arguments saved! Restart the Minecraft server to apply changes.');
  } catch (err) {
    flash('jvm-args-msg', err.message, true);
  }
});

$('btn-jvm-save-restart').addEventListener('click', async () => {
  if (!confirm('Save JVM arguments and restart the Minecraft server?')) return;
  try {
    await saveJvmArgs();
    await POST('/server/restart');
    flash('jvm-args-msg', 'JVM arguments saved. Server is restarting...');
  } catch (err) {
    flash('jvm-args-msg', err.message, true);
  }
});

// --- Settings: Simple Voice Chat ---

async function loadVoicechat() {
  try {
    const props = await GET('/settings/voicechat');
    const notInstalled = $('voicechat-not-installed');
    const config = $('voicechat-config');
    if (props === null) {
      notInstalled.classList.remove('hidden');
      config.classList.add('hidden');
      return;
    }
    notInstalled.classList.add('hidden');
    config.classList.remove('hidden');
    $('vc-port').value = props.port ?? '';
    $('vc-max-distance').value = props.max_voice_distance ?? '';
    $('vc-whisper-distance').value = props.whisper_distance ?? '';
    $('vc-enable-groups').checked = props.enable_groups !== 'false';
    $('vc-allow-recording').checked = props.allow_recording !== 'false';
    $('vc-force-voice-chat').checked = props.force_voice_chat === 'true';
    const form = $('voicechat-form');
    if (form) {
      Array.from(form.elements).forEach((el) => {
        el.disabled = !can('panel.configure');
      });
      const submit = form.querySelector('[type=submit]');
      if (submit) submit.classList.toggle('hidden', !can('panel.configure'));
    }
  } catch (err) {
    flash('voicechat-msg', 'Could not load voice chat config: ' + err.message, true);
  }
}

$('voicechat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await POST('/settings/voicechat', {
      port: $('vc-port').value,
      max_voice_distance: $('vc-max-distance').value,
      whisper_distance: $('vc-whisper-distance').value,
      enable_groups: String($('vc-enable-groups').checked),
      allow_recording: String($('vc-allow-recording').checked),
      force_voice_chat: String($('vc-force-voice-chat').checked),
    });
    flash('voicechat-msg', 'Voice chat config saved! Restart the Minecraft server to apply changes.');
  } catch (err) {
    flash('voicechat-msg', err.message, true);
  }
});

// --- Settings: FTB Chunks ---

subtabHandlers['ftbchunks'] = () => loadFtbChunks();

async function loadFtbChunks() {
  try {
    const config = await GET('/settings/ftbchunks');
    const notInstalled = $('ftbchunks-not-installed');
    const configDiv = $('ftbchunks-config');
    if (config === null) {
      notInstalled.classList.remove('hidden');
      configDiv.classList.add('hidden');
      return;
    }
    notInstalled.classList.add('hidden');
    configDiv.classList.remove('hidden');
    $('ftbc-max-claimed').value = config.max_claimed_chunks || '500';
    $('ftbc-max-forceloaded').value = config.max_force_loaded_chunks || '25';
    $('ftbc-hard-team-claim').value = config.hard_team_claim_limit || '0';
    $('ftbc-hard-team-force').value = config.hard_team_force_limit || '0';
    $('ftbc-party-limit-mode').value = config.party_limit_mode || 'largest';
    $('ftbchunks-path').textContent = `Config file: ${config._path || 'world/serverconfig/ftbchunks-server.snbt'}`;
    // FTB Ranks warning
    if (config.ftbRanksInstalled) {
      $('ftbchunks-ranks-warning').classList.remove('hidden');
    } else {
      $('ftbchunks-ranks-warning').classList.add('hidden');
    }
    // Disable fields if user lacks permission
    const form = $('ftbchunks-form');
    if (form) {
      Array.from(form.elements).forEach((el) => {
        el.disabled = !can('panel.configure');
      });
    }
  } catch (err) {
    flash('ftbchunks-msg', 'Could not load FTB Chunks config: ' + err.message, true);
  }
}

$('ftbchunks-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await POST('/settings/ftbchunks', {
      max_claimed_chunks: $('ftbc-max-claimed').value,
      max_force_loaded_chunks: $('ftbc-max-forceloaded').value,
      hard_team_claim_limit: $('ftbc-hard-team-claim').value,
      hard_team_force_limit: $('ftbc-hard-team-force').value,
      party_limit_mode: $('ftbc-party-limit-mode').value,
    });
    flash('ftbchunks-msg', 'FTB Chunks config saved! Restart the Minecraft server to apply changes.');
  } catch (err) {
    flash('ftbchunks-msg', err.message, true);
  }
});

// ============================================================
// Access Control
// ============================================================

// --- Role Reference ---

// Track RBAC editing state
let _rbacData = null; // last fetched role data from GET /roles
let _rbacDirty = false; // true when user has toggled checkboxes

async function loadRoleReference() {
  try {
    const data = await GET('/roles');
    _rbacData = data;
    const { roles, allCapabilities, editable } = data;
    const roleOrder = ['viewer', 'operator', 'moderator', 'admin', 'owner'];

    // Role summary cards
    const cards = roleOrder
      .map((key) => {
        const r = roles[key];
        return `<div class="ac-role-card">
          <div class="ac-role-card-header">
            <span class="badge badge-role-${esc(key)}">${esc(r.name)}</span>
            <span class="dim small">Level ${r.level}</span>
          </div>
          <p class="ac-role-desc">${esc(r.description)}</p>
          <p class="dim small">${r.capabilities.length} capabilities</p>
        </div>`;
      })
      .join('');
    $('ac-role-summary').innerHTML = cards;

    // Update hint text based on editability
    const hint = $('ac-matrix-hint');
    if (hint) {
      hint.textContent = editable
        ? 'Toggle checkboxes to customize which capabilities each role grants. Click Save Changes when done.'
        : 'A checkmark means the role grants this capability. Each role includes all capabilities from lower roles.';
    }

    // Build effective capability map from current role data
    const allCaps = {};
    for (const cap of allCapabilities) {
      allCaps[cap] = {};
      for (const key of roleOrder) {
        if (roles[key].capabilities.includes(cap)) allCaps[cap][key] = true;
      }
    }

    // Group capabilities by category prefix
    const groups = {};
    for (const cap of allCapabilities) {
      const dot = cap.indexOf('.');
      const category = dot > 0 ? cap.substring(0, dot) : 'other';
      if (!groups[category]) groups[category] = [];
      groups[category].push(cap);
    }

    const capLabels = {
      'panel.view': 'View dashboard',
      'panel.configure': 'Configure panel & server settings',
      'panel.manage_users': 'Manage user accounts & roles',
      'panel.link_identities': 'Manage identity links for others',
      'server.view_status': 'View server status & metrics',
      'server.view_logs': 'View server logs',
      'server.view_console': 'View live console',
      'server.send_console_command': 'Send console commands',
      'server.start': 'Start the server',
      'server.stop': 'Stop the server',
      'server.restart': 'Restart the server',
      'server.manage_files': 'Browse & manage server files',
      'server.manage_mods': 'Install, toggle & remove mods',
      'server.manage_world': 'Regenerate or delete worlds',
      'server.view_backups': 'View backups',
      'server.create_backup': 'Create backups',
      'server.restore_backup': 'Restore from backup',
      'server.delete_backup': 'Delete backups',
      'players.view': 'View player lists & profiles',
      'players.manage_ops': 'Manage server operators',
      'players.manage_whitelist': 'Manage whitelist',
      'players.manage_bans': 'Ban, unban & kick players',
      'chat.broadcast': 'Broadcast messages to server',
      'discord.use_commands': 'Use read-only Discord commands',
      'discord.use_control': 'Use server-control Discord commands',
      'discord.link_self': 'Link own Discord account',
      'discord.manage': 'Configure Discord integration',
      'identity.link_self': 'Link own Minecraft account',
      'identity.view_links': 'View all identity links',
      'audit.view': 'View audit logs',
    };

    const categoryNames = {
      panel: 'Panel',
      server: 'Server',
      players: 'Players',
      chat: 'Chat',
      discord: 'Discord',
      identity: 'Identity',
      audit: 'Audit',
    };
    const categoryOrder = ['panel', 'server', 'players', 'chat', 'discord', 'identity', 'audit'];

    let matrixRows = '';
    for (const cat of categoryOrder) {
      const caps = groups[cat];
      if (!caps) continue;
      matrixRows += `<tr class="ac-matrix-category"><td colspan="${roleOrder.length + 1}"><strong>${esc(categoryNames[cat] || cat)}</strong></td></tr>`;
      for (const cap of caps) {
        const label = capLabels[cap] || cap;
        const cells = roleOrder
          .map((r) => {
            const checked = allCaps[cap][r] ? 'checked' : '';
            const isCustomized = checked !== (roles[r].defaultCapabilities.includes(cap) ? 'checked' : '');
            const customClass = isCustomized ? ' rbac-customized' : '';
            if (editable) {
              // Safety: panel.view always on, panel.manage_users always on for owner
              const locked = cap === 'panel.view' || (cap === 'panel.manage_users' && r === 'owner');
              return `<td class="ac-matrix-check${customClass}"><input type="checkbox" class="rbac-checkbox" data-cap="${esc(cap)}" data-role="${esc(r)}" ${checked} ${locked ? 'disabled' : ''} /></td>`;
            }
            return `<td class="ac-matrix-check${customClass}">${allCaps[cap][r] ? '&#10003;' : ''}</td>`;
          })
          .join('');
        matrixRows += `<tr><td class="ac-matrix-cap">${esc(label)}</td>${cells}</tr>`;
      }
    }

    $('ac-capability-matrix').innerHTML = `<table class="ac-matrix-table">
      <thead><tr><th>Capability</th>${roleOrder.map((r) => `<th class="ac-matrix-role-header"><span class="badge badge-role-${esc(r)}">${esc(roles[r].name)}</span></th>`).join('')}</tr></thead>
      <tbody>${matrixRows}</tbody>
    </table>`;

    // Show/hide save/reset buttons
    const actionsEl = $('ac-rbac-actions');
    if (actionsEl) {
      if (editable) {
        actionsEl.classList.remove('hidden');
        _rbacDirty = false;
        updateRbacButtons();
      } else {
        actionsEl.classList.add('hidden');
      }
    }
  } catch (err) {
    $('ac-role-summary').innerHTML = `<p class="dim">Could not load roles: ${esc(err.message)}</p>`;
  }
}

function updateRbacButtons() {
  const saveBtn = $('btn-save-rbac');
  const resetBtn = $('btn-reset-rbac');
  if (saveBtn) saveBtn.disabled = !_rbacDirty;
  // Show reset button only when there are active overrides or unsaved changes
  const hasOverrides = _rbacData?.overrides && Object.keys(_rbacData.overrides).length > 0;
  if (resetBtn) resetBtn.disabled = !hasOverrides && !_rbacDirty;
}

async function saveRbacChanges() {
  const roleOrder = ['viewer', 'operator', 'moderator', 'admin', 'owner'];
  const desired = {};
  for (const role of roleOrder) {
    desired[role] = [];
  }
  // Read all checkbox states
  const checkboxes = document.querySelectorAll('.rbac-checkbox');
  for (const cb of checkboxes) {
    if (cb.checked) {
      desired[cb.dataset.role].push(cb.dataset.cap);
    }
  }
  // Safety: ensure locked caps are always included
  for (const role of roleOrder) {
    if (!desired[role].includes('panel.view')) desired[role].push('panel.view');
  }
  if (!desired.owner.includes('panel.manage_users')) desired.owner.push('panel.manage_users');

  const msg = $('ac-rbac-msg');
  try {
    const data = await PUT('/roles/capabilities', { roles: desired });
    _rbacData = data;
    _rbacDirty = false;
    if (msg) {
      msg.textContent = 'RBAC rules saved successfully.';
      msg.className = 'control-msg success';
      setTimeout(() => (msg.textContent = ''), 3000);
    }
    // Re-render to reflect saved state
    await loadRoleReference();
    // Refresh session so the current user's capabilities update
    await refreshSession();
  } catch (err) {
    if (msg) {
      msg.textContent = 'Failed to save: ' + err.message;
      msg.className = 'control-msg error';
    }
  }
}

async function resetRbacDefaults() {
  const roleOrder = ['viewer', 'operator', 'moderator', 'admin', 'owner'];
  if (!_rbacData?.roles) return;
  // Send default capabilities for each role
  const desired = {};
  for (const role of roleOrder) {
    desired[role] = _rbacData.roles[role].defaultCapabilities;
  }
  const msg = $('ac-rbac-msg');
  try {
    const data = await PUT('/roles/capabilities', { roles: desired });
    _rbacData = data;
    _rbacDirty = false;
    if (msg) {
      msg.textContent = 'RBAC rules reset to defaults.';
      msg.className = 'control-msg success';
      setTimeout(() => (msg.textContent = ''), 3000);
    }
    await loadRoleReference();
    await refreshSession();
  } catch (err) {
    if (msg) {
      msg.textContent = 'Failed to reset: ' + err.message;
      msg.className = 'control-msg error';
    }
  }
}

// --- Panel Users (unified with linked identities) ---

async function loadAccessControlUsers() {
  const container = $('ac-users-list');
  try {
    const [users, panelLinks, discordLinks] = await Promise.all([
      GET('/users'),
      GET('/panel-links'),
      GET('/players/discord-links'),
    ]);

    if (!users.length) {
      container.innerHTML = '<p class="dim">No users found. Users appear after logging in.</p>';
      return;
    }

    // Build lookup maps
    const panelLinkMap = {};
    for (const link of panelLinks) panelLinkMap[link.email || link.user_email] = link;
    const discordByMc = {};
    for (const link of discordLinks) discordByMc[link.minecraftName?.toLowerCase()] = link;

    const roleOptions = ['viewer', 'operator', 'moderator', 'admin', 'owner'];
    const rows = users
      .map((u) => {
        const isSelf = u.email === window._userEmail;
        const role = u.role || (u.admin_level >= 1 ? 'admin' : 'viewer');
        const roleBadge = `<span class="badge badge-role-${esc(role)}">${esc(ROLE_NAMES[role] || role)}</span>`;
        const lastLogin = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never';
        const roleSelect = isSelf
          ? `<span class="dim" title="Cannot change your own role">${esc(ROLE_NAMES[role] || role)}</span>`
          : `<select class="role-select" data-email="${esc(u.email)}">
              ${roleOptions.map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_NAMES[r]}</option>`).join('')}
            </select>`;
        const deleteBtn = isSelf
          ? ''
          : `<button class="btn btn-xs btn-danger" data-action="delete-user" data-email="${esc(u.email)}" title="Remove user">&#10005;</button>`;

        // Linked MC identity
        const pLink = panelLinkMap[u.email];
        const mcCell = pLink
          ? `<span class="identity-chip" title="Linked: ${esc(pLink.minecraftName)}">${esc(pLink.minecraftName)}${pLink.verified ? ' &#10003;' : ''}</span>`
          : '<span class="identity-chip unlinked">Not linked</span>';

        // Linked Discord identity (through MC name)
        const dLink = pLink ? discordByMc[pLink.minecraftName?.toLowerCase()] : null;
        const discordCell = dLink
          ? `<span class="identity-chip" title="Discord ID: ${esc(dLink.discordId)}">${esc(dLink.discordId)}</span>`
          : '<span class="identity-chip unlinked">-</span>';

        return `<tr>
          <td>${esc(u.name || '')} ${isSelf ? '<span class="dim">(you)</span>' : ''}</td>
          <td>${esc(u.email)}</td>
          <td>${roleBadge}</td>
          <td>${roleSelect}</td>
          <td>${mcCell}</td>
          <td>${discordCell}</td>
          <td>${lastLogin}</td>
          <td>${deleteBtn}</td>
        </tr>`;
      })
      .join('');

    container.innerHTML = `<table class="data-table">
      <thead><tr>
        <th>Name</th><th>Email</th><th>Role</th><th>Set Role</th><th>MC Player</th><th>Discord</th><th>Last Login</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    container.querySelectorAll('.role-select').forEach((sel) => {
      sel.addEventListener('change', () => setUserRole(sel.dataset.email, sel.value));
    });
    container.querySelectorAll('[data-action="delete-user"]').forEach((btn) => {
      btn.addEventListener('click', () => deleteUserAccount(btn.dataset.email));
    });
  } catch (err) {
    container.innerHTML = `<p class="dim">Could not load users: ${esc(err.message)}</p>`;
  }
}

async function setUserRole(email, role) {
  const roleName = ROLE_NAMES[role] || role;
  if (!confirm(`Change ${email} to ${roleName}?`)) {
    loadAccessControlUsers();
    return;
  }
  try {
    await PUT(`/users/${encodeURIComponent(email)}/role`, { role });
    flash('ac-users-msg', `${email} is now ${roleName}.`);
    loadAccessControlUsers();
  } catch (err) {
    flash('ac-users-msg', err.message, true);
    loadAccessControlUsers();
  }
}

async function deleteUserAccount(email) {
  if (!confirm(`Remove ${email} from the panel? They can re-register by logging in again.`)) return;
  try {
    await fetch(`/api/users/${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    });
    flash('ac-users-msg', `${email} removed.`);
    loadAccessControlUsers();
  } catch (err) {
    flash('ac-users-msg', err.message, true);
  }
}

// --- Discord Roles ---

async function checkDiscordTabVisibility() {
  try {
    const status = await GET('/discord/status');
    const tabBtn = document.getElementById('ac-discord-tab-btn');
    if (tabBtn) tabBtn.style.display = status.enabled ? '' : 'none';
  } catch {
    const tabBtn = document.getElementById('ac-discord-tab-btn');
    if (tabBtn) tabBtn.style.display = 'none';
  }
}

async function loadDiscordRoles() {
  const container = $('ac-discord-content');
  try {
    const status = await GET('/discord/status');
    if (!status.enabled) {
      container.innerHTML =
        '<div class="legend-box">Discord integration is not enabled. Configure it in <strong>Settings &rarr; App Config</strong> to manage Discord role mappings.</div>';
      return;
    }

    let html = `<div class="legend-box">
      Discord bot is <strong>connected</strong> to <strong>${esc(status.guildName || 'Unknown Server')}</strong>.
      Discord role mappings can be configured in the <strong>Permission Policy</strong> tab.
    </div>`;

    // Show Discord-MC identity links
    if (can('identity.view_links')) {
      const links = await GET('/players/discord-links');
      if (links.length) {
        const rows = links
          .map(
            (l) => `<tr>
            <td>${esc(l.discordId)}</td>
            <td><strong class="player-name-link" data-action="player-profile" data-name="${esc(l.minecraftName)}">${esc(l.minecraftName)}</strong></td>
            <td>${esc(l.linkedBy || '-')}</td>
            <td>${l.linkedAt ? new Date(l.linkedAt).toLocaleDateString() : '-'}</td>
            ${can('panel.link_identities') ? `<td><button class="btn btn-xs btn-danger" data-action="unlink-discord" data-id="${esc(l.discordId)}" title="Unlink">&#10005;</button></td>` : ''}
          </tr>`,
          )
          .join('');
        html += `<h3 class="ac-section-heading">Discord &harr; Minecraft Links</h3>
          <div class="player-table-wrap"><table class="data-table">
            <thead><tr><th>Discord ID</th><th>MC Player</th><th>Linked By</th><th>Linked</th>${can('panel.link_identities') ? '<th>Actions</th>' : ''}</tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;
      } else {
        html += '<p class="dim" style="margin-top:1rem">No Discord &harr; Minecraft links found.</p>';
      }
    }

    container.innerHTML = html;

    // Bind unlink buttons
    container.querySelectorAll('[data-action="unlink-discord"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Unlink Discord ID ${btn.dataset.id}?`)) return;
        try {
          await DEL(`/players/discord-link/${encodeURIComponent(btn.dataset.id)}`);
          loadDiscordRoles();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<p class="dim">Could not load Discord status: ${esc(err.message)}</p>`;
  }
}

// --- Permission Policy ---

async function loadPermissionPolicy() {
  try {
    const config = await GET('/config');
    const auth = config.authorization || {};
    const currentPolicy = auth.permissionPolicy || 'isolated';
    const opMapping = auth.opLevelMapping || {};
    const discordMapping = auth.discordRoleMapping || {};

    const policies = [
      {
        key: 'isolated',
        name: 'Isolated',
        desc: 'Each identity channel (panel, Discord, Minecraft) has independent permissions. Linking accounts does not share capabilities between channels. This is the safest default.',
      },
      {
        key: 'inherit-panel',
        name: 'Inherit Panel',
        desc: "Linked Discord and Minecraft identities inherit ALL of the panel user's capabilities. Use with caution — a panel Admin would have full admin powers through Discord commands too.",
      },
      {
        key: 'panel-ceiling',
        name: 'Panel Ceiling',
        desc: "Linked identities use the HIGHER of their own channel role and the panel user's role. The panel role can elevate but never restrict. A good middle-ground option.",
      },
    ];

    const policyHtml = policies
      .map(
        (p) => `<label class="ac-policy-card ${p.key === currentPolicy ? 'active' : ''}">
        <input type="radio" name="ac-policy" value="${p.key}" ${p.key === currentPolicy ? 'checked' : ''} />
        <strong>${esc(p.name)}</strong>
        <span class="ac-policy-desc">${esc(p.desc)}</span>
      </label>`,
      )
      .join('');
    $('ac-policy-options').innerHTML = policyHtml;

    // Bind radio cards to toggle active class
    $('ac-policy-options')
      .querySelectorAll('input[name="ac-policy"]')
      .forEach((radio) => {
        radio.addEventListener('change', () => {
          $('ac-policy-options')
            .querySelectorAll('.ac-policy-card')
            .forEach((c) => c.classList.remove('active'));
          radio.closest('.ac-policy-card').classList.add('active');
        });
      });

    // Op level mapping
    const roleOptions = ['viewer', 'operator', 'moderator', 'admin', 'owner'];
    const defaultOpMap = { 1: 'viewer', 2: 'operator', 3: 'moderator', 4: 'admin' };
    const opRows = [1, 2, 3, 4]
      .map((level) => {
        const mapped = opMapping[level] ?? defaultOpMap[level] ?? null;
        return `<tr>
          <td><span class="level-badge level-${level}">Level ${level}</span></td>
          <td><select class="ac-op-map-select" data-level="${level}">
            <option value="" ${!mapped ? 'selected' : ''}>None</option>
            ${roleOptions.map((r) => `<option value="${r}" ${r === mapped ? 'selected' : ''}>${ROLE_NAMES[r]}</option>`).join('')}
          </select></td>
        </tr>`;
      })
      .join('');
    $('ac-op-mapping').innerHTML = `<table class="data-table">
      <thead><tr><th>MC Op Level</th><th>Panel Role</th></tr></thead>
      <tbody>${opRows}</tbody>
    </table>`;

    // Discord role mapping (conditional)
    try {
      const discStatus = await GET('/discord/status');
      if (discStatus.enabled) {
        document.getElementById('ac-discord-mapping-heading').style.display = '';
        document.getElementById('ac-discord-mapping-hint').style.display = '';
        document.getElementById('ac-discord-mapping').style.display = '';

        const mappingEntries = Object.entries(discordMapping);
        let dmHtml = '';
        if (mappingEntries.length) {
          const dmRows = mappingEntries
            .map(
              ([roleId, role]) => `<tr>
              <td><input type="text" class="ac-discord-role-id" value="${esc(roleId)}" style="width:180px" /></td>
              <td><select class="ac-discord-role-select">
                ${roleOptions.map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_NAMES[r]}</option>`).join('')}
              </select></td>
              <td><button class="btn btn-xs btn-danger ac-discord-map-remove" title="Remove">&#10005;</button></td>
            </tr>`,
            )
            .join('');
          dmHtml = `<table class="data-table" id="ac-discord-map-table">
            <thead><tr><th>Discord Role ID</th><th>Panel Role</th><th></th></tr></thead>
            <tbody>${dmRows}</tbody>
          </table>`;
        }
        dmHtml +=
          '<button class="btn btn-sm btn-ghost" id="btn-add-discord-map" style="margin-top:0.5rem">+ Add Mapping</button>';
        $('ac-discord-mapping').innerHTML = dmHtml;

        // Bind add button
        const addBtn = document.getElementById('btn-add-discord-map');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            let table = document.getElementById('ac-discord-map-table');
            if (!table) {
              $('ac-discord-mapping').insertAdjacentHTML(
                'afterbegin',
                `<table class="data-table" id="ac-discord-map-table">
                <thead><tr><th>Discord Role ID</th><th>Panel Role</th><th></th></tr></thead>
                <tbody></tbody>
              </table>`,
              );
              table = document.getElementById('ac-discord-map-table');
            }
            const tbody = table.querySelector('tbody');
            tbody.insertAdjacentHTML(
              'beforeend',
              `<tr>
              <td><input type="text" class="ac-discord-role-id" placeholder="Role ID" style="width:180px" /></td>
              <td><select class="ac-discord-role-select">
                ${roleOptions.map((r) => `<option value="${r}">${ROLE_NAMES[r]}</option>`).join('')}
              </select></td>
              <td><button class="btn btn-xs btn-danger ac-discord-map-remove" title="Remove">&#10005;</button></td>
            </tr>`,
            );
            bindDiscordMapRemoveButtons();
          });
        }
        bindDiscordMapRemoveButtons();
      }
    } catch {
      // Discord not available, hide mapping sections
    }
  } catch (err) {
    $('ac-policy-options').innerHTML = `<p class="dim">Could not load policy: ${esc(err.message)}</p>`;
  }
}

function bindDiscordMapRemoveButtons() {
  document.querySelectorAll('.ac-discord-map-remove').forEach((btn) => {
    btn.onclick = () => btn.closest('tr').remove();
  });
}

// RBAC capability overrides — save/reset buttons + checkbox change tracking
document.getElementById('btn-save-rbac')?.addEventListener('click', saveRbacChanges);
document.getElementById('btn-reset-rbac')?.addEventListener('click', resetRbacDefaults);
document.getElementById('ac-capability-matrix')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('rbac-checkbox')) {
    _rbacDirty = true;
    updateRbacButtons();
    // Highlight customized cells
    const cap = e.target.dataset.cap;
    const role = e.target.dataset.role;
    const isDefault = _rbacData?.roles?.[role]?.defaultCapabilities.includes(cap);
    const isChecked = e.target.checked;
    const td = e.target.closest('td');
    if (td) td.classList.toggle('rbac-customized', isChecked !== isDefault);
  }
});

document.getElementById('btn-save-policy')?.addEventListener('click', async () => {
  const policy = document.querySelector('input[name="ac-policy"]:checked')?.value || 'isolated';

  // Collect op level mapping
  const opLevelMapping = {};
  document.querySelectorAll('.ac-op-map-select').forEach((sel) => {
    const level = sel.dataset.level;
    opLevelMapping[level] = sel.value || null;
  });

  // Collect discord role mapping
  const discordRoleMapping = {};
  document.querySelectorAll('#ac-discord-map-table tbody tr').forEach((row) => {
    const roleId = row.querySelector('.ac-discord-role-id')?.value?.trim();
    const role = row.querySelector('.ac-discord-role-select')?.value;
    if (roleId && role) discordRoleMapping[roleId] = role;
  });

  try {
    await POST('/config', { authorization: { permissionPolicy: policy, opLevelMapping, discordRoleMapping } });
    flash('ac-policy-msg', 'Policy settings saved.');
  } catch (err) {
    flash('ac-policy-msg', err.message, true);
  }
});

// ============================================================
// Backups
// ============================================================

async function loadBackups() {
  const el = $('backups-list');
  try {
    const backups = await GET('/backups');
    if (backups.length === 0) {
      el.innerHTML = '<p class="dim">No backups yet. Create one above.</p>';
      return;
    }
    el.innerHTML = backups
      .map((b) => {
        const date = new Date(b.createdAt);
        const dateStr = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const typeBadge =
          b.type === 'scheduled'
            ? '<span class="backup-badge backup-scheduled">Scheduled</span>'
            : '<span class="backup-badge backup-manual">Manual</span>';
        const dbBadge = b.includesDatabase ? '<span class="backup-badge backup-db">DB</span>' : '';
        const quiescedBadge = b.quiesced ? '<span class="backup-badge backup-quiesced">Quiesced</span>' : '';
        return `<div class="backup-card">
        <div class="backup-info">
          <div class="backup-title">
            ${typeBadge}${dbBadge}${quiescedBadge}
            <span class="backup-date">${esc(dateStr)} ${esc(timeStr)}</span>
          </div>
          ${b.note ? `<div class="backup-note">${esc(b.note)}</div>` : ''}
          <div class="backup-meta">
            <span>${formatSize(b.size)}</span>
            ${b.minecraftVersion ? `<span>MC ${esc(b.minecraftVersion)}</span>` : ''}
            ${b.modCount != null ? `<span>${b.modCount} mod${b.modCount !== 1 ? 's' : ''}</span>` : ''}
            ${b.appVersion ? `<span>v${esc(b.appVersion)}</span>` : ''}
            <span class="dim">${esc(b.filename)}</span>
          </div>
        </div>
        <div class="backup-actions">
          <button class="btn btn-sm btn-warning" data-action="restore-backup" data-filename="${esc(b.filename)}">Restore</button>
          <button class="btn btn-sm btn-danger" data-action="delete-backup" data-filename="${esc(b.filename)}">Delete</button>
        </div>
      </div>`;
      })
      .join('');
  } catch (err) {
    el.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

// --- Schedule picker logic ---
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Populate hour dropdown with 12-hour labels
(function initHourSelect() {
  const sel = $('sched-hour');
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = h;
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const ampm = h < 12 ? 'AM' : 'PM';
    opt.textContent = `${h12} ${ampm}`;
    sel.appendChild(opt);
  }
})();

// Update picker visibility based on frequency
function updatePickerVisibility() {
  const freq = $('sched-frequency').value;
  const showWeekday = freq === 'weekly';
  const showTime = freq !== 'custom';
  $('sched-on-label').classList.toggle('hidden', !showWeekday);
  $('sched-weekday').classList.toggle('hidden', !showWeekday);
  $('sched-at-label').classList.toggle('hidden', !showTime);
  $('sched-hour').classList.toggle('hidden', !showTime);
  $('sched-minute').classList.toggle('hidden', !showTime);
  // Hide the ":" label between hour and minute
  const colonLabel = $('sched-hour').nextElementSibling;
  if (colonLabel) colonLabel.classList.toggle('hidden', !showTime);

  // Auto-open cron details in custom mode
  if (freq === 'custom') {
    $('sched-cron-details').open = true;
  }
}

// Picker → cron expression
function pickerToCron() {
  const freq = $('sched-frequency').value;
  if (freq === 'custom') return; // don't overwrite manual cron
  const min = $('sched-minute').value;
  const hr = $('sched-hour').value;
  const day = $('sched-weekday').value;
  let expr;
  switch (freq) {
    case 'daily':
      expr = `${min} ${hr} * * *`;
      break;
    case 'weekly':
      expr = `${min} ${hr} * * ${day}`;
      break;
    case 'twice-daily':
      expr = `${min} ${hr},${(+hr + 12) % 24} * * *`;
      break;
    case 'every-6h':
      expr = `${min} */6 * * *`;
      break;
    default:
      expr = `${min} ${hr} * * *`;
  }
  $('backup-schedule-form').elements.backupSchedule.value = expr;
  updateSummary();
}

// Cron expression → picker (best effort)
function cronToPicker(expr) {
  const parts = (expr || '0 3 * * *').trim().split(/\s+/);
  if (parts.length < 5) return;
  const [min, hr, dom, mon, dow] = parts;

  // Try to match a known pattern
  if (dom === '*' && mon === '*' && dow === '*' && !hr.includes(',') && !hr.includes('/')) {
    $('sched-frequency').value = 'daily';
    $('sched-hour').value = parseInt(hr) || 0;
    $('sched-minute').value = nearestQuarter(parseInt(min) || 0);
  } else if (dom === '*' && mon === '*' && /^\d$/.test(dow) && !hr.includes(',')) {
    $('sched-frequency').value = 'weekly';
    $('sched-weekday').value = dow;
    $('sched-hour').value = parseInt(hr) || 0;
    $('sched-minute').value = nearestQuarter(parseInt(min) || 0);
  } else if (dom === '*' && mon === '*' && dow === '*' && hr.includes(',') && hr.split(',').length === 2) {
    const hours = hr.split(',').map(Number);
    if (Math.abs(hours[1] - hours[0]) === 12 || Math.abs(hours[0] - hours[1]) === 12) {
      $('sched-frequency').value = 'twice-daily';
      $('sched-hour').value = Math.min(...hours);
      $('sched-minute').value = nearestQuarter(parseInt(min) || 0);
    } else {
      $('sched-frequency').value = 'custom';
    }
  } else if (hr === '*/6' && dom === '*' && mon === '*' && dow === '*') {
    $('sched-frequency').value = 'every-6h';
    $('sched-minute').value = nearestQuarter(parseInt(min) || 0);
    $('sched-hour').value = 0;
  } else {
    $('sched-frequency').value = 'custom';
  }
  updatePickerVisibility();
  updateSummary();
}

function nearestQuarter(min) {
  const quarters = [0, 15, 30, 45];
  return quarters.reduce((a, b) => (Math.abs(b - min) < Math.abs(a - min) ? b : a));
}

// Human-readable summary
function updateSummary() {
  const cronVal = $('backup-schedule-form').elements.backupSchedule.value || '0 3 * * *';
  const parts = cronVal.trim().split(/\s+/);
  if (parts.length < 5) {
    $('sched-summary').textContent = '';
    return;
  }
  const [min, hr, dom, mon, dow] = parts;
  let text;

  if (dom === '*' && mon === '*' && dow === '*' && !hr.includes('/') && !hr.includes(',')) {
    text = `Runs every day at ${fmtTime(+hr, +min)}`;
  } else if (dom === '*' && mon === '*' && /^\d$/.test(dow) && !hr.includes(',')) {
    text = `Runs every ${WEEKDAY_NAMES[+dow]} at ${fmtTime(+hr, +min)}`;
  } else if (hr.includes(',')) {
    const hours = hr.split(',').map(Number);
    text = `Runs daily at ${hours.map((h) => fmtTime(h, +min)).join(' and ')}`;
  } else if (hr === '*/6') {
    text = `Runs every 6 hours at :${String(min).padStart(2, '0')}`;
  } else {
    text = `Custom schedule: ${cronVal}`;
  }
  $('sched-summary').textContent = text;
}

function fmtTime(h, m) {
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Wire up picker change events
$('sched-frequency').addEventListener('change', () => {
  updatePickerVisibility();
  pickerToCron();
});
$('sched-hour').addEventListener('change', pickerToCron);
$('sched-minute').addEventListener('change', pickerToCron);
$('sched-weekday').addEventListener('change', pickerToCron);

// Cron field manual edits → update picker
$('backup-schedule-form').elements.backupSchedule.addEventListener('input', (e) => {
  cronToPicker(e.target.value);
});

async function loadBackupSchedule() {
  try {
    const sched = await GET('/backups/schedule');
    const form = $('backup-schedule-form');
    form.elements.backupEnabled.checked = !!sched.enabled;
    form.elements.backupSchedule.value = sched.schedule || '0 3 * * *';
    form.elements.maxBackups.value = sched.maxBackups || '';
    form.elements.backupPath.value = sched.backupPath || '';
    cronToPicker(sched.schedule);
  } catch (err) {
    flash('backup-schedule-msg', err.message, true);
  }
}

$('backup-schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = {
    backupEnabled: form.elements.backupEnabled.checked,
    backupSchedule: form.elements.backupSchedule.value || '0 3 * * *',
    maxBackups: Number(form.elements.maxBackups.value) || 0,
    backupPath: form.elements.backupPath.value,
  };
  try {
    await POST('/config', data);
    flash('backup-schedule-msg', 'Backup schedule saved!');
  } catch (err) {
    flash('backup-schedule-msg', err.message, true);
  }
});

// --- Directory browser ---
let dirBrowserCallback = null;
let dirBrowserCurrent = '';

function renderCrumbs(crumbs) {
  const nav = $('dir-browser-crumbs');
  nav.innerHTML = '';
  // On Windows with no path selected yet (drive list), show a root label
  if (!crumbs.length) {
    const span = document.createElement('span');
    span.className = 'dir-crumb-current';
    span.textContent = 'My Computer';
    nav.appendChild(span);
    return;
  }
  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'dir-crumb-sep';
      sep.textContent = ' / ';
      nav.appendChild(sep);
    }
    const el = document.createElement('span');
    if (i === crumbs.length - 1) {
      el.className = 'dir-crumb dir-crumb-current';
      el.textContent = crumb.name;
    } else {
      el.className = 'dir-crumb';
      el.textContent = crumb.name;
      el.addEventListener('click', () => dirBrowserNavigate(crumb.path));
    }
    nav.appendChild(el);
  });
}

async function dirBrowserNavigate(dirPath) {
  const list = $('dir-browser-list');
  list.innerHTML = '<p class="dim p-md">Loading...</p>';
  try {
    const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    const result = await GET(`/browse-dirs${qs}`);
    dirBrowserCurrent = result.current || '';
    renderCrumbs(result.crumbs || []);

    list.innerHTML = result.dirs
      .map(
        (d) =>
          `<div class="dir-entry" data-path="${esc(d.path)}"><span class="dir-entry-icon">&#128193;</span> ${esc(d.name)}</div>`,
      )
      .join('');
    for (const entry of list.querySelectorAll('.dir-entry')) {
      entry.addEventListener('click', () => dirBrowserNavigate(entry.dataset.path));
    }
  } catch (err) {
    list.innerHTML = `<p class="error-msg p-md">${esc(err.message)}</p>`;
  }
}

function openDirBrowser(startPath, callback) {
  dirBrowserCallback = callback;
  show('dir-browser-modal');
  dirBrowserNavigate(startPath || '');
}

function closeDirBrowser() {
  hide('dir-browser-modal');
}

$('dir-browser-select').addEventListener('click', () => {
  if (dirBrowserCallback && dirBrowserCurrent) {
    dirBrowserCallback(dirBrowserCurrent);
  }
  closeDirBrowser();
});

$('dir-browser-new-folder').addEventListener('click', () => {
  const name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  const sep = dirBrowserCurrent.includes('\\') ? '\\' : '/';
  const newPath = dirBrowserCurrent + sep + name.trim();
  POST('/mkdir', { path: newPath })
    .then(() => dirBrowserNavigate(newPath))
    .catch((err) => alert('Failed to create folder: ' + err.message));
});

$('dir-browser-cancel').addEventListener('click', closeDirBrowser);
$('dir-browser-close').addEventListener('click', closeDirBrowser);

$('btn-browse-backup-path').addEventListener('click', () => {
  const current = $('backup-schedule-form').elements.backupPath.value;
  openDirBrowser(current, (selected) => {
    $('backup-schedule-form').elements.backupPath.value = selected;
  });
});

$('btn-browse-server-path').addEventListener('click', () => {
  const current = $('app-config-form').elements.serverPath.value;
  openDirBrowser(current, (selected) => {
    $('app-config-form').elements.serverPath.value = selected;
  });
});

$('btn-create-backup').addEventListener('click', async () => {
  const btn = $('btn-create-backup');
  const note = $('backup-note').value.trim();
  btn.disabled = true;
  btn.textContent = 'Creating backup...';
  flash('backup-create-msg', '');
  try {
    const result = await POST('/backups', { note });
    flash('backup-create-msg', `Backup created: ${result.filename} (${formatSize(result.size)})`);
    $('backup-note').value = '';
    loadBackups();
  } catch (err) {
    flash('backup-create-msg', err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Backup Now';
  }
});

$('btn-refresh-backups').addEventListener('click', () => {
  loadBackups();
  loadBackupSchedule();
});

// --- Restore modal ---
let restoreFilename = null;

async function openRestoreModal(filename) {
  restoreFilename = filename;
  const details = $('restore-modal-details');
  details.innerHTML = `<p>Backup: <strong>${esc(filename)}</strong></p><p class="dim">Validating archive...</p>`;
  $('restore-msg').textContent = '';
  $('btn-confirm-restore').disabled = true;
  show('restore-modal');

  try {
    const result = await POST('/backups/validate', { filename });
    let html = `<p>Backup: <strong>${esc(filename)}</strong></p>`;

    if (result.manifest) {
      const m = result.manifest;
      const date = m.createdAt ? new Date(m.createdAt).toLocaleString() : 'Unknown';
      html += '<table class="restore-manifest">';
      html += `<tr><td>Created</td><td>${esc(date)}</td></tr>`;
      if (m.minecraftVersion) html += `<tr><td>Minecraft</td><td>${esc(m.minecraftVersion)}</td></tr>`;
      if (m.modCount != null) html += `<tr><td>Mods</td><td>${m.modCount}</td></tr>`;
      if (m.appVersion) html += `<tr><td>App version</td><td>v${esc(m.appVersion)}</td></tr>`;
      if (m.archiveSize) html += `<tr><td>Archive size</td><td>${formatSize(m.archiveSize)}</td></tr>`;
      html += `<tr><td>Database</td><td>${m.includesDatabase ? 'Included' : 'Not included'}</td></tr>`;
      html += `<tr><td>Quiesced</td><td>${m.quiesced ? 'Yes' : 'No'}</td></tr>`;
      html += '</table>';
    }

    if (result.valid) {
      html += '<p class="restore-integrity restore-ok">Archive integrity verified</p>';
      $('btn-confirm-restore').disabled = false;
    } else {
      html += `<p class="restore-integrity restore-fail">Validation failed: ${esc(result.errors.join('; '))}</p>`;
    }
    if (result.warnings.length > 0) {
      html += `<p class="restore-integrity restore-warn">${esc(result.warnings.join('; '))}</p>`;
      // Allow restore even with warnings (e.g. old backups without hash)
      $('btn-confirm-restore').disabled = false;
    }

    details.innerHTML = html;
  } catch (err) {
    details.innerHTML = `<p>Backup: <strong>${esc(filename)}</strong></p><p class="restore-integrity restore-warn">Could not validate: ${esc(err.message)}</p>`;
    $('btn-confirm-restore').disabled = false;
  }
}

$('restore-modal-close').addEventListener('click', () => hide('restore-modal'));
$('btn-cancel-restore').addEventListener('click', () => hide('restore-modal'));

$('btn-confirm-restore').addEventListener('click', async () => {
  if (!restoreFilename) return;
  const btn = $('btn-confirm-restore');
  btn.disabled = true;
  btn.textContent = 'Restoring...';
  try {
    await POST('/backups/restore', { filename: restoreFilename });
    flash('restore-msg', 'Restore complete! Restart the manager and Minecraft server to apply all changes.');
    loadBackups();
  } catch (err) {
    flash('restore-msg', err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore This Backup';
  }
});

async function deleteBackup(filename) {
  if (!confirm(`Delete backup ${filename}? This cannot be undone.`)) return;
  try {
    await DEL(`/backups/${encodeURIComponent(filename)}`);
    loadBackups();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

// ============================================================
// Modpack Export / Import
// ============================================================

$('btn-export-modpack').addEventListener('click', async () => {
  const btn = $('btn-export-modpack');
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    const data = await GET('/modpack/export');
    const blob = new Blob([JSON.stringify(data.modpack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `modpack-${(data.modpack.minecraftVersion || 'mc').replace(/[^a-zA-Z0-9.-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const msg = `Exported ${data.modpack.modCount} mods.`;
    const extras = [];
    if (data.skipped.clientOnly) extras.push(`${data.skipped.clientOnly} client-only skipped`);
    if (data.skipped.unidentified) extras.push(`${data.skipped.unidentified} unidentified skipped`);
    alert(extras.length ? `${msg} (${extras.join(', ')})` : msg);
  } catch (err) {
    alert('Export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export Modpack';
  }
});

$('btn-import-modpack').addEventListener('click', () => {
  $('modpack-file-input').value = '';
  $('modpack-file-input').click();
});

$('modpack-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.name.endsWith('.mrpack')) {
      await analyzeMrpack(file);
    } else {
      const text = await file.text();
      const modpack = JSON.parse(text);
      if (!modpack.mods || !Array.isArray(modpack.mods)) {
        throw new Error('Invalid modpack file: missing "mods" array');
      }
      await analyzeModpack(modpack);
    }
  } catch (err) {
    alert('Failed to read modpack: ' + err.message);
  }
});

async function analyzeModpack(modpack) {
  show('modpack-modal');
  $('modpack-modal-title').textContent = `Import: ${esc(modpack.name || 'Modpack')}`;
  $('modpack-modal-body').innerHTML =
    `<p class="dim">Analyzing ${modpack.mods.length} mods against installed mods...</p>`;

  try {
    const analysis = await POST('/modpack/analyze', { modpack });
    renderModpackAnalysis(modpack, analysis);
  } catch (err) {
    $('modpack-modal-body').innerHTML = `<p class="error-msg">Analysis failed: ${esc(err.message)}</p>`;
  }
}

function renderModpackAnalysis(modpack, analysis) {
  const { skip, conflict, install, clientOnly } = analysis;
  const totalActions = install.length + conflict.length;

  let html = `<div class="modpack-summary">
    <p><strong>${esc(modpack.name || 'Modpack')}</strong> — MC ${esc(modpack.minecraftVersion || '?')} / ${esc(modpack.loader || '?')}</p>
    <div class="modpack-stats">
      ${install.length ? `<span class="modpack-stat modpack-stat-new">${install.length} new</span>` : ''}
      ${conflict.length ? `<span class="modpack-stat modpack-stat-conflict">${conflict.length} version conflicts</span>` : ''}
      ${skip.length ? `<span class="modpack-stat modpack-stat-skip">${skip.length} already installed</span>` : ''}
      ${clientOnly.length ? `<span class="modpack-stat modpack-stat-client">${clientOnly.length} client-only (ignored)</span>` : ''}
    </div>
  </div>`;

  // Conflicts section with checkboxes
  if (conflict.length > 0) {
    html += `<div class="modpack-section">
      <h4>Version Conflicts</h4>
      <p class="dim small">These mods are already installed but at a different version. Check the ones you want to replace.</p>
      <label class="toggle-label modpack-select-all mb-sm">
        <input type="checkbox" id="modpack-conflict-all" />
        <span>Select all conflicts</span>
      </label>
      ${conflict
        .map(
          (mod, i) => `<div class="modpack-conflict-row">
        <label class="toggle-label">
          <input type="checkbox" class="modpack-conflict-cb" data-idx="${i}" />
          <span><strong>${esc(mod.projectTitle)}</strong></span>
        </label>
        <span class="dim small">Installed: v${esc(mod.installedVersion || '?')} → Pack: v${esc(mod.versionNumber || '?')}</span>
      </div>`,
        )
        .join('')}
    </div>`;
  }

  // New mods to install
  if (install.length > 0) {
    html += `<div class="modpack-section">
      <h4>New Mods to Install (${install.length})</h4>
      <div class="modpack-mod-list">
        ${install.map((mod) => `<span class="modpack-mod-chip">${esc(mod.projectTitle)} <span class="dim">v${esc(mod.versionNumber || '?')}</span></span>`).join('')}
      </div>
    </div>`;
  }

  // Skipped (already installed)
  if (skip.length > 0) {
    html += `<div class="modpack-section">
      <h4>Already Installed (${skip.length})</h4>
      <div class="modpack-mod-list">
        ${skip.map((mod) => `<span class="modpack-mod-chip modpack-chip-skip">${esc(mod.projectTitle)} <span class="dim">v${esc(mod.versionNumber || '?')}</span></span>`).join('')}
      </div>
    </div>`;
  }

  // Client-only (ignored)
  if (clientOnly.length > 0) {
    html += `<div class="modpack-section">
      <h4>Client-Only — Ignored (${clientOnly.length})</h4>
      <div class="modpack-mod-list">
        ${clientOnly.map((mod) => `<span class="modpack-mod-chip modpack-chip-client">${esc(mod.projectTitle)}</span>`).join('')}
      </div>
    </div>`;
  }

  // Action buttons
  if (totalActions > 0) {
    html += `<div class="btn-row mt-lg">
      <button class="btn btn-primary" id="btn-modpack-install">Install Selected Mods</button>
      <button class="btn btn-ghost" id="btn-modpack-cancel">Cancel</button>
    </div>
    <p id="modpack-install-msg" class="control-msg"></p>`;
  } else {
    html += `<div class="btn-row mt-lg">
      <p class="dim">Nothing to install — all mods are already up to date.</p>
      <button class="btn btn-ghost" id="btn-modpack-cancel">Close</button>
    </div>`;
  }

  $('modpack-modal-body').innerHTML = html;

  // Wire up "select all conflicts" checkbox
  const selectAllCb = $('modpack-conflict-all');
  if (selectAllCb) {
    selectAllCb.addEventListener('change', () => {
      document.querySelectorAll('.modpack-conflict-cb').forEach((cb) => {
        cb.checked = selectAllCb.checked;
      });
    });
  }

  // Wire up cancel
  const cancelBtn = $('btn-modpack-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => hide('modpack-modal'));

  // Wire up install
  const installBtn = $('btn-modpack-install');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      // Gather selected conflict mods
      const selectedConflicts = [];
      document.querySelectorAll('.modpack-conflict-cb:checked').forEach((cb) => {
        const mod = conflict[parseInt(cb.dataset.idx)];
        selectedConflicts.push({ ...mod, replaceFilename: mod.installedFilename });
      });

      const modsToInstall = [...install, ...selectedConflicts];
      if (modsToInstall.length === 0) {
        flash('modpack-install-msg', 'No mods selected to install.', true);
        return;
      }
      executeModpackImport(modsToInstall, analysis);
    });
  }
}

async function executeModpackImport(modsToInstall, analysis) {
  const btn = $('btn-modpack-install');
  if (btn) {
    btn.disabled = true;
    btn.textContent = `Installing ${modsToInstall.length} mods...`;
  }

  try {
    const report = await POST('/modpack/import', { mods: modsToInstall });
    renderModpackReport(report, analysis);
    await loadMods(); // refresh the mods list
  } catch (err) {
    flash('modpack-install-msg', 'Import failed: ' + err.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install Selected Mods';
    }
  }
}

function renderModpackReport(report, analysis) {
  let html = '<h4>Import Complete</h4>';

  if (report.installed.length > 0) {
    html += `<div class="modpack-section">
      <p class="modpack-stat modpack-stat-new">${report.installed.length} mods installed successfully</p>
      <div class="modpack-mod-list">
        ${report.installed.map((m) => `<span class="modpack-mod-chip">${esc(m.title)} <span class="dim">v${esc(m.versionNumber || '?')}${m.size ? ` — ${formatSize(m.size)}` : ''}</span></span>`).join('')}
      </div>
    </div>`;
  }

  if (report.failed.length > 0) {
    html += `<div class="modpack-section">
      <p class="modpack-stat modpack-stat-conflict">${report.failed.length} mods failed</p>
      <div class="modpack-mod-list">
        ${report.failed.map((m) => `<span class="modpack-mod-chip modpack-chip-fail">${esc(m.title)} <span class="dim">— ${esc(m.error)}</span></span>`).join('')}
      </div>
    </div>`;
  }

  if (analysis.skip.length > 0) {
    html += `<div class="modpack-section">
      <p class="dim">${analysis.skip.length} mods were already installed at the correct version</p>
    </div>`;
  }
  if (analysis.clientOnly.length > 0) {
    html += `<div class="modpack-section">
      <p class="dim">${analysis.clientOnly.length} client-only mods were ignored</p>
    </div>`;
  }

  html += `<div class="btn-row mt-lg">
    <button class="btn btn-ghost" id="btn-modpack-report-close">Close</button>
  </div>`;

  $('modpack-modal-title').textContent = 'Import Report';
  $('modpack-modal-body').innerHTML = html;
  $('btn-modpack-report-close').addEventListener('click', () => hide('modpack-modal'));
}

// ============================================================
// .mrpack import/export
// ============================================================

let activeMrpackJobId = null;

function handleMrpackProgress(msg) {
  if (msg.jobId !== activeMrpackJobId) return;
  const fill = document.getElementById('mrpack-progress-fill');
  const text = document.getElementById('mrpack-progress-text');
  if (fill) fill.style.width = `${Math.round((msg.current / msg.total) * 100)}%`;
  if (text) text.textContent = `Downloading ${msg.filename} (${msg.current}/${msg.total})`;
}

function handleMrpackComplete(msg) {
  if (msg.jobId !== activeMrpackJobId) return;
  activeMrpackJobId = null;
  if (msg.error) {
    $('modpack-modal-body').innerHTML = `<p class="error-msg">Import failed: ${esc(msg.error)}</p>`;
    return;
  }
  renderMrpackReport(msg.report);
  loadMods();
}

async function analyzeMrpack(file) {
  show('modpack-modal');
  $('modpack-modal-title').textContent = 'Import .mrpack';
  $('modpack-modal-body').innerHTML = '<p class="dim">Uploading and analyzing .mrpack file...</p>';

  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/modpack/mrpack/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken },
      body: buf,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || err.details?.join(', ') || 'Analysis failed');
    }
    const data = await res.json();
    renderMrpackAnalysis(data);
  } catch (err) {
    $('modpack-modal-body').innerHTML = `<p class="error-msg">Analysis failed: ${esc(err.message)}</p>`;
  }
}

function renderMrpackAnalysis(data) {
  const c = data.classification;
  const serverCount = c.server.length;
  const bothCount = c.both.length;
  const clientCount = c.client.length;
  const unknownCount = c.unknown.length;

  let html = `<div class="modpack-summary">
    <p><strong>${esc(data.name)}</strong></p>
    <p class="dim small">MC ${esc(data.minecraftVersion || '?')} / ${esc(data.loader || '?')} ${esc(data.loaderVersion || '')}</p>
    <div class="modpack-stats">
      ${serverCount ? `<span class="modpack-stat modpack-stat-new">${serverCount} server</span>` : ''}
      ${bothCount ? `<span class="modpack-stat modpack-stat-new">${bothCount} both</span>` : ''}
      ${unknownCount ? `<span class="modpack-stat modpack-stat-conflict">${unknownCount} unknown</span>` : ''}
      ${clientCount ? `<span class="modpack-stat modpack-stat-client">${clientCount} client-only</span>` : ''}
    </div>
  </div>`;

  // Server + Both mods (will be installed)
  const installMods = [...c.server, ...c.both];
  if (installMods.length > 0) {
    html += `<div class="modpack-section">
      <h4>Will Install on Server (${installMods.length})</h4>
      <p class="dim small">Server and shared mods — these will be downloaded and installed.</p>
      <div class="modpack-mod-list">
        ${installMods.map((m) => `<span class="modpack-mod-chip">${esc(pathBasename(m.path))} <span class="dim">${m.classification}</span></span>`).join('')}
      </div>
    </div>`;
  }

  // Unknown mods (need user decision)
  if (unknownCount > 0) {
    html += `<div class="modpack-section">
      <h4>Unknown Environment (${unknownCount})</h4>
      <p class="dim small">These mods have no environment metadata. Choose how to handle them.</p>
      <label class="toggle-label mb-sm">
        <input type="radio" name="mrpack-unknown" value="install" />
        <span>Install all unknown mods (permissive)</span>
      </label>
      <label class="toggle-label mb-sm">
        <input type="radio" name="mrpack-unknown" value="skip" checked />
        <span>Skip all unknown mods (conservative)</span>
      </label>
      <div class="modpack-mod-list">
        ${c.unknown.map((m) => `<span class="modpack-mod-chip modpack-chip-skip">${esc(pathBasename(m.path))}</span>`).join('')}
      </div>
    </div>`;
  }

  // Client-only (skipped)
  if (clientCount > 0) {
    html += `<div class="modpack-section">
      <h4>Client-Only — Skipped (${clientCount})</h4>
      <p class="dim small">These mods are not needed on the server and will not be installed.</p>
      <div class="modpack-mod-list">
        ${c.client.map((m) => `<span class="modpack-mod-chip modpack-chip-client">${esc(pathBasename(m.path))}</span>`).join('')}
      </div>
    </div>`;
  }

  // Overrides
  if (data.overrideCount > 0 || data.serverOverrideCount > 0) {
    const total = data.overrideCount + data.serverOverrideCount;
    html += `<div class="modpack-section">
      <label class="toggle-label">
        <input type="checkbox" id="mrpack-include-overrides" checked />
        <span>Install ${total} override file(s) (configs, datapacks, etc.)</span>
      </label>
    </div>`;
  }

  // Action buttons
  if (installMods.length > 0 || unknownCount > 0) {
    html += `<div class="btn-row mt-lg">
      <button class="btn btn-primary" id="btn-mrpack-install">Install to Server</button>
      <button class="btn btn-ghost" id="btn-mrpack-cancel">Cancel</button>
    </div>
    <p id="mrpack-install-msg" class="control-msg"></p>`;
  } else {
    html += `<div class="btn-row mt-lg">
      <p class="dim">No server-compatible mods found in this pack.</p>
      <button class="btn btn-ghost" id="btn-mrpack-cancel">Close</button>
    </div>`;
  }

  $('modpack-modal-title').textContent = `Import: ${esc(data.name)}`;
  $('modpack-modal-body').innerHTML = html;

  // Wire cancel
  const cancelBtn = $('btn-mrpack-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => hide('modpack-modal'));

  // Wire install
  const installBtn = $('btn-mrpack-install');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installBtn.textContent = 'Installing...';

      const unknownRadio = document.querySelector('input[name="mrpack-unknown"]:checked');
      const unknownAction = unknownRadio?.value || 'skip';
      const overridesCb = document.getElementById('mrpack-include-overrides');
      const includeOverrides = overridesCb?.checked || false;

      try {
        const result = await POST('/modpack/mrpack/import', {
          token: data.token,
          unknownAction,
          includeOverrides,
        });

        // Demo mode returns report inline
        if (result.report) {
          renderMrpackReport(result.report);
          await loadMods();
          return;
        }

        // Real mode: show progress bar and wait for WebSocket updates
        activeMrpackJobId = result.jobId;
        $('modpack-modal-body').innerHTML = `
          <div style="padding: 1rem 0;">
            <div class="progress-bar" style="height: 10px; margin-bottom: 0.75rem;">
              <div class="progress-fill" id="mrpack-progress-fill" style="width: 0%; transition: width 0.3s;"></div>
            </div>
            <p id="mrpack-progress-text" class="dim">Starting import...</p>
          </div>`;
      } catch (err) {
        flash('mrpack-install-msg', 'Import failed: ' + err.message, true);
        installBtn.disabled = false;
        installBtn.textContent = 'Install to Server';
      }
    });
  }
}

function renderMrpackReport(report) {
  let html = '<h4>Import Complete</h4>';

  if (report.installed.length > 0) {
    html += `<div class="modpack-section">
      <p class="modpack-stat modpack-stat-new">${report.installed.length} mod(s) installed</p>
      <div class="modpack-mod-list">
        ${report.installed.map((m) => `<span class="modpack-mod-chip">${esc(m.filename)} <span class="dim">${m.classification || ''} — ${formatSize(m.size || 0)}</span></span>`).join('')}
      </div>
    </div>`;
  }

  if (report.failed.length > 0) {
    html += `<div class="modpack-section">
      <p class="modpack-stat modpack-stat-conflict">${report.failed.length} mod(s) failed</p>
      <div class="modpack-mod-list">
        ${report.failed.map((m) => `<span class="modpack-mod-chip modpack-chip-fail">${esc(m.path)} <span class="dim">— ${esc(m.error)}</span></span>`).join('')}
      </div>
    </div>`;
  }

  if (report.skipped.length > 0) {
    html += `<div class="modpack-section">
      <p class="dim">${report.skipped.length} mod(s) skipped</p>
      <div class="modpack-mod-list">
        ${report.skipped.map((m) => `<span class="modpack-mod-chip modpack-chip-skip">${esc(m.path)} <span class="dim">— ${esc(m.reason)}</span></span>`).join('')}
      </div>
    </div>`;
  }

  if (report.overridesApplied > 0) {
    html += `<p class="dim">${report.overridesApplied} override file(s) applied.</p>`;
  }

  if (report.warnings?.length > 0) {
    html += `<div class="modpack-section">
      <h4>Warnings</h4>
      ${report.warnings.map((w) => `<p class="dim small">${esc(w)}</p>`).join('')}
    </div>`;
  }

  html += `<div class="btn-row mt-lg">
    <button class="btn btn-ghost" id="btn-mrpack-report-close">Close</button>
  </div>`;

  $('modpack-modal-title').textContent = 'Import Report';
  $('modpack-modal-body').innerHTML = html;
  $('btn-mrpack-report-close').addEventListener('click', () => hide('modpack-modal'));
}

function pathBasename(p) {
  return p.split('/').pop() || p;
}

// Export .mrpack
$('btn-export-mrpack').addEventListener('click', async () => {
  // Show export options modal
  show('modpack-modal');
  $('modpack-modal-title').textContent = 'Export .mrpack';
  $('modpack-modal-body').innerHTML = `
    <div class="modpack-summary">
      <p>Choose which mod categories to include in the exported .mrpack file.</p>
    </div>
    <div class="modpack-section">
      <h4>Include Categories</h4>
      <label class="toggle-label mb-sm"><input type="checkbox" id="mrpack-exp-server" checked /><span>Server-only mods</span></label>
      <label class="toggle-label mb-sm"><input type="checkbox" id="mrpack-exp-both" checked /><span>Shared mods (client + server)</span></label>
      <label class="toggle-label mb-sm"><input type="checkbox" id="mrpack-exp-client" /><span>Client-only mods</span></label>
      <label class="toggle-label mb-sm"><input type="checkbox" id="mrpack-exp-unknown" /><span>Unknown environment mods</span></label>
    </div>
    <div class="modpack-section">
      <h4>Options</h4>
      <label class="toggle-label mb-sm"><input type="checkbox" id="mrpack-exp-overrides" /><span>Include server.properties as override</span></label>
    </div>
    <p id="mrpack-export-warn" class="dim small"></p>
    <div class="btn-row mt-lg">
      <button class="btn btn-primary" id="btn-mrpack-export-go">Export .mrpack</button>
      <button class="btn btn-ghost" id="btn-mrpack-export-cancel">Cancel</button>
    </div>`;

  $('btn-mrpack-export-cancel').addEventListener('click', () => hide('modpack-modal'));

  // Update warning text when client/unknown toggled
  const updateWarn = () => {
    const warns = [];
    if ($('mrpack-exp-client').checked) warns.push('Client-only mods are included');
    if ($('mrpack-exp-unknown').checked) warns.push('Unknown-environment mods are included');
    $('mrpack-export-warn').textContent =
      warns.length > 0 ? warns.join('. ') + '. This export may not be suitable for all environments.' : '';
  };
  $('mrpack-exp-client').addEventListener('change', updateWarn);
  $('mrpack-exp-unknown').addEventListener('change', updateWarn);

  $('btn-mrpack-export-go').addEventListener('click', async () => {
    const cats = [];
    if ($('mrpack-exp-server').checked) cats.push('server');
    if ($('mrpack-exp-both').checked) cats.push('both');
    if ($('mrpack-exp-client').checked) cats.push('client');
    if ($('mrpack-exp-unknown').checked) cats.push('unknown');

    if (cats.length === 0) {
      alert('Select at least one category.');
      return;
    }

    const overrides = $('mrpack-exp-overrides').checked;
    const btn = $('btn-mrpack-export-go');
    btn.disabled = true;
    btn.textContent = 'Exporting...';

    try {
      const params = new URLSearchParams({ include: cats.join(','), overrides: String(overrides) });
      const res = await fetch(`/api/modpack/mrpack/export?${params}`, {
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename="(.+?)"/);
      a.download = filenameMatch?.[1] || 'modpack.mrpack';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      hide('modpack-modal');
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Export .mrpack';
    }
  });
});

$('modpack-modal-close').addEventListener('click', () => hide('modpack-modal'));
$('modpack-modal').addEventListener('click', (e) => {
  if (e.target === $('modpack-modal')) hide('modpack-modal');
});

// ============================================================
// Command Reference (Help Modal)
// ============================================================

const CMD_HELP_DATA = [
  {
    category: 'Getting Started',
    entries: [
      {
        cmd: 'help',
        syntax: 'help [command]',
        desc: 'Shows a list of all available commands, or details about a specific command.',
        detail:
          'This is your best friend when you are not sure what a command does. Try <code>help gamemode</code> to see how to use that command.',
        tip: 'You can type any command name after "help" to learn about it.',
      },
      {
        cmd: 'list',
        syntax: 'list',
        desc: 'Shows all players currently online.',
        detail: 'Displays the names of everyone connected to the server right now.',
      },
      {
        cmd: 'say',
        syntax: 'say <message>',
        desc: 'Broadcasts a message to all players on the server.',
        detail: 'The message appears in chat as <code>[Server] your message</code>. Great for announcements.',
        example: 'say Server restarting in 5 minutes!',
      },
      {
        cmd: 'tell / msg',
        syntax: 'tell <player> <message>',
        desc: 'Sends a private message to a specific player.',
        example: 'tell Steve Hey, come check out the new base!',
      },
    ],
  },
  {
    category: 'World & Saving',
    entries: [
      {
        cmd: 'save-all',
        syntax: 'save-all',
        desc: 'Saves the entire world to disk immediately.',
        detail:
          'Forces the server to write all world data to files. Use this before stopping the server or making a backup.',
        tip: 'The server auto-saves periodically, but running this ensures nothing is lost.',
      },
      {
        cmd: 'save-off',
        syntax: 'save-off',
        desc: 'Disables automatic world saving.',
        detail: 'Useful during backups to prevent file corruption. <strong>Remember to turn it back on!</strong>',
        tip: 'Always run save-on after your backup is done.',
      },
      {
        cmd: 'save-on',
        syntax: 'save-on',
        desc: 'Re-enables automatic world saving.',
        detail: 'Turns auto-save back on after you disabled it.',
      },
      {
        cmd: 'seed',
        syntax: 'seed',
        desc: 'Shows the world seed number.',
        detail:
          'The seed is the number that generated your world. You can use it to create an identical world elsewhere.',
      },
      {
        cmd: 'locate',
        syntax: 'locate structure <structure>',
        desc: 'Finds the nearest structure (village, fortress, etc.).',
        example: 'locate structure minecraft:village_plains',
        tip: 'Common structures: village_plains, fortress, monument, stronghold, mansion, bastion_remnant',
      },
    ],
  },
  {
    category: 'Time & Weather',
    entries: [
      {
        cmd: 'time set',
        syntax: 'time set <value>',
        desc: 'Sets the world time.',
        detail:
          'Use named values like <code>day</code>, <code>night</code>, <code>noon</code>, or <code>midnight</code>. You can also use exact tick values (0-24000). Day starts at 1000, sunset at 12000, night at 13000.',
        example: 'time set day',
      },
      {
        cmd: 'time add',
        syntax: 'time add <ticks>',
        desc: 'Advances the clock forward by a number of ticks.',
        detail: 'There are 24,000 ticks in one Minecraft day. Adding 6000 ticks skips about a quarter of the day.',
        example: 'time add 6000',
      },
      {
        cmd: 'weather clear',
        syntax: 'weather clear [seconds]',
        desc: 'Clears the weather (makes it sunny).',
        detail:
          'Optionally set how many seconds the clear weather lasts. Without a number, it picks a random duration.',
        example: 'weather clear 999999',
      },
      {
        cmd: 'weather rain',
        syntax: 'weather rain [seconds]',
        desc: 'Makes it rain (or snow in cold biomes).',
        example: 'weather rain',
      },
      {
        cmd: 'weather thunder',
        syntax: 'weather thunder [seconds]',
        desc: 'Starts a thunderstorm.',
        example: 'weather thunder',
      },
    ],
  },
  {
    category: 'Players & Permissions',
    entries: [
      {
        cmd: 'gamemode',
        syntax: 'gamemode <mode> <player>',
        desc: "Changes a player's game mode.",
        detail:
          "Modes: <code>survival</code> (normal gameplay), <code>creative</code> (fly + unlimited blocks), <code>adventure</code> (can't break/place blocks), <code>spectator</code> (invisible, fly through walls).",
        example: 'gamemode creative Steve',
      },
      {
        cmd: 'kick',
        syntax: 'kick <player> [reason]',
        desc: 'Disconnects a player from the server.',
        detail: 'They can rejoin unless they are banned. Good for players misbehaving.',
        example: 'kick Steve Please stop griefing',
      },
      {
        cmd: 'ban',
        syntax: 'ban <player> [reason]',
        desc: 'Permanently bans a player from the server.',
        detail: 'The player is immediately kicked and cannot rejoin. Use <code>pardon</code> to unban them.',
        example: "ban Griefer123 Destroying other players' builds",
      },
      { cmd: 'pardon', syntax: 'pardon <player>', desc: 'Unbans a previously banned player.', example: 'pardon Steve' },
      {
        cmd: 'ban-ip',
        syntax: 'ban-ip <ip>',
        desc: 'Bans an IP address from the server.',
        detail: 'Blocks all accounts from that IP. Use carefully.',
      },
      {
        cmd: 'op',
        syntax: 'op <player>',
        desc: 'Gives a player operator (admin) privileges.',
        detail: 'Operators can use all server commands. Be careful who you op!',
        tip: 'Use the Players tab for more control over op levels (1-4).',
      },
      {
        cmd: 'deop',
        syntax: 'deop <player>',
        desc: 'Removes operator privileges from a player.',
        example: 'deop Steve',
      },
      {
        cmd: 'whitelist',
        syntax: 'whitelist <add|remove|list|on|off|reload>',
        desc: 'Manages the server whitelist.',
        detail:
          'When the whitelist is on, only listed players can join. <code>whitelist add Steve</code> adds a player. <code>whitelist on</code> enables it.',
        example: 'whitelist add Steve',
      },
    ],
  },
  {
    category: 'Teleporting & Movement',
    entries: [
      {
        cmd: 'tp / teleport',
        syntax: 'tp <player> <x> <y> <z>',
        desc: 'Teleports a player to specific coordinates.',
        detail: 'Use exact numbers or <code>~</code> for relative positions. <code>~ ~ ~</code> means "right here".',
        example: 'tp Steve 100 64 -200',
        tip: 'tp Steve ~ ~50 ~ will teleport Steve 50 blocks up from their current position.',
      },
      {
        cmd: 'tp (to player)',
        syntax: 'tp <player> <target>',
        desc: 'Teleports one player to another player.',
        example: 'tp Steve Alex',
      },
      {
        cmd: 'spawnpoint',
        syntax: 'spawnpoint <player> <x> <y> <z>',
        desc: 'Sets where a player respawns after dying.',
        example: 'spawnpoint Steve 100 64 -200',
      },
      {
        cmd: 'setworldspawn',
        syntax: 'setworldspawn <x> <y> <z>',
        desc: "Sets the world's default spawn point for all new players.",
        example: 'setworldspawn 0 64 0',
      },
      {
        cmd: 'spreadplayers',
        syntax: 'spreadplayers <x> <z> <minDist> <maxRange> <player...>',
        desc: 'Randomly spreads players across an area.',
        detail: 'Useful for minigames or spreading players out at the start of a challenge.',
        example: 'spreadplayers 0 0 100 500 @a',
      },
    ],
  },
  {
    category: 'Giving Items & Effects',
    entries: [
      {
        cmd: 'give',
        syntax: 'give <player> <item> [amount]',
        desc: 'Gives items to a player.',
        detail: 'Item IDs look like <code>minecraft:diamond</code> or just <code>diamond</code>. Amount defaults to 1.',
        example: 'give Steve diamond 64',
        tip: 'Common items: diamond, iron_ingot, golden_apple, netherite_ingot, elytra, ender_pearl',
      },
      {
        cmd: 'clear',
        syntax: 'clear <player> [item] [amount]',
        desc: "Removes items from a player's inventory.",
        detail: 'Without specifying an item, clears their entire inventory!',
        example: 'clear Steve dirt',
      },
      {
        cmd: 'effect give',
        syntax: 'effect give <player> <effect> [seconds] [level]',
        desc: 'Applies a status effect to a player.',
        detail:
          'Effects include speed, strength, regeneration, invisibility, etc. Level 0 = level I, level 1 = level II.',
        example: 'effect give Steve speed 60 1',
        tip: 'Useful effects: speed, strength, regeneration, night_vision, invisibility, jump_boost, resistance, fire_resistance, slow_falling',
      },
      {
        cmd: 'effect clear',
        syntax: 'effect clear <player> [effect]',
        desc: 'Removes status effects from a player.',
        detail: 'Without specifying an effect, removes ALL effects.',
        example: 'effect clear Steve',
      },
      {
        cmd: 'enchant',
        syntax: 'enchant <player> <enchantment> [level]',
        desc: 'Enchants the item a player is holding.',
        example: 'enchant Steve sharpness 5',
        tip: 'Common enchantments: sharpness, protection, efficiency, unbreaking, fortune, looting, mending',
      },
      {
        cmd: 'xp',
        syntax: 'xp add <player> <amount> [levels|points]',
        desc: 'Gives or removes XP from a player.',
        example: 'xp add Steve 30 levels',
      },
    ],
  },
  {
    category: 'Game Rules',
    entries: [
      {
        cmd: 'difficulty',
        syntax: 'difficulty <level>',
        desc: 'Changes the server difficulty.',
        detail: 'Options: <code>peaceful</code> (no mobs), <code>easy</code>, <code>normal</code>, <code>hard</code>.',
        example: 'difficulty hard',
      },
      {
        cmd: 'gamerule keepInventory',
        syntax: 'gamerule keepInventory true/false',
        desc: 'Whether players keep items when they die.',
        detail: "When true, dying won't drop your items. Great for younger players or when building.",
        tip: 'This is one of the most popular gamerules to change.',
      },
      {
        cmd: 'gamerule doDaylightCycle',
        syntax: 'gamerule doDaylightCycle true/false',
        desc: 'Whether time passes naturally.',
        detail:
          'Set to false to freeze the sun in place. Combine with <code>time set day</code> for permanent daytime.',
      },
      {
        cmd: 'gamerule doMobSpawning',
        syntax: 'gamerule doMobSpawning true/false',
        desc: 'Whether mobs spawn naturally.',
        detail: 'Disabling this stops all natural mob spawning (both hostile and friendly). Spawners still work.',
      },
      {
        cmd: 'gamerule doWeatherCycle',
        syntax: 'gamerule doWeatherCycle true/false',
        desc: 'Whether weather changes naturally.',
        detail: 'Set to false and use <code>weather clear</code> for permanent sunshine.',
      },
      {
        cmd: 'gamerule mobGriefing',
        syntax: 'gamerule mobGriefing true/false',
        desc: 'Whether mobs can destroy blocks.',
        detail:
          "When false, creepers won't blow up blocks and endermen won't pick them up. Mobs still do damage to players.",
        tip: 'This also prevents villagers from farming, which may not be what you want.',
      },
      {
        cmd: 'gamerule pvp',
        syntax: 'gamerule pvp true/false',
        desc: 'Whether players can damage each other.',
        detail:
          'Set to false to prevent PvP combat. Note: this is actually set in server.properties, not as a gamerule. Use the server.properties editor in Settings.',
      },
      {
        cmd: 'gamerule doFireTick',
        syntax: 'gamerule doFireTick true/false',
        desc: 'Whether fire spreads and burns things.',
        detail: 'Set to false to prevent accidental fire damage to builds.',
      },
      {
        cmd: 'gamerule announceAdvancements',
        syntax: 'gamerule announceAdvancements true/false',
        desc: 'Whether advancement messages show in chat.',
        detail: 'Set to false to stop the "[Player] has made the advancement..." messages.',
      },
      {
        cmd: 'gamerule commandBlockOutput',
        syntax: 'gamerule commandBlockOutput true/false',
        desc: 'Whether command blocks show output in chat.',
        detail: 'Set to false to reduce chat spam from command blocks.',
      },
      {
        cmd: 'gamerule showDeathMessages',
        syntax: 'gamerule showDeathMessages true/false',
        desc: 'Whether death messages appear in chat.',
      },
      {
        cmd: 'gamerule naturalRegeneration',
        syntax: 'gamerule naturalRegeneration true/false',
        desc: 'Whether players regenerate health from being full.',
        detail: 'When false, players must use potions or golden apples to heal. Makes the game much harder.',
      },
      {
        cmd: 'gamerule randomTickSpeed',
        syntax: 'gamerule randomTickSpeed <number>',
        desc: 'Controls how fast crops grow and leaves decay.',
        detail: 'Default is 3. Higher = faster crop growth. Setting to 0 freezes crop growth entirely.',
        example: 'gamerule randomTickSpeed 10',
      },
    ],
  },
  {
    category: 'World Borders & Spawn',
    entries: [
      {
        cmd: 'worldborder set',
        syntax: 'worldborder set <size> [seconds]',
        desc: 'Sets the world border size.',
        detail:
          'Size is the total width/height in blocks. If you add seconds, it gradually shrinks or grows to that size.',
        example: 'worldborder set 5000',
        tip: 'Shrinking borders are great for minigames! Try: worldborder set 100 600',
      },
      {
        cmd: 'worldborder center',
        syntax: 'worldborder center <x> <z>',
        desc: 'Moves the center of the world border.',
        example: 'worldborder center 0 0',
      },
      { cmd: 'worldborder get', syntax: 'worldborder get', desc: 'Shows the current world border size.' },
    ],
  },
  {
    category: 'Performance & Advanced',
    entries: [
      {
        cmd: 'tick rate',
        syntax: 'tick rate <rate>',
        desc: 'Changes the server tick speed.',
        detail:
          'Default is 20 ticks/second. Lower = slower game. Higher = faster. <strong>Changing this can cause lag.</strong>',
        example: 'tick rate 20',
      },
      {
        cmd: 'tick freeze',
        syntax: 'tick freeze',
        desc: 'Freezes all game ticks.',
        detail:
          'The world stops: mobs freeze, items stop, nothing moves. Players can still walk around. Use <code>tick unfreeze</code> to resume.',
      },
      {
        cmd: 'forceload',
        syntax: 'forceload add <x> <z>',
        desc: 'Keeps a chunk loaded even when no players are nearby.',
        detail:
          'Useful for farms or machines that need to run 24/7. Use <code>forceload query</code> to see which chunks are forceloaded.',
        tip: 'Forceloading too many chunks can cause lag.',
      },
      {
        cmd: 'kill',
        syntax: 'kill <target>',
        desc: 'Instantly kills entities.',
        detail:
          'Use <code>@e[type=zombie]</code> to kill all zombies, or <code>@e[type=item]</code> to clean up item drops.',
        example: 'kill @e[type=zombie]',
        tip: 'Be very careful with @e (all entities) — it will kill players too! Use @e[type=!player] to exclude players.',
      },
      {
        cmd: 'fill',
        syntax: 'fill <x1> <y1> <z1> <x2> <y2> <z2> <block> [mode]',
        desc: 'Fills a region with a specific block.',
        detail:
          'Modes: <code>replace</code> (default), <code>hollow</code> (only edges), <code>outline</code> (only outer shell), <code>destroy</code> (drops items).',
        example: 'fill 0 60 0 20 64 20 stone',
      },
      {
        cmd: 'setblock',
        syntax: 'setblock <x> <y> <z> <block>',
        desc: 'Places a single block at the given coordinates.',
        example: 'setblock 0 64 0 diamond_block',
      },
      {
        cmd: 'summon',
        syntax: 'summon <entity> [x] [y] [z]',
        desc: 'Spawns an entity at the given location.',
        example: 'summon minecraft:pig ~ ~ ~',
        tip: 'Fun entities to summon: pig, cow, villager, iron_golem, ender_dragon, lightning_bolt',
      },
    ],
  },
  {
    category: 'Recipes',
    entries: [
      {
        cmd: 'recipe give',
        syntax: 'recipe give <player> <recipe|*>',
        desc: "Unlocks recipes in a player's recipe book.",
        detail:
          'Use <code>*</code> to unlock all recipes at once. Only affects the recipe book UI — players can still craft anything at a crafting table.',
        example: 'recipe give Steve *',
      },
      {
        cmd: 'recipe take',
        syntax: 'recipe take <player> <recipe|*>',
        desc: "Removes recipes from a player's recipe book.",
        detail:
          'Hides recipes from the recipe book. Use <code>*</code> to hide all. Players can still craft items manually if they know the pattern.',
        example: 'recipe take Steve minecraft:diamond_sword',
        tip: 'To truly disable crafting recipes, you need a datapack or mod like CraftTweaker.',
      },
    ],
  },
  {
    category: 'Selectors & Shortcuts',
    entries: [
      {
        cmd: '@a',
        syntax: '@a',
        desc: 'Targets ALL players on the server.',
        detail:
          'Use in place of a player name to affect everyone. Example: <code>effect give @a speed 60</code> gives everyone speed.',
        tip: 'You can filter: @a[distance=..10] = players within 10 blocks of the command source.',
      },
      {
        cmd: '@p',
        syntax: '@p',
        desc: 'Targets the NEAREST player.',
        detail: 'Useful when running commands from command blocks.',
      },
      {
        cmd: '@r',
        syntax: '@r',
        desc: 'Targets a RANDOM player.',
        detail: 'Fun for minigames! Example: <code>tp @r 0 64 0</code> teleports a random player to spawn.',
      },
      {
        cmd: '@e',
        syntax: '@e',
        desc: 'Targets ALL entities (mobs, items, everything).',
        detail:
          'Very powerful but dangerous. <code>@e</code> includes players! Use <code>@e[type=!player]</code> to exclude them.',
        tip: 'Filter by type: @e[type=zombie], @e[type=item], @e[type=!player]',
      },
      {
        cmd: '@s',
        syntax: '@s',
        desc: 'Targets the entity running the command (yourself).',
        detail: 'Rarely used from the server console, more useful in-game or from command blocks.',
      },
      {
        cmd: '~ (tilde)',
        syntax: '~ or ~5 or ~-3',
        desc: 'Relative coordinates — offset from current position.',
        detail:
          '<code>~</code> = exact current position. <code>~5</code> = 5 blocks forward. <code>~-3</code> = 3 blocks backward. Used in place of X, Y, or Z values.',
        example: 'tp Steve ~ ~10 ~ (teleport 10 blocks up)',
      },
    ],
  },
];

function renderCmdHelp(filter) {
  const body = $('cmd-help-body');
  const q = (filter || '').toLowerCase().trim();

  let html = '';
  if (!q) {
    html += `<div class="cmd-help-intro">
      <strong>Welcome!</strong> This is a reference for all the commands you can run on your Minecraft server.
      Click any command to see details, examples, and tips. Use the search box above to find what you need.
      Commands are sent through the console input below the Quick Actions area.
    </div>`;
  }

  let totalMatches = 0;

  for (const cat of CMD_HELP_DATA) {
    const matchingEntries = cat.entries.filter((e) => {
      if (!q) return true;
      const haystack =
        `${e.cmd} ${e.desc} ${e.detail || ''} ${e.syntax} ${e.example || ''} ${e.tip || ''} ${cat.category}`.toLowerCase();
      return q.split(/\s+/).every((word) => haystack.includes(word));
    });

    if (matchingEntries.length === 0) continue;
    totalMatches += matchingEntries.length;

    html += `<div class="cmd-help-category">
      <div class="cmd-help-category-title">${esc(cat.category)}</div>`;

    for (const e of matchingEntries) {
      const detailParts = [];
      detailParts.push(`<p>${e.desc}</p>`);
      if (e.detail) detailParts.push(`<p>${e.detail}</p>`);
      detailParts.push(`<p><strong>Usage:</strong> <span class="cmd-syntax">${esc(e.syntax)}</span></p>`);
      if (e.example)
        detailParts.push(
          `<p class="cmd-example"><strong>Example:</strong> <span class="cmd-syntax">${esc(e.example)}</span></p>`,
        );
      if (e.tip) detailParts.push(`<div class="cmd-tip">Tip: ${e.tip}</div>`);

      // Only show "Try it" button for commands that are directly runnable (no arguments needed)
      const isDirectCmd = !e.syntax.includes('<') && !e.syntax.includes('[') && !e.syntax.includes('|');
      const tryBtn = isDirectCmd
        ? `<button class="cmd-help-entry-run" data-try-cmd="${esc(e.cmd)}" title="Send this command to the server">Try it</button>`
        : '';

      html += `<div class="cmd-help-entry">
        <div class="cmd-help-entry-header">
          <span class="cmd-help-entry-toggle">&#9654;</span>
          <span class="cmd-help-cmd">${esc(e.cmd)}</span>
          ${tryBtn}
        </div>
        <div class="cmd-help-detail">${detailParts.join('')}</div>
      </div>`;
    }

    html += '</div>';
  }

  if (totalMatches === 0) {
    html = `<div class="cmd-help-no-results">
      <p>No commands found matching "<strong>${esc(q)}</strong>"</p>
      <p class="dim mt-sm">Try different keywords, e.g. "weather", "player", "spawn", "ban"</p>
    </div>`;
  }

  body.innerHTML = html;

  // Wire up expand/collapse
  body.querySelectorAll('.cmd-help-entry-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.cmd-help-entry-run')) return; // don't toggle when clicking Try
      header.closest('.cmd-help-entry').classList.toggle('open');
    });
  });

  // Wire up "Try it" buttons
  body.querySelectorAll('[data-try-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.tryCmd;
      btn.textContent = 'Sending...';
      try {
        const r = await POST('/server/command', { command: cmd });
        btn.textContent = 'Sent!';
        flash('quick-action-msg', `${cmd}: ${r.result || 'OK'}`);
      } catch {
        try {
          await POST('/server/stdin', { command: cmd });
          btn.textContent = 'Sent!';
          flash('quick-action-msg', `${cmd}: sent via stdin`);
        } catch (err) {
          btn.textContent = 'Failed';
          flash('quick-action-msg', err.message, true);
        }
      }
      setTimeout(() => {
        btn.textContent = 'Try it';
      }, 2000);
    });
  });

  // If searching, auto-expand all entries for convenience
  if (q) {
    body.querySelectorAll('.cmd-help-entry').forEach((e) => e.classList.add('open'));
  }
}

// Open/close command help modal
$('btn-cmd-help').addEventListener('click', () => {
  show('cmd-help-modal');
  $('cmd-help-search').value = '';
  renderCmdHelp('');
  $('cmd-help-search').focus();
});

$('cmd-help-close').addEventListener('click', () => hide('cmd-help-modal'));
$('cmd-help-modal').addEventListener('click', (e) => {
  if (e.target === $('cmd-help-modal')) hide('cmd-help-modal');
});

// Live search
$('cmd-help-search').addEventListener('input', (e) => {
  renderCmdHelp(e.target.value);
});

// --- Player Profile Modal ---

const OP_LEVEL_NAMES = { 1: 'Spawn Protection Bypass', 2: 'Game Master', 3: 'Admin', 4: 'Owner' };

async function openPlayerProfile(name) {
  if (!name) return;
  const content = $('player-profile-content');
  $('player-profile-title').textContent = name;
  content.innerHTML = '<p class="dim">Loading player profile...</p>';
  show('player-profile-modal');

  try {
    const p = await GET(`/players/profile/${encodeURIComponent(name)}`);
    renderPlayerProfile(p, content);
  } catch (err) {
    content.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

function renderPlayerProfile(p, container) {
  const avatarUrl = p.uuid ? `https://mc-heads.net/avatar/${p.uuid}/64` : `https://mc-heads.net/avatar/${p.name}/64`;

  // Badges
  const badges = [];
  if (p.online === true) badges.push('<span class="profile-badge online">Online</span>');
  else if (p.online === false) badges.push('<span class="profile-badge offline">Offline</span>');
  if (p.op) badges.push(`<span class="profile-badge op">Op Level ${p.op.level}</span>`);
  if (p.whitelisted) badges.push('<span class="profile-badge whitelisted">Whitelisted</span>');
  if (p.banned) badges.push('<span class="profile-badge banned">Banned</span>');

  let html = `
    <div class="player-profile-header">
      <img class="player-profile-avatar" src="${avatarUrl}" alt="${esc(p.name)}" onerror="this.style.display='none'">
      <div>
        <div class="player-profile-name">${esc(p.name)}</div>
        ${p.uuid ? `<div class="player-profile-uuid">${esc(p.uuid)}</div>` : ''}
      </div>
    </div>
    <div class="profile-badges">${badges.join('')}</div>`;

  // Op details
  if (p.op) {
    html += `
    <div class="profile-section">
      <h4>Operator</h4>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Level</span>
        <span class="profile-detail-value">${p.op.level} &mdash; ${OP_LEVEL_NAMES[p.op.level] || 'Unknown'}</span>
      </div>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Bypasses Player Limit</span>
        <span class="profile-detail-value">${p.op.bypassesPlayerLimit ? 'Yes' : 'No'}</span>
      </div>
    </div>`;
  }

  // Ban details
  if (p.banned) {
    html += `
    <div class="profile-section">
      <h4>Ban Info</h4>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Reason</span>
        <span class="profile-detail-value">${esc(p.banned.reason || 'No reason given')}</span>
      </div>
      ${
        p.banned.created
          ? `<div class="profile-detail-row">
        <span class="profile-detail-label">Banned On</span>
        <span class="profile-detail-value">${new Date(p.banned.created).toLocaleDateString()}</span>
      </div>`
          : ''
      }
      <div class="profile-detail-row">
        <span class="profile-detail-label">Expires</span>
        <span class="profile-detail-value">${esc(p.banned.expires || 'Never')}</span>
      </div>
    </div>`;
  }

  // Discord linking
  html += `
    <div class="profile-section">
      <h4>Discord Link</h4>`;
  if (p.discord) {
    html += `
      <div class="profile-detail-row">
        <span class="profile-detail-label">Discord ID</span>
        <span class="profile-detail-value profile-discord-id">${esc(p.discord.discordId)}</span>
      </div>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Linked By</span>
        <span class="profile-detail-value">${esc(p.discord.linkedBy)}</span>
      </div>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Linked At</span>
        <span class="profile-detail-value">${new Date(p.discord.linkedAt).toLocaleString()}</span>
      </div>`;
    if (can('panel.link_identities')) {
      html += `
      <div class="profile-detail-row" style="margin-top:0.5rem">
        <span></span>
        <button class="btn btn-sm btn-danger" data-action="unlink-discord" data-discord-id="${esc(p.discord.discordId)}" data-name="${esc(p.name)}">Unlink Discord</button>
      </div>`;
    }
  } else {
    html += '<p class="dim" style="font-size:0.85rem">No Discord account linked.</p>';
  }
  html += `<div style="margin-top:6px"><button class="btn btn-xs btn-ghost" data-action="show-link-instructions">How to link Discord</button></div></div>`;

  // Panel account link
  html += `
    <div class="profile-section">
      <h4>Panel Account</h4>`;
  if (p.panelUser) {
    html += `
      <div class="profile-detail-row">
        <span class="profile-detail-label">Email</span>
        <span class="profile-detail-value">${esc(p.panelUser.email)}</span>
      </div>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Verified</span>
        <span class="profile-detail-value">${p.panelUser.verified ? 'Yes' : 'No'}</span>
      </div>
      <div class="profile-detail-row">
        <span class="profile-detail-label">Linked At</span>
        <span class="profile-detail-value">${p.panelUser.linkedAt ? new Date(p.panelUser.linkedAt).toLocaleString() : ''}</span>
      </div>`;
  } else {
    html += '<p class="dim" style="font-size:0.85rem">No panel account linked.</p>';
  }
  html += `<div style="margin-top:6px"><button class="btn btn-xs btn-ghost" data-action="show-panel-link-instructions">How to link Panel Account</button></div></div>`;

  container.innerHTML = html;
}

async function unlinkDiscordFromProfile(discordId, playerName) {
  if (!confirm(`Unlink Discord account from ${playerName}?`)) return;
  try {
    await DEL(`/players/discord-link/${encodeURIComponent(discordId)}`);
    // Refresh the profile
    openPlayerProfile(playerName);
  } catch (err) {
    alert('Failed to unlink: ' + err.message);
  }
}

$('player-profile-close').addEventListener('click', () => hide('player-profile-modal'));
$('player-profile-modal').addEventListener('click', (e) => {
  if (e.target === $('player-profile-modal')) hide('player-profile-modal');
});

// --- User Profile Modal ---

$('btn-view-profile').addEventListener('click', () => {
  hideUserMenu();
  openUserProfile();
});

async function openUserProfile() {
  const content = $('user-profile-content');
  content.innerHTML = '<p class="dim">Loading profile...</p>';
  show('user-profile-modal');

  const providerLabels = { google: 'Google', microsoft: 'Microsoft', local: 'Local' };
  const provider = providerLabels[window._userProvider] || window._userProvider || 'Unknown';
  const role = ROLE_NAMES[window._userRole] || window._userRole || 'Viewer';
  const roleCls = 'badge-role-' + (window._userRole || 'viewer');
  const loginAt = window._userLoginAt ? new Date(window._userLoginAt).toLocaleString() : 'Unknown';

  let html = `
    <div class="user-profile-account">
      <div class="user-profile-avatar-row">
        <div class="user-profile-icon">&#9787;</div>
        <div>
          <div class="user-profile-name">${esc(window._userName || 'User')}</div>
          <div class="user-profile-email">${esc(window._userEmail || '')}</div>
        </div>
      </div>
      <div class="profile-section">
        <h4>Account</h4>
        <div class="profile-detail-row">
          <span class="profile-detail-label">Sign-in Method</span>
          <span class="profile-detail-value">${esc(provider)}</span>
        </div>
        <div class="profile-detail-row">
          <span class="profile-detail-label">Panel Role</span>
          <span class="profile-detail-value"><span class="badge ${roleCls}">${esc(role)}</span></span>
        </div>
        <div class="profile-detail-row">
          <span class="profile-detail-label">Session Started</span>
          <span class="profile-detail-value">${loginAt}</span>
        </div>
      </div>
    </div>`;

  // Minecraft Account section
  html += `
    <div class="profile-section">
      <h4>Minecraft Account</h4>
      <div id="user-profile-mc-link">
        <p class="dim" style="font-size:0.85rem">Loading...</p>
      </div>
    </div>`;

  // Discord links section
  html += `
    <div class="profile-section">
      <h4>Discord Links</h4>
      <div id="user-profile-links">
        <p class="dim" style="font-size:0.85rem">Loading links...</p>
      </div>
    </div>`;

  // Logout
  html += `
    <div class="profile-section" style="text-align:center">
      <button class="btn btn-sm btn-danger" id="user-profile-logout">Log Out</button>
    </div>`;

  content.innerHTML = html;

  // Wire up logout button inside profile
  document.getElementById('user-profile-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
    isLoggedIn = false;
    userRole = 'viewer';
    userCapabilities = new Set();
    csrfToken = '';
    hide('user-profile-modal');
    applyRoleVisibility();
    updateUserMenu();
  });

  // Load MC link + Discord links in parallel
  await Promise.all([loadUserProfileMcLink(), loadUserProfileLinks()]);
}

async function loadUserProfileMcLink() {
  const container = document.getElementById('user-profile-mc-link');
  if (!container) return;

  try {
    const identity = await GET('/identity/me');
    if (identity.minecraft) {
      const mc = identity.minecraft;
      const opLabels = { 1: 'Moderator', 2: 'Gamemaster', 3: 'Admin', 4: 'Owner' };
      const opLabel = mc.opLevel ? `Op Level ${mc.opLevel} (${opLabels[mc.opLevel] || 'Op'})` : '';
      const verifiedBadge = mc.verified
        ? '<span class="badge badge-green" style="font-size:0.7rem">Verified</span>'
        : '';
      const onlineStatus =
        mc.online === true
          ? '<span class="badge badge-green" style="font-size:0.7rem">Online</span>'
          : mc.online === false
            ? '<span class="badge badge-dim" style="font-size:0.7rem">Offline</span>'
            : '';
      const linkedAt = mc.linkedAt ? new Date(mc.linkedAt).toLocaleDateString() : '';

      container.innerHTML = `
        <div class="mc-link-info">
          <div class="mc-link-player">
            <img src="https://mc-heads.net/avatar/${encodeURIComponent(mc.name)}/32" alt="" class="player-avatar-sm">
            <strong>${esc(mc.name)}</strong>
            ${verifiedBadge}
            ${onlineStatus}
          </div>
          <div class="mc-link-details dim" style="font-size:0.8rem; margin-top:4px">
            ${opLabel ? esc(opLabel) + ' &middot; ' : ''}${mc.whitelisted ? 'Whitelisted &middot; ' : ''}Linked: ${esc(linkedAt)}
          </div>
          <button class="btn btn-xs btn-danger" style="margin-top:8px" data-action="unlink-mc-self">Unlink</button>
        </div>`;
    } else {
      container.innerHTML = `
        <div id="mc-link-flow">
          <p class="dim" style="font-size:0.85rem; margin-bottom:8px">Not linked to a Minecraft account.</p>
          <div id="mc-link-start">
            <div style="display:flex; gap:8px; align-items:center">
              <input type="text" id="mc-link-name-input" placeholder="Your Minecraft name" style="flex:1; padding:6px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text)">
              <button class="btn btn-sm btn-primary" data-action="start-mc-link">Link Account</button>
            </div>
          </div>
          <div id="mc-link-pending" class="hidden">
            <p class="dim" style="font-size:0.85rem">Join the server as <strong id="mc-link-pending-name"></strong> and type:</p>
            <pre id="mc-link-pending-code" style="background:var(--bg-card); padding:8px 12px; border-radius:6px; font-size:1rem; margin:6px 0"></pre>
            <p class="dim" style="font-size:0.75rem">Code expires in <span id="mc-link-pending-expires"></span> minutes.</p>
            <button class="btn btn-xs btn-ghost" data-action="check-mc-link-status" style="margin-top:4px">Check Status</button>
          </div>
        </div>`;
    }
  } catch {
    container.innerHTML = '<p class="dim" style="font-size:0.85rem">Could not load Minecraft link info.</p>';
  }
}

async function loadUserProfileLinks() {
  const container = document.getElementById('user-profile-links');
  if (!container) return;

  try {
    const identity = await GET('/identity/me');
    if (identity.discord) {
      const linkedAt = identity.discord.linkedAt ? new Date(identity.discord.linkedAt).toLocaleDateString() : '';
      container.innerHTML = `
        <div class="user-profile-link-row">
          <div class="user-profile-link-info">
            <span class="user-profile-link-mc">${esc(identity.minecraft?.name || '')}</span>
            <span class="dim" style="font-size:0.75rem">Discord ID: ${esc(identity.discord.discordId)}</span>
          </div>
          <div class="user-profile-link-meta">
            <span class="dim" style="font-size:0.75rem">${esc(linkedAt)}</span>
          </div>
        </div>`;
    } else {
      container.innerHTML =
        '<p class="dim" style="font-size:0.85rem">No Discord account linked. Use <code>/link</code> in Discord to link your account.</p>';
    }
  } catch {
    container.innerHTML = '<p class="dim" style="font-size:0.85rem">Could not load Discord link info.</p>';
  }
}

async function unlinkFromUserProfile(discordId, playerName) {
  if (!confirm(`Unlink Discord account from ${playerName}?`)) return;
  try {
    await DEL(`/players/discord-link/${encodeURIComponent(discordId)}`);
    await loadUserProfileLinks();
    loadPlayerLinkCount();
  } catch (err) {
    alert('Failed to unlink: ' + err.message);
  }
}

async function startMcLink() {
  const input = document.getElementById('mc-link-name-input');
  const name = input?.value?.trim();
  if (!name) return alert('Enter your Minecraft player name.');
  try {
    const result = await POST('/identity/link', { minecraftName: name });
    const startDiv = document.getElementById('mc-link-start');
    const pendingDiv = document.getElementById('mc-link-pending');
    if (startDiv) startDiv.classList.add('hidden');
    if (pendingDiv) {
      pendingDiv.classList.remove('hidden');
      document.getElementById('mc-link-pending-name').textContent = result.minecraftName;
      document.getElementById('mc-link-pending-code').textContent = '!link ' + result.code;
      document.getElementById('mc-link-pending-expires').textContent = result.expiresInMinutes;
    }
  } catch (err) {
    alert('Failed to start link: ' + (err.message || err));
  }
}

async function unlinkMcSelf() {
  if (!confirm('Remove your Minecraft account link?')) return;
  try {
    await DEL('/identity/link');
    await loadUserProfileMcLink();
  } catch (err) {
    alert('Failed to unlink: ' + (err.message || err));
  }
}

async function checkMcLinkStatus() {
  try {
    const status = await GET('/identity/link/status');
    if (status.linked) {
      await loadUserProfileMcLink();
    } else if (status.pending) {
      alert('Challenge still pending. Type the code in Minecraft chat.');
    } else {
      alert('Challenge expired. Please start a new link request.');
      await loadUserProfileMcLink();
    }
  } catch (err) {
    alert('Failed to check status: ' + (err.message || err));
  }
}

$('user-profile-close').addEventListener('click', () => hide('user-profile-modal'));
$('user-profile-modal').addEventListener('click', (e) => {
  if (e.target === $('user-profile-modal')) hide('user-profile-modal');
});

$('link-instructions-close').addEventListener('click', () => hide('link-instructions-modal'));
$('link-instructions-modal').addEventListener('click', (e) => {
  if (e.target === $('link-instructions-modal')) hide('link-instructions-modal');
});

$('panel-link-instructions-close').addEventListener('click', () => hide('panel-link-instructions-modal'));
$('panel-link-instructions-modal').addEventListener('click', (e) => {
  if (e.target === $('panel-link-instructions-modal')) hide('panel-link-instructions-modal');
});

// --- Environment Management ---

function isViewingActiveEnv() {
  return !selectedEnvId || selectedEnvId === activeEnvId;
}

function renderEnvSelector() {
  const container = $('env-selector-container');
  if (envList.length <= 1) {
    hide(container);
    return;
  }
  show(container);

  // Update selector button
  const current = envList.find((e) => e.id === selectedEnvId) || envList.find((e) => e.isActive) || envList[0];
  $('env-selector-name').textContent = current.name;
  const dot = $('env-selector-dot');
  dot.className = 'env-dot ' + (current.isActive ? 'env-dot-active' : 'env-dot-inactive');

  // Build dropdown list
  const list = $('env-selector-list');
  list.innerHTML = envList
    .map((env) => {
      const isSelected = env.id === selectedEnvId;
      const isActive = env.isActive;
      return `<button class="env-selector-item${isSelected ? ' env-selected' : ''}" data-env-id="${esc(env.id)}">
        <span class="env-dot ${isActive ? 'env-dot-active' : 'env-dot-inactive'}"></span>
        <span class="env-item-name">${esc(env.name)}</span>
        ${isActive ? '<span class="badge badge-green badge-xs">Active</span>' : ''}
        <span class="env-item-version dim">${esc(env.minecraftVersion || '')}</span>
      </button>`;
    })
    .join('');

  // Wire click handlers on items
  list.querySelectorAll('.env-selector-item').forEach((btn) => {
    btn.addEventListener('click', () => selectEnvironment(btn.dataset.envId));
  });
}

function updateEnvBanner() {
  const banner = $('env-banner');
  if (isViewingActiveEnv() || envList.length <= 1) {
    hide(banner);
    return;
  }
  const env = envList.find((e) => e.id === selectedEnvId);
  if (!env) {
    hide(banner);
    return;
  }
  $('env-banner-text').innerHTML = `Viewing <strong>${esc(env.name)}</strong> — this is not the running environment.`;
  show(banner);
}

function updateEnvDisabledControls() {
  const notActive = !isViewingActiveEnv();
  // Disable start/stop/restart/kill buttons when viewing non-active env
  ['btn-start', 'btn-stop', 'btn-restart', 'btn-kill'].forEach((id) => {
    const btn = $(id);
    if (btn) {
      btn.disabled = notActive;
      btn.title = notActive ? 'Switch to this environment to control the server' : '';
    }
  });
  // Console tab messaging
  const consoleNotice = $('console-env-notice');
  if (consoleNotice) {
    if (notActive) {
      const activeEnv = envList.find((e) => e.isActive);
      consoleNotice.textContent = `Console shows the active environment. Currently running: ${activeEnv?.name || 'Unknown'}`;
      show(consoleNotice);
    } else {
      hide(consoleNotice);
    }
  }
}

async function selectEnvironment(envId) {
  if (envId === selectedEnvId) {
    hideEnvDropdown();
    return;
  }
  selectedEnvId = envId;
  hideEnvDropdown();

  // Update session on server
  try {
    await POST('/environments/select', { environmentId: envId });
  } catch {
    /* non-fatal */
  }

  renderEnvSelector();
  updateEnvBanner();
  updateEnvDisabledControls();

  // Refresh data for current tab
  refreshCurrentTabData();
}

function refreshCurrentTabData() {
  const activeBtn = document.querySelector('.tab-btn.active');
  if (activeBtn) onTabActivate(activeBtn.dataset.tab);
}

async function loadEnvironments() {
  try {
    const data = await GET('/environments');
    const envs = data.environments || [];
    envList = envs;
    activeEnvId = data.activeEnvironment || envs.find((e) => e.isActive)?.id || null;
    if (!selectedEnvId) selectedEnvId = activeEnvId;
    renderEnvSelector();
    updateEnvBanner();
    updateEnvDisabledControls();
  } catch {
    /* ignore */
  }
}

// Env selector dropdown toggle
$('env-selector-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('env-selector-dropdown').classList.toggle('hidden');
});

function hideEnvDropdown() {
  $('env-selector-dropdown').classList.add('hidden');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.env-selector-container')) {
    hideEnvDropdown();
  }
});

// Env banner buttons
$('env-banner-deploy').addEventListener('click', () => {
  openDeployModal(selectedEnvId);
});
$('env-banner-switch-active').addEventListener('click', () => {
  selectEnvironment(activeEnvId);
});

// Manage Environments button in dropdown
$('btn-manage-envs').addEventListener('click', () => {
  hideEnvDropdown();
  // Switch to settings tab, environments subtab
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.add('hidden'));
  const settingsBtn = document.querySelector('[data-tab="settings"]');
  if (settingsBtn) settingsBtn.classList.add('active');
  show('tab-settings');
  // Activate environments subtab
  const settingsTab = $('tab-settings');
  settingsTab.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
  settingsTab.querySelectorAll('.subtab-content').forEach((t) => t.classList.add('hidden'));
  const envSubtab = settingsTab.querySelector('[data-subtab="environments"]');
  if (envSubtab) envSubtab.classList.add('active');
  show('subtab-environments');
  loadEnvManagement();
});

// New Environment button in dropdown
$('btn-new-env').addEventListener('click', () => {
  hideEnvDropdown();
  openEnvModal();
});

// --- Environment Management (Settings subtab) ---

async function loadEnvManagement() {
  const container = $('env-list');
  try {
    const data = await GET('/environments');
    const envs = data.environments || [];
    if (envs.length === 0) {
      container.innerHTML = '<p class="dim">No environments configured.</p>';
      return;
    }
    container.innerHTML = envs
      .map(
        (env) => `
      <div class="env-card${env.isActive ? ' env-card-active' : ''}">
        <div class="env-card-header">
          <div class="env-card-title">
            <span class="env-dot ${env.isActive ? 'env-dot-active' : 'env-dot-inactive'}"></span>
            <strong>${esc(env.name)}</strong>
            ${env.isActive ? '<span class="badge badge-green badge-xs">Active</span>' : ''}
          </div>
          <div class="env-card-actions">
            ${!env.isActive ? `<button class="btn btn-xs btn-primary" data-action="deploy-env" data-env-id="${esc(env.id)}" data-env-name="${esc(env.name)}">Deploy</button>` : ''}
            <button class="btn btn-xs btn-ghost" data-action="edit-env" data-env-id="${esc(env.id)}">Edit</button>
            ${!env.isActive ? `<button class="btn btn-xs btn-danger" data-action="delete-env" data-env-id="${esc(env.id)}" data-env-name="${esc(env.name)}">Delete</button>` : ''}
          </div>
        </div>
        <div class="env-card-details">
          <span class="dim">Path: ${esc(env.serverPath || '')}</span>
          <span class="dim">MC ${esc(env.minecraftVersion || 'unknown')}</span>
          <span class="dim">ID: ${esc(env.id)}</span>
        </div>
      </div>`,
      )
      .join('');
  } catch (err) {
    container.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

// Add to subtab handlers
subtabHandlers['environments'] = () => loadEnvManagement();

// Wire data-action handlers for environment cards
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'deploy-env') {
    openDeployModal(el.dataset.envId, el.dataset.envName);
  } else if (el.dataset.action === 'edit-env') {
    openEnvModal(el.dataset.envId);
  } else if (el.dataset.action === 'delete-env') {
    await deleteEnvironment(el.dataset.envId, el.dataset.envName);
  }
});

// Create Environment button in settings
$('btn-create-env').addEventListener('click', () => openEnvModal());

// --- Environment Modal (Create / Edit) ---

let editingEnvId = null;

function openEnvModal(envId) {
  editingEnvId = envId || null;
  const form = $('env-form');
  form.reset();
  $('env-form-msg').textContent = '';

  if (envId) {
    $('env-modal-title').textContent = 'Edit Environment';
    $('env-form-submit').textContent = 'Save Changes';
    $('env-id').disabled = true;
    // Hide clone option when editing
    $('env-clone-source').closest('.form-group').classList.add('hidden');
    // Load env data
    GET(`/environments/${encodeURIComponent(envId)}`)
      .then((env) => {
        $('env-name').value = env.name || '';
        $('env-id').value = env.id || '';
        $('env-server-path').value = env.serverPath || '';
        $('env-mc-version').value = env.minecraftVersion || '';
        $('env-executable').value = env.launch?.executable || '';
        $('env-args').value = (env.launch?.args || []).join('\n');
        $('env-rcon-port').value = env.rconPort || '';
        $('env-rcon-password').value = '';
      })
      .catch((err) => flash('env-form-msg', err.message, true));
  } else {
    $('env-modal-title').textContent = 'New Environment';
    $('env-form-submit').textContent = 'Create Environment';
    $('env-id').disabled = false;
    $('env-clone-source').closest('.form-group').classList.remove('hidden');
    // Populate clone source options
    const sel = $('env-clone-source');
    sel.innerHTML = '<option value="">Don\'t clone — point to existing directory</option>';
    envList.forEach((env) => {
      sel.innerHTML += `<option value="${esc(env.id)}">${esc(env.name)}</option>`;
    });
  }

  show('env-modal');
}

// Auto-slug name → id
$('env-name').addEventListener('input', () => {
  if (!editingEnvId && !$('env-id').dataset.manual) {
    $('env-id').value = $('env-name')
      .value.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
  }
});
$('env-id').addEventListener('input', () => {
  $('env-id').dataset.manual = '1';
});

$('env-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: $('env-name').value.trim(),
    serverPath: $('env-server-path').value.trim(),
    minecraftVersion: $('env-mc-version').value.trim(),
  };

  const exe = $('env-executable').value.trim();
  const argsText = $('env-args').value.trim();
  if (exe) {
    data.launch = {
      executable: exe,
      args: argsText
        ? argsText
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean)
        : [],
    };
  }

  const rconPort = $('env-rcon-port').value;
  if (rconPort) data.rconPort = Number(rconPort);
  const rconPw = $('env-rcon-password').value;
  if (rconPw) data.rconPassword = rconPw;

  try {
    if (editingEnvId) {
      await PUT(`/environments/${encodeURIComponent(editingEnvId)}`, data);
      flash('env-form-msg', 'Environment updated.');
    } else {
      data.id = $('env-id').value.trim();
      const cloneSource = $('env-clone-source').value;
      if (cloneSource) {
        data.clone = { sourceId: cloneSource, destPath: data.serverPath };
      }
      await POST('/environments', data);
      flash('env-form-msg', 'Environment created.');
    }
    hide('env-modal');
    loadEnvManagement();
    loadEnvironments();
  } catch (err) {
    flash('env-form-msg', err.message, true);
  }
});

$('env-modal-close').addEventListener('click', () => hide('env-modal'));
$('env-form-cancel').addEventListener('click', () => hide('env-modal'));
$('env-modal').addEventListener('click', (e) => {
  if (e.target === $('env-modal')) hide('env-modal');
});

async function deleteEnvironment(envId, envName) {
  if (
    !confirm(
      `Delete environment "${envName}"? This only removes the environment from the manager — it does not delete server files.`,
    )
  )
    return;
  try {
    await DEL(`/environments/${encodeURIComponent(envId)}`);
    loadEnvManagement();
    loadEnvironments();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

// --- Deploy Modal ---

let deployEnvId = null;

function openDeployModal(envId, envName) {
  deployEnvId = envId;
  const env = envList.find((e) => e.id === envId);
  $('deploy-env-name').textContent = envName || env?.name || envId;
  $('deploy-auto-start').checked = true;
  $('deploy-msg').textContent = '';
  show('deploy-modal');
}

$('btn-deploy-confirm').addEventListener('click', async () => {
  if (!deployEnvId) return;
  const btn = $('btn-deploy-confirm');
  btn.disabled = true;
  btn.textContent = 'Deploying...';
  try {
    await POST(`/environments/${encodeURIComponent(deployEnvId)}/deploy`, {
      start: $('deploy-auto-start').checked,
    });
    hide('deploy-modal');
    selectedEnvId = deployEnvId;
    loadStatus();
    loadEnvironments();
    refreshCurrentTabData();
  } catch (err) {
    flash('deploy-msg', err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Deploy';
  }
});

$('deploy-modal-close').addEventListener('click', () => hide('deploy-modal'));
$('btn-deploy-cancel').addEventListener('click', () => hide('deploy-modal'));
$('deploy-modal').addEventListener('click', (e) => {
  if (e.target === $('deploy-modal')) hide('deploy-modal');
});

// Browse for env server path
$('btn-browse-env-path').addEventListener('click', async () => {
  const startPath = $('env-server-path').value || '/';
  try {
    const dirs = await GET(`/browse-dirs?path=${encodeURIComponent(startPath)}`);
    if (dirs && dirs.length > 0) {
      const chosen = prompt(
        'Available directories:\n' + dirs.map((d, i) => `${i + 1}. ${d}`).join('\n') + '\n\nEnter the full path:',
        startPath,
      );
      if (chosen) $('env-server-path').value = chosen;
    }
  } catch {
    /* ignore */
  }
});
