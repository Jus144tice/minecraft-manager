// Shared application services and mutable state.
// Passed as `ctx` to route modules so they don't need 10+ separate arguments.

import { RconClient } from './rcon.js';
import * as Demo from './demoData.js';
import { audit, info } from './audit.js';

export function createServices({ config, saveConfig, loadConfig, mc, broadcast, broadcastStatus }) {
  let rcon = null;
  let rconReconnectTimer = null;

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
    if (rcon) { try { rcon.disconnect(); } catch { /* ok */ } }
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
        await new Promise(r => setTimeout(r, 5000));
        attempts++;
      }
      info('[RCON] Could not connect after server start.');
    }, delayMs);
  }

  async function rconCmd(cmd) {
    if (!rcon || !rcon.connected) throw new Error('RCON is not connected. Server may still be starting, or check rcon settings.');
    return rcon.sendCommand(cmd);
  }

  mc.on('stopped', () => {
    if (rcon) { rcon.disconnect(); rcon = null; }
    clearTimeout(rconReconnectTimer);
    broadcastStatus();
  });

  return {
    get config() { return config; },
    set config(c) { config = c; },
    saveConfig,
    loadConfig,
    mc,
    broadcast,
    broadcastStatus,
    demoState,
    getDemoUptime,
    startDemoActivityTimer,
    stopDemoActivityTimer,
    connectRcon,
    scheduleRconConnect,
    rconCmd,
    get rconConnected() { return !!(rcon?.connected); },
  };
}
