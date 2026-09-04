# Ultra-Audit · FIX · DESKTOP + REPO-PLUMBING

Rollback point: `main` at `889c91a` (baseline: `npm --prefix desktop test` = 153 pass, 0 fail).
Scope: `desktop/**`, `BUILD.command`, `INSTALL*.command`, `.github/**`, `.gitignore`.
Out of scope (other agents own them concurrently): `backend/`, `frontend/`,
`CHANGELOG.md`, `PROJECT_STRUCTURE.md`, `BUGS_AUDIT*`.

---
## Commit 1 — `a152ec7` · power/lifecycle wiring

**IDs:** D-001 (P0), D-076 (P2), D-075 (P2).

**Files:** `desktop/power-events.js` (new), `desktop/power-events.test.js` (new),
`desktop/main.js`, `desktop/ipc-contract.test.js`, `desktop/package.json`.

**Re-verified on current code before fixing:** yes — the two `powerMonitor.on`
blocks were still inside `restoreShortcutsAfterCaptureAbort` at HEAD `889c91a`.

**Verification**
- Guard fails before / passes after (brace-matched body of the abort handler,
  run against `git show HEAD:desktop/main.js`):
  ```
  OLD main.js: restoreShortcutsAfterCaptureAbort body contains powerMonitor: true
  OLD main.js: ... contains notifyRendererSystemSuspend: true
  ```
  i.e. the new `ipc-contract.test.js` assertion would have failed on the
  pre-fix source. After the fix the whole suite is green.
- D-075 proof (synthetic leak `exposeInMainWorld("bad", { raw: ipcRenderer })`):
  ```
  old regex catches raw-ipcRenderer leak: false
  new scan catches raw-ipcRenderer leak: true
  ```
- `npm --prefix desktop test` -> `tests 159 / pass 159 / fail 0` (was 153).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.
- `desktop/package.json` `build.files` now lists `power-events.js`
  (`packaging.test.js` passes, which is what proves the packaging graph).

**Decisions**
- *Chosen:* extract the event -> action mapping into a pure module rather than
  moving the loose statements up to `whenReady`. A move alone would have left
  the same untestable shape that hid the bug for two releases; the module is
  what the required source-level + pure-module tests attach to.
- *Chosen:* idempotent subscribe (WeakSet on the monitor) even though the new
  call site runs once — the accumulation bug (N aborts -> N re-registrations)
  must be impossible by construction, not by call-site discipline.
- *Chosen:* handler failures are caught **inside** the per-event callback and
  logged. This is not catch-and-ignore: it is containment at an OS callback
  boundary, and it is what stops a failing shortcut re-claim from suppressing
  the warm-capture release. The failure is logged with its message.
- *Rejected:* keeping `for (const reason of ["suspend", "lock-screen"])` and
  simply re-indenting it — the shadowing of the enclosing `reason` parameter and
  the source-string-matching test would both have survived.

**Not done in this commit:** nothing from this group.

---
## Commit 2 — `317b4ca` · Windows paste decoding & the paste wire protocol

**IDs:** D-002 (P0), D-032 (P2), D-016 (P2, SSOT), D-033 (P2, SSOT).

**Files:** `desktop/child-io.js` (new), `desktop/child-io.test.js` (new),
`desktop/paste-protocol.js` (new), `desktop/main.js`, `desktop/paste-result.js`,
`desktop/paste-result.test.js`, `desktop/paste-script.js`,
`desktop/paste-verification-policy.js`, `desktop/package.json`.

**Re-verified on current code:** yes — `runCommand("cscript", [... "//U" ...])`
and the unconditional `setEncoding("utf8")` were both still present.

**Verification**
- New `child-io.test.js` encodes the exact wire bytes `cscript //U` writes
  (BOM + UTF-16LE `OK:vbs-paste\r\n`) and asserts both directions:
  ```
  the old UTF-8 decode  -> isVbsPasteSuccess === false   (the bug)
  the declared UTF-16LE -> isVbsPasteSuccess === true    (the fix)
  ```
  The old `paste-result.test.js` case fed a hand-typed UTF-8 string, a shape the
  pipeline cannot produce, which is why it was green on a broken pipeline; the
  replacement goes through `childStreamEncoding` + `StringDecoder`.
- A split-chunk case is covered too (a UTF-16LE code unit straddling two
  chunks), because `setEncoding` on the stream is what makes that work.
- `npm --prefix desktop test` -> `tests 171 / pass 171 / fail 0`.
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.
- `packaging.test.js` green with `child-io.js` and `paste-protocol.js` added to
  `build.files` (it fails without them — observed).

**Decisions**
- *Chosen:* keep `//U` and decode as UTF-16LE, per the charter's tie-breaker
  ("keeps Cyrillic-safe error text"). Dropping `//U` would make the ASCII
  markers work but leave cscript's own error text (which can carry a Cyrillic
  user path) in the OEM code page, read as UTF-8 -> mojibake.
  *Rejected:* a per-call `stdoutEncoding` option — that is a second place the
  flag and the decode could drift apart. The encoding is derived from the
  command line, so it cannot.
- *Chosen:* `desktop/paste-protocol.js` as the marker SSOT rather than making
  `paste-result.js` require `paste-script.js` (the report's suggestion). The
  Windows VBS in main.js now needs `SENT:` too, and a generic parser depending
  on the macOS script builder is the wrong direction.
- *Chosen:* give the VBS branch the same receipt semantics as macOS instead of
  raising its timeout. A larger budget would only move the window.

**Not done in this commit:** nothing from this group.

---
## Commit 3 — `1d9fda2` · signing / release

**IDs:** D-003 (P0), D-020 (P1), D-021 (P1), D-022 (P1), D-023 (P1), D-024 (P1),
D-025 (P1), D-038 (P2), D-057 (P2), D-058 (P2), D-062 (P2), D-080 (P2).

**Files:** `desktop/scripts/macos-signing-utils.js`, `desktop/scripts/sign-mas.js`,
`desktop/afterPack.js`, `desktop/afterAllArtifactBuild.js`,
`desktop/entitlements.mac.plist` (new, strict), `desktop/entitlements.mac.inherit.plist`
(new, strict), `desktop/entitlements.mac.selfsigned{,.inherit}.plist` (renamed from
the old relaxed ones), `desktop/entitlements.mas.plist`, `desktop/package.json`,
`desktop/signing.test.js` (new), `BUILD.command`.

**Re-verified on current code:** yes — `const signIdentity = kind === "executable" ? identity : "-";`
and both copies of `DEFAULT_INTERNAL_SIGNING_IDENTITY` were present at HEAD.

**Verification**
- Pre-fix argument builder, replayed from `git show 889c91a:.../macos-signing-utils.js`:
  ```
  OLD dylib args: ["--force","--sign","-","/tmp/numpy/_core/_multiarray_umath.so"]
  OLD dylib signed ad-hoc: true
  OLD dylib has hardened runtime: false
  OLD dylib timestamped: false
  ```
  The new `signing.test.js` asserts the exact opposite for both `executable`
  and `dylib`, so it fails on the old code and passes now. This is the
  `codesign -dvv` expectation expressed as a test of the argument builder —
  notarization itself cannot be run here (no Developer ID certificate).
- `git show 889c91a:desktop/entitlements.mac.plist | grep -c disable-library-validation`
  -> `1`; the new public profile asserts 0 and the self-signed profile asserts 1.
- `npm --prefix desktop test` -> `tests 185 / pass 185 / fail 0` (was 171).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.
- `bash -n BUILD.command` -> OK. `plutil -lint` OK on all six plists.

**Decisions**
- *Chosen:* keep `identity: null` in package.json and make the hooks READ
  `build.<platform>.entitlements/entitlementsInherit/extendInfo`. Removing
  `identity: null` would hand signing back to electron-builder, which is exactly
  what afterPack.js documents at length that it must not do.
- *Chosen:* the entitlements profile follows from the identity
  (`resolveSigningPlan().entitlementsProfile`), with the self-signed variant
  derived by one rule (`selfSignedEntitlementsPath`) rather than a second list of
  filenames.
- *Chosen:* no built-in default identity in the hooks, and `BUILD.command` names
  the internal identity once so the repository owner's one-click build keeps
  working while any other machine gets an actionable error instead of a failure
  inside a hook. *Rejected:* leaving the default in the hooks (the report's
  D-023 finding) and *rejected:* removing it everywhere (would break the
  owner's daily build with no benefit the explicit name does not give).
- *Chosen:* `hasSigningIdentity` matches exactly, and a `security` failure is
  raised rather than reported as "identity absent" — the old behaviour told a
  user who had set the variable correctly to go and set it.

**Not done in this commit**
- **D-061** (release/ holds three full copies, ~750 MB): the internal zip is not
  dead weight — `INSTALL_ON_OTHER_MAC.command` falls back to it when a
  quarantined DMG will not mount, and reads its name from the release manifest.
  Which artifacts a release ships is a product decision with no test or lock
  file implying an answer, so the false comment was corrected and the artifact
  set left alone. Recorded as a human-decision item.
- Notarization itself could not be exercised (no Developer ID certificate in
  this environment); the Developer ID entitlements profile is reasoned from
  Apple's library-validation rule (a real Team ID is non-empty and now shared by
  every bundled Mach-O) and needs one real notarized build to confirm.

---
## Commit 4 — `22c6e3d` · paste verification & clipboard restore

**IDs:** D-004 (P1), D-056 (P2), and the policy half of D-004
(`paste-verification-policy` no longer disables on an early read).

**Files:** `desktop/paste-script.js`, `desktop/paste-script.test.js`,
`desktop/paste-result.js`, `desktop/paste-result.test.js`,
`desktop/paste-verification-policy.js`, `desktop/paste-verification-policy.test.js`,
`desktop/paste-capability.js`, `desktop/main.js`.

**Re-verified on current code:** yes. And re-verification found a SECOND,
deeper cause the discovery report did not have: the read itself was broken.

**Verification — measured live on macOS 27, not reasoned**
- Root cause A, `count of` on an attribute specifier (scratch TextEdit doc
  holding "abcde"):
  ```
  inline_count=1  value_first_count=5
  ```
  `count of (value of attribute "AXValue" of axElem)` inside a
  `tell application "System Events"` counts specifier ELEMENTS, not string
  characters. Both reads returned 1 for every readable value, so no paste
  could verify even with a settle delay, and `AXNumberOfCharacters`
  (which returned 5 correctly) was unreachable behind the `axLen is -1` guard.
- Root cause B, settle: with counting corrected, polling every 50 ms after a
  synthesised keystroke, 8 trials: `polls=1` every time.
- End-to-end A/B, running the REAL generated handlers from each version of
  `paste-script.js` in the same harness against a scratch TextEdit document:
  ```
  pre-fix  (889c91a): t1..t5  before=1 after=1  tag=:unverified
  post-fix          : t1..t5  before=0 after=5  tag=:verified
  ```
  Nothing was pasted into another app: the harness uses `keystroke`, and the
  document is closed without saving.
- `npm --prefix desktop test` -> `tests 189 / pass 189 / fail 0` (was 187),
  including the two osacompile suites, which do run here (macOS).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* poll (4 x 50 ms, exit on match) rather than a fixed sleep — per the
  charter, and because it makes the common case (50 ms) cheaper than the 160 ms
  sleep that was removed, while bounding the pathological one.
- *Chosen:* the element is resolved ONCE and the polls reuse it. The expensive
  read is `AXFocusedUIElement` (measured 20 s+ against Finder unbounded);
  re-resolving per poll would have blown the budget.
- *Chosen:* three verification outcomes (`:verified` / `:unverified` /
  `:unreadable`) instead of two, and a matching `INCONCLUSIVE` policy outcome.
  Collapsing "no readable value" with "growth did not match" is what let a
  merely slow target be treated like a mute one.
  *Rejected:* leaving the policy alone and relying on the read fix — the early
  read was only one way to produce a mismatch.
- *Chosen:* `verificationAllowanceMs` 1500 -> 3300, derived from the bound the
  reads can now actually reach, and the derivation written into the table.
  Darwin worst case is ~24.8 s, still inside `PASTE_POST_STOP_DEADLINE_MS` (32 s).

**Not done in this commit**
- D-031 (`bundleId` never supplied, so the verification key is a display name):
  needs an extra Apple Event on the capture path to fetch the bundle id.
  Deferred to the P2 pass.

---
## Commit 5 — `86d63d3` · permissions, auto-send, activation & the paste budget

**IDs:** D-005 (P1), D-006 (P1), D-007 (P1), D-008 (P1), D-019 (P1), D-039 (P2),
D-047 (P2), plus a companion of D-006 the report did not list (the PowerShell in
`activateAppByPid` and `activateAppByName` also discarded `SetForegroundWindow`'s
own result and printed "1" regardless).

**Files:** `desktop/main.js`, `desktop/paste-capability.js`,
`desktop/paste-capability.test.js`.

**Re-verified on current code:** yes, all five.

**Verification (pre-fix behaviour replayed from `889c91a`)**
```
trigger fires for "paste-capability-untrusted" -> false        (D-005)
planModifierRelease(win32, Control+Alt+Shift+V) -> needed:false (D-008)
worst case, activation uncounted: darwin 19435 win32 19890 linux 18360 (D-019)
```
Honest worst case after counting activation + probe + spawn allowance, and after
sizing:
```
darwin 26435   win32 28230   linux 29160   (deadline 32000, all inside)
```
Before the re-sizing the honest numbers were darwin 26435 / win32 64890 /
linux 36360 — i.e. the existing "worst case fits the deadline" test had been
passing on a model, not on the system.
- `npm --prefix desktop test` -> `tests 191 / pass 191 / fail 0` (was 189).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* one classifier (`classifyPastePermissionFailure` in
  `paste-capability.js`, returning a `PASTE_PERMISSION_ROUTE`), consumed by the
  prompt trigger, the dialog route and the two status-badge functions.
  *Rejected:* just adding the two new reasons to `looksLikeAutomationPermissionError`
  — that leaves two ladders that can drift again.
- *Chosen:* auto-send makes exactly ONE attempt. Neither `keystroke` nor
  `key code` reports whether the target acted, so a second chord would be a
  guess reported as a result. `key code 36` for the same layout-independence
  reason the paste uses `key code 9`.
- *Chosen (product-shaped, forced by the arithmetic):* Windows `maxAttempts`
  3 -> 2. With the activation ladder counted, three attempts cannot fit the
  32 s post-stop deadline at any per-spawn bound that PowerShell + Add-Type can
  actually meet. Two attempts still means four injections.
  *Rejected:* raising `PASTE_POST_STOP_DEADLINE_MS` — that is the envelope the
  user waits in, and §6.4 sets it deliberately.
- *Chosen:* Linux activation bound 5000 -> 1200 ms (wmctrl/xdotool compile
  nothing on the way in); Windows 5000 -> 2500 ms.

**Not done in this commit:** nothing from this group.

---
## Commit 6 — `966bcf7` · recording lifecycle & backend restart

**IDs:** D-014 (P1), D-017 (P1), D-018 (P1), D-030 (P2), D-037 (P2), D-040 (P2),
D-042 (P2), D-043 (P2), D-044 (P2), D-046 (P2), D-048 (P2).

**Files:** `desktop/main.js`.

**Re-verified on current code:** yes, all of them.

**Verification**
- `npm --prefix desktop test` -> `tests 191 / pass 191 / fail 0`.
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.
- D-037 rendered output checked directly:
  `cd ~/Downloads/Voice\ Transcriptor && ./INSTALL.command` (was
  `Voice\\ Transcriptor`, which a shell reads as a literal backslash).
- D-030: `grep -n "broadcastEngineStatus\|engine:status" desktop/main.js` now
  matches only the comment explaining why there is no push channel.
- **No unit test for D-017 / D-018 / D-014 / D-048.** They live inside
  `main.js`, which is a single 9k-line Electron module with no seam a
  `node --test` process can drive; extracting each would be a larger change
  than the fix. Stated rather than papered over. The `ipc-contract`-style
  source-level guard was not used here because these are control-flow facts,
  not textual ones.

**Decisions**
- *Chosen:* delete the `engine:status` push rather than expose it in preload.
  The renderer states its choice in a comment ("pull beats push here: no
  subscription lifecycle to leak across window reloads") and implements it; a
  channel with a sender and no receiver is not a second surface.
- *Chosen:* one `noteBackendHealthy(source)` used by both reset sites, instead
  of duplicating the counter-clearing logic on the restart path.
- *Chosen:* bound the recovery poll at 40 x 3 s (two minutes) and end with a
  message that says what happened, rather than removing the poll.

**Not done in this commit:** nothing from this group.

---
## Commit 7 — `0bf8ed7` · status SSOT & the reachable autostop state

**IDs:** D-012 (P1), D-013 (P1), plus hypothesis **H-1** (a click on an amber
capsule would have been a no-op once autostop became reachable — fixed in the
same change, as the report advised).

**Files:** `desktop/recording-status.js` (new), `desktop/recording-status.test.js`
(new), `desktop/main.js`, `desktop/package.json`.

**Re-verified on current code:** yes — both ladders were still present and still
disagreed.

**Verification**
- The two pre-fix ladders, extracted from `889c91a` and run over the real
  vocabulary (this is the evidence for the drift):
  ```
  "Starting"          mode=recording     tone=neutral
  "App Loading"       mode=fail          tone=warning
  "Grant Access"      mode=fail          tone=warning
  "App Not Ready"     mode=transcribing  tone=warning
  "Mic Not Started"   mode=transcribing  tone=neutral
  "Pasting"           mode=transcribing  tone=neutral
  "Timed out, but transcript is on your clipboard."  mode=transcribing tone=neutral
  "Timed out with no transcript to recover."         mode=transcribing tone=neutral
  ```
- `recording-status.test.js` walks all 27 statuses either process produces and
  asserts the kind each one MEANS; a source-level assertion fails if a second
  classifier reappears in `main.js`; another fails if the renderer rewords one
  of the four strings main.js has to classify.
- `npm --prefix desktop test` -> `tests 199 / pass 199 / fail 0` (was 191).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.
- `packaging.test.js` green after adding `recording-status.js` to `build.files`
  (observed failing without it).

**Decisions**
- *Chosen:* kind travels WITH the status, and the ladder is kept only as the
  compatibility path for renderer-authored text — the report's own
  recommendation. Every main-process producer now names its kind.
- *Chosen:* a failed paste is `WARN`, not `FAIL`. The transcript is always on the
  clipboard at that point and the status says which key pastes it; drawing it as
  a hard error would misdescribe a one-keypress recovery.
- *Chosen (product):* the autostop countdown is announced as
  `Auto stop in <n>s` and cancelled by speech. The alternative — leaving the
  amber state unreachable and deleting its CSS — would have removed a warning
  the user demonstrably needs, since the mechanism ends recordings on its own.

**Not done**
- The renderer does not yet send its own `statusKind` (it computes one for
  itself already). Doing so would delete the compatibility ladder outright, but
  it is a `frontend/` change and another agent owns that tree. Recorded as a
  follow-up.

---
## Commit 8 — `19b0235` · engine overlap policy

**IDs:** D-010 (P1), D-011 (P1, was "hypothesis" — confirmed), D-054 (P2, was
"hypothesis" — confirmed).

**Files:** `desktop/engine-deps.js`, `desktop/engine-deps.test.js`,
`desktop/main.js`.

**Verification (pre-fix behaviour replayed from `889c91a`)**
```
compareVersions("1.0rc1", "1.0")                = 1     (PEP 440: < 0)
specifierSatisfied(">=1.0", "1.0rc1")           = true  (should be false)
parseRequiresDist('sympy>=1.14; python_version >= "3.11"') = []   (dropped)
```
Both "hypotheses" in the discovery report are therefore confirmed facts.
- New PEP 440 ordering checked against 13 cases (rc/alpha/beta/dev/post/epoch/
  local/trailing-zero), all correct.
- New marker evaluator checked against the shapes real METADATA uses, including
  `and`/`or`, reversed operands, `in`, and the two undecidable shapes
  (parentheses, unknown variable) which return null.
- `npm --prefix desktop test` -> `tests 208 / pass 208 / fail 0` (was 199).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* delete by the distribution's own `RECORD` (pip's authoritative file
  list), with a conventional-layout fallback when RECORD is unreadable, and a
  path guard on both. *Rejected:* the report's suggestion of removing
  `<name>/`, `<name>.libs/`, `<name>.py` only — that misses top-level modules
  and data files a wheel installs under other names, and would have silently
  left them shadowing.
- *Chosen:* EVALUATE markers rather than treat every marked requirement as
  undecidable. Treating them all as undecidable would have turned nearly every
  overlapping name in torch's METADATA into a conflict and broken the engine
  install outright — a regression dressed as a fix. Only genuinely
  undecidable markers (parentheses, unknown variables) become conflicts.
- *Chosen:* `extra == "..."` evaluates to false, because
  `requirements-gigaam.txt` requests no extras. Recorded here because it is the
  one marker whose answer is a policy choice rather than a fact.
- *Chosen:* the marker environment's `python_version` comes from the engine
  interpreter itself (`resolvePythonVersion`), not from a constant; an unknown
  version makes version markers undecidable rather than guessing.

**Not done in this commit:** nothing from this group.

---
## Commit 9 — Python version SSOT

**IDs:** D-069 (P2), D-068 (P2, the `.python-version` half).

**Files:** `.python-version` (new, committed), `.gitignore`,
`desktop/scripts/prepare-runtime.sh`, `.github/workflows/tests.yml`,
`desktop/python-version.js` (new), `desktop/python-version.test.js` (new),
`desktop/main.js`, `desktop/package.json`, `AGENTS.md`, `CONTRIBUTING.md`.

**Re-verified on current code before fixing:** yes. `grep` over the tree at
`1a12c3c` still found the version typed into `prepare-runtime.sh` six times
(`PBS_PYVER="3.12.13"`, `cp312` ×3, `python3.12/site-packages` ×2,
`--python-version 3.12`), `tests.yml:24`, `main.js` (the winget hint),
`AGENTS.md:19`, `CONTRIBUTING.md:27` and `:137`, `NOTICE.md:13` —
and `.gitignore:13` forbade the one file that could hold it.

**Verification**
- Every new assertion replayed against `git show HEAD:<file>` (pre-fix source):
  ```
  OLD prepare-runtime.sh reads .python-version: false
  OLD prepare-runtime.sh retypes cp3NN: true
  OLD prepare-runtime.sh retypes pythonX.Y/: true
  OLD tests.yml uses python-version-file: false
  OLD tests.yml pins a literal version: true
  OLD main.js requires ./python-version: false
  OLD main.js hardcodes winget Python.Python.3.12: true
  ```
  i.e. all six guards in `python-version.test.js` fail on the old tree.
- The derivation reproduces the literals it replaces, run the way the script
  runs it (`bash -c`, same `tr`/`case`/`%.*`/`//./` expressions):
  ```
  PBS_PYVER=3.12.13 PY_XY=3.12 PY_ABI_TAG=cp312
  ```
  — byte-identical to the removed `3.12.13` / `3.12` / `cp312`.
- `bash -n desktop/scripts/prepare-runtime.sh` -> OK.
- `packaging.test.js` catches the new module if it is left out of
  `build.files` (observed by removing the entry):
  `main.js -> ./python-version.js is MISSING from build.files` -> `fail 1`.
- `npm --prefix desktop test` -> `tests 213 / pass 213 / fail 0` (was 208).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* `.python-version` holds the full `X.Y.Z`, and `X.Y` / `cpXY` are
  DERIVED. The three shapes the build needs (tarball version, site-packages
  path + pip `--python-version`, wheel ABI tag) are three renderings of one
  fact, so only the fact is stored.
- *Chosen:* the file is committed and `.gitignore` says why in place of the
  old blanket `.python-version` line. A `.gitignore` entry that hides the
  SSOT is how the duplication became necessary in the first place.
- *Chosen:* `prepare-runtime.sh` **dies** on a missing or malformed file
  rather than falling back to a literal. A fallback is a second source of
  truth wearing a default's clothes. The same rule shapes
  `parsePythonVersion`, which returns `null` instead of guessing, and
  `main.js`, which then names no version at all instead of a wrong one.
- *Chosen:* `log`/`warn`/`die` moved above their first call site in
  `prepare-runtime.sh`. The version gate is the first thing that can fail, and
  it sits above where `die()` used to be defined; leaving it there would have
  turned a clear error into `die: command not found`.
- *Chosen:* `.python-version` ships in `extraResources` so `getRepoRoot()`
  resolves it in a packaged app the same way it already resolves
  `requirements.txt`. *Rejected:* a constant in `main.js` guarded by a test —
  that is a copy plus a tripwire, not one source.
- *Chosen:* `NOTICE.md` keeps its literal `Python 3.12.13` (a redistribution
  notice must spell the version out) and the test locks every
  `Python X.Y.Z` it names to the SSOT.

**Not done in this commit**
- `desktop/engine-deps.js:52` and two `main.js` comments still say "3.12" while
  narrating a past bug; the one path-shaped comment was generalised, the
  historical ones are prose about what happened and are left as written.
---
## Commit 10 — dependency pins SSOT

**IDs:** D-026 (P1).

**Files:** `desktop/package.json`, `desktop/main.js`,
`.github/workflows/tests.yml`, `desktop/packaging.test.js`, `AGENTS.md`.

**Re-verified on current code before fixing:** yes, and on the SHIPPED app.
`ls /Applications/Transcriptor.app/Contents/Resources/` (installed 1.6.0):
```
ENABLE_GIGAAM
requirements-gigaam.txt
requirements.txt
```
— `requirements.runtime-lock.txt` is not there, so the on-device repair
install could not have applied it even if it had tried.

**Verification (pre-fix behaviour replayed from `git show HEAD:`)**
```
OLD backend pip calls: 2
   "-m","pip","install","-r",requirementsPath                                  | has constraints: false
   "-m","pip","install","--user","--break-system-packages","-r",requirementsPath | has constraints: false
OLD CI applies the lock: false
OLD extraResources destinations: backend, frontend, requirements.txt, .python-version, requirements-gigaam.txt, ENABLE_GIGAAM
```
Three installers, one of them applying the lock. After the fix all three do,
and the two new packaging tests assert each of the three by its own text.
- `npm --prefix desktop test` -> `tests 215 / pass 215 / fail 0` (was 213).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* one `constraintArgs` array, built once and spread into both pip
  invocations. The report's suggested edit touched only the first call; a
  retry that installs a different version set than the attempt it replaces is
  a second source of truth reachable only from a failure.
- *Chosen:* a missing lock **warns and continues** here, unlike
  `prepare-runtime.sh`, which dies. The build must not produce an unlocked
  bundle; a user whose Resources are damaged is better served by dependencies
  installed loosely than by an app that refuses to repair itself.
- *Chosen:* the optional-engine install (`requirements-gigaam.txt` into a
  staging site) is deliberately NOT constrained by the runtime lock, and the
  test says so. It is a different dependency set, and `engine-deps.js` already
  reconciles it against the bundle by its own rules; constraining it here
  would be a behaviour change to the engine path that no finding asks for.
- *Chosen:* `requirements.txt` keeps its five deliberate ranges. The lock is
  the release rendering of them, not a replacement — the header of the lock
  file states that policy and it is unchanged.

**Not done in this commit:** nothing from this group.

---
## Commit 11 — CI runs every suite, on a platform that can run it

**IDs:** D-027 (P1), D-071 (P2).

**Files:** `.github/workflows/tests.yml`, `desktop/packaging.test.js`,
`AGENTS.md`.

**Re-verified on current code before fixing:** yes.

**Verification (pre-fix workflow, replayed from `git show HEAD:`)**
```
OLD desktop job runs-on: ubuntu-latest
OLD workflow declares permissions: false
OLD workflow declares concurrency: false
OLD desktop job runs node --check: false
```
The two suites that had never executed in CI, confirmed by name on this Mac:
```
darwin-gated cases that ran here: 2
  ✔ every AppleScript in main.js compiles      (applescript.test.js)
  ✔ both shapes compile                        (paste-script.test.js)
```
They are the only `process.platform !== "darwin"` gates in the tree, and the
new test asserts exactly that list — so if the reason for the macOS runner
moves, the test says so instead of the runner silently becoming decoration.
- `npm --prefix desktop test` -> `tests 216 / pass 216 / fail 0` (was 215).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.
- The workflow parses as YAML (`yaml.safe_load` -> `name, on, permissions,
  concurrency, jobs`).

**Decisions**
- *Chosen:* move the desktop job to `macos-latest` rather than install an
  AppleScript compiler on Linux (there is none) or drop the skip guard (the
  tests would fail, not run). The suite takes ~2 s; the macOS minute
  multiplier is the price of the only CI that can compile the shipped script.
- *Chosen:* `node --check` as its own step, before `npm test`. AGENTS.md has
  declared it a required check all along and CI had never run it;
  `packaging.test.js` reads `main.js` as *text*, so nothing else in the suite
  ever parses these two files as modules.
- *Chosen:* `permissions: contents: read` at workflow level, not per job —
  no job in this file writes anything, and a per-job list would be three
  copies of one fact.
- *Chosen:* `concurrency.group` is `${{ github.workflow }}-${{ github.ref }}`.
  The WIP draft prefixed it with a literal `tests-` as well, which only
  restates `github.workflow`.

**Not done in this commit**
- Both osacompile tests still `return` silently if `osacompile` itself is
  missing. On `macos-latest` it is present; making that a hard failure would
  trade a real guard for a runner-image assumption. Left as written.

---
## Commit 12 — packaging & release invariants

**IDs:** D-060 (P2), D-063 (P2, recorded as debt), D-064 (P2), D-065 (P2),
D-066 (P2), D-067 (P2), D-068 (P2, the remaining three defects), D-070 (P2),
D-083 (P2).

**Files:** `.gitignore`, `desktop/package.json`, `desktop/packaging.test.js`,
`desktop/scripts/prepare-runtime.sh`, `desktop/scripts/notarize-dmg.sh`,
`desktop/scripts/generate-dmg-background.py`.

**Re-verified on current code before fixing:** yes, each by running the
mechanism rather than reading it.

**Verification**
- D-067 / D-068, measured with `git check-ignore -v --no-index` on the
  pre-fix file:
  ```
  .gitignore:84:desktop/build/   desktop/build/dmg-background.png   (tracked, and named by build.dmg.background)
  .gitignore:106:.claude/        .claude/launch.json                (tracked)
  .gitignore:79:!desktop/scripts/prepare-runtime.sh                 (a negation of nothing — desktop/runtime/ never covers desktop/scripts/)
  desktop/dist/ listed twice, at :33 and :82
  ```
  After: both tracked files report unignored, `desktop/dist/x`,
  `desktop/build/other.png` and `.claude/settings.local.json` still ignored.
- D-066, from `app-builder-lib/out/fileMatcher.js` — `addPatterns(config[name])`
  then `addPatterns(options.customBuildOptions[name])`, i.e. concatenation:
  ```
  OLD mac   duplicated destinations: ["requirements-gigaam.txt","ENABLE_GIGAAM"]
  OLD win   duplicated destinations: ["requirements-gigaam.txt","ENABLE_GIGAAM"]
  OLD linux duplicated destinations: ["requirements-gigaam.txt","ENABLE_GIGAAM"]
  OLD mas   duplicated destinations: []
  ```
  (`mas` was never *missing* them — the top-level list covers it. Three copies
  were dead weight, not a gap.) After: all four platforms report `[]`.
- D-070: `OLD artifactName: undefined`. The five strings that reproduce
  electron-builder's default expect `Transcriptor-<version>-arm64.dmg`; the
  new template expands to exactly that, asserted against `notarize-dmg.sh`.
- D-083: `OLD npm scripts running bash unguarded: dist, dist:dir, dist:adhoc,
  dist:dir:adhoc, notarize:dmg, dist:mas, testflight:upload, dist:linux` —
  eight of nine. Now the test enumerates `pkg.scripts` and requires the guard
  on every one that shells out to bash.
- D-060, both branches reproduced with a stubbed `notarytool`:
  ```
  OLD: error: Could not authenticate
       script continued; log file contains: []
  NEW: Could not fetch the notarization log for submission 1234:
       error: Could not authenticate
  ```
  The old form left an empty log and a message indistinguishable from
  "notarization was rejected for no stated reason".
- D-064, two `ffmpeg.exe` in one extracted tree:
  ```
  OLD picked: BUILD-B     (last match the traversal reached)
  NEW picked: BUILD-A     (first match, then stop — as mac and linux already do)
  ```
- D-065: the refactor is pixel-neutral. Both script versions were executed
  against the same Pillow and fonts and their outputs compared:
  ```
  OLD script vs NEW script — difference bbox: None
  ```
  The derived geometry reproduces the removed literals exactly
  (178+82+22 = 282, 482-82-22 = 378, head 378-22 = 356, ±14).
- `bash -n` on both shell scripts, `ast.parse` on the Python -> OK.
- `npm --prefix desktop test` -> `tests 220 / pass 220 / fail 0` (was 216).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* `desktop/build/*` with a negation, not `desktop/build/`. Git does
  not descend into an excluded directory, so a negation under one can never
  match — the committed background survived only because git already tracked
  it, and a regenerated or renamed one would not have appeared in
  `git status` at all.
- *Chosen:* the bash guard goes on EVERY npm script that shells out to bash,
  including the three macOS-only ones, and the test enumerates the scripts
  rather than naming them. One rule beats a per-script judgement call, which
  is how `dist:win` ended up the only guarded entry point.
- *Chosen:* pin `artifactName` to the template the five existing strings
  already assume, and assert the expansion against `notarize-dmg.sh`. A
  default is not a contract; making it one costs one line and removes the
  upstream-change failure mode without renaming anything.
- *Chosen:* the DMG generator reads `build.dmg.contents` and derives the well
  and arrow geometry from named offsets. *Rejected:* regenerating the
  committed PNG — this machine's Pillow/font stack produces different text
  antialiasing than the commit did (`committed PNG vs OLD script output —
  difference bbox: (43, 41, 521, 152)`, entirely in the two text rows), so
  regenerating would commit an unrelated visual change under a refactor.
  Recorded as debt.
- *Chosen:* the `ffmpeg.exe` search dies with the temp tree cleaned up. The
  old code leaked the mktemp dir on the not-found path.

**Not done in this commit**
- **D-063** (the macOS ffmpeg URL carries no build identifier, so the
  publisher can overwrite it in place): the pinned SHA256 keeps a substituted
  binary out of a release, but the day the file changes every macOS release
  build fails and the only repair is re-deriving the hash from an
  unverifiable source. A versioned mirror is the fix and it is a hosting
  decision. The trade-off is now written at the pin; recorded in "долг".
- "Install for macOS Sonoma" in the generator names an OS release with no
  source in the manifest (`build.mac.minimumSystemVersion` is not set).
  Changing user-visible artwork copy is a product decision; recorded in "долг".

---
## Commit 13 — the documented hotkeys, and the SSOT pointer that pointed nowhere

**IDs:** D-028 (P1), D-029 (P1), D-078 (P2).

**Files:** `README.md`, `README.en.md`, `desktop/shortcut-defaults.test.js`,
`AGENTS.md`.

**Re-verified on current code before fixing:** yes — both READMEs still printed
`F9` / `F10`, and `ls PRODUCT.md` still said no such file.

**Verification**
- The new README lock, run against the pre-fix documentation
  (`git show HEAD:README*.md` in a scratch dir with the real manifest):
  ```
  ✖ the documented Windows/Linux hotkeys are the ones the app registers
  ℹ tests 7 / pass 6 / fail 1
  ```
- D-078, the two weakened assertions, shown with a manifest a reviewer would
  expect to be rejected:
  ```
  defaults {"record":"Ctrl+Alt+F10","paste":"Ctrl+Alt+Shift+V"}
    OLD suite: pass 6  fail 0      <- fully green on a chord ending in F10
    NEW suite: pass 5  fail 2

  defaults {"record":"F10","paste":"F9"}   (the legacy pair, swapped)
    OLD suite: pass 5  fail 1      <- "no bare F9/F10" PASSED
    NEW suite: pass 4  fail 3
  ```
  The old `record !== "F9"` / `paste !== "F10"` pair is slot-specific, so the
  legacy keys survive in the other slot; and "3+ modifier chords" checked
  `parts.length >= 3`, which is two modifiers and a key.
- D-029: every path AGENTS.md names now resolves —
  `docs/PRODUCT.md`, `docs/VISION.md`, `.env.example`,
  `desktop/package.json`, `.python-version`, `.nvmrc`,
  `requirements.runtime-lock.txt`, `desktop/shortcut-defaults.json` — all OK.
- `npm --prefix desktop test` -> `tests 221 / pass 221 / fail 0` (was 220).
- `node --check desktop/main.js && node --check desktop/preload.js` -> OK.

**Decisions**
- *Chosen:* a test that reads the READMEs and asserts the manifest's current
  defaults appear and the retired pair does not — rather than generating the
  tables from `shortcut-defaults.json`. The READMEs are prose in two
  languages with their own spelling of a chord (`Ctrl`, not Electron's
  `Control`); generating them would need a templating step in a repo that has
  none. The rendering rule lives in the test, in one function, and the test
  is what fails when they drift.
- *Chosen:* the "bare function key" check covers BOTH slots and consults
  `legacy` for the values, so it cannot go stale against the manifest.
- *Chosen:* AGENTS.md rule 4 now names `docs/PRODUCT.md` as the vision and
  says what `docs/VISION.md` is, instead of leaving a reader to pick.

**Not done in this commit:** nothing from this group.

