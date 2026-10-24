const HOST = "com.egocompat.bridge";
const spaces = new Map();
const sessions = new Map();
const tabSessions = new Map();
const expectedDetaches = new Set();
const uiRequests = new Map();
const pendingPopups = [];
let nativePort;
let reconnectTimer;
const ready = hydrateSpaces();

connectNative();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void ready.then(() => handleUiMessage(message, sender)).then(sendResponse, (error) =>
    sendResponse({ error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const space of spaces.values()) space.tabs.delete(tabId);
  const sessionId = tabSessions.get(tabId);
  if (sessionId) sessions.delete(sessionId);
  tabSessions.delete(tabId);
  persistSpaces();
});

chrome.tabs.onCreated.addListener((tab) => {
  void inheritPopupTab(tab);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const owner = taskForTab(tabId);
  const tab = owner ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (owner && tab) emit("tab.changed", { taskId: owner.taskId, tab: publicTab(tab, true) });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!taskForTab(tabId)) void inheritPopupTab(tab);
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") return;
  const owner = taskForTab(tabId);
  if (owner) emit("tab.changed", { taskId: owner.taskId, tab: publicTab(tab, tab.active) });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const rootSession = tabSessions.get(source.tabId);
  if (!rootSession) return;
  const session = sessions.get(rootSession);
  if (!session) return;
  if (method === "Page.windowOpen") {
    pendingPopups.push({
      taskId: session.taskId,
      url: typeof params?.url === "string" ? params.url : "",
      createdAt: Date.now(),
    });
    prunePendingPopups();
  }
  if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
    sessions.set(params.sessionId, { taskId: session.taskId, tabId: source.tabId });
  } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
    sessions.delete(params.sessionId);
  }
  emit("cdp.event", {
    taskId: session.taskId,
    payload: JSON.stringify({
      method,
      params,
      sessionId: source.sessionId || rootSession,
    }),
  });
});

async function inheritPopupTab(tab) {
  if (!tab?.id || taskForTab(tab.id)) return;
  const openerOwner = tab.openerTabId ? taskForTab(tab.openerTabId) : undefined;
  prunePendingPopups();
  const exactIndex = tab.url
    ? pendingPopups.findIndex((popup) => popup.url === tab.url)
    : -1;
  const pendingIndex = exactIndex >= 0 ? exactIndex : pendingPopups.length ? 0 : -1;
  const pending = pendingIndex >= 0 ? pendingPopups.splice(pendingIndex, 1)[0] : undefined;
  const owner = openerOwner || (pending ? spaces.get(pending.taskId) : undefined);
  if (!owner || owner.tabs.has(tab.id)) return;
  owner.tabs.add(tab.id);
  owner.windowId = tab.windowId;
  await chrome.storage.session.set({ [`ego-tab-${tab.id}`]: owner.taskId });
  await persistSpaces();
  emit("tab.changed", { taskId: owner.taskId, tab: publicTab(tab, Boolean(tab.active)) });
  await notifyUi();
}

function prunePendingPopups() {
  const cutoff = Date.now() - 5_000;
  while (pendingPopups[0] && pendingPopups[0].createdAt < cutoff) pendingPopups.shift();
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const sessionId = tabSessions.get(source.tabId);
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  if (session) {
    emit("cdp.event", {
      taskId: session.taskId,
      payload: JSON.stringify({
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: targetId(source.tabId), reason },
      }),
    });
    if (!expectedDetaches.delete(source.tabId)) {
      emit("control.lost", { taskId: session.taskId, reason: `debugger-detached:${reason}` });
    }
  }
  sessions.delete(sessionId);
  tabSessions.delete(source.tabId);
});

async function handleUiMessage(message, sender) {
  if (message?.method === "content.selectionChanged") {
    const tab = sender.tab;
    const owner = tab?.id ? taskForTab(tab.id) : undefined;
    if (owner && typeof message.text === "string") {
      emit("text.selectionChanged", {
        taskId: owner.taskId,
        selection: {
          text: message.text,
          sourceUrl: tab.url || "",
          pageTitle: tab.title || "",
          favicon: tab.favIconUrl || null,
        },
      });
    }
    return { ok: true };
  }
  if (message?.method === "ui.state") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      connected: Boolean(nativePort),
      spaces: [...spaces.values()].map(publicSpace),
      currentTab: tab ? { id: tab.id, title: tab.title, url: tab.url } : undefined,
    };
  }
  if (message?.method === "ui.chatState") {
    return requestBroker("chat.state", { query: message.query || "" });
  }
  if (message?.method === "ui.chatPageContent") {
    return requestBroker("chat.pageContent", { targetId: message.targetId });
  }
  if (message?.method === "ui.chatSaveSelection") {
    return requestBroker("chat.saveSelection", {
      text: message.text,
      sourceUrl: message.sourceUrl,
    });
  }
  if (message?.method === "ui.chatActivateTab") {
    return requestBroker("chat.activateTab", { targetId: message.targetId });
  }
  if (message?.method === "ui.chatCloseTab") {
    return requestBroker("chat.closeTab", { targetId: message.targetId });
  }
  if (message?.method === "ui.chatSend") {
    return requestBroker("chat.send", {
      prompt: message.prompt,
      context: message.context || "",
    });
  }
  if (message?.method === "ui.adoptCurrentTab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active browser tab");
    const space = requireSpace(message.taskId);
    space.tabs.add(tab.id);
    space.windowId = tab.windowId;
    await chrome.storage.session.set({ [`ego-tab-${tab.id}`]: message.taskId });
    await persistSpaces();
    return { ok: true };
  }
  if (message?.method === "ui.takeControl") {
    await relinquishTask(message.taskId, "user-requested");
    return { ok: true };
  }
  if (message?.method === "ui.authorizeTakeover") {
    const space = requireSpace(message.taskId);
    if (space.ownership !== "agentDelegatedToUser") {
      throw new Error("Task is not under delegated user control");
    }
    emit("control.takeoverAuthorized", { taskId: message.taskId });
    return { ok: true };
  }
  throw new Error("Unknown extension UI command");
}

function connectNative() {
  if (nativePort) return;
  const port = chrome.runtime.connectNative(HOST);
  nativePort = port;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  void ready.then(async () => {
    for (const space of spaces.values()) await detachTask(space);
    emit("bridge.ready", {
      recoveredTaskIds: [...spaces.keys()],
      reason: "extension-reconnected",
    });
  });
  port.onMessage.addListener((message) => {
    const pending = message?.id ? uiRequests.get(message.id) : undefined;
    if (pending) {
      uiRequests.delete(message.id);
      clearTimeout(pending.timer);
      message.error
        ? pending.reject(new Error(message.error.message || "Broker request failed"))
        : pending.resolve(message.result);
      return;
    }
    void handleCommand(message);
  });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    nativePort = undefined;
    for (const pending of uiRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Native Host disconnected"));
    }
    uiRequests.clear();
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectNative();
      }, 1000);
    }
  });
}

function requestBroker(method, params = {}) {
  if (!nativePort) return Promise.reject(new Error("本地服务未连接"));
  const id = `ui-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      uiRequests.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, 15_000);
    uiRequests.set(id, { resolve, reject, timer });
    nativePort.postMessage({ id, method, params });
  });
}

async function handleCommand(command) {
  try {
    await ready;
    const result = await dispatch(command.method, command.params || {});
    nativePort?.postMessage({ id: command.id, result });
  } catch (error) {
    nativePort?.postMessage({
      id: command.id,
      error: {
        code: error?.code || "EGO_OPERATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "space.create": {
      spaces.set(params.taskId, {
        taskId: params.taskId,
        name: params.name,
        tabs: new Set(),
        ownership: "agent",
        lifecycle: "active",
      });
      await persistSpaces();
      return {};
    }
    case "space.state": {
      const space = requireSpace(params.taskId);
      space.ownership = params.ownership;
      space.lifecycle = params.lifecycle;
      space.leaseEpoch = params.leaseEpoch;
      await persistSpaces();
      await notifyUi();
      return {};
    }
    case "space.close": {
      const space = requireSpace(params.taskId);
      await detachTask(space);
      if (space.tabs.size) await chrome.tabs.remove([...space.tabs]);
      spaces.delete(params.taskId);
      await persistSpaces();
      return {};
    }
    case "space.handoff":
      await detachTask(requireSpace(params.taskId));
      return {};
    case "tab.list":
      return listTabs(params.taskId);
    case "tab.create": {
      const space = requireSpace(params.taskId);
      const tab = await chrome.tabs.create({
        url: params.url || "about:blank",
        active: false,
        ...(space.windowId ? { windowId: space.windowId } : {}),
      });
      space.tabs.add(tab.id);
      space.windowId = tab.windowId;
      await persistSpaces();
      return publicTab(tab, false);
    }
    case "cdp.send":
      return sendCdp(params.taskId, params.payload);
    case "snapshot.capture":
      return captureSnapshot(params.taskId, params.options || {}, params.targetId);
    case "page.aiContent": {
      const tabs = await listTabs(params.taskId);
      const tab = tabs.find((item) => item.targetId === params.targetId);
      if (!tab) throw protocolError("EGO_WEB_CONTENTS_UNAVAILABLE", "Tab is outside the selected task");
      const captured = await capturePage(params.taskId, {
        includeActionMarks: true,
        includeStableLocator: true,
        ...(params.options || {}),
      }, params.targetId);
      return {
        title: tab.title,
        url: tab.url,
        ...captured.snapshot,
        rootNode: buildAIPageTree(captured.nodes),
      };
    }
    default:
      throw protocolError("EGO_INVALID_ARGUMENT", `Unknown companion method: ${method}`);
  }
}

async function sendCdp(taskId, payload) {
  const request = JSON.parse(payload);
  const params = request.params || {};
  try {
    let result;
    switch (request.method) {
      case "Target.getTargets":
        result = { targetInfos: await targetInfos(taskId) };
        break;
      case "Target.attachToTarget":
        result = await attachTarget(taskId, params.targetId);
        break;
      case "Target.activateTarget":
        await activateTarget(taskId, params.targetId);
        result = {};
        break;
      case "Target.closeTarget":
        await closeTarget(taskId, params.targetId);
        result = { success: true };
        break;
      case "Target.createTarget": {
        const tab = await dispatch("tab.create", { taskId, url: params.url });
        result = { targetId: tab.targetId };
        break;
      }
      default: {
        const session = requireSession(taskId, request.sessionId);
        result = await chrome.debugger.sendCommand(
          { tabId: session.tabId, ...(isSynthetic(request.sessionId) ? {} : { sessionId: request.sessionId }) },
          request.method,
          params,
        );
      }
    }
    return JSON.stringify({ id: request.id, result });
  } catch (error) {
    return JSON.stringify({
      id: request.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function attachTarget(taskId, value) {
  const tabId = parseTargetId(value);
  requireOwnedTab(taskId, tabId);
  const existing = tabSessions.get(tabId);
  if (existing) return { sessionId: existing };
  await chrome.debugger.attach({ tabId }, "1.3");
  const sessionId = `ego-session-${crypto.randomUUID()}`;
  sessions.set(sessionId, { taskId, tabId });
  tabSessions.set(tabId, sessionId);
  return { sessionId };
}

async function captureSnapshot(taskId, options, targetId) {
  return (await capturePage(taskId, options, targetId)).snapshot;
}

async function capturePage(taskId, options, targetId) {
  const tabs = await listTabs(taskId);
  const active = targetId
    ? tabs.find((tab) => tab.targetId === targetId)
    : tabs.find((tab) => tab.active) || tabs[0];
  if (!active) throw protocolError("EGO_WEB_CONTENTS_UNAVAILABLE", "Task has no tabs");
  const { sessionId } = await attachTarget(taskId, active.targetId);
  const session = requireSession(taskId, sessionId);
  const response = await chrome.debugger.sendCommand(
    { tabId: session.tabId },
    "Accessibility.getFullAXTree",
    {},
  );
  const nodes = response.nodes || [];
  return { nodes, snapshot: serializeAx(nodes, options) };
}

function buildAIPageTree(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds || []));
  const convert = (node) => {
    const children = (node.childIds || []).flatMap((id) => byId.has(id) ? convert(byId.get(id)) : []);
    if (node.ignored) return children;
    const role = String(node.role?.value || "generic");
    const text = String(node.name?.value || node.value?.value || "").trim();
    const attributeType = aiAttributeType(role);
    const label = role.toLowerCase() === "link" ? axProperty(node, "url") : text;
    return [{
      attributeType,
      ...(text ? { textInfo: { textContent: text } } : {}),
      ...([4, 7].includes(attributeType) && label ? { label } : {}),
      children,
    }];
  };
  const converted = nodes.filter((node) => !childIds.has(node.nodeId)).flatMap(convert);
  return converted.find((node) => node.attributeType === 0) || { attributeType: 0, children: converted };
}

function axProperty(node, name) {
  const value = (node.properties || []).find((property) => property.name === name)?.value?.value;
  return typeof value === "string" ? value : "";
}

function aiAttributeType(role) {
  switch (role.toLowerCase()) {
    case "rootwebarea": return 0;
    case "iframe": return 1;
    case "statictext": case "inlinetextbox": return 3;
    case "link": return 4;
    case "paragraph": return 5;
    case "heading": return 6;
    case "image": return 7;
    case "canvas": return 9;
    case "video": return 10;
    case "form": return 11;
    case "table": case "grid": return 13;
    case "row": return 14;
    case "cell": case "gridcell": case "columnheader": case "rowheader": return 15;
    case "list": return 17;
    case "listitem": return 18;
    default: return actionable(role.toLowerCase()) ? 12 : 2;
  }
}

function serializeAx(nodes, options) {
  const refs = [];
  const lines = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = String(node.role?.value || "generic").toLowerCase();
    const name = String(node.name?.value || node.value?.value || "").trim();
    if (!name && role === "generic") continue;
    let suffix = "";
    if (options.includeActionMarks && node.backendDOMNodeId && actionable(role)) {
      refs.push({ backendNodeId: node.backendDOMNodeId, role, name });
      suffix = ` [ref=@${node.backendDOMNodeId}]`;
    }
    lines.push(`${role}${suffix}${name ? ` ${JSON.stringify(name)}` : ""}`);
  }
  const content = lines.join("\n").slice(0, options.maxResultLength || 100000);
  return { content, refs: refs.filter((ref) => content.includes(`[ref=@${ref.backendNodeId}]`)) };
}

async function listTabs(taskId) {
  const space = requireSpace(taskId);
  const tabs = await Promise.all([...space.tabs].map((tabId) => chrome.tabs.get(tabId).catch(() => null)));
  return tabs.filter(Boolean).map((tab) => publicTab(tab, tab.active));
}

async function targetInfos(taskId) {
  return (await listTabs(taskId)).map((tab) => ({
    targetId: tab.targetId,
    type: "page",
    title: tab.title,
    url: tab.url,
    attached: tabSessions.has(parseTargetId(tab.targetId)),
  }));
}

async function activateTarget(taskId, value) {
  const tabId = parseTargetId(value);
  requireOwnedTab(taskId, tabId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function closeTarget(taskId, value) {
  const tabId = parseTargetId(value);
  requireOwnedTab(taskId, tabId);
  await chrome.tabs.remove(tabId);
}

async function relinquishTask(taskId, reason) {
  const space = requireSpace(taskId);
  await detachTask(space);
  emit("control.lost", { taskId, reason });
}

async function detachTask(space) {
  const attachedTabs = [...space.tabs].filter((tabId) => tabSessions.has(tabId));
  await Promise.all(attachedTabs.map(async (tabId) => {
    expectedDetaches.add(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      expectedDetaches.delete(tabId);
    }
    const rootSession = tabSessions.get(tabId);
    if (rootSession) sessions.delete(rootSession);
    tabSessions.delete(tabId);
  }));
}

function requireSession(taskId, sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.taskId !== taskId) {
    throw protocolError("EGO_CDP_CHANNEL_UNAVAILABLE", "Session is outside the selected task");
  }
  return session;
}

function requireOwnedTab(taskId, tabId) {
  if (!requireSpace(taskId).tabs.has(tabId)) {
    throw protocolError("EGO_CDP_CHANNEL_UNAVAILABLE", "Tab is outside the selected task");
  }
}

function requireSpace(taskId) {
  const space = spaces.get(taskId);
  if (!space) throw protocolError("EGO_TASK_SPACE_NOT_FOUND", "Unknown task space");
  return space;
}

function taskForTab(tabId) {
  for (const space of spaces.values()) {
    if (space.tabs.has(tabId)) return space;
  }
  return undefined;
}

function publicTab(tab, active) {
  return {
    targetId: targetId(tab.id),
    title: tab.title || "",
    url: tab.url || "",
    active,
    ...(tab.favIconUrl ? { faviconUrl: tab.favIconUrl } : {}),
  };
}

function publicSpace(space) {
  return {
    taskId: space.taskId,
    name: space.name,
    tabCount: space.tabs.size,
    ownership: space.ownership,
    lifecycle: space.lifecycle,
  };
}

function targetId(tabId) { return `ego-tab-${tabId}`; }
function parseTargetId(value) {
  const match = /^ego-tab-(\d+)$/.exec(value || "");
  if (!match) throw protocolError("EGO_INVALID_ARGUMENT", "Invalid synthetic target id");
  return Number(match[1]);
}
function isSynthetic(value) { return typeof value === "string" && value.startsWith("ego-session-"); }
function actionable(role) { return ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "option", "slider", "switch", "tab"].includes(role); }
function protocolError(code, message) { return Object.assign(new Error(message), { code }); }
function emit(method, params) { nativePort?.postMessage({ method, params }); }
async function notifyUi() {
  await chrome.runtime.sendMessage({ method: "ui.changed" }).catch(() => {});
}

async function persistSpaces() {
  await chrome.storage.local.set({
    spaces: [...spaces.values()].map((space) => ({ ...publicSpace(space), tabs: [...space.tabs], windowId: space.windowId })),
  });
}

async function hydrateSpaces() {
  const stored = await chrome.storage.local.get("spaces");
  for (const record of stored.spaces || []) {
    const validTabs = [];
    for (const tabId of record.tabs || []) {
      if (await chrome.tabs.get(tabId).catch(() => null)) validTabs.push(tabId);
    }
    spaces.set(record.taskId, {
      taskId: record.taskId,
      name: record.name,
      tabs: new Set(validTabs),
      windowId: record.windowId,
      ownership: record.ownership || "user",
      lifecycle: record.lifecycle || "inactive",
    });
  }
}
