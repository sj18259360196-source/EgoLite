// Serialized into the two supported extensions; it has no Node or Electron access.
export function installTargetedExtensionClient() {
  const api = globalThis.chrome;
  const host = globalThis.egoExtensionHost;
  if (!api || !host || globalThis.__egoTargetedExtension) return;
  globalThis.__egoTargetedExtension = true;
  globalThis.__egoExtensionErrors = [];
  addEventListener('error', event => globalThis.__egoExtensionErrors.push(event.error?.stack || event.message));
  addEventListener('unhandledrejection', event => globalThis.__egoExtensionErrors.push(event.reason?.stack || String(event.reason)));
  const events = new Map();
  const event = name => {
    if (!events.has(name)) {
      const listeners = new Set();
      events.set(name, {
        addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
        hasListener: fn => listeners.has(fn), hasListeners: () => listeners.size > 0,
        dispatch: (...args) => { for (const fn of listeners) { try { fn(...args); } catch (error) { console.error(error); } } },
      });
    }
    return events.get(name);
  };
  host.onEvent((name, args) => events.get(name)?.dispatch(...args));
  const call = (method, args) => host.call(method, args).then(result => {
    if (result.error) throw new Error(result.error);
    return result.value;
  });
  const dual = fn => (...args) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    const promise = Promise.resolve().then(() => fn(...args));
    if (!callback) return promise;
    promise.then(value => callback(value), error => {
      Object.defineProperty(api.runtime, 'lastError', { configurable: true, value: { message: error.message } });
      try { callback(); } finally { delete api.runtime.lastError; }
    });
  };
  const methods = (namespace, names) => {
    api[namespace] ||= {};
    for (const name of names) api[namespace][name] = dual((...args) => call(`${namespace}.${name}`, args));
  };
  methods('tabs', ['query', 'get', 'create', 'update', 'remove']);
  for (const name of ['onActivated', 'onUpdated', 'onRemoved', 'onReplaced']) api.tabs[name] = event(`tabs.${name}`);
  methods('windows', ['getCurrent', 'getAll', 'update']);
  api.windows.WINDOW_ID_CURRENT = -2;
  api.windows.onCreated = event('windows.onCreated');
  methods('runtime', ['openOptionsPage']);
  methods('permissions', ['contains', 'getAll', 'request', 'remove']);
  api.permissions.onAdded = event('permissions.onAdded');
  api.permissions.onRemoved = event('permissions.onRemoved');
  api.storage.session = {};
  for (const name of ['get', 'set', 'remove', 'clear', 'getBytesInUse']) {
    api.storage.session[name] = dual((...args) => call(`storage.session.${name}`, args));
  }
  api.storage.session.QUOTA_BYTES = 10 * 1024 * 1024;
  const nativeChanges = api.storage.onChanged;
  const sessionChanges = event('storage.onChanged');
  api.storage.onChanged = {
    addListener(fn) { nativeChanges?.addListener(fn); sessionChanges.addListener(fn); },
    removeListener(fn) { nativeChanges?.removeListener(fn); sessionChanges.removeListener(fn); },
    hasListener(fn) { return nativeChanges?.hasListener(fn) || sessionChanges.hasListener(fn); },
  };
  methods('alarms', ['create', 'get', 'getAll', 'clear', 'clearAll']);
  api.alarms.onAlarm = event('alarms.onAlarm');
  methods('action', ['setTitle', 'getTitle', 'setBadgeText', 'getBadgeText', 'setBadgeBackgroundColor', 'setIcon']);
  api.action.onClicked = event('action.onClicked');
  api.browserAction = api.action;
  methods('contextMenus', ['update', 'remove', 'removeAll']);
  let menuId = 0;
  api.contextMenus.create = (properties, callback) => {
    const id = properties.id ?? `ego-menu-${++menuId}`;
    dual(p => call('contextMenus.create', [p]))({ ...properties, id }, callback || (() => {}));
    return id;
  };
  api.contextMenus.onClicked = event('contextMenus.onClicked');
  methods('notifications', ['create', 'clear']);
  api.notifications.onClicked = event('notifications.onClicked');
  api.notifications.onClosed = event('notifications.onClosed');
  api.commands ||= { onCommand: event('commands.onCommand'), getAll: dual(() => []) };
  api.extension.isAllowedIncognitoAccess ||= dual(() => false);
  api.extension.isAllowedFileSchemeAccess ||= dual(() => false);
  api.runtime.getBrowserInfo ||= dual(() => ({ name: 'EgoLite', vendor: 'EgoLite', version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '0' }));

  const nativeExecute = api.tabs.executeScript.bind(api.tabs);
  const execute = async (tabId, details) => {
    await call('tabs.authorizeInjection', [tabId]);
    return new Promise((resolve, reject) => nativeExecute(tabId, details, values => {
      if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message));
      else resolve(values);
    }));
  };
  api.tabs.executeScript = dual(execute);
  api.scripting ||= {};
  api.scripting.executeScript = dual(async details => {
    if (details.target.allFrames) throw new Error('allFrames result mapping is not supported by this adapter; use explicit frameIds');
    if (details.world && details.world !== 'ISOLATED') throw new Error('MAIN world scripting is not supported by this adapter');
    const frameIds = details.target.frameIds || [undefined];
    const results = [];
    for (const frameId of frameIds) {
      const base = { ...(frameId === undefined ? {} : { frameId }), allFrames: Boolean(details.target.allFrames), runAt: details.injectImmediately ? 'document_start' : 'document_idle' };
      const sources = details.files?.map(file => ({ file })) || [{ code: `(${details.func.toString()})(...${JSON.stringify(details.args || [])})` }];
      let values;
      for (const source of sources) values = await execute(details.target.tabId, { ...base, ...source });
      results.push({ frameId: frameId || 0, result: values?.[0] });
    }
    return results;
  });

  if (/violentmonkey/i.test(api.runtime.getManifest().name) || api.runtime.id === 'eeagobfjdenkkddmbclomhiblgggliao') {
    api.webRequest = {};
    for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onErrorOccurred', 'onCompleted']) {
      const listeners = event(`webRequest.${name}`);
      const registrations = new Map();
      const matches = (pattern, url) => {
        if (pattern === '<all_urls>') return /^(https?|file):/.test(url);
        return new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(url);
      };
      const subscribe = () => call('webRequest.subscribe', [name, [...registrations.values()].map(item => item.filter)]).catch(console.error);
      api.webRequest[name] = {
        ...listeners,
        addListener(fn, filter, options = []) {
          if (options.includes('blocking')) throw new Error('Blocking webRequest is not supported by this adapter');
          if (registrations.has(fn)) return;
          const wrapped = details => {
            if (filter.urls.some(pattern => matches(pattern, details.url)) && (!filter.types || filter.types.includes(details.type))) return fn(details);
          };
          registrations.set(fn, { filter, wrapped });
          listeners.addListener(wrapped);
          subscribe();
        },
        removeListener(fn) { const entry = registrations.get(fn); if (entry) listeners.removeListener(entry.wrapped); registrations.delete(fn); subscribe(); },
        hasListener: fn => registrations.has(fn),
      };
    }
    api.webRequest.OnBeforeSendHeadersOptions = { EXTRA_HEADERS: 'extraHeaders' };
    api.webRequest.OnHeadersReceivedOptions = { EXTRA_HEADERS: 'extraHeaders' };
    const getManifest = api.runtime.getManifest.bind(api.runtime);
    api.runtime.getManifest = () => { const manifest = getManifest(); manifest.action ||= manifest.browser_action; return manifest; };
    api.webNavigation ||= {};
    api.webNavigation.onCommitted = event('webNavigation.onCommitted');
    // The two bootstrap files are registered in the runtime manifest. VM owns scripts and GM storage.
    api.userScripts = {
      getScripts: dual(() => [{ id: '1001', js: [{ file: 'injected-web.js' }, { file: 'injected.js' }] }]),
      execute: dual(async ({ target, js, injectImmediately }) => {
        const results = [];
        for (const frameId of target.frameIds || [0]) for (const item of js) {
          const values = await execute(target.tabId, { ...item, frameId, runAt: injectImmediately ? 'document_start' : 'document_idle' });
          results.push({ frameId, result: values?.[0] });
        }
        return results;
      }),
    };
    api.cookies ||= {};
    for (const name of ['get', 'getAll', 'set', 'remove']) api.cookies[name] = dual((...args) => call(`cookies.${name}`, args));
    api.identity ||= {};
    api.identity.getRedirectURL = path => `https://${api.runtime.id}.chromiumapp.org/${path || ''}`;
    api.identity.launchWebAuthFlow = dual(() => { throw new Error('Cloud sync authorization is not supported by this adapter'); });
    api.declarativeNetRequest = {
      getDynamicRules: dual(() => []), getSessionRules: dual(() => call('declarativeNetRequest.getSessionRules', [])),
      updateDynamicRules: dual(({ addRules = [] }) => { if (addRules.length) throw new Error('Dynamic DNR rules are not supported by this adapter'); }),
      updateSessionRules: dual(rules => call('declarativeNetRequest.updateSessionRules', [rules])),
    };
    let offscreen;
    api.offscreen = {
      hasDocument: dual(() => Boolean(offscreen)),
      createDocument: dual(async ({ url }) => {
        if (offscreen) throw new Error('Only a single offscreen document may be created');
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) throw new Error('Offscreen document must belong to this extension');
        offscreen = document.createElement('iframe');
        offscreen.hidden = true;
        await new Promise((resolve, reject) => { offscreen.onload = resolve; offscreen.onerror = reject; offscreen.src = target.href; document.body.append(offscreen); });
      }),
      closeDocument: dual(() => { offscreen?.remove(); offscreen = null; }),
    };
    globalThis.clients = {
      claim: async () => {},
      matchAll: async () => offscreen ? [{ url: offscreen.src, postMessage: (data, ports) => offscreen.contentWindow.postMessage(data, location.origin, ports) }] : [],
    };
    const routeWorkerMessages = target => {
      let listener;
      Object.defineProperty(target, 'onmessage', { configurable: true, get: () => listener, set: value => { listener = value; } });
      window.addEventListener('message', message => {
        if (message.origin !== location.origin || ![parent, offscreen?.contentWindow].includes(message.source)) return;
        listener?.({ data: message.data, source: { postMessage: (data, ports) => message.source.postMessage(data, location.origin, ports) } });
      });
    };
    globalThis.importScripts = (...urls) => { if (urls.some(url => !url.endsWith('/public/lib/tld.js'))) throw new Error('Unsupported worker import'); };
    // VM's offscreen page uses service-worker messaging; the adapted background is its parent.
    if (location.pathname === '/offscreen/index.html') {
      const controller = { postMessage: (data, ports) => parent.postMessage(data, location.origin, ports) };
      const worker = { controller, ready: Promise.resolve({ active: controller }), addEventListener: (...args) => window.addEventListener(...args) };
      routeWorkerMessages(worker);
      Object.defineProperty(navigator, 'serviceWorker', { value: worker });
    } else if (location.pathname === '/electron-background.html') routeWorkerMessages(globalThis);
    else if (/^\/(popup|options|confirm)\//.test(location.pathname)) {
      // VM's UI uses serviceWorker messaging for settings and installer data.
      // The MV2 background receives the same commands through runtime messaging.
      const worker = { onmessage: null };
      const sendMessage = api.runtime.sendMessage.bind(api.runtime);
      const controller = { postMessage: ({ id, msg }) => {
        if (!msg) return;
        const command = typeof msg === 'string' ? JSON.parse(msg) : msg;
        sendMessage(command, response => {
          const failure = api.runtime.lastError;
          const [res, err] = Array.isArray(response) ? response : [response];
          worker.onmessage?.({ data: { id, res, err: failure ? { message: failure.message } : err }, source: controller });
        });
      } };
      Object.assign(worker, { controller, ready: Promise.resolve({ active: controller }) });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    }
  }
}
