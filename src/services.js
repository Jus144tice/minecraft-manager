// Shared application services and mutable state.
// Passed as `ctx` to route modules so they don't need 10+ separate arguments.

import { RconClient } from './rcon.js';
import * as Demo from './demoData.js';
import { audit, info } from './audit.js';

// ---- Crash detection constants ----
const MAX_RESTARTS = 3; // max auto-restarts within the window
const RESTART_WINDOW_MS = 600000; // 10-minute sliding window
const RESTART_DELAY_MS = 10000; // wait 10s before restarting
const MIN_RUNTIME_MS = 30000; // ignore exits within 30s of start (startup crash)

export function createServices({ config, saveConfig, loadConfig, mc, broadcast, broadcastStatus }) {
  let rcon = null;
  let rconReconnectTimer = null;

  // ---- Intentional-stop tracking ----
  // Set to true before user-initiated stop/kill/restart; reset on 'stopped' event.
  let intentionalStop = false;

  // ---- Crash auto-restart state ----
  const recentRestarts = []; // timestamps of recent auto-restarts
  let autoRestartTimer = null;

  const demoState = {
    running: true,
    startTime: Date.now() - 3847000,
    activityIndex: 0,
    activityTimer: null,
  };

  function getDemoUptime() {
    if (!demoState.running || !demoState.startTime) return null;
    return Math.floor((Date.now() - demoState.startTime) / 1000);
  }

  function startDemoActivityTimer() {
    stopDemoActivityTimer();
    demoState.activityTimer = setInterval(() => {
      if (!demoState.running) return;
      const line = Demo.DEMO_ACTIVITY_LOGS[demoState.activityIndex % Demo.DEMO_ACTIVITY_LOGS.length];
      demoState.activityIndex++;
      broadcast({ type: 'log', time: Date.now(), line });
    }, 8000);
  }

  function stopDemoActivityTimer() {
    if (demoState.activityTimer) {
      clearInterval(demoState.activityTimer);
      demoState.activityTimer = null;
    }
  }

  async function connectRcon() {
    if (rcon) {
      try {
        rcon.disconnect();
      } catch {
        /* ok */
      }
    }
    rcon = new RconClient(config.rconHost || '127.0.0.1', config.rconPort || 25575, config.rconPassword);
    try {
      await rcon.connect();
      info('[RCON] Connected');
      return true;
    } catch {
      rcon = null;
      return false;
    }
  }

  async function scheduleRconConnect(delayMs = 5000) {
    clearTimeout(rconReconnectTimer);
    rconReconnectTimer = setTimeout(async () => {
      let attempts = 0;
      while (attempts < 24) {
        if (!mc.running) break;
        if (await connectRcon()) return;
        await new Promise((r) => setTimeout(r, 5000));
        attempts++;
      }
      info('[RCON] Could not connect after server start.');
    }, delayMs);
  }

  async function rconCmd(cmd) {
    if (!rcon || !rcon.connected)
      throw new Error('RCON is not connected. Server may still be starting, or check rcon settings.');
    return rcon.sendCommand(cmd);
  }

  // Mark the next stop as intentional (called before user-initiated stop/kill/restart)
  function markIntentionalStop() {
    intentionalStop = true;
  }

  // ---- Crash detection + auto-restart ----

  function pruneRestartWindow() {
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    while (recentRestarts.length > 0 && recentRestarts[0] < cutoff) recentRestarts.shift();
  }

  function handleProcessExit(code, uptimeSeconds) {
    // Clean up RCON
    if (rcon) {
      rcon.disconnect();
      rcon = null;
    }
    clearTimeout(rconReconnectTimer);
    clearTimeout(autoRestartTimer);
    broadcastStatus();

    const wasIntentional = intentionalStop;
    intentionalStop = false;

    if (config.demoMode || wasIntentional) return;

    // Determine if this was a crash
    const uptime = uptimeSeconds ?? null;
    const isCrash = code !== 0 && code != null;
    const startupCrash = uptime != null && uptime < MIN_RUNTIME_MS / 1000;

    if (!isCrash) return; // clean exit (code 0) — not a crash

    // Broadcast crash notification to all connected clients
    const crashMsg = startupCrash
      ? `Server crashed during startup (exit code ${code})`
      : `Server crashed (exit code ${code})`;
    info('Server crash detected', { code, uptimeSeconds: uptime });
    audit('SERVER_CRASH', { code, uptimeSeconds: uptime });
    broadcast({ type: 'crash', message: crashMsg, code, time: Date.now() });

    // Auto-restart if enabled
    if (!config.autoRestart) {
      info('Auto-restart is disabled — server will not restart automatically');
      return;
    }

    // Startup crash — don't restart (would loop immediately)
    if (startupCrash) {
      info('Startup crash detected — skipping auto-restart to avoid restart loop');
      broadcast({
        type: 'crash',
        message:
          'Startup crash detected — auto-restart skipped to avoid restart loop. Check the console log and restart manually.',
        code,
        time: Date.now(),
      });
      return;
    }

    // Rate limit: check if we've exceeded max restarts in the window
    pruneRestartWindow();
    if (recentRestarts.length >= MAX_RESTARTS) {
      info(`Auto-restart rate limit reached (${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 60000} minutes)`);
      broadcast({
        type: 'crash',
        message: `Auto-restart limit reached (${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 60000} min). Restart manually.`,
        code,
        time: Date.now(),
      });
      return;
    }

    // Schedule auto-restart
    recentRestarts.push(Date.now());
    const attempt = recentRestarts.length;
    info(`Auto-restarting server in ${RESTART_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RESTARTS})`);
    broadcast({
      type: 'crash',
      message: `Crash detected — auto-restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RESTARTS})...`,
      code,
      time: Date.now(),
      autoRestarting: true,
    });

    autoRestartTimer = setTimeout(() => {
      try {
        mc.start(config.launch, config.serverPath);
        scheduleRconConnect(15000);
        broadcastStatus();
        audit('SERVER_AUTO_RESTART', { attempt, code });
        info('Auto-restart: server starting');
      } catch (err) {
        info('Auto-restart failed', { error: err.message });
        broadcast({ type: 'crash', message: `Auto-restart failed: ${err.message}`, code, time: Date.now() });
      }
    }, RESTART_DELAY_MS);
  }

  mc.on('stopped', handleProcessExit);

  // Drain all timers and connections for graceful shutdown.
  function cleanup() {
    clearTimeout(rconReconnectTimer);
    rconReconnectTimer = null;
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
    stopDemoActivityTimer();
    if (rcon) {
      try {
        rcon.disconnect();
      } catch {
        /* ok */
      }
      rcon = null;
    }
  }

  return {
    get config() {
      return config;
    },
    set config(c) {
      config = c;
    },
    saveConfig,
    loadConfig,
    mc,
    broadcast,
    broadcastStatus,
    markIntentionalStop,
    cleanup,
    demoState,
    getDemoUptime,
    startDemoActivityTimer,
    stopDemoActivityTimer,
    connectRcon,
    scheduleRconConnect,
    rconCmd,
    get rconConnected() {
      return !!rcon?.connected;
    },
  };
}
