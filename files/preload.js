const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cf', {
  checkOllama: ()  => ipcRenderer.invoke('checkOllama'),
  checkModel:  (m) => ipcRenderer.invoke('checkModel', m),
  generate:    (d) => ipcRenderer.invoke('generate', d),
  makeDocx:    (d) => ipcRenderer.invoke('makeDocx', d),
  makePdf:     (d) => ipcRenderer.invoke('makePdf', d),
  save:        (d) => ipcRenderer.invoke('save', d),
  onUpdate:    (cb) => ipcRenderer.on('update-ready', cb),
  onRestart:   (cb) => ipcRenderer.on('update-restart', cb),
});
