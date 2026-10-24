import { resolvePackEntry } from "./cos-runtime.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CosPageAgent } from "./cos-page-agent.mjs";
import { validateScriptTarget } from "./cos-frames.mjs";

const GROUP_PREFIX = 'cos-tab-group:';
const GROUP_COLORS = { grey: '#888888', blue: '#4285f4', red: '#ea4335', yellow: '#fbbc04', green: '#34a853', pink: '#f28b82', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa7b17' };
let nextGroupId = Date.now();

export class CosBrowser {
  #options;
  #stopped = false;
  #attached = new Map();
  #pages;
  constructor(options) {
    this.#options = options;
    if (options.message) this.#pages = new CosPageAgent({
      ...options,
      checkTab: id => this.#public(this.#tab(id)),
    });
  }

  #check() {
    if (this.#stopped || !this.#options.enabled()) throw new Error("CoS browser adapter is stopped");
  }
  #tabs() { return this.#options.tabs().filter(tab => tab.taskId === this.#options.taskId() && tab.webContentsId); }
  #tab(id) {
    const tab = this.#tabs().find(item => item.webContentsId === id);
    if (!tab) throw new Error("Browser tab is outside the CoS workspace or has closed");
    return tab;
  }
  #public(tab) {
    const contents = this.#options.contents(tab);
    return {
      id: tab.webContentsId, windowId: this.#options.windowId(), index: tab.order || 0,
      url: contents.getURL() || tab.url, title: contents.getTitle() || tab.title,
      active: tab.active === true, pinned: tab.pinned === true,
      status: contents.isLoading() ? "loading" : "complete",
      discarded: tab.sleeping === true, incognito: false,
      autoDiscardable: tab.autoDiscardable !== false,
      mutedInfo: { muted: contents.isAudioMuted?.() ?? tab.muted === true },
      groupId: this.#groupId(tab),
    };
  }
  #window() { return { id: this.#options.windowId(), type: "normal", state: "normal", focused: false, tabs: this.#tabs().map(tab => this.#public(tab)) }; }
  #groupId(tab) {
    const id = String(tab.groupId || '').startsWith(GROUP_PREFIX) ? Number(tab.groupId.slice(GROUP_PREFIX.length)) : -1;
    return Number.isSafeInteger(id) && id > 0 ? id : -1;
  }
  #groups() {
    return [...new Map(this.#tabs().filter(tab => this.#groupId(tab) !== -1).map(tab => [this.#groupId(tab), {
      id: this.#groupId(tab), windowId: this.#options.windowId(), title: tab.groupTitle || '',
      color: Object.keys(GROUP_COLORS).find(color => GROUP_COLORS[color] === tab.groupColor) || 'grey',
      collapsed: tab.groupCollapsed === true,
    }])).values()];
  }
  #group(id) {
    const group = this.#groups().find(group => group.id === id);
    if (!group) throw new Error('Tab group is outside the CoS workspace or has closed');
    return group;
  }
  async prepareTab(tab) {
    this.#check();
    this.#tab(tab.webContentsId);
    await this.#pages?.attach(tab);
    this.#check();
  }
  async resumePages() {
    this.#check();
    return this.#options.runMutation(async () => {
      for (const tab of this.#tabs()) {
        this.#check();
        if (!tab.sleeping) await this.prepareTab(tab);
      }
    });
  }
  async call(method, args = [], { visual = false } = {}) {
    this.#check();
    if (method === "tabs.query") {
      const query = args[0] || {};
      const patterns = query.url == null ? null : Array.isArray(query.url) ? query.url : [query.url];
      return this.#tabs().map(tab => this.#public(tab)).filter(tab =>
        (query.active === undefined || tab.active === query.active)
        && (query.groupId === undefined || tab.groupId === query.groupId)
        && (query.windowId === undefined || query.windowId === tab.windowId)
        && (!patterns || patterns.some(pattern => {
          const regex = String(pattern).split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
          return new RegExp(`^${regex}$`).test(tab.url);
        })));
    }
    if (method === "tabs.get") return this.#public(this.#tab(args[0]));
    if (method === "windows.get") {
      if (args[0] !== this.#options.windowId()) throw new Error("Window is outside the CoS workspace");
      return this.#window();
    }
    if (method === 'windows.getAll' || method === 'windows.getLastFocused') {
      const valid = !args[0]?.windowTypes || args[0].windowTypes.includes('normal');
      if (method === 'windows.getAll') return valid ? [this.#window()] : [];
      if (!valid) throw new Error('No matching CoS window');
      return this.#window();
    }
    if (method === 'tabGroups.get') return this.#group(args[0]);
    if (method === 'tabGroups.query') {
      const query = args[0] || {};
      return this.#groups().filter(group => ['windowId', 'title', 'color', 'collapsed'].every(key => query[key] === undefined || query[key] === group[key]));
    }
    if (method === "permissions.contains") {
      const allowed = new Set(["debugger", "tabs", "storage", "scripting", "alarms", "tabGroups"]);
      return (args[0]?.permissions || []).every(permission => allowed.has(permission))
        && !(args[0]?.origins?.length);
    }
    if (method === "debugger.getTargets") {
      return this.#tabs().map(tab => ({ id: tab.targetId, tabId: tab.webContentsId, type: "page", title: tab.title, url: tab.url, attached: this.#attached.has(tab.webContentsId) }));
    }
    return this.#options.runMutation(async () => {
      this.#check();
      if (method === 'tabs.group') {
        const details = args[0] || {};
        const ids = Array.isArray(details.tabIds) ? details.tabIds : [details.tabIds];
        if (!ids.length) throw new Error('CoS group needs tabs');
        const tabs = ids.map(id => this.#tab(id));
        if (details.createProperties?.windowId !== undefined && details.createProperties.windowId !== this.#options.windowId()) throw new Error('Group is outside the CoS workspace');
        const group = details.groupId === undefined ? { id: ++nextGroupId, title: '', color: 'grey', collapsed: false } : this.#group(details.groupId);
        for (const tab of tabs) await this.#options.update(tab.targetId, { groupId: GROUP_PREFIX + group.id, groupTitle: group.title, groupColor: GROUP_COLORS[group.color], groupCollapsed: group.collapsed });
        return group.id;
      }
      if (method === 'tabs.ungroup') {
        const tabs = (Array.isArray(args[0]) ? args[0] : [args[0]]).map(id => this.#tab(id));
        for (const tab of tabs) await this.#options.update(tab.targetId, { groupId: '', groupTitle: '', groupColor: '', groupCollapsed: false });
        return;
      }
      if (method === 'tabGroups.update') {
        const group = this.#group(args[0]);
        const patch = args[1] || {};
        if (patch.color !== undefined && !Object.hasOwn(GROUP_COLORS, patch.color)) throw new Error('Invalid CoS group color');
        if (patch.title !== undefined && typeof patch.title !== 'string' || patch.collapsed !== undefined && typeof patch.collapsed !== 'boolean') throw new Error('Invalid CoS group properties');
        const updated = { ...group, ...Object.fromEntries(['title', 'color', 'collapsed'].filter(key => patch[key] !== undefined).map(key => [key, patch[key]])) };
        for (const tab of this.#tabs().filter(tab => this.#groupId(tab) === group.id)) {
          await this.#options.update(tab.targetId, { groupTitle: updated.title, groupColor: GROUP_COLORS[updated.color], groupCollapsed: updated.collapsed });
        }
        await this.#options.setGroupCollapsed?.(GROUP_PREFIX + group.id, updated.collapsed);
        return updated;
      }
      if (method === "tabs.create" || method === "windows.create") {
        const details = args[0] || {};
        if (details.windowId !== undefined && details.windowId !== this.#options.windowId()) throw new Error("Window is outside the CoS workspace");
        if (method === 'windows.create' && details.tabId !== undefined) {
          const tab = this.#public(this.#tab(details.tabId));
          return { ...this.#window(), tabs: [tab] };
        }
        const urls = Array.isArray(details.url) ? details.url : [details.url || "about:blank"];
        if (method === "tabs.create" && Array.isArray(details.url) || !urls.length || urls.some(url => typeof url !== "string")) throw new Error("Invalid CoS tab URLs");
        const normalized = urls.map(url => this.#options.url ? this.#options.url(url) : url);
        const opened = [];
        for (const [index, url] of normalized.entries()) {
          this.#check();
          const created = await this.#options.create(this.#pages ? "about:blank" : url, { active: index === 0 && details.active !== false, visual: index === 0 && visual });
          this.#check();
          const tab = this.#tabs().find(item => item.targetId === created.targetId);
          if (!tab) throw new Error("Created CoS tab was not registered");
          if (this.#pages) {
            await this.#pages.attach(tab);
            this.#check();
            if (url !== "about:blank") await this.#options.contents(tab).loadURL(url);
          }
          opened.push(this.#public(tab));
        }
        return method === "windows.create" ? { ...this.#window(), tabs: opened } : opened[0];
      }
      if (method === "windows.update") {
        if (args[0] !== this.#options.windowId()) throw new Error("Window is outside the CoS workspace");
        // Upstream background windows are logical groups; never minimize the user's Ego window.
        return { ...this.#window(), state: args[1]?.state || "normal" };
      }
      if (method === "tabs.remove") {
        for (const id of Array.isArray(args[0]) ? args[0] : [args[0]]) {
          this.#check();
          const tab = this.#tab(id);
          await this.#options.remove(tab.targetId);
          if (!this.#pages) this.#options.event("tabs.onRemoved", id, { windowId: this.#options.windowId(), isWindowClosing: false });
        }
        return;
      }
      if (method === "tabs.move") {
        const moving = [...new Set(Array.isArray(args[0]) ? args[0] : [args[0]])].map(id => this.#tab(id));
        if (!moving.length) throw new Error("CoS tab list cannot be empty");
        if (args[1]?.windowId !== undefined && args[1].windowId !== this.#options.windowId()) throw new Error("CoS cannot move tabs out of its workspace");
        const ordered = this.#tabs().sort((a, b) => (a.order || 0) - (b.order || 0)).filter(item => !moving.includes(item));
        const index = args[1]?.index;
        if (!Number.isInteger(index) || index < -1) throw new Error("CoS tab index must be -1 or a nonnegative integer");
        ordered.splice(index === -1 ? ordered.length : Math.min(index, ordered.length), 0, ...moving);
        await this.#options.reorder(ordered.map(item => item.targetId));
        return Array.isArray(args[0]) ? moving.map(tab => this.#public(tab)) : this.#public(moving[0]);
      }
      if (method === "tabs.update" || method === "tabs.reload") {
        const tab = this.#tab(args[0]);
        const contents = this.#options.contents(tab);
        await this.#pages?.attach(tab);
        if (method === "tabs.reload") {
          if (args[1]?.bypassCache) contents.reloadIgnoringCache();
          else contents.reload();
        }
        else {
          const details = args[1] || {};
          const patch = Object.fromEntries(["autoDiscardable", "pinned", "muted"]
            .filter(key => typeof details[key] === "boolean").map(key => [key, details[key]]));
          if (Object.keys(patch).length) await this.#options.update(tab.targetId, patch);
          if (typeof details.muted === "boolean") contents.setAudioMuted(details.muted);
          if (details.url) await contents.loadURL(this.#options.url(details.url));
          this.#check();
          if (details.active) await this.#options.activate(tab.targetId, { visual: false });
        }
        return this.#public(tab);
      }
      if (method === "tabs.sendMessage") {
        this.#tab(args[0]);
        if (!this.#pages) throw new Error("CoS page messaging is unavailable");
        return this.#pages.send(args[0], args[1], args[2]);
      }
      if (method === "debugger.attach") {
        const id = args[0]?.tabId;
        const contents = this.#options.contents(this.#tab(id));
        const debuggerApi = contents.debugger;
        if (this.#attached.has(id)) throw new Error("CoS debugger is already attached");
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        const message = (_event, name, params, sessionId) => this.#options.event("debugger.onEvent", { tabId: id, ...(sessionId ? { sessionId } : {}) }, name, params);
        const detach = (_event, reason) => {
          debuggerApi.removeListener("message", message);
          this.#attached.delete(id);
          this.#options.event("debugger.onDetach", { tabId: id }, reason);
        };
        contents.debugger.on("message", message);
        contents.debugger.once("detach", detach);
        this.#attached.set(id, { debugger: debuggerApi, message, detach });
        return;
      }
      if (method === "debugger.detach") {
        this.#tab(args[0]?.tabId);
        this.#detach(args[0].tabId);
        return;
      }
      if (method === "debugger.sendCommand") {
        const source = args[0] || {};
        const tab = this.#tab(source.tabId);
        if (!this.#attached.has(source.tabId)) throw new Error("CoS debugger is not attached");
        const name = args[1];
        if (name.startsWith("Browser.") || name.startsWith("Target.") && name !== "Target.setAutoAttach") {
          throw new Error("Browser-global CDP is outside the CoS page scope");
        }
        const contents = this.#options.contents(tab);
        if (name === "Page.captureScreenshot" && !source.sessionId) {
          await this.#options.prepareCapture?.(contents);
          this.#check();
          let timer;
          try {
            return await Promise.race([
              this.#options.sendCommand(contents, name, args[2] || {}),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CoS page capture timed out')), 3000); }),
            ]);
          } catch (error) {
            const params = args[2] || {};
            if (params.clip || params.captureBeyondViewport || params.format && params.format !== 'png') throw error;
            clearTimeout(timer);
            const image = await Promise.race([
              contents.capturePage(undefined, { stayAwake: true }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CoS compositor capture timed out')), 7000); }),
            ]);
            this.#check();
            if (image.isEmpty()) throw new Error('CoS page capture returned an empty image');
            return { data: image.toPNG().toString('base64') };
          } finally { clearTimeout(timer); }
        }
        return this.#options.sendCommand(contents, name, args[2] || {}, source.sessionId);
      }
      if (method === "scripting.executeScript" || method === "scripting.insertCSS") {
        const details = args[0] || {};
        const tab = this.#tab(details.target?.tabId);
        const contents = this.#options.contents(tab);
        validateScriptTarget(details.target || {});
        const sources = [];
        for (const file of details.files || []) {
          sources.push(await readFile(resolvePackEntry(join(this.#options.directory, "source/extension"), file), "utf8"));
        }
        this.#check();
        if (method === "scripting.insertCSS") {
          if (this.#pages && (details.target.allFrames || details.target.frameIds || details.target.documentIds)) {
            if (details.origin && details.origin !== "AUTHOR") throw new Error("CoS frame CSS currently requires AUTHOR origin");
            await this.#pages.execute(tab, "", details.target, "ISOLATED", details.css || sources.join("\n"));
            return;
          }
          await contents.insertCSS(details.css || sources.join("\n"), { cssOrigin: (details.origin || "AUTHOR").toLowerCase() });
          return;
        }
        const code = details.functionSource
          ? `(${details.functionSource})(...${JSON.stringify(details.args || [])})`
          : sources.join("\n");
        const documents = details.target?.documentIds;
        if (this.#pages) return this.#pages.execute(tab, code, details.target, details.world);
        if (documents) throw new Error("CoS document targeting is unavailable");
        if (details.target.allFrames || details.target.frameIds?.some(id => id !== 0)) throw new Error("CoS frame targeting is unavailable");
        const result = details.world === "MAIN"
          ? await contents.executeJavaScript(code)
          : await contents.executeJavaScriptInIsolatedWorld(1002, [{ code }]);
        return [{ frameId: 0, result }];
      }
      throw new Error(`CoS browser method is not connected yet: ${method}`);
    });
  }
  #detach(id) {
    const attachment = this.#attached.get(id);
    if (!attachment) return;
    attachment.debugger.removeListener("message", attachment.message);
    attachment.debugger.removeListener("detach", attachment.detach);
    this.#attached.delete(id);
    // Ego owns the physical debugger connection and may have other active observers.
  }
  preferencesChanged(changes) { return this.#pages?.preferencesChanged(changes); }
  async stop() {
    this.#stopped = true;
    for (const id of this.#attached.keys()) this.#detach(id);
    await this.#pages?.stop();
    for (const tab of this.#tabs()) this.#options.update?.(tab.targetId, { autoDiscardable: true });
  }
}
