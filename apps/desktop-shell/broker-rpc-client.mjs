import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';

export class PipeRpcClient {
  constructor(socket, { timeoutMs = 30_000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.pending = new Map();
    this.listeners = new Set();
    this.disconnectListeners = new Set();
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      try { this.receive(chunk); } catch (error) { this.fail(error); }
    });
    socket.on('close', () => this.fail(new Error('Broker connection closed')));
    socket.on('error', error => this.fail(error));
  }

  static connect(pipe, options = {}) {
    return new Promise((resolve, reject) => {
      const socket = connect(pipe);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Broker connection timed out')); }, options.timeoutMs ?? 30_000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); resolve(new PipeRpcClient(socket, options)); });
    });
  }

  request(method, params = {}) {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error('Broker connection closed'));
    const id = randomUUID();
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (frame.length > 32 * 1024 * 1024) return Promise.reject(new Error('Desktop RPC frame exceeds 32 MB'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Broker request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame, error => { if (error) this.fail(error); });
    });
  }

  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDisconnect(listener) { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) throw new Error('Desktop RPC frame exceeds 32 MB');
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id) {
        for (const listener of this.listeners) listener(message.method, message.params || {});
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending.resolve(message.result);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.socket.destroy();
    for (const listener of this.disconnectListeners) listener(error);
  }

  async close() { this.fail(new Error('Broker connection closed')); }
}
