const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("egoDesktop", {
  invoke(method, payload) {
    return ipcRenderer.invoke("ego:invoke", method, payload);
  },
  onAutomationJobs(handler) {
    const listener = (_event, jobs) => handler(jobs || []);
    ipcRenderer.on("ego:automation-jobs", listener);
    return () => ipcRenderer.removeListener("ego:automation-jobs", listener);
  },
  onEvent(handler) {
    const listener = (_event, method, payload) => {
      if (typeof method === "string" && (method.startsWith("chat.stream.") || method.startsWith("codex.stream.") || method.startsWith("operation.") || method === "agent.changed" || method === "agent.disconnected" || method === "agent.integrations.changed" || method === "space.controlChanged" || method === "space.changed" || method === "tab.changed" || method === "collection.changed")) handler(method, payload || {});
    };
    ipcRenderer.on("ego:event", listener);
    return () => ipcRenderer.removeListener("ego:event", listener);
  },
  onHomeBarCompose(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:homebar-compose", listener);
    return () => ipcRenderer.removeListener("ego:homebar-compose", listener);
  },
  onBrowserOpenError(handler) {
    ipcRenderer.on("ego:browser-open-error", (_event, payload) => handler(payload));
  },
  onBrowserFindResult(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:browser-find-result", listener);
    return () => ipcRenderer.removeListener("ego:browser-find-result", listener);
  },
  onBrowserCommand(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:browser-command", listener);
    return () => ipcRenderer.removeListener("ego:browser-command", listener);
  },
  onDevToolsState(handler) {
    const listener = (_event, entries) => handler(entries || []);
    ipcRenderer.on("ego:devtools-state", listener);
    return () => ipcRenderer.removeListener("ego:devtools-state", listener);
  },
  onDownload(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:download", listener);
    return () => ipcRenderer.removeListener("ego:download", listener);
  },
  onBrowserPrompt(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:browser-prompt", listener);
    return () => ipcRenderer.removeListener("ego:browser-prompt", listener);
  },
  onBrowserPromptExpired(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:browser-prompt-expired", listener);
    return () => ipcRenderer.removeListener("ego:browser-prompt-expired", listener);
  },
  respondBrowserPrompt(payload) {
    ipcRenderer.send("ego:browser-prompt-response", payload || {});
  },
  onBrowserTabCrashed(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:browser-tab-crashed", listener);
    return () => ipcRenderer.removeListener("ego:browser-tab-crashed", listener);
  },
  onBrowserTabResponsive(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:browser-tab-responsive", listener);
    return () => ipcRenderer.removeListener("ego:browser-tab-responsive", listener);
  },
  onHostRequest(handler) {
    ipcRenderer.on("ego:host-request", async (_event, request) => {
      try {
        const result = await handler(request.method, request.payload || {});
        ipcRenderer.send("ego:host-response", { id: request.id, result });
      } catch (error) {
        ipcRenderer.send("ego:host-response", { id: request.id, error: error?.message || String(error) });
      }
    });
  },
});
