const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('island', {
  onMedia: cb => ipcRenderer.on('media', (_, m) => cb(m)),
  onCursor: cb => ipcRenderer.on('cursor', (_, c) => cb(c)),
  hover: on => ipcRenderer.send('hover', on),
  control: a => ipcRenderer.send('control', a),
  quit: () => ipcRenderer.send('quit'),
  startAudio: () => ipcRenderer.send('startAudio'),
  getLogin: () => ipcRenderer.invoke('getLogin'),
  setLogin: on => ipcRenderer.send('setLogin', on)
});
