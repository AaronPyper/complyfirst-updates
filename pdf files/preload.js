const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  checkOllama:          ()      => ipcRenderer.invoke('check-ollama'),
  checkModel:           (model) => ipcRenderer.invoke('check-model', model),
  callOllama:           (data)  => ipcRenderer.invoke('call-ollama', data),
  saveDocx:             (data)  => ipcRenderer.invoke('save-docx', data),
  generateDocx:         (data)  => ipcRenderer.invoke('generate-docx', data),
  generatePdf:          (data)  => ipcRenderer.invoke('generate-pdf', data),
  savePdf:              (data)  => ipcRenderer.invoke('save-pdf', data),
  onUpdateComplete:     (cb)    => ipcRenderer.on('update-complete', cb),
  onUpdateNeedsRestart: (cb)    => ipcRenderer.on('update-needs-restart', cb),
});
