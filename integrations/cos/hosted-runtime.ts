import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeWire, decodeWire } from './ego-wire.cjs';
import { requestEgoBrowser, type EgoBrowserRequest } from './ego-browser.js';
import { activateEgoExecution, egoExecutionAllowed, egoExecutionStatus, egoIsProbe } from './ego-execution.js';

export const isEgoHosted = process.env.COS_EGO_HOSTED === '1';
type Handler = (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown;
const handlers = new Map<string, Handler>();
const hostCalls = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}>();
let owner: BrowserWindow | null = null;
let stopping = false;

function send(message: unknown): void {
  if (process.connected && process.send) process.send(encodeWire(message) as object);
}

export function initializeEgoHostedEnvironment(): void {
  if (!isEgoHosted) return;
  const data = process.env.COS_EGO_DATA;
  if (!process.send || !data || !isAbsolute(data)) {
    throw new Error('Ego hosted mode requires a private IPC parent and an absolute data directory');
  }
  mkdirSync(data, { recursive: true });
  app.setPath('userData', data);
  app.setName('CoS Ego Hosted');
  dialog.showOpenDialog = ((...args: unknown[]) => egoHostRequest('dialog.open', args.length === 2 ? args[1] : args[0], 0)) as typeof dialog.showOpenDialog;
  dialog.showSaveDialog = ((...args: unknown[]) => egoHostRequest('dialog.save', args.length === 2 ? args[1] : args[0], 0)) as typeof dialog.showSaveDialog;
  process.once('disconnect', () => app.quit());
  app.on('before-quit', () => {
    stopping = true;
    for (const pending of hostCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CoS is stopping'));
    }
    hostCalls.clear();
  });
}

export function createEgoHostedOwner(): BrowserWindow {
  // Upstream handlers use a BrowserWindow for dialogs and terminal ownership.
  // It never loads the UI or becomes visible; Ego owns the actual app view.
  owner = new BrowserWindow({
    show: false, skipTaskbar: true, width: 1, height: 1,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: true } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  owner.webContents.send = (channel: string, ...args: unknown[]): void => {
    send({ type: 'cos:event', channel, args });
  };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener): void => {
    handlers.set(channel, listener);
    originalHandle(channel, listener);
  };
  handlers.set('ego:browser-request', (_event, payload) => requestEgoBrowser(payload as EgoBrowserRequest));
  handlers.set('ego:agent-status', (_event, payload) => egoHostRequest('agents.status', payload));
  handlers.set('ego:execution-status', () => egoExecutionStatus());
  handlers.set('ego:execution-activate', (_event, payload) => activateEgoExecution((payload as { resume?: boolean })?.resume === true));
  process.on('message', async (raw: unknown) => {
    const message = decodeWire(raw) as { type?: string; id?: string; channel?: string; payload?: unknown; error?: string; result?: unknown };
    if (message?.type === 'cos:stop') { app.quit(); return; }
    if (message?.type === 'ego:reply' && typeof message.id === 'string') {
      const pending = hostCalls.get(message.id);
      if (!pending) return;
      hostCalls.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message?.type !== 'cos:invoke' || typeof message.id !== 'string') return;
    try {
      if (stopping || !owner || owner.isDestroyed()) throw new Error('CoS is stopping');
      if (egoIsProbe() && !['state:get', 'ego:execution-status'].includes(message.channel || '')) {
        throw new Error('CoS maintenance probe only accepts state reads');
      }
      if (!egoExecutionAllowed() && ['sessions:send', 'sessions:retryBrowser', 'sessions:retryHelper', 'sessions:compact',
        'sessions:plan', 'sessions:goalOpening', 'connection:connect'].includes(message.channel || '')) {
        throw new Error('CoS tasks are paused. Resume tasks in Ego before starting work.');
      }
      if (message.channel === 'update:refresh') {
        send({ type: 'cos:reply', id: message.id, result: { ok: true, data: true } });
        return;
      }
      if (message.channel?.startsWith('update:')) throw new Error('CoS updates are managed by Ego');
      const handler = handlers.get(message.channel || '');
      if (!handler) throw new Error(`Unknown CoS method: ${message.channel}`);
      const event = {
        sender: owner.webContents,
        senderFrame: owner.webContents.mainFrame
      } as Electron.IpcMainInvokeEvent;
      const result = await handler(event, message.payload);
      send({ type: 'cos:reply', id: message.id, result });
    } catch (error) {
      send({ type: 'cos:reply', id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return owner;
}

export function egoHostedReady(): void {
  send({ type: 'cos:ready', protocol: 1, pid: process.pid, channels: [...handlers.keys()] });
}

export function egoHostRequest(method: string, payload: unknown, timeoutMs = 60_000): Promise<unknown> {
  if (!isEgoHosted || stopping || !process.connected) return Promise.reject(new Error('Ego host is unavailable'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0 ? setTimeout(() => {
      hostCalls.delete(id);
      reject(new Error(`Ego host request timed out: ${method}`));
    }, timeoutMs) : undefined;
    hostCalls.set(id, { resolve, reject, timer });
    send({ type: 'ego:request', id, method, payload });
  });
}
