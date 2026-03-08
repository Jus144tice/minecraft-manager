// Minecraft Manager - Frontend Application
'use strict';

// --- Delegated error handler for mod icons ---
// Replaces broken <img class="mod-icon"> with a placeholder div.
// Using a delegated listener (capture phase) instead of inline onerror= because
// CSP 'unsafe-inline' may not cover event handlers injected via innerHTML in all browsers.
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el.tagName === 'IMG' && el.classList.contains('mod-icon')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'mod-icon-placeholder';
    el.replaceWith(placeholder);
  }
}, true); // capture=true so it fires even if the element has no bubbling listener

// --- State ---
let ws = null;
let wsReconnectTimer = null;
let currentModData = {}; // filename -> modrinth data from lookup
let browseOffset = 0;
let browseTotal = 0;
const BROWSE_LIMIT = 20;
let lastBrowseHits = []; // cached so the "show installed" toggle re-renders without a new fetch
let modsPage = 0;
const MODS_PAGE_SIZE = 10;

// --- Generic pagination bar ---
// Creates a controller for a prev/next pagination bar.
// Call .update(page, totalPages, totalCount, label) to refresh the UI.
// To switch to infinite scroll later: replace createPagination with a different factory
// and both tabs update automatically.
function createPagination({ prevId, nextId, infoId, containerId }) {
  return {
    update(page, totalPages, totalCount, label = 'items') {
      if (totalPages < 1) { hide(containerId); return; }
      show(containerId);
      $(infoId).textContent = `Page ${page} of ${totalPages} (${totalCount.toLocaleString()} ${label})`;
      $(prevId).disabled = page <= 1;
      $(nextId).disabled = page >= totalPages;
    },
    hide() { hide(containerId); },
  };
}

const modsPager  = createPagination({ prevId: 'mods-prev',   nextId: 'mods-next',   infoId: 'mods-page-info',   containerId: 'mods-pagination'   });
const browsePager = createPagination({ prevId: 'browse-prev', nextId: 'browse-next', infoId: 'browse-page-info', containerId: 'browse-pagination' });
let csrfToken = ''; // fetched after login; sent as X-CSRF-Token on all mutating requests

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
    // Session expired or logged out from another tab — return to login
    showLoginScreen();
    throw new Error('Session expired. Please log in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET = (path) => api('GET', path);
const POST = (path, body) => api('POST', path, body);
const DEL = (path) => api('DELETE', path);

// --- Utilities ---
function $(id) { return document.getElementById(id); }
function show(el) { (typeof el === 'string' ? $(el) : el).classList.remove('hidden'); }
function hide(el) { (typeof el === 'string' ? $(el) : el).classList.add('hidden'); }
function flash(id, msg, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? 'control-msg error-msg' : 'control-msg ok-msg';
  setTimeout(() => { el.textContent = ''; el.className = 'control-msg'; }, 4000);
}
function formatUptime(secs) {
  if (!secs) return '-';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function sideLabel(clientSide, serverSide) {
  const c = clientSide, s = serverSide;
  if (c === 'unsupported' && s !== 'unsupported') return { text: 'Server-only', cls: 'side-server' };
  if (s === 'unsupported' && c !== 'unsupported') return { text: 'Client-only', cls: 'side-client' };
  if (c !== 'unsupported' && s !== 'unsupported') return { text: 'Both', cls: 'side-both' };
  return { text: 'Unknown', cls: 'side-unknown' };
}
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- Login screen setup ---

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

function showLoginScreen() {
  if (ws) { ws.close(); ws = null; }
  hide('app');
  // Load providers fresh so login buttons are correct
  fetch('/api/auth/providers')
    .then(r => r.json())
    .then(setupLoginUI)
    .catch(() => {});
  show('login-screen');
}

// --- Local password login ---
$('login-btn').addEventListener('click', login);
$('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

async function login() {
  const pw = $('login-password').value;
  const errEl = $('login-error');
  errEl.classList.add('hidden');
  try {
    await fetch('/auth/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
    });
    hide('login-screen');
    show('app');
    initApp();
  } catch (err) {
    errEl.textContent = err.message || 'Login failed.';
    errEl.classList.remove('hidden');
  }
}

// --- Logout ---
$('logout-btn').addEventListener('click', async () => {
  if (ws) { ws.close(); ws = null; }
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.reload(); // cleanest way to reset all state and re-check session
});

// --- Startup: check existing session ---
(async () => {
  try {
    const session = await fetch('/api/session').then(r => r.json());
    if (session.loggedIn) {
      hide('login-screen');
      show('app');
      initApp();
      return;
    }
  } catch { /* network error — fall through to login */ }

  // Not logged in — configure login UI based on available providers
  const providers = await fetch('/api/auth/providers').then(r => r.json()).catch(() => ({}));
  setupLoginUI(providers);
  show('login-screen');
})();

// Demo banner dismiss
$('demo-banner-close').addEventListener('click', () => hide('demo-banner'));

// --- Tab navigation ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    btn.classList.add('active');
    const tab = $('tab-' + btn.dataset.tab);
    if (tab) tab.classList.remove('hidden');
    onTabActivate(btn.dataset.tab);
  });
});

document.querySelectorAll('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const parent = btn.closest('.tab-content');
    parent.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
    parent.querySelectorAll('.subtab-content').forEach(t => t.classList.add('hidden'));
    btn.classList.add('active');
    const el = parent.querySelector(`#subtab-${btn.dataset.subtab}`);
    if (el) el.classList.remove('hidden');
    onSubtabActivate(btn.dataset.subtab);
  });
});

function onTabActivate(tab) {
  if (tab === 'mods') loadMods();
  if (tab === 'players') { loadOps(); loadWhitelist(); loadBans(); }
  if (tab === 'settings') { loadAppConfig(); loadServerProps(); }
}

function onSubtabActivate(subtab) {
  if (subtab === 'ops') loadOps();
  if (subtab === 'whitelist') loadWhitelist();
  if (subtab === 'bans') loadBans();
  if (subtab === 'server-props') loadServerProps();
  if (subtab === 'app-cfg') loadAppConfig();
  if (subtab === 'browse') browseLoad(); // auto-load popular mods on first open
}

// --- App init ---
async function initApp() {
  // Fetch CSRF token first so all subsequent mutating requests include it.
  try {
    const { token } = await GET('/csrf-token');
    csrfToken = token;
  } catch { /* non-fatal — CSRF check will reject mutating requests until resolved */ }

  connectWs();
  loadStatus();
  loadOnlinePlayers(); // populate immediately without needing a manual refresh
  setInterval(loadStatus, 15000);
  // Show demo banner if in demo mode; also stash demoMode for UI decisions
  try {
    const cfg = await GET('/config');
    if (cfg.demoMode) {
      show('demo-banner');
      window._demoMode = true;
      // In demo mode the identify button is unnecessary — mods come pre-identified
      hide('btn-lookup-mods');
    } else {
      window._demoMode = false;
    }
  } catch { /* ignore */ }
}

// --- WebSocket (live console) ---
// Session cookie is sent automatically by the browser on same-origin WS upgrades.
function connectWs() {
  if (ws) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => { clearTimeout(wsReconnectTimer); appendConsole('[Manager] Connected to server', 'info'); };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'log') appendConsole(msg.line);
      if (msg.type === 'status') updateStatusBadge(msg.running, msg.uptime);
    } catch { /* ignore */ }
  };

  ws.onclose = (ev) => {
    ws = null;
    // Code 4001 = unauthorized (session expired) — don't reconnect
    if (ev.code === 4001) { showLoginScreen(); return; }
    wsReconnectTimer = setTimeout(connectWs, 5000);
  };

  ws.onerror = () => { ws.close(); };
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

$('btn-clear-console').addEventListener('click', () => { consoleOutput.innerHTML = ''; });

$('btn-send-cmd').addEventListener('click', sendConsoleCmd);
$('console-cmd').addEventListener('keydown', e => { if (e.key === 'Enter') sendConsoleCmd(); });

async function sendConsoleCmd() {
  const input = $('console-cmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  try {
    await POST('/server/command', { command: cmd });
  } catch {
    // Fall back to stdin
    try { await POST('/server/stdin', { command: cmd }); } catch (err) {
      appendConsole(`[Error] ${err.message}`, 'error');
    }
  }
}

// --- Status & dashboard ---
function updateStatusBadge(running, uptime) {
  const badge = $('server-badge');
  badge.textContent = running ? 'Running' : 'Stopped';
  badge.className = running ? 'badge badge-running' : 'badge badge-stopped';
  $('stat-status').textContent = running ? 'Running' : 'Stopped';
  $('stat-status').className = 'stat-value ' + (running ? 'text-green' : 'text-red');
  $('stat-uptime').textContent = formatUptime(uptime);
}

async function loadStatus() {
  try {
    const s = await GET('/status');
    updateStatusBadge(s.running, s.uptime);
    $('stat-players').textContent = s.running ? String(s.onlineCount) : '-';
    $('stat-rcon').textContent = s.rconConnected ? 'Connected' : 'Disconnected';
    $('stat-rcon').className = 'stat-value ' + (s.rconConnected ? 'text-green' : 'text-yellow');
  } catch { /* ignore */ }
}

// Server control
$('btn-start').addEventListener('click', async () => {
  try { const r = await POST('/server/start'); flash('control-msg', r.message || 'Starting...'); }
  catch (err) { flash('control-msg', err.message, true); }
});
$('btn-stop').addEventListener('click', async () => {
  if (!confirm('Stop the Minecraft server?')) return;
  try { const r = await POST('/server/stop'); flash('control-msg', r.message || 'Stopping...'); }
  catch (err) { flash('control-msg', err.message, true); }
});
$('btn-restart').addEventListener('click', async () => {
  if (!confirm('Restart the Minecraft server?')) return;
  try { const r = await POST('/server/restart'); flash('control-msg', r.message || 'Restarting...'); }
  catch (err) { flash('control-msg', err.message, true); }
});
$('btn-kill').addEventListener('click', async () => {
  if (!confirm('FORCE KILL the server process? Unsaved world data may be lost!')) return;
  try { await POST('/server/kill'); flash('control-msg', 'Process killed.'); }
  catch (err) { flash('control-msg', err.message, true); }
});

$('btn-say').addEventListener('click', async () => {
  const msg = $('say-input').value.trim();
  if (!msg) return;
  try { await POST('/players/say', { message: msg }); $('say-input').value = ''; flash('control-msg', 'Message sent!'); }
  catch (err) { flash('control-msg', err.message, true); }
});

$('btn-refresh-online').addEventListener('click', loadOnlinePlayers);

async function loadOnlinePlayers() {
  const el = $('online-players-list');
  try {
    const data = await GET('/players/online');
    if (data.players.length === 0) {
      el.innerHTML = '<span class="dim">No players online</span>';
    } else {
      el.innerHTML = data.players.map(name =>
        `<span class="chip">${esc(name)}
          <button class="chip-kick" data-name="${esc(name)}" title="Kick">&#10005;</button>
        </span>`
      ).join('');
      el.querySelectorAll('.chip-kick').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Kick ${btn.dataset.name}?`)) return;
          try { await POST('/players/kick', { name: btn.dataset.name }); loadOnlinePlayers(); }
          catch (err) { alert(err.message); }
        });
      });
    }
  } catch (err) {
    el.innerHTML = `<span class="dim">${esc(err.message)}</span>`;
  }
}

// --- Mods ---
let allMods = [];

async function loadMods() {
  try {
    const data = await GET('/mods');
    allMods = data.mods;
    for (const mod of allMods) {
      if (mod.modrinthData) {
        currentModData[mod.filename] = { modrinth: mod.modrinthData, enabled: mod.enabled };
      }
    }
    renderMods();
  } catch (err) {
    $('mods-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

function renderMods() {
  const filterText = $('mod-filter').value.toLowerCase();
  const sideFilter = $('mod-side-filter').value;
  const showDisabled = $('mod-show-disabled').checked;
  const sortOrder = $('mod-sort').value;

  let mods = allMods.filter(m => {
    if (!showDisabled && !m.enabled) return false;
    if (filterText) {
      const md = currentModData[m.filename]?.modrinth;
      const title = (md?.projectTitle || m.filename).toLowerCase();
      if (!title.includes(filterText) && !m.filename.toLowerCase().includes(filterText)) return false;
    }
    // Always exclude client-only mods — they don't belong on a server
    const md = currentModData[m.filename]?.modrinth;
    if (md && md.serverSide === 'unsupported') return false;
    if (sideFilter !== 'all') {
      if (!md) return sideFilter === 'unknown';
      const { cls } = sideLabel(md.clientSide, md.serverSide);
      if (sideFilter === 'both' && cls !== 'side-both') return false;
      if (sideFilter === 'server' && cls !== 'side-server') return false;
    }
    return true;
  });

  mods.sort((a, b) => {
    const mdA = currentModData[a.filename]?.modrinth;
    const mdB = currentModData[b.filename]?.modrinth;
    const nameA = (mdA?.projectTitle || a.filename).toLowerCase();
    const nameB = (mdB?.projectTitle || b.filename).toLowerCase();
    switch (sortOrder) {
      case 'name-asc':  return nameA.localeCompare(nameB);
      case 'name-desc': return nameB.localeCompare(nameA);
      case 'size-desc': return b.size - a.size;
      case 'size-asc':  return a.size - b.size;
      case 'enabled':   return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0);
      default:          return 0;
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

  $('mods-list').innerHTML = pageMods.map(mod => {
    const md = currentModData[mod.filename]?.modrinth;
    const side = md ? sideLabel(md.clientSide, md.serverSide) : { text: 'Unknown', cls: 'side-unknown' };
    const title = md?.projectTitle || mod.filename.replace(/\.jar$/i, '');
    const desc = md?.projectDescription || '';
    const ver = md?.versionNumber || '';

    return `<div class="mod-card ${mod.enabled ? '' : 'mod-disabled'}">
      ${md?.iconUrl ? `<img class="mod-icon" src="${esc(md.iconUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : '<div class="mod-icon-placeholder"></div>'}
      <div class="mod-info">
        <div class="mod-title">
          <span>${esc(title)}</span>
          <span class="side-badge ${side.cls}">${side.text}</span>
          ${!mod.enabled ? '<span class="side-badge mod-off-badge">Disabled</span>' : ''}
        </div>
        ${desc ? `<div class="mod-desc">${esc(desc.slice(0, 120))}${desc.length > 120 ? '...' : ''}</div>` : ''}
        <div class="mod-meta">
          <span class="dim">${esc(mod.filename)}</span>
          <span class="dim">${formatSize(mod.size)}</span>
          ${ver ? `<span class="dim">v${esc(ver)}</span>` : ''}
        </div>
      </div>
      <div class="mod-actions">
        <button class="btn btn-sm ${mod.enabled ? 'btn-warning' : 'btn-success'}"
          data-filename="${esc(mod.filename)}" data-enable="${!mod.enabled}"
          onclick="toggleMod(this)">
          ${mod.enabled ? 'Disable' : 'Enable'}
        </button>
        <button class="btn btn-sm btn-danger"
          data-filename="${esc(mod.filename)}"
          onclick="deleteMod(this)">
          Delete
        </button>
      </div>
    </div>`;
  }).join('');
}

window.toggleMod = async function(btn) {
  const { filename } = btn.dataset;
  const enable = btn.dataset.enable === 'true';
  try {
    await POST('/mods/toggle', { filename, enable });
    await loadMods();
  } catch (err) { alert(err.message); }
};

window.deleteMod = async function(btn) {
  const { filename } = btn.dataset;
  if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
  try {
    await DEL(`/mods/${encodeURIComponent(filename)}`);
    await loadMods();
  } catch (err) { alert(err.message); }
};

$('mod-filter').addEventListener('input', () => { modsPage = 0; renderMods(); });
$('mod-side-filter').addEventListener('change', () => { modsPage = 0; renderMods(); });
$('mod-sort').addEventListener('change', () => { modsPage = 0; renderMods(); });
$('mod-show-disabled').addEventListener('change', () => { modsPage = 0; renderMods(); });
$('mods-prev').addEventListener('click', () => { modsPage--; renderMods(); });
$('mods-next').addEventListener('click', () => { modsPage++; renderMods(); });
$('btn-refresh-mods').addEventListener('click', loadMods);

$('btn-lookup-mods').addEventListener('click', async () => {
  show('mod-lookup-progress');
  $('lookup-progress-fill').style.width = '30%';
  try {
    const data = await GET('/mods/lookup');
    currentModData = data;
    $('lookup-progress-fill').style.width = '100%';
    renderMods();
    setTimeout(() => hide('mod-lookup-progress'), 1000);
  } catch (err) {
    alert('Lookup failed: ' + err.message);
    hide('mod-lookup-progress');
  }
});

// --- Browse Modrinth ---
let browseLoaded = false;

$('btn-browse-search').addEventListener('click', () => { browseOffset = 0; browseSearch(); });
$('browse-query').addEventListener('keydown', e => { if (e.key === 'Enter') { browseOffset = 0; browseSearch(); } });

$('browse-prev').addEventListener('click', () => {
  browseOffset = Math.max(0, browseOffset - BROWSE_LIMIT);
  const q = $('browse-query').value.trim();
  q ? browseSearch() : browseLoad();
});
$('browse-next').addEventListener('click', () => {
  browseOffset = Math.min(browseOffset + BROWSE_LIMIT, browseTotal - BROWSE_LIMIT);
  const q = $('browse-query').value.trim();
  q ? browseSearch() : browseLoad();
});

async function browseLoad() {
  if (browseLoaded && browseOffset === 0 && !$('browse-query').value.trim()) {
    return; // Already loaded, don't reload unless paginating
  }
  $('browse-heading').textContent = 'Popular server-compatible Forge mods';
  $('browse-results').innerHTML = '<p class="dim">Loading popular mods...</p>';
  browsePager.hide();
  try {
    const params = new URLSearchParams({ limit: BROWSE_LIMIT, offset: browseOffset });
    const data = await GET(`/modrinth/browse?${params}`);
    browseTotal = data.total_hits || 0;
    lastBrowseHits = data.hits || [];
    renderBrowseResults(lastBrowseHits);
    updateBrowsePagination();
    browseLoaded = true;
  } catch (err) {
    $('browse-results').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

async function browseSearch() {
  const q = $('browse-query').value.trim();
  if (!q) { browseOffset = 0; return browseLoad(); }
  const side = $('browse-side').value;
  $('browse-heading').textContent = `Search results for "${q}"`;
  $('browse-results').innerHTML = '<p class="dim">Searching Modrinth...</p>';
  browsePager.hide();
  try {
    const params = new URLSearchParams({ q, side, limit: BROWSE_LIMIT, offset: browseOffset });
    const data = await GET(`/modrinth/search?${params}`);
    browseTotal = data.total_hits || 0;
    lastBrowseHits = data.hits || [];
    renderBrowseResults(lastBrowseHits);
    updateBrowsePagination();
  } catch (err) {
    $('browse-results').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

$('browse-show-installed').addEventListener('change', () => {
  if (lastBrowseHits.length > 0) renderBrowseResults(lastBrowseHits);
});

function updateBrowsePagination() {
  const page = Math.floor(browseOffset / BROWSE_LIMIT) + 1;
  const totalPages = Math.ceil(browseTotal / BROWSE_LIMIT) || 1;
  browsePager.update(page, totalPages, browseTotal, 'mods');
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

function renderBrowseResults(hits) {
  const installed = getInstalledSlugs();
  const showInstalled = $('browse-show-installed').checked;
  const displayHits = showInstalled ? hits : hits.filter(h => !installed.has(h.slug));

  if (displayHits.length === 0) {
    if (hits.length > 0 && !showInstalled) {
      $('browse-results').innerHTML = '<p class="dim">All mods on this page are already installed. Check "Show installed" to see them.</p>';
    } else {
      $('browse-results').innerHTML = '<p class="dim">No results found.</p>';
    }
    return;
  }
  $('browse-results').innerHTML = displayHits.map(hit => {
    const side = sideLabel(hit.client_side, hit.server_side);
    const downloads = Number(hit.downloads || 0).toLocaleString();
    const follows = Number(hit.follows || 0).toLocaleString();
    const latestVer = (hit.versions || []).filter(v => /^\d/.test(v)).slice(-1)[0] || '';
    const cats = (hit.categories || []).filter(c => c !== 'forge').slice(0, 3);
    const isInstalled = installed.has(hit.slug);
    return `<div class="mod-card browse-card${isInstalled ? ' mod-disabled' : ''}">
      ${hit.icon_url ? `<img class="mod-icon" src="${esc(hit.icon_url)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : '<div class="mod-icon-placeholder"></div>'}
      <div class="mod-info">
        <div class="mod-title">
          <span>${esc(hit.title)}</span>
          <span class="side-badge ${side.cls}">${side.text}</span>
          ${isInstalled ? '<span class="installed-badge">Installed</span>' : ''}
          ${cats.map(c => `<span class="cat-badge">${esc(c)}</span>`).join('')}
        </div>
        <div class="mod-desc">${esc((hit.description || '').slice(0, 160))}</div>
        <div class="mod-meta">
          <span class="dim" title="Author">by <strong>${esc(hit.author)}</strong></span>
          <span class="dim" title="Downloads">&#11015; ${downloads}</span>
          <span class="dim" title="Followers">&#9829; ${follows}</span>
          ${latestVer ? `<span class="dim" title="Latest version">${esc(latestVer)}</span>` : ''}
        </div>
      </div>
      <div class="mod-actions">
        ${isInstalled
          ? '<button class="btn btn-sm" disabled>Installed</button>'
          : `<button class="btn btn-sm btn-primary" data-projectid="${esc(hit.project_id)}" data-title="${esc(hit.title)}" onclick="openVersionModal(this)">Install</button>`}
      </div>
    </div>`;
  }).join('');
}

window.openVersionModal = async function(btn) {
  const { projectid, title } = btn.dataset;
  $('modal-title').textContent = `Install: ${title}`;
  show('version-modal');
  $('modal-versions').innerHTML = '<p class="dim">Loading versions...</p>';
  try {
    const versions = await GET(`/modrinth/versions/${projectid}`);
    if (!versions.length) {
      $('modal-versions').innerHTML = '<p class="dim">No compatible versions found for your Minecraft version / Forge.</p>';
      return;
    }
    $('modal-versions').innerHTML = versions.slice(0, 15).map(v => {
      const file = v.files.find(f => f.primary) || v.files[0];
      return `<div class="version-row">
        <div>
          <strong>${esc(v.name)}</strong>
          <span class="dim"> — ${esc(v.version_type)} — ${(v.game_versions || []).join(', ')}</span>
        </div>
        <div class="dim">${file ? formatSize(file.size) : ''}</div>
        <button class="btn btn-sm btn-success"
          data-versionid="${esc(v.id)}"
          onclick="downloadMod(this)">
          Download
        </button>
      </div>`;
    }).join('');
  } catch (err) {
    $('modal-versions').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
};

$('modal-close').addEventListener('click', () => hide('version-modal'));
$('version-modal').addEventListener('click', e => { if (e.target === $('version-modal')) hide('version-modal'); });

window.downloadMod = async function(btn) {
  const { versionid } = btn.dataset;
  btn.disabled = true;
  btn.textContent = 'Downloading...';
  try {
    const result = await POST('/modrinth/download', { versionId: versionid });
    btn.textContent = 'Done!';
    btn.className = 'btn btn-sm btn-ghost';
    hide('version-modal');
    await loadMods();
    alert(`Downloaded: ${result.filename} (${formatSize(result.size)})`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Download';
    alert('Download failed: ' + err.message);
  }
};

// --- Players: Ops ---
async function loadOps() {
  try {
    const ops = await GET('/players/ops');
    const el = $('ops-list');
    if (!ops.length) { el.innerHTML = '<p class="dim">No operators set.</p>'; return; }
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Name</th><th>Level</th><th>UUID</th><th>Actions</th></tr></thead>
      <tbody>${ops.map(op => `
        <tr>
          <td><strong>${esc(op.name)}</strong></td>
          <td><span class="level-badge level-${op.level}">Level ${op.level}</span></td>
          <td class="dim small">${esc(op.uuid || '-')}</td>
          <td>
            <button class="btn btn-sm btn-danger" data-name="${esc(op.name)}" onclick="removeOp(this)">Remove</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  } catch (err) { $('ops-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; }
}

$('btn-add-op').addEventListener('click', async () => {
  const name = $('op-name').value.trim();
  const level = parseInt($('op-level').value);
  if (!name) return alert('Enter a player name.');
  try { await POST('/players/op', { name, level }); $('op-name').value = ''; loadOps(); }
  catch (err) { alert(err.message); }
});

window.removeOp = async function(btn) {
  if (!confirm(`Remove operator status from ${btn.dataset.name}?`)) return;
  try { await DEL(`/players/op/${encodeURIComponent(btn.dataset.name)}`); loadOps(); }
  catch (err) { alert(err.message); }
};

// --- Players: Whitelist ---
async function loadWhitelist() {
  try {
    const list = await GET('/players/whitelist');
    const el = $('whitelist-list');
    if (!list.length) { el.innerHTML = '<p class="dim">Whitelist is empty.</p>'; return; }
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Name</th><th>UUID</th><th>Actions</th></tr></thead>
      <tbody>${list.map(e => `
        <tr>
          <td><strong>${esc(e.name)}</strong></td>
          <td class="dim small">${esc(e.uuid || '-')}</td>
          <td>
            <button class="btn btn-sm btn-danger" data-name="${esc(e.name)}" onclick="removeWl(this)">Remove</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  } catch (err) { $('whitelist-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; }
}

$('btn-add-wl').addEventListener('click', async () => {
  const name = $('wl-name').value.trim();
  if (!name) return alert('Enter a player name.');
  try { await POST('/players/whitelist', { name }); $('wl-name').value = ''; loadWhitelist(); }
  catch (err) { alert(err.message); }
});

window.removeWl = async function(btn) {
  if (!confirm(`Remove ${btn.dataset.name} from whitelist?`)) return;
  try { await DEL(`/players/whitelist/${encodeURIComponent(btn.dataset.name)}`); loadWhitelist(); }
  catch (err) { alert(err.message); }
};

// --- Players: Bans ---
async function loadBans() {
  try {
    const data = await GET('/players/banned');
    const el = $('bans-list');
    const banned = data.players || [];
    if (!banned.length) { el.innerHTML = '<p class="dim">No banned players.</p>'; return; }
    el.innerHTML = `<table class="player-table">
      <thead><tr><th>Name</th><th>Reason</th><th>Actions</th></tr></thead>
      <tbody>${banned.map(e => `
        <tr>
          <td><strong>${esc(e.name)}</strong></td>
          <td class="dim">${esc(e.reason || '-')}</td>
          <td>
            <button class="btn btn-sm btn-success" data-name="${esc(e.name)}" onclick="unbanPlayer(this)">Unban</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  } catch (err) { $('bans-list').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; }
}

$('btn-ban').addEventListener('click', async () => {
  const name = $('ban-name').value.trim();
  const reason = $('ban-reason').value.trim() || 'Banned by admin';
  if (!name) return alert('Enter a player name.');
  if (!confirm(`Ban ${name} for: "${reason}"?`)) return;
  try { await POST('/players/ban', { name, reason }); $('ban-name').value = ''; $('ban-reason').value = ''; loadBans(); }
  catch (err) { alert(err.message); }
});

window.unbanPlayer = async function(btn) {
  if (!confirm(`Unban ${btn.dataset.name}?`)) return;
  try { await DEL(`/players/ban/${encodeURIComponent(btn.dataset.name)}`); loadBans(); }
  catch (err) { alert(err.message); }
};

// --- Settings: App config ---
async function loadAppConfig() {
  try {
    const cfg = await GET('/config');
    const form = $('app-config-form');
    for (const [k, v] of Object.entries(cfg)) {
      const el = form.elements[k];
      if (!el || el.type === 'password') continue;
      if (el.type === 'checkbox') { el.checked = !!v; }
      else { el.value = v; }
    }
  } catch (err) { console.error('Config load failed', err); }
}

$('app-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') { data[el.name] = el.checked; }
    else if (el.type === 'number' && el.value !== '') { data[el.name] = Number(el.value); }
    else if (el.value !== '') { data[el.name] = el.value; }
  }
  if (!data.webPassword) delete data.webPassword;
  try {
    await POST('/config', data);
    if (data.demoMode === false) {
      hide('demo-banner');
      flash('app-cfg-msg', 'Demo mode disabled. Restart the manager app (node server.js) to connect to your real server.');
    } else if (data.demoMode === true) {
      show('demo-banner');
      flash('app-cfg-msg', 'Demo mode enabled. Restart the manager app to return to seed data.');
    } else {
      flash('app-cfg-msg', 'Config saved! Restart the manager for port/path changes to take effect.');
    }
  } catch (err) { flash('app-cfg-msg', err.message, true); }
});

$('btn-reconnect-rcon').addEventListener('click', async () => {
  try {
    const r = await POST('/rcon/connect');
    flash('app-cfg-msg', r.connected ? 'RCON connected!' : 'RCON connection failed. Check password and server.properties.');
  } catch (err) { flash('app-cfg-msg', err.message, true); }
});

// --- Settings: server.properties ---
const IMPORTANT_PROPS = [
  'enable-rcon', 'rcon.port', 'rcon.password',
  'white-list', 'online-mode', 'max-players', 'server-port',
  'motd', 'gamemode', 'difficulty', 'level-name',
  'pvp', 'spawn-protection', 'op-permission-level',
];

async function loadServerProps() {
  const el = $('props-fields');
  try {
    const props = await GET('/settings/properties');
    const entries = Object.entries(props);
    if (!entries.length) { el.innerHTML = '<p class="dim">Could not read server.properties.</p>'; return; }

    entries.sort(([a], [b]) => {
      const ai = IMPORTANT_PROPS.indexOf(a), bi = IMPORTANT_PROPS.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });

    el.innerHTML = entries.map(([k, v]) => {
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
    }).join('');
  } catch (err) { el.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; }
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
  } catch (err) { flash('props-msg', err.message, true); }
});
