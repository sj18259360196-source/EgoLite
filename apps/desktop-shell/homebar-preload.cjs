const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("egoHomeBar", {
  submit(payload) {
    return ipcRenderer.invoke("ego:homebar-submit", payload);
  },
  dismiss() {
    return ipcRenderer.invoke("ego:homebar-dismiss");
  },
  openMain() {
    return ipcRenderer.invoke("ego:homebar-open-main");
  },
  onContext(handler) {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on("ego:homebar-context", listener);
    return () => ipcRenderer.removeListener("ego:homebar-context", listener);
  },
});
