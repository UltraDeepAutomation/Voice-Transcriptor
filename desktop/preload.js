const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("__transcriptorFilePathForFile", (file) => {
  try {
    if (!file || typeof webUtils?.getPathForFile !== "function") return "";
    return String(webUtils.getPathForFile(file) || "");
  } catch {
    return "";
  }
});

// Engine lifecycle bridge (Settings → Local models → "Install engine").
// Invoke-only surface: the renderer can query the install state machine
// and request an install; everything else (gates, progress phases,
// backend restart) is owned by the main process. No raw ipcRenderer and
// no arbitrary channels are exposed.
contextBridge.exposeInMainWorld("__transcriptorEngine", {
  getStatus: () => ipcRenderer.invoke("engine:get-status"),
  install: () => ipcRenderer.invoke("engine:install"),
});
