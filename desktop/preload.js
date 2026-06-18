const { contextBridge, webUtils } = require("electron");

contextBridge.exposeInMainWorld("__transcriptorFilePathForFile", (file) => {
  try {
    if (!file || typeof webUtils?.getPathForFile !== "function") return "";
    return String(webUtils.getPathForFile(file) || "");
  } catch {
    return "";
  }
});
