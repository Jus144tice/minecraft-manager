// RCON protocol client for Minecraft Java Edition
// Implements Source RCON protocol: https://wiki.vg/RCON
import net from 'net';

const TYPE = { RESPONSE: 0, COMMAND: 2, LOGIN: 3 };

export class RconClient {
  constructor(host, port, password) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this._pending = new Map();
    this._reqId = 2; // start at 2, 1 is reserved for auth
    this._buf = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      socket.connect(this.port, this.host, () => {
        this.connected = true;
        // Send auth packet
        this._pending.set(1, {
          resolve: () => { this.authenticated = true; resolve(); },
          reject,
        });
        this._write(TYPE.LOGIN, this.password, 1);
      });

      socket.on('data', (data) => {
        this._buf = Buffer.concat([this._buf, data]);
        this._drain();
      });

      socket.on('error', (err) => {
        this.connected = false;
        this.authenticated = false;
        for (const cb of this._pending.values()) cb.reject(err);
        this._pending.clear();
        reject(err);
      });

      socket.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        for (const cb of this._pending.values()) cb.reject(new Error('RCON connection closed'));
        this._pending.clear();
      });
    });
  }

  _drain() {
    while (this._buf.length >= 4) {
      const length = this._buf.readInt32LE(0);
      if (this._buf.length < 4 + length) break;

      const id = this._buf.readInt32LE(4);
      // payload is bytes 12..(4+length-2), stripping two null terminators
      const payloadEnd = Math.max(12, 4 + length - 2);
      const payload = this._buf.slice(12, payloadEnd).toString('utf8');
      this._buf = this._buf.slice(4 + length);

      if (id === -1) {
        // Auth failure
        for (const cb of this._pending.values()) cb.reject(new Error('RCON authentication failed - wrong password'));
        this._pending.clear();
      } else {
        const cb = this._pending.get(id);
        if (cb) {
          this._pending.delete(id);
          cb.resolve(payload);
        }
      }
    }
  }

  _write(type, payload, id) {
    const payloadBuf = Buffer.from(payload, 'utf8');
    const length = payloadBuf.length + 10; // id(4) + type(4) + payload + null + pad
    const buf = Buffer.alloc(4 + length);
    buf.writeInt32LE(length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    payloadBuf.copy(buf, 12);
    buf.writeUInt8(0, 12 + payloadBuf.length);
    buf.writeUInt8(0, 13 + payloadBuf.length);
    this.socket.write(buf);
  }

  sendCommand(command) {
    if (!this.connected) return Promise.reject(new Error('RCON not connected'));
    const id = this._reqId++;
    if (this._reqId > 0x7fffffff) this._reqId = 2;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._write(TYPE.COMMAND, command, id);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.authenticated = false;
    }
  }
}
