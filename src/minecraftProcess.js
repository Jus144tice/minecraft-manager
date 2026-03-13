// Manages the Minecraft server child process and log streaming
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const MAX_LOGS = 2000;

export class MinecraftProcess extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.running = false;
    this.logs = []; // circular buffer
    this.startTime = null;
  }

  start(launch, cwd) {
    if (this.running) throw new Error('Server is already running');
    if (!launch?.executable) throw new Error('Launch config missing executable');

    const cmd = launch.executable;
    const args = launch.args || [];

    this.proc = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: launch.env ? { ...process.env, ...launch.env } : undefined,
    });

    this.running = true;
    this.startTime = Date.now();
    this._log('[Manager] Server process starting...');
    this._log(`[Manager] CWD: ${cwd}`);
    this._log(`[Manager] Command: ${cmd} ${args.join(' ')}`);

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (data) => {
      data
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => this._log(l));
    });

    this.proc.stderr.on('data', (data) => {
      data
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => this._log('[STDERR] ' + l));
    });

    this.proc.on('close', (code) => {
      const uptime = this.getUptime();
      this.running = false;
      this.proc = null;
      this.startTime = null;
      this._log(`[Manager] Server stopped (exit code: ${code ?? 'unknown'})`);
      this.emit('stopped', code, uptime);
    });

    this.proc.on('error', (err) => {
      this.running = false;
      this.proc = null;
      this.startTime = null;
      this._log(`[Manager] Failed to start server: ${err.message}`);
      this.emit('error', err);
    });
  }

  stop() {
    if (!this.running || !this.proc) throw new Error('Server is not running');
    this._log('[Manager] Sending stop command...');
    this.proc.stdin.write('stop\n');
  }

  kill() {
    if (this.proc) {
      this._log('[Manager] Force-killing server process...');
      this.proc.kill('SIGKILL');
    }
  }

  sendConsoleCommand(command) {
    if (!this.running || !this.proc) throw new Error('Server is not running');
    this.proc.stdin.write(command + '\n');
    this._log(`> ${command}`);
  }

  getUptime() {
    if (!this.running || !this.startTime) return null;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  _log(line) {
    const entry = { time: Date.now(), line };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.emit('log', entry);
  }
}
