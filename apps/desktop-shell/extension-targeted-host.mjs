import { BrowserWindow, Notification, dialog, ipcMain, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { updateTargetedRules, applyTargetedHeaders } from './extension-targeted-rules.mjs';

export function matchesExtensionOrigin(pattern, url) {
  try {
    const target = new URL(url);
    if (pattern === '<all_urls>') return ['http:', 'https:', 'file:'].includes(target.protocol);
    const match = /^(\*|https?|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!match) return false;
    const [, scheme, host, path] = match;
    if (scheme === '*' ? !['http:', 'https:'].includes(target.protocol) : target.protocol !== `${scheme}:`) return false;
    const hostname = host.includes(':') ? target.host : target.hostname;
    if (host !== '*' && hostname !== host && !(host.startsWith('*.') && (hostname === host.slice(2) || hostname.endsWith(host.slice(1))))) return false;
    return new RegExp(`^${path.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(target.pathname + target.search);
  } catch { return false; }
}

export class TargetedExtensionHost {
  constructor({ session, statePath, getTabs, getActiveTab, createTab, updateTab, removeTab, getWindow, assertTabAllowed = () => {} }) {
    Object.assign(this, { session, statePath, getTabs, getActiveTab, createTab, updateTab, removeTab, getWindow, assertTabAllowed });
    this.extensions = new Map();
    this.saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
    this.preloadId = session.registerPreloadScript({ type: 'frame', filePath: join(import.meta.dirname, 'extension-host-preload.cjs') });
    this.handler = async (event, method, args = []) => {
      try {
        const url = new URL(event.senderFrame.url);
        const state = this.extensions.get(url.hostname);
        if (url.protocol !== 'chrome-extension:' || !state || event.sender.session !== this.session) throw new Error('Extension host access denied');
        if (!Array.isArray(args)) throw new Error('Invalid extension arguments');
        return { value: await this.invoke(state, method, args) };
      } catch (error) { return { error: error.message }; }
    };
    ipcMain.handle('ego:extension-host', this.handler);
    const headers = values => Object.entries(values || {}).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => ({ name, value: String(item) })));
    const observe = (name, details) => {
      for (const state of this.extensions.values()) {
        const filters = state.network?.[name];
        const type = details.resourceType === 'xhr' ? 'xmlhttprequest' : details.resourceType.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        if (!filters || !this.authorized(state, details.url) || !filters.some(filter => filter.urls?.some(pattern => pattern === details.url || matchesExtensionOrigin(pattern, details.url)) && (!filter.types || filter.types.includes(type)))) continue;
        this.emit(state, `webRequest.${name}`, { requestId: String(details.id), method: details.method, error: details.error, statusCode: details.statusCode, initiator: details.initiator || details.frame?.origin, frameId: details.frame?.parent ? details.frame.routingId : 0, parentFrameId: -1, tabId: this.getTabs().some(tab => tab.id === details.webContentsId) ? details.webContentsId : -1, url: details.url, type, requestHeaders: headers(details.requestHeaders), responseHeaders: headers(details.responseHeaders) });
      }
    };
    session.webRequest.onSendHeaders(details => { observe('onBeforeSendHeaders', details); observe('onSendHeaders', details); });
    session.webRequest.onResponseStarted(details => observe('onHeadersReceived', details));
    session.webRequest.onErrorOccurred(details => observe('onErrorOccurred', details));
    session.webRequest.onCompleted(details => observe('onCompleted', details));
    session.webRequest.onBeforeRequest((details, callback) => { observe('onBeforeRequest', details); callback({}); });
    const modify = (details, phase) => {
      // Requests from workers and the network service may have no WebContents.
      const contents = Number.isInteger(details.webContentsId) && details.webContentsId > 0
        ? webContents.fromId(details.webContentsId) : undefined;
      const origin = details.frame?.url || contents?.getURL() || '';
      const state = [...this.extensions.values()].find(state => origin.startsWith(state.extension.url));
      return state && this.authorized(state, details.url) ? applyTargetedHeaders(state.rules || new Map(), details.url, details[phase], phase) : details[phase];
    };
    session.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: modify(details, 'requestHeaders') }));
    session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: modify(details, 'responseHeaders') }));
  }

  register(extension, manifest) {
    if (this.extensions.has(extension.id)) return;
    const saved = this.saved[extension.id] || {};
    const state = { extension, manifest, grants: saved.grants || { permissions: [], origins: [] }, session: {}, alarms: new Map(), menus: new Map(), action: {}, notifications: new Map(), activeGrants: new Map() };
    this.extensions.set(extension.id, state);
    for (const alarm of saved.alarms || []) this.schedule(state, alarm);
  }

  unregister(id) {
    const state = this.extensions.get(id);
    if (!state) return;
    for (const alarm of state.alarms.values()) clearTimeout(alarm.timer);
    for (const notification of state.notifications.values()) notification.close();
    state.options?.destroy();
    this.extensions.delete(id);
  }

  grantActiveTab(id) {
    const state = this.extensions.get(id);
    const tab = this.getActiveTab();
    if (state?.manifest.permissions?.includes('activeTab') && tab) {
      state.activeGrants.set(tab.id, new URL(tab.url).origin);
    }
  }

  emit(state, name, ...args) {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.session !== this.session || contents.isDestroyed()) continue;
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (frame.url.startsWith(state.extension.url)) frame.send('ego:extension-event', name, args);
      }
    }
  }

  notifyTab(name, ...args) {
    for (const state of this.extensions.values()) {
      if (name === 'tabs.onRemoved') state.activeGrants.delete(args[0]);
      this.emit(state, name, ...args);
    }
  }

  persist() {
    for (const [id, state] of this.extensions) {
      this.saved[id] = { grants: state.grants, alarms: [...state.alarms.values()].map(({ timer, ...alarm }) => alarm) };
    }
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.saved));
    renameSync(`${this.statePath}.tmp`, this.statePath);
  }

  schedule(state, alarm) {
    clearTimeout(state.alarms.get(alarm.name)?.timer);
    const delay = Math.min(2_147_483_647, Math.max(0, alarm.scheduledTime - Date.now()));
    const timer = setTimeout(() => {
      if (alarm.scheduledTime > Date.now() + 10) { this.schedule(state, alarm); return; }
      this.emit(state, 'alarms.onAlarm', alarm);
      state.alarms.delete(alarm.name);
      if (alarm.periodInMinutes) this.schedule(state, { ...alarm, scheduledTime: Date.now() + alarm.periodInMinutes * 60_000 });
      this.persist();
    }, delay);
    timer.unref();
    state.alarms.set(alarm.name, { ...alarm, timer });
  }

  allPermissions(state) {
    const permissions = state.manifest.permissions || [];
    return {
      permissions: [...new Set([...permissions.filter(item => !item.includes('://') && item !== '<all_urls>'), ...state.grants.permissions])],
      origins: [...new Set([...(state.manifest.host_permissions || []), ...permissions.filter(item => item.includes('://') || item === '<all_urls>'), ...state.grants.origins])],
    };
  }

  authorized(state, url, tabId) {
    if (url.startsWith(state.extension.url)) return true;
    if (this.allPermissions(state).origins.some(pattern => matchesExtensionOrigin(pattern, url))) return true;
    try { return state.activeGrants.get(tabId) === new URL(url).origin; } catch { return false; }
  }

  tab(state, id, inject = false) {
    const tab = this.getTabs().find(item => item.id === id);
    if (!tab || webContents.fromId(id)?.session !== this.session) throw new Error('Tab is unavailable in this extension profile');
    this.assertTabAllowed(tab);
    if (inject && !this.authorized(state, tab.url, id)) throw new Error('Website permission has not been granted');
    return tab;
  }

  async invoke(state, method, args) {
    const [first = {}, second] = args;
    if (method.startsWith('declarativeNetRequest.')) {
      if (state.extension.id !== 'eeagobfjdenkkddmbclomhiblgggliao') throw new Error('Network rule access denied');
      state.rules ||= new Map();
      if (method === 'declarativeNetRequest.getSessionRules') return [...state.rules.values()];
      if (method === 'declarativeNetRequest.updateSessionRules') { state.rules = updateTargetedRules(state.rules, first); return; }
      throw new Error('Unsupported network rule operation');
    }
    if (method === 'webRequest.subscribe') {
      if (!['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onErrorOccurred', 'onCompleted'].includes(first) || !this.allPermissions(state).permissions.includes('webRequest')) throw new Error('Unsupported network observation');
      if (!Array.isArray(second) || second.some(filter => !Array.isArray(filter.urls) || filter.urls.some(url => typeof url !== 'string'))) throw new Error('Invalid network filters');
      state.network ||= {};
      state.network[first] = second;
      return;
    }
    if (method === 'tabs.authorizeInjection') { this.tab(state, first, true); return true; }
    if (method === 'tabs.query') return this.getTabs().filter(tab => webContents.fromId(tab.id)?.session === this.session
      && (first.active === undefined || tab.active === first.active)
      && (!first.currentWindow || tab.windowId === this.getWindow()?.id)
      && (first.windowId === undefined || first.windowId === -2 || first.windowId === tab.windowId)
      && (!first.url || (Array.isArray(first.url) ? first.url : [first.url]).some(pattern => matchesExtensionOrigin(pattern, tab.url))));
    if (method === 'tabs.get') return this.tab(state, first);
    if (method === 'tabs.create') {
      const url = new URL(first.url || 'about:blank', state.extension.url);
      if (!['http:', 'https:', 'about:', 'chrome-extension:'].includes(url.protocol) || (url.protocol === 'chrome-extension:' && url.hostname !== state.extension.id)) throw new Error('Unsupported extension tab URL');
      return this.createTab({ ...first, url: url.href });
    }
    if (method === 'tabs.update') { const id = typeof first === 'number' ? first : this.getActiveTab()?.id; return this.updateTab(this.tab(state, id), typeof first === 'number' ? second : first); }
    if (method === 'tabs.remove') { for (const id of Array.isArray(first) ? first : [first]) await this.removeTab(this.tab(state, id)); return; }
    if (method.startsWith('windows.')) {
      const window = this.getWindow();
      if (!window) return method === 'windows.getAll' ? [] : { id: -2, focused: false, type: 'normal', incognito: false };
      const result = { id: window.id, focused: window.isFocused(), ...window.getBounds(), type: 'normal', incognito: false };
      if (method === 'windows.getAll') return [result];
      if (method === 'windows.update' && second?.focused) window.focus();
      return result;
    }
    if (method === 'runtime.openOptionsPage') {
      const path = state.manifest.options_ui?.page || state.manifest.options_page;
      if (!path) throw new Error('This extension has no options page');
      if (state.options && !state.options.isDestroyed()) { state.options.show(); state.options.focus(); return; }
      const url = new URL(path, state.extension.url);
      if (!url.href.startsWith(state.extension.url)) throw new Error('Invalid options page');
      const win = new BrowserWindow({ parent: this.getWindow(), width: 1100, height: 800, show: false, webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      state.options = win;
      win.on('closed', () => { state.options = null; });
      const openLinkedPage = (target, active = true) => {
        void this.invoke(state, 'tabs.create', [{ url: target, active }]).catch(error => {
          if (!win.isDestroyed()) void dialog.showMessageBox(win, { type: 'error', message: error.message });
        });
      };
      win.webContents.on('will-navigate', (event, target) => {
        if (!target.startsWith(state.extension.url)) { event.preventDefault(); openLinkedPage(target); }
      });
      win.webContents.setWindowOpenHandler(({ url, disposition }) => {
        openLinkedPage(url, disposition !== 'background-tab');
        return { action: 'deny' };
      });
      await win.loadURL(url.href);
      win.show();
      return;
    }
    if (method.startsWith('permissions.')) {
      const granted = this.allPermissions(state);
      const requested = { permissions: first.permissions || [], origins: first.origins || [] };
      if (method === 'permissions.getAll') return granted;
      if (method === 'permissions.contains') return requested.permissions.every(p => granted.permissions.includes(p)) && requested.origins.every(p => granted.origins.includes(p) || granted.origins.includes('<all_urls>'));
      if (method === 'permissions.request') {
        const allowedPermissions = [...(state.manifest.permissions || []), ...(state.manifest.optional_permissions || [])];
        const allowedOrigins = [...(state.manifest.host_permissions || []), ...(state.manifest.optional_host_permissions || []), ...allowedPermissions.filter(p => p.includes('://') || p === '<all_urls>')];
        if (!requested.permissions.every(p => allowedPermissions.includes(p)) || !requested.origins.every(p => allowedOrigins.includes(p) || allowedOrigins.includes('<all_urls>') || allowedOrigins.some(pattern => matchesExtensionOrigin(pattern, p.replace('*', 'example.com'))))) throw new Error('Permission is not declared by this extension');
        if (await this.invoke(state, 'permissions.contains', args)) return true;
        const answer = await dialog.showMessageBox(this.getWindow(), { type: 'question', title: state.extension.name, message: '允许此扩展访问以下内容？', detail: [...requested.permissions, ...requested.origins].join('\n'), buttons: ['取消', '允许'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return false;
        for (const key of ['permissions', 'origins']) state.grants[key] = [...new Set([...state.grants[key], ...requested[key]])];
        this.persist(); this.emit(state, 'permissions.onAdded', requested); return true;
      }
      if (method === 'permissions.remove') {
        for (const key of ['permissions', 'origins']) state.grants[key] = state.grants[key].filter(item => !requested[key].includes(item));
        this.persist(); this.emit(state, 'permissions.onRemoved', requested); return true;
      }
    }
    if (method.startsWith('storage.session.')) {
      const name = method.slice('storage.session.'.length);
      const keys = args[0] == null ? Object.keys(state.session) : typeof first === 'string' ? [first] : Array.isArray(first) ? first : Object.keys(first);
      if (name === 'get') return Object.fromEntries(keys.filter(key => Object.hasOwn(state.session, key) || (!Array.isArray(first) && typeof first === 'object' && Object.hasOwn(first, key))).map(key => [key, Object.hasOwn(state.session, key) ? state.session[key] : first[key]]));
      if (name === 'getBytesInUse') return Buffer.byteLength(JSON.stringify(Object.fromEntries(keys.filter(key => Object.hasOwn(state.session, key)).map(key => [key, state.session[key]]))));
      const next = { ...state.session };
      if (name === 'set') Object.assign(next, first);
      else if (name === 'remove') for (const key of keys) delete next[key];
      else if (name === 'clear') for (const key of Object.keys(next)) delete next[key];
      else throw new Error('Unsupported session storage method');
      if (Buffer.byteLength(JSON.stringify(next)) > 10 * 1024 * 1024) throw new Error('Session storage quota exceeded');
      const changes = Object.fromEntries([...new Set([...Object.keys(state.session), ...Object.keys(next)])].filter(key => JSON.stringify(state.session[key]) !== JSON.stringify(next[key])).map(key => [key, { ...(Object.hasOwn(state.session, key) ? { oldValue: state.session[key] } : {}), ...(Object.hasOwn(next, key) ? { newValue: next[key] } : {}) }]));
      state.session = next;
      if (Object.keys(changes).length) this.emit(state, 'storage.onChanged', changes, 'session');
      return;
    }
    if (method.startsWith('alarms.')) {
      const name = typeof first === 'string' ? first : '';
      const info = typeof first === 'string' ? second : first;
      const clean = alarm => { if (!alarm) return; const { timer, ...value } = alarm; return value; };
      if (method === 'alarms.get') return clean(state.alarms.get(name));
      if (method === 'alarms.getAll') return [...state.alarms.values()].map(clean);
      if (method === 'alarms.create') {
        if (!info || ![info.when, info.delayInMinutes, info.periodInMinutes].some(Number.isFinite)) throw new Error('Invalid alarm schedule');
        this.schedule(state, { name, scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes) * 60_000, ...(info.periodInMinutes ? { periodInMinutes: Math.max(0.5, info.periodInMinutes) } : {}) });
        this.persist(); return;
      }
      const names = method === 'alarms.clearAll' ? [...state.alarms.keys()] : [name];
      let removed = false;
      for (const key of names) { clearTimeout(state.alarms.get(key)?.timer); removed = state.alarms.delete(key) || removed; }
      this.persist(); return removed;
    }
    if (method.startsWith('action.')) {
      const name = method.slice(7);
      if (name === 'setTitle') state.action.title = first.title;
      else if (name === 'getTitle') return state.action.title || state.extension.name;
      else if (name === 'setBadgeText') state.action.badgeText = first.text;
      else if (name === 'getBadgeText') return state.action.badgeText || '';
      else if (name === 'setBadgeBackgroundColor') state.action.badgeColor = first.color;
      else if (name === 'setIcon') state.action.icon = first.path;
      return;
    }
    if (method.startsWith('contextMenus.')) {
      if (method === 'contextMenus.create') { state.menus.set(first.id, first); return first.id; }
      if (method === 'contextMenus.update') { if (!state.menus.has(first)) throw new Error('Unknown context menu'); state.menus.set(first, { ...state.menus.get(first), ...second }); return; }
      if (method === 'contextMenus.remove') { state.menus.delete(first); return; }
      if (method === 'contextMenus.removeAll') { state.menus.clear(); return; }
    }
    if (method.startsWith('cookies.')) {
      if (!this.allPermissions(state).permissions.includes('cookies')) throw new Error('Cookie permission denied');
      const operation = method.slice(8);
      if (operation === 'getAll' || operation === 'get') {
        const cookies = await this.session.cookies.get(first);
        const allowed = cookies.filter(cookie => this.authorized(state, first.url || `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`));
        return operation === 'get' ? allowed[0] || null : allowed;
      }
      if (!this.authorized(state, first.url)) throw new Error('Cookie website permission denied');
      if (operation === 'set') { await this.session.cookies.set(first); return (await this.session.cookies.get({ url: first.url, name: first.name }))[0]; }
      if (operation === 'remove') { await this.session.cookies.remove(first.url, first.name); return { url: first.url, name: first.name }; }
    }
    if (method === 'notifications.create') {
      const id = typeof first === 'string' ? first : randomUUID();
      const options = typeof first === 'string' ? second : first;
      const notification = new Notification({ title: options.title || state.extension.name, body: options.message || '' });
      state.notifications.set(id, notification);
      notification.on('click', () => this.emit(state, 'notifications.onClicked', id));
      notification.on('close', () => { state.notifications.delete(id); this.emit(state, 'notifications.onClosed', id, true); });
      notification.show(); return id;
    }
    if (method === 'notifications.clear') { const notification = state.notifications.get(first); notification?.close(); return Boolean(notification); }
    if (method === 'violentmonkey.initialData') {
      if (state.extension.id !== 'eeagobfjdenkkddmbclomhiblgggliao') throw new Error('Unsupported extension');
      if (!['popup', 'options', 'confirm'].includes(first)) throw new Error('Invalid extension page');
      const background = webContents.getAllWebContents().find(contents => contents.session === this.session && contents.getURL() === `${state.extension.url}electron-background.html`);
      if (!background) throw new Error('Extension background is unavailable');
      return background.executeJavaScript(`new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Extension data timed out')), 10000); Promise.resolve().then(() => globalThis.onfetch({request: new Request(${JSON.stringify(state.extension.url + 'get-data.js?' + first)}), respondWith: response => Promise.resolve(response).then(r => r.text()).then(text => { clearTimeout(timer); resolve(JSON.parse(text.slice('var BGDATA='.length))); }, reject)})).catch(reject); })`);
    }
    throw new Error(`Unsupported extension host method: ${method}`);
  }

  contextMenu(tab, params) {
    const items = [];
    for (const state of this.extensions.values()) for (const menu of state.menus.values()) {
      const contexts = menu.contexts || ['page'];
      if (menu.visible === false || !(contexts.includes('all') || contexts.includes('page') || (params.selectionText && contexts.includes('selection')) || (params.linkURL && contexts.includes('link')))) continue;
      if (menu.documentUrlPatterns && !menu.documentUrlPatterns.some(pattern => matchesExtensionOrigin(pattern, tab.url))) continue;
      items.push({ label: (menu.title || '').replace('%s', params.selectionText || ''), enabled: menu.enabled !== false, click: () => this.emit(state, 'contextMenus.onClicked', { menuItemId: menu.id, pageUrl: tab.url, selectionText: params.selectionText, linkUrl: params.linkURL }, tab) });
    }
    return items;
  }

  dispose() {
    this.persist();
    for (const id of [...this.extensions.keys()]) this.unregister(id);
    this.session.unregisterPreloadScript(this.preloadId);
    ipcMain.removeHandler('ego:extension-host');
    this.session.webRequest.onSendHeaders(null);
    this.session.webRequest.onResponseStarted(null);
    this.session.webRequest.onErrorOccurred(null);
    this.session.webRequest.onCompleted(null);
    this.session.webRequest.onBeforeRequest(null);
    this.session.webRequest.onBeforeSendHeaders(null);
    this.session.webRequest.onHeadersReceived(null);
  }
}
