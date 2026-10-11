const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pagefolio', {
  open: url => ipcRenderer.invoke('browser:open', url),
  back: () => ipcRenderer.invoke('browser:back'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  pick: () => ipcRenderer.invoke('browser:pick'),
  start: options => ipcRenderer.invoke('capture:start', options),
  stop: () => ipcRenderer.invoke('capture:stop'),
  reveal: () => ipcRenderer.invoke('capture:reveal'),
  getState: () => ipcRenderer.invoke('app:state'),
  onState: callback => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('app:state', listener);
    return () => ipcRenderer.removeListener('app:state', listener);
  }
});
