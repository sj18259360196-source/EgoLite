import { contextBridge, ipcRenderer as egoIpc, webUtils } from 'electron';

contextBridge.exposeInMainWorld('egoHost', { name: 'EgoLite', protocol: 1 });

const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
egoIpc.on('ego:cos:event', (_event, channel: string, args: unknown[]) => {
  for (const listener of listeners.get(channel) ?? []) listener(undefined, ...args);
});
const ipcRenderer = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    egoIpc.invoke('ego:cos:invoke', channel, payload),
  on(channel: string, listener: (...args: any[]) => void): void {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
  },
  removeListener(channel: string, listener: (...args: any[]) => void): void {
    listeners.get(channel)?.delete(listener);
  }
};
