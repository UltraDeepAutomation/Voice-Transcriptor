# Voice Transcriptor — Audit

> **Verification status — read this first.**
>
> The list below was compiled from three parallel code-audit agents (backend/frontend/desktop). The raw agent output was **not individually vetted against source before commit** — a subsequent sampling pass found ~40% false-positive rate (agents misread paired event-listeners, missed existing `try/finally` guards, inverted check ordering). Treat every unmarked entry as a **CANDIDATE** requiring verification, not a confirmed bug.
>
> Entries I personally verified by reading the cited file+line at HEAD are marked with status tags:
>
> - **✓ VERIFIED** — re-read the code; matches claim.
> - **✗ FALSE** — agent misread; code is correct.
> - **⚠ PARTIAL** — claim is technically correct but overstated severity or already mitigated.
> - **🛠 FIXED** — verified real and repaired in this session.
> - *(no tag)* — candidate; needs verification before acting on it.
>
> Severity: **P0** catastrophic/security, **P1** high impact, **P2** medium, **P3** low/cosmetic.
> Line numbers are from the commit HEAD at audit time (dbf1bef).

## Verified so far

| # | Status | File:line | Claim |
|---|---|---|---|
| 3 | 🛠 FIXED | `backend/jobs.py:48-90` | `set_running/set_progress/set_done/set_error` raised `KeyError` when the job was pruned mid-update — now guarded with `.get()` + None-skip. |
| 4 | 🛠 FIXED (same as #3) | `backend/jobs.py` | — |
| 5 | ⚠ PARTIAL | `backend/jobs.py:26-32` | `_prune` eviction was the trigger for #3/#4 — the KeyError path is closed by the setter guards; the eviction itself is expected behaviour. |
| 1 | ⚠ PARTIAL | `backend/main.py:620` | `API_TOKEN` IS injected into the HTML. Practical impact is low because the token is randomised per app launch, bound to 127.0.0.1, and the only script on that origin is the app itself — an XSS exploit already has full API access via the same origin. Defense-in-depth move would be to drop the token into `sessionStorage` via a short-lived one-shot endpoint. Not a P0 for the current deployment shape. |
| 2 | ⚠ PARTIAL | `backend/remote_deepgram_live.py:283` | `body_text[:200]` IS logged. Risk is theoretical — Deepgram's error bodies don't echo the key in standard responses. Low severity. |
| 6 | ✗ FALSE | `backend/main.py:1443-1449` | Token check is at line 1443, rate-limit at 1447 — auth happens BEFORE the rate-limit slot is consumed. Agent inverted the order. |
| 7 | ✗ FALSE | `backend/main.py:1767-1778` | Local-live transcribe tasks properly cancelled in `finally` with `await (CancelledError, Exception)`. |
| 15 | ✗ FALSE | `backend/main.py:440-458` | `_live_promote_session_locks` protected by global `_live_promote_lock` — no race. |
| 28 | ✗ FALSE | `backend/main.py:572` | GET requests ALSO require `API_TOKEN` — attacker cannot CSRF without knowing randomized token. |
| 30 | ✗ FALSE | `backend/main.py:1298-1302` | `UPSCALE_PRESET_ID_RE = [A-Za-z0-9_-]{1,64}` rejects `\x00`, `/`, `.` — path traversal impossible. |
| 32 | ⚠ PARTIAL | `backend/main.py:2955-2970` | Audio replace before text write. Multi-file atomic rename isn't POSIX; crash between = stale text + new audio. Rare; no data loss (old text preserved). |
| 35 | ✗ FALSE | `frontend/src/main.tsx:2393,2405` | `handleShortcutKeydown` listener IS paired — added in `startShortcutRecording`, removed in `stopShortcutRecording`. |
| 36 | 🛠 FIXED | `frontend/src/main.tsx:5013,5929` | `stopTransitionInFlight = false` was outside the outer try/finally — any throw in the pre-main-try awaits permanently bricked stop. Wrapped entire body in `try { … } finally { stopTransitionInFlight = false; }`. |
| 39 | ✗ FALSE | `frontend/src/main.tsx:4860-4863` | `recordedWebmChunks` has a 2h sliding-window splice at line 4861 — not unbounded. |
| 40 | ✗ FALSE | `frontend/src/main.tsx:6042` | `pollAbortController?.abort()` — optional chaining handles null. |
| 42 | ✗ FALSE | `frontend/src/main.tsx:5312` | `tearDown("ac.close")` called unconditionally in stopLive. |
| 43 | ✗ FALSE | `frontend/src/main.tsx:5308` | `tearDown("stream.getTracks.stop")` called unconditionally. |
| 44 | ✗ FALSE | `frontend/src/main.tsx:4859-4870` | `capturedSessionToken` closure + `activeUiSessionToken` check correctly gates stale callbacks. |
| 46 | ✗ FALSE | `frontend/src/main.tsx:2742-2747` | `uiPrefSaveTimer` cleared with `clearTimeout` before reuse. |
| 47 | ✗ FALSE | `frontend/src/main.tsx:4861` | `stopTransitionInFlight` guard handles concurrent stopLive calls. |
| 48 | 🛠 FIXED | `frontend/src/main.tsx:4553-4569` | `ws.send` silent break — added diagnostic log. REST fallback already recovers audio. |
| 50 | ✗ FALSE | `frontend/src/main.tsx:5157-5173` | `ws` access at line 5157 is inside `if (ws)` guard; `ws.send` is in try/catch. No null-deref. |
| 51 | ✗ FALSE | `frontend/src/main.tsx:1261` | OPFS `writable.write` in try/catch + re-enqueue failed chunks for WebM fallback. |
| 54 | ✗ FALSE | `frontend/src/main.tsx:5266` | `waveAnimId` cancelled unconditionally in stopLive; now guarded by outer try/finally. |
| 58 | ✗ FALSE | `frontend/src/main.tsx:6181` | Drag-drop listeners never need removal in SPA — elements not unmounted. |
| 62/63 | 🛠 FIXED | `frontend/src/main.tsx:3257-3292` | `execCommand("copy")` now in try/catch/finally — `<textarea>` always removed from DOM. |
| 64 | ✗ FALSE | `frontend/src/main.tsx:6146-6164` | Inner try/catch handles `transcribeSelectedFile` errors. |
| 65 | ✗ FALSE | `frontend/src/main.tsx:1791` | `loadRecordings().catch()` ignores noise after explicit success notice. |
| 74 | ✗ FALSE | `frontend/src/main.tsx:4886` | MediaRecorder start error → graceful PCM-sink fallback (canonical source). |
| 77 | ✗ FALSE | `desktop/main.js:1823-1912` | Wave monitor has `.catch(() => {})` + destroyed-check. |
| 78 | ✗ FALSE | `desktop/main.js:3148-3157` | `pendingTranscriptionCount` decrement IS in `finally` (line 3155) — agent missed the nested try/finally. |
| 80 | 🛠 FIXED | `desktop/main.js:2919-2934` | VBS AppActivate: strip control chars (0x00-0x1f, 0x7f) + standard `"→""` escape — prevents CR/LF injection. |
| 82 | ✗ FALSE | `desktop/main.js:350` | `executeJavaScript(..., true)` is async — `true` is userGesture flag, not sync-block. |
| 83 | ⚠ PARTIAL | `desktop/main.js:3555-3579` | `pasteTargetAppPid` captured microseconds before paste — PID reuse race theoretical. |
| 84 | ✗ FALSE | `desktop/main.js:2712-2745` | `askForMediaAccess` is interactive dialog; `micPermissionChecked` caches after first run. |
| 85 | 🛠 FIXED | `desktop/main.js:2312-2344` | Late `executeJavaScript` settlement after timeout → attached `.catch(() => null)` to prevent unhandledRejection. |
| 87 | ⚠ PARTIAL | `desktop/main.js:4482-4500` | `globalShortcut.unregister`+`register` has microsecond race; single-threaded main process → very narrow. |
| 88 | ✗ FALSE | `backend/config.py:320-335` | Backend writes config via tmp→replace atomic. Partial read impossible. |
| 89 | ✗ FALSE | `desktop/main.js:4097` | `render-process-gone` handler has `if (!win || win.isDestroyed())` guard. |
| 91 | 🛠 FIXED | `desktop/main.js:2598` | PowerShell double-quoted `$(...)` subexpression → single-quoted + `'→''` escape. |
| 92 | 🛠 FIXED | `desktop/main.js:2444-2456` | `escapeAppleScriptString` now strips control chars (CR/LF injection blocked). |
| 93 | ✗ FALSE | `desktop/main.js:2944, 2955` | VBS temp file unlinked in both success and error paths. |
| 94 | ⚠ PARTIAL | `desktop/main.js:2822` | Clipboard race window is microseconds + `savedClipboard` restore after 1200ms. |
| 95 | ✗ FALSE | `desktop/main.js:2220` | `guardedStopFromOverlay` clears `overlayStopInFlight` on every exit (timeout/resolve/reject via `finish()`). |
| 98 | ✗ FALSE | `desktop/main.js:4411-4423` | Tray menu only has Open/Quit — no model/language state to go stale. |
| 100 | ✗ FALSE | `desktop/main.js:3647` | `runCommand` awaits `child.on("close")` — `unref()` not needed for awaited spawns. |
| DG | 🛠 FIXED | `backend/remote_deepgram_live.py:207-368` | `Deepgram connect timed out after 10.0s` — bumped default to 15s + one silent retry on TimeoutError with 6s budget (not retried on 4xx/OSError). Worst-case 21s, typical <2s. |
| R1 | 🛠 FIXED | `desktop/main.js:3158-3200` | Race where fast post-stop + slow stopLive cleanup caused overlay to flip back to "Recording" — now gated by `recordingId` comparison against `__transcriptorCurrentRecordingId`. |
| UX | 🛠 FIXED | `frontend/src/main.tsx:3758-3832` | Re-transcribe button: Deepgram-key pre-check + in-memory blob fallback to avoid fetch race with archive write. |

## Summary of fixes landed in this session

1. **`stopTransitionInFlight` outer guard** — [frontend/src/main.tsx:5013,5929](frontend/src/main.tsx:5013). Prevents permanent stop-state-machine brick if any pre-main-try `await` throws.
2. **`JobStore` setter None-guards** — [backend/jobs.py:48-90](backend/jobs.py:48). Prevents worker thread death when job is pruned mid-transcription.
3. **Overlay post-stop recordingId gate** — [desktop/main.js:3158-3200](desktop/main.js:3158). Prevents false "Recording" overlay during slow stopLive cleanup.
4. **Re-transcribe UX** — [frontend/src/main.tsx:3758](frontend/src/main.tsx:3758), [frontend/index.html:208](frontend/index.html:208), [frontend/src/styles.css](frontend/src/styles.css). Icon button next to player, Deepgram-key pre-check, in-memory blob fallback.

---

## Candidates — NOT verified individually

Entries below are the raw agent output. **Do not act on any entry without reading the cited code first.** False-positive sampling showed the agents regularly miss existing guards, invert check ordering, and miscount line numbers.

---

## Backend (Python) — 34 bugs

### P0 — Security critical

1. **API token leaked in HTML** `backend/main.py:620` — `API_TOKEN` is injected into the HTML as `window.__TRANSCRIPTOR_API_TOKEN` in plaintext, visible in page source, browser cache, devtools.
2. **Deepgram API key can be logged** `backend/remote_deepgram_live.py:283` — `logger.error("deepgram-live: %s (raw body=%s)", msg, body_text[:200])` prints remote error body that may echo the key.

### P1 — High impact

3. **KeyError in `JobStore.set_running`** `backend/jobs.py:50` — direct `self._jobs[job_id]` access; fails if job was pruned between `create` and update.
4. **KeyError in `JobStore.set_progress`** `backend/jobs.py:56` — same pattern as above.
5. **Race between `_prune` and updates** `backend/jobs.py:26-32` — pruning drops a job mid-write; result permanently lost.
6. **WebSocket rate-limit slot eaten by unauth connections** `backend/main.py:1447-1449` — auth validated after `ws_connect_limit` decrement; attacker can DoS quota with bad tokens.
7. **Zombie live-transcribe tasks on client disconnect** `backend/main.py:1765-1778` — `CancelledError` swallowed silently; tx task blocked in long `maybe_transcribe` hangs forever.
8. **CSRF-prone GET endpoints** `backend/main.py:574-577` — origin check only for `POST/PUT/PATCH/DELETE`; `<img src="/api/recordings">` leaks data.
9. **Path traversal via `archive_dir`** `backend/main.py:958-994` — symlink race: user creates `~/data → /etc/shadow` after `resolve()` check, before `mkdir`.
10. **Path traversal via `file.filename`** `backend/main.py:2046, 2107, 2216, 2281, 2939` — `os.path.basename()` on a Windows-formatted path like `..\..\etc\passwd` on Linux does not strip the traversal.
11. **Missing UUID validation on `job_id`** `backend/main.py:2043, 2106` — client-supplied id reaches `download()` unchecked; file path traversal possible.
12. **Orphaned audio on crash** `backend/main.py:2959-2970` — audio replaced atomically, text file written separately; crash between the two leaves an audio with no transcript.
13. **Unbounded recovery file growth** `backend/main.py:1610-1612` — `recovery["bytes"] += len(data)` has no cap; one open WS drains disk.
14. **Unbounded `window_sec` in `LiveSession`** `backend/live.py:88` — `max_keep = int((window_sec + 10) * sample_rate)` with no upper bound; malicious config → OOM.
15. **Globals `_list_cache` / `_graph_cache` / `_stats_cache` mutated without lock** `backend/main.py:2617-2674` — torn reads/writes under concurrent traffic.
16. **Subprocess ffmpeg with no concurrency cap** `backend/audio.py:45-69` — unlimited parallel ffmpeg processes on simultaneous uploads.
17. **`_live_promote_cache` grows unbounded** `backend/main.py:464-471` — stale keys only removed on lookup, not on timer; memory leak for abandoned sessions.
18. **`_touch_rate_limit` crashes on empty deque** `backend/main.py:268-302` — sort key `kv[1][-1]` raises `IndexError` if another thread drained the deque.
19. **Partial upload files never cleaned** `backend/main.py:672-686` — `MAX_UPLOAD_BYTES` check after each chunk leaves partial file on disk when quota hit.
20. **Config keys silently dropped on corruption** `backend/config.py:141-142` — `except (InvalidToken, Exception): return ""` — user never learns API keys became unreadable.

### P2 — Medium impact

21. **`assert` in production hot path** `backend/remote_deepgram_live.py:349,493` — `python -O` strips them; code silently degrades.
22. **Retry-After header missing on 429** `backend/main.py:579-580` — clients hammer in tight loops.
23. **Text upscale size limit loosely enforced** `backend/main.py:2317-2318` — 120k chars client-side, OpenRouter rejects smaller; wasted bandwidth.
24. **Preset instruction length unlimited** `backend/main.py:2405-2410` — 10MB preset sent on every upscale call.
25. **`split_stereo` Form("True") always truthy** `backend/main.py:2035-2036` — string-vs-bool comparison; mono path unreachable.
26. **Logger never configured at module level** `backend/transcribe.py:15, audio.py:13, …` — parent app relies on defaults; silent log drops.
27. **Config migration swallows `PermissionError`** `backend/config.py:177-214` — legacy recordings silently lost with no user notice.
28. **Corrupted recovery-meta JSON silently default** `backend/main.py:507-509` — wrong model/language used for transcription.
29. **Missing tz on `started_at.isoformat()`** `backend/main.py:1568` — recovery cleanup uses naive datetimes; hours off per locale.
30. **Upscale preset id allows null byte on some FS** `backend/main.py:1300-1302` — regex passes `"test\x00..."`; unexpected path on macOS APFS.
31. **Language regex too permissive** `backend/main.py:708-715` — `"AAAAAA-BBBBBB"` passes, upstream APIs return 400 with no local validation.
32. **Model cache warming swallows exceptions** `backend/transcribe.py:100-101` — first user request blocks; no diagnostic.
33. **ffmpeg invocation without explicit shell-safe guarantee** `backend/audio.py:46-61` — `check=True`+no `shell=True` is safe today; comment it or a future refactor could break.
34. **`FileResponse` without explicit `Content-Disposition: attachment`** `backend/main.py:2522` — large audio opens inline in browser instead of prompting save.

---

## Frontend (TypeScript) — 33 bugs

### P0 — Critical

35. **Keydown listener never removed** `frontend/src/main.tsx:2393,2405` — `addEventListener("keydown", …, true)` is removed only in one branch; handler stays wired permanently across remounts.
36. **`stopTransitionInFlight` leaked on error** `frontend/src/main.tsx:4996,5912` — set early, cleared only at the very end of `stopLive`; any throw in between blocks all future stops forever.
37. **WebSocket never closed on startLive error paths** `frontend/src/main.tsx:4686-4978` — `ws = new WebSocket(...)` but early throws in the try block leave the socket dangling.
38. **`await stopLive(false)` inside startLive error handler swallows errors** `frontend/src/main.tsx:4977` — inner throw leaves session half-torn-down.

### P1 — High impact

39. **`recordedWebmChunks` grows without bound** `frontend/src/main.tsx:400,4838-4843` — 2h sliding window is O(n) splice per chunk; memory ~O(duration).
40. **`draftSaveTimer` / `vuIntervalId` not cleared on early return** `frontend/src/main.tsx:5365-5386` — start-path aborts leave intervals ticking.
41. **`ws` never nulled on early stopLive exit** `frontend/src/main.tsx:5267-5270, 5365…5569` — stale ref can be read from other paths.
42. **`AudioContext` leaked on mid-startLive exception** `frontend/src/main.tsx:4822,5254-5259` — `ac.close()` only on happy path.
43. **`MediaStream` tracks not stopped on error** `frontend/src/main.tsx:4787,5096` — mic indicator stays on until browser GC.
44. **Stale `capturedSessionToken` in track.ended handler** `frontend/src/main.tsx:4809-4820` — rapid Start twice → first handler never matches, autostop lost.
45. **`isRecording` stays `true` on startLive error** `frontend/src/main.tsx:4570,5284` — all future `startLive` calls are blocked.
46. **`uiPrefSaveTimer` not cleared before reuse** `frontend/src/main.tsx:406,4660-4664` — old closure fires with stale UI state.
47. **`track.ended` vs user-stop race** `frontend/src/main.tsx:4811-4820` — both enqueue `stopLive`; guard catches one but side effects duplicate.
48. **`ws.send` silently drops frames** `frontend/src/main.tsx:4512-4523` — `try { ws.send(...) } catch { break; }` with no log, no recovery.
49. **`ws.readyState === OPEN` race** `frontend/src/main.tsx:4512-4519` — can close between check and send.
50. **`ws` null-deref possible** `frontend/src/main.tsx:5139-5145` — read-then-send without re-checking after cleanup set it to null.
51. **OPFS `writable.write` quota errors uncaught** `frontend/src/main.tsx:1261` — partial WAV; stopLive path assumes sink healthy.
52. **`setBusy(true, token)` has no matching false on early return** `frontend/src/main.tsx:4637,5365-5385` — UI permanently frozen.
53. **Deepgram final envelope lost on unclean WS close** `frontend/src/main.tsx:4728-4778,5139-5145` — no REST fallback triggered, tail words dropped.
54. **`waveAnimId` never cancelled on error exits** `frontend/src/main.tsx:5208-5210` — RAF loop keeps running.
55. **`stopTransitionInFlight` not reset in try/finally** `frontend/src/main.tsx:4994-5912` — should be `try { … } finally { stopTransitionInFlight = false; }`; currently assigned inline.
56. **Fetch-based clipboard write hangs forever** `frontend/src/main.tsx:3258,3278` — `navigator.clipboard.writeText` has no `AbortSignal`/timeout.

### P2 — Medium impact

57. **`lastModalFocus` null-deref** `frontend/src/main.tsx:1671,1683` — `document.contains(null)` isn't a crash but preceding logic assumes object.
58. **Drag-drop listeners never removed** `frontend/src/main.tsx:6131-6150` — `drop` element holds closure refs to `fileInput`.
59. **`pollAbortController.abort()` on null** `frontend/src/main.tsx:405,6011` — declared but never `new AbortController()`'d; abort crashes.
60. **localStorage quota silently drops draft** `frontend/src/main.tsx:2175-2180` — no fallback; recording resume fails with zero feedback.
61. **Object URL leak on audio probe timeout** `frontend/src/main.tsx:1375-1398` — `createObjectURL` only revoked in finally on happy path.
62. **`document.execCommand("copy")` not in try/catch** `frontend/src/main.tsx:3260-3267` — uncaught throw in older browsers.
63. **Fallback `<textarea>` never detached** `frontend/src/main.tsx:3260-3270` — DOM grows with ghosts per copy attempt.
64. **`transcribeSelectedFile` errors swallowed** `frontend/src/main.tsx:5949-5960,6151` — `void fn()` hides all failures.
65. **`loadRecordings().catch(() => {})`** `frontend/src/main.tsx:1791,1966` — stale UI, no user feedback.
66. **`aria-busy="true"` stays on error** `frontend/src/main.tsx:3237,3562` — screen readers announce "busy" forever.
67. **`btnStop.hidden` attribute inconsistent** `frontend/src/main.tsx:78,4652,5378` — disabled+hidden mismatch across paths.
68. **`refreshNetworkState` online/offline listeners uncaught** `frontend/src/main.tsx:6821-6822` — `void fn()` hides failures.
69. **Network-state `setInterval` never cleared** `frontend/src/main.tsx:6820` — on hot reload, intervals stack.
70. **Hotkey handler has no top-level try/catch** `frontend/src/main.tsx:2393-2412` — startLive throw → silent no-op with no user toast.
71. **Graph-view listeners never removed** `frontend/src/main.tsx:6720-6789` — mousemove/mouseup/wheel/click listeners leak on tab switch.
72. **File size check only; no MIME match** `frontend/src/main.tsx:5927-5946` — `.exe` with `audio/*` sneaks past.
73. **`setSelectedFile` doesn't clear stale state on rejection** `frontend/src/main.tsx:5928-5946` — next "Transcribe File" uses the old file.
74. **MediaRecorder start error sets mediaRecorder=null but leaves `isRecording=true`** `frontend/src/main.tsx:4846-4861` — UI stuck in fake-recording.

### P3

75. **`btnStart`/`btnStop` disabled desync** `frontend/src/main.tsx:4651-4652` — inconsistent visible-vs-disabled when error occurs mid-transition.

---

## Desktop (Electron) — 33 bugs

### P1 — High impact

76. **`overlayWaveMonitor` accesses destroyed window** `desktop/main.js:1823` — interval callback reads `overlayWin.webContents` without `isDestroyed()` guard.
77. **Wave monitor cleanup race** `desktop/main.js:1988` — clear + one-last-fire = `executeJavaScript` on dead webContents.
78. **`pendingTranscriptionCount` leaks on throw** `desktop/main.js:3148-3157` — inner try/finally drops the decrement in one path.
79. **Processing window destroyed mid-eval** `desktop/main.js:3239` — `win.webContents.executeJavaScript` without fresh `isDestroyed()` check.
80. **VBS paste command injection on Windows** `desktop/main.js:2900` — `WScript.AppActivate "${effectiveTargetName}"` — only `"→""` escape; unescaped CR/LF in app name break out.
81. **`JSON.parse` of config.json with no schema** `desktop/main.js:4419` — malicious userData → crash or bad accelerator registered as a global shortcut.
82. **Synchronous `executeJavaScript` blocks Electron main thread 2s** `desktop/main.js:349,1129,2308` — hotkey press freezes UI when renderer slow.
83. **`paste_target_pid` reused PID race** `desktop/main.js:3509-3570` — stale PID after target app quit → paste lands in a different app that reused PID.
84. **`requestMacMicrophonePermissionOnce` has no timeout** `desktop/main.js:2694,2706` — `systemPreferences.askForMediaAccess` can hang on sluggish TCC daemon.
85. **`queryRendererState` dangling promise on timeout** `desktop/main.js:2345-2360` — `executeJavaScript` keeps running in renderer after main gave up.
86. **Paste mechanism silent fail on AppleScript disabled** `desktop/main.js:2943-2994` — `lastReason` set, but overlay shows nothing actionable.
87. **`globalShortcut.unregister`/`register` race** `desktop/main.js:4450-4470` — hotkey pressed between calls runs with no handler.
88. **Config file read not atomic** `desktop/main.js:4417-4424` — concurrent write → partial-but-valid JSON with wrong shortcut.
89. **`render-process-gone` + `win=null` race** `desktop/main.js:4093` — scheduled `win.loadURL` after null.
90. **Backend restart attempts can overflow** `desktop/main.js:3959` — `backendRestartAttempts` incremented without explicit cap until line check; trivial to bump externally.

### P2 — Medium impact

91. **PowerShell injection in `frontmostAppInfo`** `desktop/main.js:2593` — backtick escape only; `$(...)` subexpression still evaluates.
92. **AppleScript injection via `escapedApp`** `desktop/main.js:2604,2814` — control-char injection via crafted app name.
93. **VBS temp file not unlinked when cscript locked** `desktop/main.js:2911,2922` — `/tmp` fills with orphaned `.vbs`.
94. **Clipboard write not atomic with paste** `desktop/main.js:2800,2944` — another process can overwrite clipboard between write and AppleScript paste.
95. **`overlayStopInFlight` not cleared on autostop early-exit** `desktop/main.js:1880,1897` — subsequent recordings blocked if `guardedStopFromOverlay` hangs.
96. **Tray context menu after quit** `desktop/main.js:4395` — `tray?.popUpContextMenu` without `isDestroyed()`.
97. **`globalShortcut.unregisterAll()` before overlay cleanup** `desktop/main.js:4269,4286` — mid-quit hotkey still lands.
98. **Tray menu never rebuilt after settings change** `desktop/main.js:4378-4390` — shows old model/language forever.
99. **`overlayQuickSettingsOpen` stale after renderer reload** `desktop/main.js:24,1800` — overlay width mismatches UI.
100. **`spawn` child lacks `child.unref()`** `desktop/main.js:3614` — delays graceful app shutdown; process table fills with exited children on hot-key spam.

---

## Fixed in this session

**R1.** Race: overlay wrongly switches to "Recording" (red bar + timer reset) when fast post-stop completes while `stopLive` is still cleaning up — `desktop/main.js:3158-3186`. Fixed by comparing `task.recordingId` against renderer's live `__transcriptorCurrentRecordingId`; "Recording" overlay only when ID actually advanced via `++liveRecordingSeq`.

---

## Priority breakdown

| Severity | Count |
|---|---|
| P0 | 6  |
| P1 | 54 |
| P2 | 37 |
| P3 | 3  |
| **Total** | **100** |

Recommendation: knock P0 first (secrets & auth), then P1s grouped by subsystem — jobs.py KeyErrors, WebSocket/stopLive state machine, Electron IPC race guards. Most of the P2s are one-line defensive patches.
