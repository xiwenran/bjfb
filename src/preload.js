const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  reportRendererError: (payload) => ipcRenderer.send('diagnostics:renderer-error', payload),
});
