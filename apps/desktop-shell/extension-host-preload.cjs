const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'chrome-extension:') {
  contextBridge.exposeInMainWorld('egoExtensionHost', {
    call: (method, args) => ipcRenderer.invoke('ego:extension-host', method, args),
    onEvent: (listener) => {
      const handler = (_event, name, args) => listener(name, args);
      ipcRenderer.on('ego:extension-event', handler);
      return () => ipcRenderer.removeListener('ego:extension-event', handler);
    },
  });
}
