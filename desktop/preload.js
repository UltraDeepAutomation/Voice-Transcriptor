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

// Transcript hand-off bridge (BUGS_AUDIT_2026-09-03 §6.7/§6.8).
//
// The renderer knows the instant a recording's text exists; the main
// process used to find out by injecting `executeJavaScript` into the
// renderer every 30 ms for up to 32 s — hundreds of synchronous
// evaluations landing exactly while the renderer finalizes Deepgram and
// runs the paste upscale. It now says so once, when it happens:
//
//   window.transcriptor.recordingFinal({
//     recordingId,          // the renderer's monotonic recording id
//     text,                 // best-known text (false) / paste-ready text (true)
//     final,                // true ONLY for the paste-ready text
//     source,               // free-form label, trace log only
//   })
//
// `final:false` is published with the status-only output (pre-upscale
// text — never pasted, §6.8) and is kept as the best-known text for the
// deadline-expiry recovery (§6.9). `final:true` is published at the one
// site that produces paste-ready text.
//
// Send-only, one fixed channel, no raw ipcRenderer: the renderer cannot
// name a channel or receive anything back. Payload fields are copied
// onto a fresh plain object so a renderer-side getter or exotic value
// cannot ride along, and the whole call is swallowed on failure — this
// runs on the renderer's own finalization path, which must not break
// because an IPC clone was refused. The main process validates the
// shape it receives (desktop/recording-final-slot.js); nothing here
// judges the payload, so there is only one definition of "well formed".
contextBridge.exposeInMainWorld("transcriptor", {
  recordingFinal: (payload) => {
    try {
      const p = payload && typeof payload === "object" ? payload : {};
      ipcRenderer.send("recording-final", {
        recordingId: p.recordingId,
        text: p.text,
        final: p.final,
        source: p.source,
      });
      return true;
    } catch {
      return false;
    }
  },
});
