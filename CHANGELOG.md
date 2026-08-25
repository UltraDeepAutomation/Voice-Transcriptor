# Changelog

All notable changes to Transcriptor are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **The model registry is derived from the catalog, not listed beside it.** `models_manager` carried its own hand-written table of Whisper repos and size hints, so after the catalog was cut to three sizes `tiny` and `base` still had repos — downloadable through the API while the UI could not offer them, with nothing reporting the disagreement. Repos are now derived by the one naming rule every Systran repo follows (`_REPO_OVERRIDES` exists for a future model that breaks it), size hints are keyed to the catalog, and tests assert the manager's universe of models *equals* the catalog's in both directions. `LOCAL_LIVE_PREVIEW_MODELS` — the cap on what may decode continuously beside a remote provider, so a user who chose `large-v3` for final quality does not get it running live — is now the catalog's first entry rather than a second list; `WHISPER_LOCAL_MODELS` is documented as ordered cheapest-first and a test holds that order against the size hints, so a reorder cannot silently make the live preview heavier.
- **Both Deepgram paths now format a transcript the same way, from one module.** Live streaming sent `smart_format=true`, prerecorded REST sent `smart_format=false`, and each carried a comment asserting the other was wrong — so the same recording came back formatted differently depending on which path served it, with nothing telling the user which did. The premise for disabling it, that Deepgram strips punctuation for Russian, is contradicted by the live path's own output: 3646 sessions run with it enabled, and 23 sampled transcripts carry a median of **60.3 punctuation marks per 1000 letters** (an earlier archive-wide measurement found the same direction, 50.7 against 36.6 on the path that disabled it "to protect punctuation"). `backend/deepgram_format.py` now owns `smart_format`, `punctuate` and `filler_words`; `DeepgramLiveConfig` no longer carries private copies, and options only one endpoint accepts (`paragraphs`, `numerals`, `endpointing`, `utterance_end_ms`) stay with their path because they are genuinely path-specific rather than a second opinion. `TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT` flips the shared value without a code change, and a test asserts the two paths agree, so they cannot drift apart again. What stays unproven is the narrower question of whether enabling it improves the batch path specifically — only a same-audio A/B answers that, and it spends live API calls against the user's key.

### Fixed
- **Eight stops in sixty-nine delivered less text than the provider had returned.** Measured by pairing `finalize EXIT text_len` against `[trace stopLive] FINAL transcriptLen` across a day of real recordings; the saved files name what went missing, and it is mid-sentence, not at a seam: `старая база данных отклоняет пароли. Я ж тебе скинул` delivered as `старая база данных Я ж тебе скинул`, `вот так, чтобы стоял Вот, и отправь` as `вот и отправь`. Three functions were answering one question — pick the richer text, graft the candidate's tail, or keep what we hold — and each loses a different half. `unionTranscripts` aligns the two readings by their longest common subsequence and keeps every word of both: shared runs take the authoritative wording (it decoded the whole recording with context), a run only one side has is inserted where the alignment places it, and where both decoded the same span differently the authoritative reading wins. It falls back to the pick when the texts share too little to be the same speech, or when either is long enough that alignment would cost more than the stop path can spend. `mergeTranscriptTail` is gone — the union subsumes it, and its production case is now one of the union's fixtures.

- **A word re-heard slightly later is the same word.** The local live path decided a word was new when its END fell past the emit watermark. A re-decode of already-committed audio answers yes to that whenever its estimated end drifts — which both engines do, by more than `emit_epsilon_sec` — so the second reading was emitted again. The text guard cannot catch these: they are the same speech rendered differently (`пять` re-decoded as `56789`, `сам` as `самое`), sharing no token. Coverage is now decided by a word's CENTRE, which moves half as far under the same drift, and which is the rule the Deepgram path's interim splice already applies to the same question. Measured on a real recording, replayed through the shipped pipeline under both rules: overlapping segments **10 → 2**, 26 words → 21, with the removed five being re-decode debris (`и дальше` after `дальше`, a repeated filler). The trade is stated plainly: where the first reading was the poorer one, it is the reading that survives — a streaming path cannot retract what it has already emitted.

- **The capsule stayed invisible for a whole recording.** Reported after a press produced no capsule at all; the next press showed one already reading six seconds. The log agrees — the window was created in 198 ms at the start and first painted 6 s later by the stop. `ensureRecordingStatusCapsuleWindow` returned the window as soon as `new BrowserWindow` had constructed it, before its document had loaded, so a caller handed it mid-load fell out at the `recordingStatusWindowReady` check. That was harmless while some other caller was still going to paint — and stopped being harmless the moment every update took a sequence number: the early return had already claimed the newest number, so the caller that *was* waiting for the load saw itself superseded and skipped its paint as well. Both left; nothing painted. Every caller now waits for the in-flight load, which is what makes the sequence guard sound: it may only ever drop a paint in favour of one that will actually happen. A dropped update also says so in the log instead of returning silently.

- **The model dropdown and the engine that ran disagreed.** The user selected GigaAM, the selector showed a GigaAM model, and five consecutive sessions transcribed with Whisper `small` — the WS query in the log says `model=small` on every one of them. `setTranscriptionSelection(group, model?)` stored the model only when one was passed, and the group selector's change handler has none to pass, so switching group left that group's model slot empty. From there the two sides answered "what is selected here?" differently: the selector rendered `group.models[0].id` while the reader of the selection fell back to the global default model, which is a Whisper id. One `defaultModelForGroup` now answers for both, preferring a model whose engine is actually installed, and `selectedLocalModel` falls back inside the chosen group before it falls back to the global default — answering with a Whisper model for a GigaAM group is a silent engine switch.

### Changed
- **Three Whisper sizes instead of five, and one GigaAM instead of two.** `tiny` and `base` were choices with no reason to choose them: fast in exchange for a transcript that needs correcting. `small` is the default and the floor, `medium` and `large-v3` the steps above. The GigaAM pair differ by decoding head, not by hearing: `e2e-rnnt` is trained end to end over a 1024-piece SentencePiece vocabulary, emits punctuated normalised text directly and decodes faster, while plain `rnnt` has a 33-character vocabulary and emits lowercase without punctuation — it exists so word-error rate can be scored without case and punctuation absorbing errors. That is a benchmarking tool, not a dictation engine. The live-preview model list followed the catalog (it pointed at `tiny`/`base`, both now gone), and four tests that hardcoded retired ids now read them from the catalog.

- **Local engines repeated the window overlap into the transcript.** Reported against both faster-whisper and GigaAM, and visible verbatim in the reports themselves: `насколько он хорошо. хорошо работает`, `какие-то проблемы. проблемы, может быть`, `у этих чуваков чуваков еще Чанкова`. The local live path decodes a rolling 8 s window and re-feeds 1 s of already-committed audio at its head so a word on a boundary is decoded with context — the head of every pass is therefore a second reading of speech already emitted. It was removed by timestamp alone: a word whose end fell at or before the watermark plus `emit_epsilon_sec` (50 ms) was dropped. But both engines re-estimate word times on every pass and drift by more than that, so the second reading survived the trim and was emitted again. Timestamps cannot settle it — both readings are equally plausible. The text can: the longest run of words at the head of a new segment that repeats the tail of what was already said is the overlap, and it is now dropped, bounded to ten words so a genuine repetition further along is never touched. `trim_repeated_prefix` is pure and unit-tested against the reported transcripts. One existing single-flight test had a stub returning the *same* words on both passes and asserted that the second was still emitted — it now returns distinct text per pass, because a fixture that repeats itself was asserting the duplication.

## [1.4.0] - 2026-08-25

The release that fixed the things that had been quietly costing words and
seconds on every single recording. Every entry below was accepted on a
measurement taken from production logs, and the ones that were wrong the first
time are marked as such — including two regressions introduced and corrected
inside this release.

Headline numbers, all measured on this tree:

| | before | after |
|---|---|---|
| hotkey press → renderer | 110-380 ms | 2-29 ms |
| press → first captured audio frame | never measured | 182-230 ms |
| paste | 592 ms (p50) | 235-374 ms |
| finalize, empty tail | 962-1011 ms | ~460 ms |
| the last word of a sentence | missing in ~45 % of stops' worth of risk | captured |

### Performance
- **A hotkey press reaches the microphone in one round trip.** The press had to survive three sequential `executeJavaScript` calls to the renderer and a capsule-window create before the toggle event was dispatched: `renderer_ready_check` → `queryRendererRecordingState` → `publishRecordingStatus` (110-380 ms, because the capsule is destroyed 8 s after going idle and most presses pay a fresh create) → an awaited `osascript` frontmost-app lookup (60-250 ms). The three questions are one question — the toggle handler reads both facts anyway — so `dispatchRendererTogglePress` asks and acts at once, with `allowStart` carrying the main process's veto (post-stop work holding the single capsule, microphone permission not granted) so a start that could not proceed is still refused. `getMediaAccessStatus` is synchronous, so the granted case costs nothing. The capsule is published, not awaited. The frontmost lookup is fired at the press and read after the start is confirmed — it reports the same app either way, and auto-paste needs it at stop.
- **The paste stopped waiting on itself: p50 ~590 ms, ~240 ms of it fixed sleeps that nothing observed.** `set frontmost of p to true` followed by `delay 0.08` ran on every paste; the log says the target was already frontmost in **1459 of 1459** of them, because Transcriptor never takes focus (the capsule is a non-focusable window). The activation is now conditional on `frontmost of p is false` — the safety net survives, the delay does not, and the returned reason carries `+activated` when it does fire, so the assumption stays measurable. The `delay 0.16` between clicking the target's Paste menu item and returning was 160 ms added to exactly the moment the user is waiting for: nothing after it observes the paste, the clipboard restore does not run for at least 1.5 s, and the auto-send Enter carries its own settle (220 → 380 ms, so the paste-to-Enter interval is unchanged).
- **The short post-Finalize window now covers only the tails it was measured on.** Shipping it against `_tail_needs_flush` applied a 0.25 s window — measured on stops whose gap was 0.06-0.24 s, pure boundary jitter — to every tail that did not need a *retry*, a band up to `TAIL_GUARD_MIN_SEC` (0.75 s) wide. "Needs a retry" and "has nothing left to flush" are different questions, and collapsing them cost a user the end of a sentence: production 2026-08-25 14:33:16, `gap=0.50s speech_in_gap=0.00`, stream closed 0.25 s after Finalize, transcript delivered ending `…чтобы никуда не не`. Half a second of audio past the last final that no interim had decoded either — exactly what Finalize exists to force, and the answer takes a round trip the window was too short to receive. Three of the stops recorded in the hour it shipped were in that band (gaps 0.39, 0.50, 0.58 s). Three cases now: an empty tail (≤ `COVERAGE_GAP_MIN_SEC`) keeps 0.25 s, a small but real tail gets the 0.75 s sized from actual round trips, an uncovered tail keeps the full ceiling and the retry. The timeout log also stops printing "nothing was unflushed" over half a second of unflushed audio — it reports what was measured and lets the reader conclude.
- **The post-Finalize confirmation window was sized from the wrong population.** 0.75 s came from the round trips of sessions that *received* a post-Finalize transcript — all uncovered-tail sessions, where `Finalize` has something to flush and therefore answers. A covered tail is the case where it does not, and every covered stop recorded since the split shipped — **9 of 9** — waited out the whole window and got nothing, at 962-1011 ms per finalize. A number never once reached is not a margin, it is a fixed cost: 0.75 → 0.25 s, still long enough for a message already on the wire. What is risked is bounded by what "covered" means — every streamed second is already inside a finalized segment, so a late arrival could only re-word text we hold, never add missing speech. An uncovered tail keeps the full 3 s ceiling and the retry.

### Fixed
- **The microphone stays open 200 ms past Stop, because the last word was missing from the audio itself.** Reported as "I say the last word, press stop right after, and the word is simply gone". Two saved recordings analysed frame by frame end with speech at full level in their final 50 ms — `0.036 0.045 0.051 0.042 0.041 0.049 0.058 0.051 0.026` — with 0.05 s and 0.15 s of trailing silence. The word is not lost in transcription; it is not in the recording, and no re-decode, tail guard or merge can recover what was never captured. Nor is it rare: across 112 measured stops, **39 % left no trailing silence at all and 45 % left 100 ms or less**. A recogniser also needs the word's release and a moment of silence before it will seal it. The hold is fixed and unconditional — no speech detection, no variable window — and is skipped for a discarded take. It is reported as the first phase of the stop breakdown so the stop chain's published total stays the true distance from the press.
- **A double-tap on the hotkey no longer breaks the next recording.** Reported as "I pressed twice very fast and recording broke". The log: a stop at 07:43:21.900 ending a 3.3 s take, then a press 308 ms later answered with `start blocked by single-capsule post-stop work pending=1` — the second press started nothing, while a 14-character fragment went to the clipboard. The one-capsule-at-a-time guard is right; there was simply no work worth blocking for. A recording shorter than `minRecordingMs` is now discarded outright: no transcript, no history entry, no audio on disk, no `Finalize` sent upstream, and no post-stop work for the next press to queue behind — the capsule just closes. 500 ms, and the archive picked the number: across 3681 recordings the shortest are 0.00 s (six of them, a second press landing before any audio arrived), 0.22 s and 0.25 s, and then nothing at all until 0.55 s. The floor sits inside that gap, so it discards every accident on record (8 of 3681) and nothing that looks like speech. The renderer owns the clock (first captured audio frame) and the threshold, and the main process asks it rather than timing the press itself — two measurements would disagree at the boundary, and that disagreement is the main process waiting for a transcript the renderer had already thrown away.
- **A mis-heard word at the seam repeated the opening of the sentence.** Delivered to the user, 2026-08-25 14:19:55: `Так, ну вроде сейчас сообщение записывается за Так, ну вроде сейчас сообщение записывается, заебись, довольно быстро…` — the whole clause twice. The live source is `committed + snapshot + interim`, and the snapshot is the hypothesis a final replaced; here the final read `…записывается за` where its own interim had `…записывается, заебись, довольно быстро`. Six words agree and the seventh does not. Every existing guard needs the overlap to be exact end-to-end — `base.endsWith`, containment, the suffix/prefix scan — so one divergent word at the seam defeated all of them at every window length, and the hypothesis was appended whole. A hypothesis whose leading words re-decode a run at the end of the committed text now supersedes that run instead of following it: aligned by stem so an inflected re-decode still lines up, and only when the run is at least three words and at least 70 % accounted for, so a common opening cannot swallow committed speech. `composeCanonicalLiveSourceText` moved to `frontend/src/live-source.ts` to be testable at all — the production pair is a fixture, and the guards that already worked are pinned beside it.
- **"I press stop and my words get cut off" was a tie-break, not a lost tail.** The audio and the recognition were both complete. The saved file from the reported recording holds both texts: the backend final ends `…и у меня обрываются слова. В чём проблема?`, the delivered transcript ends `…и у меня обрываются` — and the delivered one carries `несколько слов. Они иногда`, a phrase no final segment ever covered. Two partial views of one utterance, both 27 words, so `richerTranscript` — a *pick* — tied on word count and fell through to "longer string wins". `mergeTranscriptTail` aligns the tail of what we hold against the candidate by stem key (a re-decode with different endings still anchors) at the LAST place it occurs (a repeated phrase grafts after its final appearance) and appends everything past it. No anchor means the texts are not continuations of each other, and there the pick is still safest, so `richerTranscript` stays the fallback. The production pair is a test fixture, next to a test pinning what the old policy returned.
- **The hole warning measured re-decode windows, not speech.** `_uncovered_speech_sec` charged the full span of every interim message carrying ≥8 characters. A rolling interim spans several seconds and can carry two words near its end, so each one reported seconds of "recognised speech that never reached a final" that was never spoken — and that number is shown to the user as a warning that their transcript may be incomplete. Spans now come from Deepgram's word timings, with inter-word silence shorter than the boundary threshold bridged so a breath is not a hole and a real pause still splits the span. A hypothesis that arrives without word timings still contributes its message span: going blind would be worse than over-reporting.

### Changed
- **The support log answers three questions it could not before.** `[trace startLive]` — the phases between the hotkey reaching the renderer and the FIRST CAPTURED AUDIO FRAME, mirroring the stop chain's breakdown; nothing in that path had ever been measured. `[trace tail-gap]` — the verdict on whether a stop believed its tail was complete, which is the whole diagnosis when a user reports a cut-off ending and which existed only in a devtools console nobody had open. `[recording-capsule] visible … create=…ms` — how long the capsule took to appear and how much of it was its window create. Deepgram sessions also log their full query string at connect: `endpointing`, `utterance_end_ms`, `smart_format` and `punctuate` all change what the transcript looks like, and a session whose parameters are absent from the log cannot be compared with one recorded before they changed.
- Detaching the capsule publish makes two writers concurrent, so every intent to change what the capsule shows takes a sequence number and a write that had to wait for its window re-checks it before painting. A slow create can no longer repaint a state the app has left, nor re-show a window a later hide put away.

## [1.3.10] - 2026-08-25

Verified good build: stop latency, memory, idle CPU and the recording tail all measured on
this tree. See the entries below for the numbers each change was accepted on.

### Performance
- **Half a second removed from every stop.** The instrumentation shipped an hour earlier produced its first breakdown: `total=1255ms | stream.getTracks.stop: 1ms → flushWorkletPort: 2ms → waitForWorkletDrain: 467ms → …`. `waitForWorkletDrain` waits for a 120 ms gap with no new frame, bounded at 450 ms — but the microphone track is stopped in step 1 while the worklet node stays connected, so the audio thread keeps calling `process()` and keeps handing over frames of silence. The idle condition can never be satisfied, so the cost was the ceiling, every time. The flush that runs immediately before it already provides a complete barrier: the processor runs `flushPending()` and posts `flush-ack` in the same handler, and a MessagePort preserves order, so every PCM message posted before the ack has been delivered. `flushWorkletPort` now reports whether the ack arrived, and the drain runs only when it did not — which is the ScriptProcessor fallback, where no port exists and the silence heuristic is the only barrier available.

- **~~The tail guard measured audio; it now measures speech.~~ REVERTED — see below.** Almost every recording ends the same way: the user finishes a sentence, then reaches for the stop hotkey. That trailing second or two of silence is streamed audio with no final segment covering it, so `streamed − covered` read it as an unflushed tail and took the retry path — a 3 s wait, a second `Finalize`, another 3 s wait — to discover Deepgram had nothing to send, because there was nothing there. Observed in production immediately after the previous fix shipped: two consecutive sessions, gaps of 3.01 s and 1.94 s, **6272 ms and 6214 ms at finalize**, one splicing a single word and the other nothing at all. With `interim_results` on, Deepgram emits a hypothesis as it decodes, so a trailing region that produced no interim produced no words — and a `Finalize` cannot flush words that were never decoded. `_tail_coverage` now also returns the recognised speech lying past the last final (clipped and merged, so a rolling re-decode cannot double-count), and that is what the guard turns on. Real unflushed speech keeps the full ceiling and the retry, unchanged. With interim results off the audio measure still applies — without hypotheses there is no speech signal, and waiting needlessly is the safe direction.

- **Paste script walks the target's menu bar once, not twice.** The auto-paste AppleScript asked `exists` for a deep accessibility path and then fetched the same path again — two full traversals of another application's menu bar, the most expensive operation in the script. Measured against a live app: 170–240 ms duplicated and visibly jittery, versus a flat 160 ms evaluated once, over a 40 ms `osascript` baseline. The window-title lookup had the same shape. Semantics are unchanged; a missing element raises, which is exactly what the `exists` test was detecting.

- **Stop latency: the post-Finalize wait now sizes itself from tail coverage.** Measured over 706 real Deepgram sessions in `main.log`: median finalize wait 1205 ms, p90 3220 ms, 1053 s in total — and 267 of 410 traced stops (65 %) ended with the streamed audio *already fully covered* by finalized segments, meaning Finalize had nothing left to flush and Deepgram was never going to answer. The coverage figure that proves nothing is missing was computed only inside the timeout handler, i.e. strictly after the ceiling had been paid. It is now measured first (`_tail_coverage`) and chooses the budget: an uncovered tail keeps the full 3.0 s plus the retry (truncating there would cost the user real words), a covered tail gets a 0.75 s confirmation window — sized from 411 measured round trips whose p95 is 0.49 s and max is 1.49 s.
- **Deepgram session summaries carry the whole picture** (`streamed_sec`, `text_len` added), and the finalize log lines now print `streamed / covered / gap` so a truncated tail can be diagnosed from the log alone instead of inferred.

- **Idle memory cut from ~1.4 GB to ~0.5 GB**: the backend loaded faster-whisper (plus ctranslate2, PyAV and the Silero VAD) on *every* launch, regardless of the selected provider — 767 MB resident, 1.3 GB peak, and 5-16 s of startup CPU even for users who transcribe exclusively through Deepgram or OpenRouter. The unconditional startup warm is gone; `scheduleLocalWarmup` now fires only when `resolveEffectiveProvider` actually resolves to `local` (missing/unusable remote key, or offline), and re-fires on the connectivity transition that creates that condition. Measured backend footprint after the change: **60.9 MB** at rest, no `ctranslate2` / `av` / `tokenizers` mapped into the process.
- **Local models are released after 10 minutes idle** (`TRANSCRIPTOR_WHISPER_IDLE_UNLOAD_SEC`, 0 disables): the LRU cap only ever evicted on *insert*, so a single local transcription pinned its model until quit. Measured: 504 MB → 116 MB after one sweep.
- **`/api/transcribe/warmup` short-circuits when the model is already resident**: the renderer calls it on startup, on provider change and on every network flip, and each call re-ran two full synthetic transcriptions. Repeat call now costs 15 ms instead of 4.7 s. Residency — not a stale warm record — is the authority, so a model dropped by the idle sweeper still re-warms.
- **The recording capsule no longer outlives the recording**: its window was created on the first recording and lived until quit — a second permanently resident renderer process (~64 MB and its own V8 isolate) that, created with `backgroundThrottling` disabled, kept compositing while hidden and burned ~13% of a CPU core at idle, dragging the shared GPU process with it. The window is now destroyed 8 s after going idle and re-created on demand.

### Changed
- **The radius scale is the only place a corner is decided.** A census of the stylesheet found 15 distinct `border-radius` values, of which a third were raw pixel literals sitting alongside tokens that already carried the same number: `999px` is what `--chip-radius` means, `10px` is `--control-radius`, `8px` is `--radius-sm`, `12px` is `--radius`. Sixteen such literals now use their token, which is a pure de-duplication — each value *is* the token's value, verified in a live page: every token resolves to exactly the literal it replaced and real elements measure unchanged (chip 999px, controls 10px, cards 12px). `6px` was used four times with no token at all, so the scale did not cover what the design actually used; it gained `--radius-xs`. What deliberately stays literal: `50%` on circular dots, where a token would hide the intent, and four genuine one-offs.

- **History list rebuild: ~1250 ms → ~85 ms** (measured on this archive's 5907 transcripts). Rebuilding the list read the full text of *every* transcript to parse four header fields and probed *every* accepted audio extension per item to find the sibling file — ~12 MB of reads and ~100k `stat()` calls. And it ran constantly: the list cache is invalidated after every single save, so the first History load after each recording paid the whole rescan. Two structural fixes, no change to the response contract: a per-transcript metadata cache keyed by identity + `(mtime_ns, size)` (a saved transcript is immutable, so every unchanged file becomes a dict lookup; the cache is pruned to exactly the files each scan sees, so deletions cannot leak it), and one directory listing per archive dir that builds a stem→audio index in place of the per-item extension probe.
- **History list renders a window, not the whole archive.** Every filtered item used to get its own DOM row — ~35 000 nodes at 5907 recordings, for a list showing about twenty. `frontend/src/list-window.ts` (unit-tested) caps what is materialised at 200 rows and grows by 200 as the user scrolls toward the end. Search, keyboard navigation and selection still operate over the complete filtered set — only the DOM is bounded — and the window always extends far enough to contain the selected row, so `moveRecordingSelection` keeps working. Growth is monotonic within a filtered set (scrolling back up never tears down rows), and resets when the set is replaced: a new search query or a fresh archive load. A "Showing N of M" line under the search box keeps the truncation honest.

- **Background polls suspend instead of spinning.** `createGatedPoll` (`frontend/src/gated-poll.ts`, unit-tested) is now the one scheduler behind every recurring renderer refresh. The old shape — `setInterval(() => { if (hidden) return; refresh(); }, 2000)` — still pays for the wakeup, and the main window runs with `backgroundThrottling: false` (needed so recording survives an alt-tab), so Chromium does not clamp those timers the way it would in a normal tab. A closed gate now costs **zero** wakeups. Consumers: the Settings→Shortcuts conflict badge (was 2 s forever, now only while that pane is on screen), the network-state pill (only while the window is visible; an OS online/offline event refreshes immediately instead of waiting out the interval), and the local-models list. Ticks are chained rather than interval-driven, so a request slower than the cadence delays the next wakeup instead of queueing callbacks behind it, and a throw or rejection is reported without killing the poll.
- **Global-shortcut changes are event-driven.** The renderer published every shortcut edit on *two* channels: the `__app_shortcuts__` bridge message, and a `window.__transcriptorPendingShortcuts` value that the main process fetched with an `executeJavaScript` round-trip every 2 s for the entire life of the app. The bridge message already carries the accelerators, and it is strictly better — it arrives the instant capture finishes rather than up to 2 s later, and it is the only channel that can express the capture lifecycle at all. The poll, its handle, its teardown and the renderer-side duplicate are gone; one channel now carries the fact.

- **Audio retention is now per collection, and declarative.** The old rule — "only the newest recording in the archive keeps its audio" — was a single global cardinality answer applied to two collections with different economics, and it was written twice (once for the per-save path, once re-derived from the newest transcript for the startup sweep). It also meant a voice note lost its audio the instant the next one was recorded. Retention is now a data table (`AUDIO_RETENTION_POLICIES`) keyed by collection, with two composable dimensions evaluated by one function:
  - **Live Capsule** (voice notes): keep the audio of the newest **3** takes (`TRANSCRIPTOR_LIVE_AUDIO_KEEP_COUNT`).
  - **Uploaded Media** (track extracted from an uploaded file): keep for **7 days** (`TRANSCRIPTOR_UPLOAD_AUDIO_RETENTION_SEC`).
  - The archive root inherits the Live policy — it predates the collection folders and held voice recordings.
  - **Transcripts are never deleted**, at any age or count, in any collection.
  A recording just saved is exempt from deletion but still occupies a slot in the count ranking, so a clock skew can never let a save collect its own audio. Age limits also get an hourly background sweep, because a long-running app would otherwise never revisit files that aged out while it was up.

### Fixed
- **Reverted: gating the tail guard on recognised speech. It lost four seconds of a real sentence.** The reasoning was that with `interim_results` on, a trailing region producing no interim produced no words, so a `Finalize` could not flush what was never decoded — which would let a pause before Stop close fast instead of paying the retry path. The premise is false in exactly the case the guard exists for. Measured in production one stop after it shipped: `streamed=20.08s covered=16.07s gap=4.01s speech_in_gap=0.00s` — four seconds of speech, reported as zero, because Deepgram had stopped emitting interims 3.7 s before Stop and then never flushed the final either. A provider going quiet and a user falling silent are indistinguishable to that signal. Uncovered **audio** decides again; recognised speech can only add a reason to retry, never remove one. The cost is that a pause before Stop still pays the retry path — losing a closing sentence is not a trade worth three seconds. `speech_in_gap` stays measured and logged, because telling the two shapes apart after the fact is how this was caught.

- **The per-stop latency breakdown was computed on every recording and thrown away.** `stopLive` already times each phase of the stop chain — `flushWorkletPort → waitForWorkletDrain → stopMediaRecorderAndFlush → pcmSink.finalize → …` — and emits it as one `[trace stopLive]` line. Severity is the right default rule for the console mirror, but it misfiled this: a summary emitted once per recording is not chatter, and sitting behind the debug flag with the thousands of per-step `[trace]` lines meant that when a user said "the transcript took a very long time" the answer existed only in a devtools console nobody had open. Summaries are now always mirrored (prefix match, so a transcript quoting the prefix cannot smuggle itself in); the high-volume stream stays behind the flag. The chain also gained a `wsFinalizeSent` mark, because the interval between Stop and telling Deepgram the recording ended was invisible — measured on one real stop at **1.4 s**, spent on local canonical-audio work while the upstream flush had not yet begun.
- **Permission denials said what, never why.** A recording start produces six decisions in ~40 ms and some are denials *by design*: Chromium probes video alongside audio, and `selectAudioOutput` asks for a capability this app does not use. Both logged as a bare `perm=media allow=false`, which reads as "the microphone was refused" — and was indistinguishable from an actual refusal, so the one line worth spotting was camouflaged by 70 that meant nothing was wrong. Each decision now carries the media types and a reason.

- **A write landed inside the audio spool's own close, and blamed the disk for it.** `OpfsPcmSink.finalize` awaits `writable.close()` and only nulls `writable` after it resolves — so for the whole duration of that close, a microtask flush scheduled by a late `append` still saw a non-null stream and wrote into it. The stream rejects that with "Cannot write to a closing writable stream", which the catch reported as **"disk may be full or permissions revoked"**: an internal ordering bug, told to the user as failing hardware, and it also set `lastWriteError`, diverting finalize onto its salvage path for a perfectly healthy disk. A `closing` flag is now set *before* the close is awaited and checked by the flush, because `writable` being non-null cannot be the test for "may I still write". Samples arriving past the drain barrier are counted and reported rather than dropped silently — a rising count would mean the barrier itself is wrong. Only visible at all because the renderer console mirror and readable error text landed first; before that it was `[object Object]` in a log nobody received.

- **Retries were invisible latency.** Every remote transcription and upscale call passes through `request_with_retry`, and the module had no logger. A user whose upload took eight seconds because the provider answered 429 twice saw only that it was slow, and the support log agreed with them. Retries now record the status or exception, the wait, and — importantly — whether the wait came from our backoff or from the provider's `Retry-After`, because a run of `Retry-After` waits is a rate limit rather than a flaky network and the two are fixed very differently. The two paths that give up are WARNINGs: a read timeout on a non-idempotent request, which is abandoned deliberately because the provider may already have done and billed the work, and the final failure, which records attempts and elapsed time so a "the upload failed" report has a history behind it. A clean first attempt stays silent. Log targets are `METHOD host/path` — never the query string, which is where provider URLs carry keys.

- **Focus was drawn three different ways, and the API-key row got two of them at once.** Generic controls used a 2 px `outline` offset 2 px outward, list rows used an outline plus a coloured border, composite fields used a 2–3 px `box-shadow` ring — so a focused key field showed a soft ring on the row *and* a hard outline offset outward from the input inside it, painted straight across the row's own border. One recipe now, expressed as tokens (`--focus-ring-width`, `--focus-border`): a `box-shadow` ring, which unlike `outline-offset` adds nothing to the control's footprint, so focusing never makes a control look taller than its neighbours. The ring is neutral rather than accent blue — it belongs to the same surface family as the plate it sits on, which is what keeps a focused control looking like the same component it was a moment ago. The `forced-colors` blocks still map both tokens to `Highlight`, so high-contrast users keep a system-strength indicator.
- **A saved API key looked unconfigured after you clicked its field.** Focus clears the mask so a click lands you straight into typing a replacement; nothing restored it. Clicking the field and clicking away left it empty, showing the placeholder, so a provider with a perfectly good stored key read as having none. Blur restores the mask when nothing was typed — safe precisely because the mask displays stored state and never *is* it.
- **`activate` with a visible-but-unfocused window now reveals.** Visible is not the same as frontmost: a window can be on screen behind another application, and `activate` is the user explicitly asking for this app. Measured before changing: across 157 activates that skipped the reveal, 156 were already focused and the skip was correct — this closes the one that was not, and cannot affect the other 156. The focus event also records `waited_ms` from the activate or reveal request, so "the window does not come forward immediately" stops being a report with nothing in the log to confirm or refute it.

- **Every recording was captured through the deprecated ScriptProcessor, not the AudioWorklet.** Vite inlines assets under 4 KB as `data:` URLs, and `pcm-worklet.js` is 2.3 KB — so every production build emitted the PCM capture processor as `data:text/javascript;base64,…`, which the page CSP (`script-src 'self' 'unsafe-inline'`) quite correctly refuses. `audioWorklet.addModule()` rejected on **every single take** and the catch fell back to ScriptProcessor: capture on the main thread, dropping frames under load, instead of on a dedicated realtime audio thread. Measured once the renderer console mirror was repaired: **5 fallbacks in 5 capture attempts, 100 %**. The CSP is not the thing to relax — `script-src data:` is a standard XSS vector, and the policy was refusing an artifact the build should never have produced; the worklet is now emitted as a real file served from `'self'`.
- **Renderer failures logged their context but not their reason.** `console.warn("context", err)` formats a caught error as `[object DOMException]`, so the support log recorded that the AudioWorklet fallback happened while discarding the one field that explained it. Fixing ~25 call sites would have fixed the 25 that exist today; `frontend/src/error-text.ts` fixes the formatting once, for every site present and future. The error `name` leads, because that is what separates a CSP refusal from a permission denial from a cancellation.

- **The upload pipeline left no trace at all.** `backend/jobs.py` had no logger, so the only record of an upload or from-path transcription in main.log was the uvicorn access line for the POST that created it — not whether it started, how long it queued, how long it ran, what it produced, or why it stopped. A user reporting "I dropped in a file and nothing came out" produced a support log with nothing to read. Every transition is now recorded in the store itself, which every caller passes through, so a new call site cannot ship silent: start with its queue wait, completion with duration and text length (an empty-but-successful transcription used to be indistinguishable from a real one), failure at WARNING with the reason and the progress it reached, and cancellation with how far it got. Fields are snapshotted under the lock and emitted after releasing it, so a blocking write to stderr cannot stall every other job's state transition.
- **ffmpeg conversions were timed nowhere.** `backend/audio.py` logged failures only, so decoding a source file — the heaviest step in the upload pipeline, tens of seconds for a long video — was indistinguishable in the log from a fast conversion or from none at all. `_run_ffmpeg`, the one runner every invocation in the module goes through, now records duration and input/output sizes on success and adds the elapsed time to both failure paths.

- **The microphone chip had no capsule because JavaScript kept deleting the class that draws it.** `renderMicHealthPill` assigned `pill.className` wholesale, which also wiped `status-chip` — the class giving all three topbar chips their shared background, border and radius. From the first state change onward the chip rendered as bare text beside two capsules, and no stylesheet fix could show, because the markup had already lost the class the rules were keyed to. Only the state class is swapped now; a state writer does not own the whole class attribute.
- **Topbar controls share one height.** The Record button took `--h-control` (40 px) and stood beside MIC and LANG selects on `--h-topbar-control` (34 px). The row already had a token meaning "the height of a topbar control"; the button simply had not joined it. Its "Rec" caption also aligns left like its neighbours instead of being pinned right.
- **The API-key row was a control drawn inside a control.** The action button inherited `.icon-btn`'s background, border and inset shadow — the same surface `.key-row` already paints — so the field rendered as a box containing a second, identically-coloured box. It is flat until hovered now, like a clear-button in a search field, and the input no longer carries a second copy of the row's padding.
- **Model sizes finally line up.** Verified numerically: all seven rows, including the two GigaAM rows that carry no action button, now share one right edge.
- **Settings header is one row.** Title left; version and "Check for updates" right. They were stacked under the heading, costing two rows of vertical space on every visit while the right half of the header sat empty.

- **Rescued words lost their punctuation.** Deepgram returns two spellings per word — `word` (raw) and `punctuated_word` (after the `smart_format`/`punctuate` options we request). The two providers disagreed about precedence: the batch path preferred `punctuated_word`, the live path preferred `word`. The live form was not a fallback chain at all, since `word` is populated on every word Deepgram returns, so the formatted spelling was unreachable. It mattered on the path that exists to *improve* quality: the live provider keeps interim words so `_splice_uncovered_interim_words` can fold back speech no final ever covered (43 such repairs across the shipped logs), and each rescued word entered the transcript raw — unpunctuated, uncapitalised — inside otherwise punctuated prose, so the repair announced itself. `backend/deepgram_words.py` now owns the decision and both providers import it.
- **Topbar chips, the Record control and the model table**, from user-reported screenshots: the microphone chip expressed its state with an `outline` while its two neighbours use the dot's colour — a difference of *kind*, painted outside the border box by separate machinery, so it rendered as a hard rectangle pinned beside two rounded pills; state is now a tint on the chip's own border. The Record button had no caption, so flex baseline alignment floated it above its labelled MIC/LANG neighbours; it is now a captioned `.top-item` like them, right-aligned via the wrapper so the caption travels with it. Model sizes still did not line up because every row was an independent grid — grid tracks are sized per container, and the GigaAM rows carry no action button, so their trailing `auto` track collapsed and shifted their cells; the table now owns one set of tracks and each row adopts them with `grid-template-columns: subgrid`, keeping per-row backgrounds while aligning every column down the card.

- **Discarding a live recovery left its sidecar behind.** `_live_recovery_paths` resolves the spool/sidecar pair by globbing for the `.pcm16`, so once the spool was gone it reported "no such recovery" and the delete returned immediately — orphaning the `.json` with nothing left that could ever name it. Measured on a real machine: 207 orphan sidecars against a single live spool, one per recording of the past day, cleared only by the 24 h retention sweep. Both halves are now removed independently, sidecar first so that a sidecar which cannot be deleted still leaves the audio in place (an orphan `.json` advertising a recovery whose PCM is gone is worse than leaving both for the sweep).

- **Nothing the renderer logged had ever reached the support log.** Measured across the entire archive set: zero `[renderer …]` lines, in any file, ever. Two independent causes, either sufficient on its own — the mirror was gated behind a development-only flag so every shipped build had it off, and the handler read Electron's pre-36 `console-message` signature `(event, level, message)` while the bundled Electron is 42, which passes `(event, details)`, so even with the flag on it tested the string `"undefined"` for a `[trace` prefix and matched nothing. Every renderer-side failure was therefore invisible: the recovery that could not be promoted, an AudioWorklet falling back to ScriptProcessor (a real capture-quality downgrade), a failed saved-audio fetch, a rejected key save. Diagnosing a user-visible error banner meant reproducing it by hand. `desktop/renderer-console.js` (pure, unit-tested) now owns the policy: **severity decides, not a string prefix** — warnings and errors are always mirrored, `[trace…]` stays behind the debug flag because it is thousands of lines per session, and routine info/debug is dropped. Both call signatures are normalised so the mirror survives the next Electron upgrade instead of silently going dark again; messages are newline-folded to one log line and length-clipped so a runaway dump cannot flood the file.

- **There was no way to record from inside the window.** The Live view had a microphone picker, a language picker and three panes, but no Record control — `setRecordButton()` had not painted a button in a long time, it only flipped a flag, and the renderer's own comment said recording "is controlled by global hotkey events". A hotkey the OS or another app had claimed therefore left the user unable to record at all, with nothing on screen to suggest why. The Live topbar now carries a Record/Stop button. It does not start recording itself: it asks the main process to run the same `toggleRecordingFromShortcut` the hotkey runs, so the microphone-permission prompt, the frontmost-window capture auto-paste depends on, the recording capsule, the single-capsule busy guard and the trace all behave identically whichever way the user asked. `setRecordButton` stays the single writer of the flag and now paints the control from it, so a recording started by hotkey shows a Stop button and vice versa.

- **"Could not recover 1 interrupted recording" on every launch.** A session interrupted by a crash, a SIGKILL or an installer leaves its recovery sidecar saying `status: "recording"` — that field is written when the session opens and only rewritten when it closes. The promote guard read it as "this session is still streaming" and answered 409, while the list endpoint happily offered the same session as recoverable. The renderer promotes every listed recovery at startup, so the pair produced a permanent, self-renewing failure: the message reappeared on every launch and the audio stayed unreachable. Liveness is process state, so it is now answered by an in-process registry that is empty at startup by construction — after a crash nothing is registered, so a stale "recording" sidecar reads as exactly what it is. Both endpoints consult the same predicate, so the list can no longer offer what promote would reject.

- **A live transcription that returns nothing is no longer silent.** 29 of 706 sessions (4.1 %) ended with zero final segments, 21 of them after more than 2 s of streamed audio — the renderer falls back to REST so the user usually still got their text, but the live path having failed left no trace above INFO. Now a WARNING carrying `interim_segs` (which separates "Deepgram never recognised anything" from "recognition worked, the flush failed"), the connect/finalize timings and the upstream error.
- **The support log is no longer three-quarters polling noise.** On a real 42 833-line archive: `GET /api/health` 29.5 %, `GET /api/network` 29.5 %, `PUT /api/ui/live-draft` 15.5 % — while the 135 recordings actually saved were 0.3 %. A `uvicorn.access` filter drops **successful** requests to the four paths the UI polls on a timer; a non-2xx on those same paths is kept, since a failing `/api/health` is the most useful line in the file. This also slows rotation, so real history survives longer than ~1.5 days.

- **AudioContext leak, one realtime audio thread per failed recording start**: `stopLive` returned early whenever `isRecording` was false — exactly the state `startLive`'s error path funnels into after the AudioContext exists but before the flag flips — so the context, its MediaStream and its AudioWorklet were never released, and Chromium keeps a running context's realtime thread and V8 isolate alive forever. Every teardown path now vacates the single-owner `ac` slot through one `closeAudioContextSlot`, and a start that finds the slot occupied closes and reports it instead of overwriting.
- **Log archives are capped at 7 days** in addition to the existing count/byte caps, so a heavy-logging stretch can no longer pin 50 MB of months-old archives.

## [1.3.9] - 2026-08-25

### Fixed
- **Audit wave 2 (BUG-39..52)**: offline machines no longer stall boot on a pip attempt (engine install is never part of the boot path); a failed model-download request can no longer pin `#model` to an un-downloaded model; config loading survives an unusable encryption keyfile instead of raising; the model-manager card derives its button/state from row state in both create and update paths; dead full-audio WAV write removed from the GigaAM adapter; model download progress is byte-weighted; cancelling the download modal restores the previous model choice.
- **GigaAM adapter contract**: empty-audio early return carries the full result shape (`text`, `language_probability`); model cache is LRU-capped (`TRANSCRIPTOR_GIGAAM_CACHE_SIZE`, default 1).
- **Backend hygiene**: recordings cache-key probe moved off the event loop; recovery session-id fallback handles ids containing underscores.
- **Audit wave 1 (BUG-24..38)**: GigaAM ids now work on every path that accepts them — file jobs, re-transcribe and warmup dispatch to the engine instead of crashing inside WhisperModel; the adapter emits faster-whisper's word-spacing convention and full result shape (live trim no longer glues GigaAM words, sync transcriptions no longer lose text); >20 s audio is chunked with a 1.2 s overlap and stitched by word time, so boundary words are neither truncated nor duplicated; Settings cards no longer paint inputs outside their borders (grid rows now measure real content); uploads honor the selected local model; a model choice made before its download finishes applies automatically; the Local-models card states loading/offline instead of rendering blank.
- **Audit wave 2 (BUG-53..76)**: POST requests are no longer retried on read timeouts (a provider may have processed — and billed — the first attempt); saving settings with an unusable key file returns a clean 503 instead of a raw 500; the finalize splice deduplicates orphan words that a newer hypothesis re-decoded at shifted times; model rows carry reconciler keys (no full-table rebuild every 2 s); the upload queue snapshots the model at enqueue time and gates availability; the model `<select>` rebuilds only when options change (an open dropdown survives the health poll); the live WS handshake buffer is capped in output samples (4 s of audio, was ~1.3 s — slow handshakes no longer drop opening words); the engine installer logs real pip stderr, gates on 8 GB free disk, installs into a fresh staging tree swapped in atomically, and boot-sweeps retired trees; pip children are killed on quit; a backend spawn error releases its dead handle so restart works; stereo channel split writes atomically; job progress is monotonic; OpenRouter audio-support detection no longer misfires on the word "image" and upscale shape errors are reported verbatim; the seam merger no longer mutates caller segments; the post-Finalize event is armed before the send (both paths); the stop-time forced flush is bounded; GigaAM models load under per-model locks; a failed model download releases the pending selection; the microphone-acquire timer is cleared on success (no unhandled rejection per recording); persisted queue/draft payloads are version-gated; the boot status line replays into a reloaded window; desktop and frontend package versions are equality-tested.
- **Audit wave 2.5 (BUG-77..81)**: a JSON-null Deepgram transcript no longer crashes the provider call; the engine import probe allows 60 s for a cold torch load; the install network gate validates TLS (captive portals that pass TCP now fail fast with a clear reason); global hotkeys are re-registered on system resume.
- **Runtime failure attribution (BUG-82)**: when the bundled runtime fails its import check, a clean-environment re-probe distinguishes engine-site shadowing from a genuinely damaged bundle — the error names the real cause instead of blaming the bundle.

### Changed
- **Engine install is user-initiated** (Settings → Local models → "Install engine"): explicit consent, network/disk gates, staged install with atomic swap, backend auto-restart after success. Boot never installs the engine.
- **Dependency-overlap policy** (`desktop/engine-deps.js`): engine-site may only add names the pinned bundle lacks — every overlap is pruned when the bundle satisfies all declared requirements and fails the install loudly otherwise. Boot-time reconcile heals pre-existing dirty installs.

## [1.3.8] - 2026-08-24

### Fixed
- **numpy shadowing**: the GigaAM stack installs its own numpy into engine-site, which would shadow the bundled runtime's pinned numpy for every import. The installer now prunes duplicate `numpy`/`ml_dtypes` after install — the bundle provides the single numpy; torch/gigaam are verified to run against it. *(Superseded by the generalized overlap policy in Unreleased.)*

## [1.3.7] - 2026-08-24

### Fixed
- **GigaAM engine location**: torch must never live inside the signed `.app` — writes break the code signature and every update wipes them. The installer now targets `userData/engine-site` via `pip --target`, and the backend imports the engine through a prepended `PYTHONPATH`. Both files (`requirements-gigaam.txt`, `ENABLE_GIGAAM`) now ship inside the bundle's resources, so packaged installs can actually see the opt-in.

## [1.3.6] - 2026-08-24

### Fixed
- **GigaAM never installed on existing setups**: the engine installer lived inside the requirements.txt reinstall branch, which healthy venvs skip entirely (early return on import check). Installation is now an independent gate — it runs whenever ENABLE_GIGAAM exists and `import gigaam` fails, on every launch path.

## [1.3.5] - 2026-08-24

### Added
- **GigaAM-v3 engine (Sber)** — Russian-only local ASR alongside faster-whisper: `gigaam-v3-e2e-rnnt` / `gigaam-v3-rnnt` in the same model catalog, dispatched to a new adapter that maps upstream results (incl. word timestamps) onto the existing segment shape; >20 s audio is auto-sliced under the upstream 25 s cap. Opt-in install via `ENABLE_GIGAAM` marker → app venv (never bloats the DMG); selector disables entries whose engine is missing.
- **Settings → Local models**: per-model download management — presence detection via HF cache, one-click Download with live progress, ✓ when stored. Selecting a missing model now asks first ("Download it now?") and applies the choice automatically once the download lands.

### Fixed
- **BUG-24**: superseded interim hypotheses no longer destroy the only record of unconfirmed speech — an orphan pool feeds the finalize splice (root cause of backend-side mid-recording holes).

## [1.3.4] - 2026-08-24

### Fixed (expanded audit wave 2 — desktop/main.js, backend API surface, config/persistence layer)
- **live.py single-flight**: a Stop-time forced flush could run concurrently with an in-flight periodic pass — overlapping windows interleaved emits (duplicate/out-of-order tail text). Forced flush now awaits the running pass; periodic ticks during a pass are skipped.
- **Recovery promote TOCTOU**: promoting a session that is still recording truncated the WAV and unlinked the PCM out from under the live writer; now rejected with 409.
- **Backend kill escalation on exit paths**: SIGKILL escalation lived in a timer that cannot fire during `process.on("exit")`/signals — hung uvicorn could survive as an orphan. Signal paths now escalate after 250 ms; the exit path escalates synchronously.
- **Port picker degenerate fallback**: ephemeral port `0` fell back to a port just proven occupied → EADDRINUSE crash loop. Now retried, then extended scan.
- **config.py keyfile contract**: Windows branch overwrote an existing-but-unreadable keyfile (permanent loss of all `enc:` values) — now mirrors POSIX refusal. Plaintext downgrade when the key is unavailable is refused loudly instead of silently writing secrets. Backup recovery unified between the two config readers (missing-primary case).
- **DEFAULT_CONFIG providers skeleton** derives from `REMOTE_TRANSCRIPTION_PROVIDERS` (SSOT).
- **Log rotation orphans**: crash between rotation renames stranded `*.rotating` support logs forever; swept and promoted at boot.
- Minor: upscale `instruction` capped (413 >20k), stale `enableRemoteModule` removed, http_retry timeout hint corrected.

### Verified clean (wave 2)
preload.js IPC surface · frontend id-wiring/listener-leaks/timers/draft-queue/XSS/settings-races/storage · backend WS disconnect/cancel paths · requirements vs imports · packaging whitelist vs require graph.

## [1.3.3] - 2026-08-24

### Fixed
- **Duplicated trailing phrases in live transcripts**: an interim hypothesis restating its own span with different word forms ("...на визуальную часть" → "...на визуальное") was appended as new content; stem-normalized subsequence matching now recognizes re-statements (seen live, session 20-32-21).
- **Word fragments severed at Deepgram flush boundaries** ("четыре, пя | ть"): adjacent touching finals whose boundary tokens form one vowel-less fragment are re-joined in the canonical transcript.
### Added
- **Finalize tail guard**: when Deepgram stays silent after Finalize AND streamed audio runs past the last final, the flush is retried once instead of closing blind (19 silent-close sessions on 2026-08-24 were benign by luck only).

## [1.3.2] — 2026-08-24

### Fixed
- **Update check "Failed to fetch":** the Content-Security-Policy now allows the renderer to reach `api.github.com`, so "Check for updates" actually works.
- **Build footprint:** a finished build no longer keeps three full copies of the same version (~715 MB → ~470 MB); the root-level internal zip is dropped once the install kit embeds it.

## [1.3.1] — 2026-08-24

### Fixed
- **Live tail truncation (BUG-20):** the end of dictated messages no longer gets cut off. Backend now waits up to 3 s for Deepgram's post-Finalize flush (was 1.5 s; healthy sessions still return instantly); an unflushed interim at the tail counts as proof of speech and triggers tail recovery; proven uncovered speech (>0.5 s) surfaces a visible warning instead of silent holes.

### Added
- **Update detection:** Settings header gains "Check for updates". The app checks GitHub releases at most once per day (plus on demand) and links to the new release page when one exists. Detection only — no automatic download/install.

## [1.3.0] — 2026-08-23

Recording reliability and stop-to-paste latency pass. Every number below
was measured from `main.log`, before and after.

### Added (integration pass, same release)

- **ESLint 9 flat config** as a hard CI gate at zero-warning baseline
  (`npm run lint`; adopted from external PR #4 by @chiliec).
- **GitHub Actions** running all three suites on every push/PR:
  backend unittest on the shipped Python 3.12 runtime (including the
  ten live-coverage TS cross-tests), frontend lint/typecheck/vitest/
  build on Node pinned by `.nvmrc`, desktop node:test.
- **BUGS_AUDIT.md** — full 19-defect audit with per-bug resolution
  status kept in-repo.
 and stop-to-paste latency pass. Every number below
was measured from `main.log`, before and after.

### Fixed

- **Recordings captured pure silence.** `askForMediaAccess` was only
  reached from the global-hotkey path, so starting a recording from the
  in-app button never asked macOS for microphone access — and a renderer
  `getUserMedia` does not reject when access was never granted, it
  resolves with a live track that emits zeros. No waveform, no words, no
  error. Microphone access is now resolved once at startup through a
  single `ensureMacMicrophoneAccess` helper shared by every entry point,
  and the TCC status is read live instead of latched.
- **Quiet recordings and clipped phrase boundaries.** Capture used
  Chromium's call-oriented defaults; echo cancellation and noise
  suppression are tuned for conferencing and both attenuate a quiet
  source and gate low-energy speech. Both are off for dictation, gain
  control stays on, defined once in `DICTATION_AUDIO_PROCESSING`.
- **The opening words of short recordings were dropped.** Frames captured
  while the live WebSocket was still connecting were drained only from
  inside `pushCapturedFrame`, so the flush depended on another frame
  arriving after the socket opened. A recording that ended inside the
  handshake window kept its first frames buffered forever. The socket's
  `open` event now drains them, and stop drains them again before
  finalize.
- **The last sentence went missing when Stop landed mid-phrase.**
  `Finalize` and `CloseStream` were written in the same millisecond, so
  the close raced the transcript Finalize had just flushed. Across 14
  sessions, streams that ended naturally left 0.25 s of audio undecoded
  on average; streams stopped mid-utterance left 1.86 s. `finalize()`
  now waits for the flushed transcript, bounded and short-circuited on
  arrival.
- **A client disconnect was logged as a server error.**
  `_is_broken_pipe_error` matched substrings of the message and missed
  `ConnectionClosedOK`, producing a full traceback thirteen times in one
  session. Classification is type-first and walks the cause chain.

### Changed

- **Stop → text in the target app: 9.56 s → 1.1–1.7 s.** The transcript
  now goes into whatever holds focus rather than restoring a start
  target. The trace showed the target app was *already* frontmost and the
  pipeline still spent 2.46 s restoring it and 2.20 s activating it,
  while Transcriptor's own window bounced forward mid-sequence. Target
  resolution went from 4156 ms to 13 ms.
- **Frontmost-app lookup: ~800 ms → ~110 ms.** `first process whose
  frontmost is true` makes AppleScript enumerate every process;
  `lsappinfo` reads the same facts from LaunchServices. Callers that
  route by window still use the AppleScript path.
- **Local stop no longer re-transcribes what was already decoded.** The
  live assist runs the same model the final pass would in the default
  configuration, so `LiveSession` now reports coverage truth — seconds
  covered, dropped, and left untranscribed — and the stop path adopts the
  live transcript only when the backend certifies full coverage, the
  models match, and no frame was stranded in the renderer.
- **Model warm-up is symmetric.** Startup probed the default model while
  the user-triggered warmup only loaded weights, leaving the lazy VAD
  load and first encoder pass to the first live window. Both probe now,
  and the probe exercises the decode path rather than only silence.
- **Recording capsule** narrowed 1.25× to 110 px, waveform column kept at
  30 px with a taller 15 px envelope, and the pill is fully opaque.

### Added

- **Microphone health state machine** (`frontend/src/mic-health.ts`) —
  classifies the capture stream on *digital silence*, no sample above one
  16-bit LSB, rather than on loudness, so a quiet room is never mistaken
  for a broken microphone. Flags a dead pipeline 2.5 s after start or
  after 4 s mid-session, with a 10 s watchdog for an audio graph that
  never starts. A topbar pill and the stop-time summary name the actual
  cause — permission, OS mute, device loss — instead of "No speech
  captured".
- **Live-transcript adoption policy** (`frontend/src/live-coverage.ts`) —
  pure, typed rejection reasons, so choosing the slow path is visible in
  the trace log.
- 42 tests across the new paths: mic-health FSM, coverage contract,
  adoption policy, disconnect classification, finalize ordering.

### Security

- **Purged a leaked OpenRouter API key from the entire git history.** It
  had been committed in `data/config.json` in the initial commit and was
  already published to GitHub. Removing it from history does not
  un-publish it — the key must be revoked at the provider.

## [Unreleased] — 2026-06-25

### Fixed

- **Settings shortcuts UI** — each key in a shortcut is rendered as an
  individual outlined keycap instead of a plain text phrase.
- **Deepgram small-audio REST timeout** — live recovery and short
  re-transcribe payloads no longer inherit the large-upload timeout budget.
  Tiny payloads fail fast on provider/network stalls while large uploads keep
  their long upload window.
- **Deepgram live connect budget** — live WebSocket connection attempts are
  bounded to an 8 s first attempt plus one 4 s retry.
- **Remote offline guard** — remote transcription calls fail fast when the
  app's network probe already reports offline, avoiding long cloud waits.
- **Redacted API-key roundtrip** — saving the Settings payload returned by
  `/api/config` preserves the real provider secret instead of persisting the
  masked display value.
- **Dormant legacy waveform** — the hidden legacy waveform sink no longer
  creates a canvas context, resize observer, or rAF render loop while disabled.
- **Recordings stats scan** — the expensive summary scan is now lazy and runs
  only when the Stats panel is explicitly opened.

### Build

- Added README guidance for internal ad-hoc macOS arm64 transfer artifacts
  versus production Developer ID + notarized distribution.

## [1.1.25] — 2026-05-10

Historical release-audit batch across 24K LOC. This changelog keeps the
1.1.25 release notes; the current verified bug audit lives in
`VERIFIED_AUDIT.md` and intentionally lists only confirmed real bugs.

### Fixed (audit + post-audit batch)

#### P0 (data-loss / breakage)
- **frontend `setSelectedFile`** — extension-less + MIME-less files no longer
  bypass the upload validator (lenient `!file.type` short-circuit removed).
- **frontend `OpfsPcmSink.finalize`** — recovers in-memory PCM after a write
  failure instead of returning empty WAV; salvages spool prefix + RAM tail.
- **frontend `parseError`** — reads response body once as text then attempts
  JSON; previous form double-consumed the stream and dropped server error
  detail.

#### P1 (incorrect behaviour / leaks)
- **backend Fernet keyfile** — disk-write failure no longer returns an
  in-memory key that would have caused silent permanent loss of every
  encrypted API key on the next boot.
- **backend `decrypt_value`** — distinguishes InvalidToken (warn) from any
  other exception (error + stack), no more silent secret loss.
- **backend `dict(DEFAULT_CONFIG)` → `copy.deepcopy`** — caller mutation no
  longer corrupts the global default for the rest of the process (5 sites).
- **backend Deepgram error envelopes** — final-payload + `/api/upscale` 502
  now route through `_safe_error_text`, no more raw upstream URLs / token
  prefixes leaking into the renderer.
- **backend local-assist final envelope** — `LiveSession.finalize_envelope()`
  reports the cumulative transcript instead of always-empty; frontend stops
  triggering a recovery REST round-trip on every successful local stop.
- **backend `transcribe.py` warm-probe regex** — covers Python 3.12 wording
  ("max() iterable argument is empty"); spurious stack trace on every cold
  start is gone.
- **backend `audio.py` ffmpeg cleanup** — partial output files unlinked on
  ffmpeg failure (both `compact_audio_for_remote` and `ensure_wav_16k`);
  downstream transcribe paths can no longer consume torn files.
- **backend Deepgram `connect()`** — retries on `OSError` (DNS gaierror,
  ConnectionRefused) per the docstring; previous code retried only on
  `TimeoutError`.
- **backend `_finalize_sent` flag** — set AFTER the Finalize send succeeds,
  not before; cancellation between flag-set and send no longer orphans the
  Finalize.
- **backend keepalive race** — snapshots `self._ws` before each send; close()
  on the same event loop can no longer null the reference between guard
  and use.
- **backend `connect()` rollback** — closes the open WebSocket if a
  `BaseException` (incl. `CancelledError`) fires between socket-open and
  recv/keepalive task launch; eliminates a connection-leak path.
- **backend `_ws_send_json`** — 5 s send timeout treats stalled clients as
  broken pipes; one paused renderer can no longer wedge the entire
  forwarder loop.
- **backend `_extract_meta_field`** — restricted to the file header prefix
  (text before first blank line); user transcript content starting with
  "Provider:" / "Language:" no longer corrupts stats / graph / filter.
- **backend `_promote_live_recovery`** — registers archive dir AFTER writes
  succeed, not before; failed writes no longer pollute the registry.
- **backend `compact_audio_for_remote` ffmpeg-missing** — raises
  `RemoteError` with an actionable message for non-Deepgram-native
  containers (.wma / .mkv / .opus / .webm / etc.) instead of degrading
  to a confusing upstream 400.
- **backend validators** — `_validate_audio_filename` rejects empty
  extensions; `_normalize_filename` strips Windows backslashes regardless
  of host OS and ensures fallback `.wav` extension when none exists.
- **backend recordings list** — `_recording_audio_payload` receives
  `target_dir` from list and single-recording paths so non-default
  archives correctly resolve audio existence.
- **frontend `lastSegEnd`** — tail-gap detection uses `Math.max(end)` over
  segments instead of array tail; correct for diarized recordings and
  out-of-order arrivals.
- **frontend `xhr.send`** — wrapped in try/catch + idempotent abort guard;
  pre-send abort no longer surfaces as a network-error reject.
- **frontend `discardLiveRecovery`** — failure no longer misreported as a
  save failure; recovery duplicate-on-restart eliminated.
- **frontend `hideBootOverlayOnce`** — defers `hidden=true` past the CSS
  transition so the documented fade-out actually runs.
- **frontend Re-transcribe token leak** — `activeUiSessionToken` adopted
  on cold-start re-transcribe is now released in `finally`; phantom token
  no longer survives.
- **frontend `reportFileSelectionError`** — non-disruptive notice replaces
  the blanket `patchCurrentRecordingSummary` write that could clobber an
  active live recording's status pill.
- **desktop `toggleRecordingFromShortcut`** — uses
  `execRendererJsWithTimeout(2000)` instead of unbounded
  `executeJavaScript`; stuck renderer no longer makes the hotkey a
  permanent no-op.
- **desktop OneDrive migration** — marker only written when EVERY child
  copy succeeded; partial copy failures now retry on next boot instead
  of permanently stranding user data in the OneDrive path.
- **desktop backend restart timer** — null'd from `.finally` instead of
  the synchronous start path; concurrent `startBackend()` callers no
  longer race into a double-spawn → port-bind collision loop.
- **desktop `hideRecordingOverlay`** — clears `overlayMouseTrackTimer`;
  20 Hz syscall poll no longer wastes CPU + battery for the entire app
  session whenever the overlay is hidden.
- **desktop overlay timer regex** — `\d{2,3}:\d{2}` accepts 100+ minute
  recordings; previous regex froze the overlay timer at 99:59.
- **desktop macOS permissions** — request prompt runs in parallel with
  backend boot, no longer blocks the launch sequence on a modal dialog
  the user might leave for minutes.
- **desktop `playOverlayCue`** — 500 ms cap on executeJavaScript so a
  stuck overlay webContents can't freeze hotkey-bound code paths.
- **desktop overlay close** — resets `overlayQuickSettingsInitialized` and
  `overlayQuickAutoSendInitialized` flags; recreated overlay window no
  longer shows stale checkbox states until manual toggle.
- **desktop `__app_reveal_recording__`** — rejects names containing `..`;
  prevents path-traversal enumeration of the user's home parent through
  `shell.showItemInFolder`.
- **desktop hotkey 1.1.24 regression** — comment block inside
  `createOverlayHtml`'s template literal was breaking the outer literal
  via stray backticks + `${}`; rewritten without those characters.

#### SSOT consolidation
- **`backend/audio_constants.py`** — single source of truth for
  `LIVE_SAMPLE_RATE_HZ` (16 000), `LIVE_PCM_BYTES_PER_SEC` (32 000), and
  `LIVE_RECOVERY_MIN_BYTES`. Every literal `16000`/`32000` in `audio.py`,
  `main.py`, `live.py`, and `remote_deepgram_live.py` migrated.
- **`backend/deepgram_endpoints.py`** — `DEEPGRAM_REST_BASE` and
  `DEEPGRAM_LIVE_URL` centralised; both `remote_deepgram` and
  `remote_deepgram_live` import from here. `TRANSCRIPTOR_DEEPGRAM_HOST`
  env override for regional routing.
- **Version SSOT** — `vite.config.ts` now reads
  `desktop/package.json` instead of `frontend/package.json` for
  `__APP_VERSION__`. One file to bump per release; `frontend/package.json`
  `"version"` field is vestigial.
- **MIME drift assert** — backend module-import-time assertion that
  `ALLOWED_AUDIO_EXTS ⊆ _AUDIO_EXT_TO_MIME.keys()` so a future addition
  to the ext list without a matching MIME entry fails on boot, not
  silently downstream.
- **`DEFAULT_OPENROUTER_AUDIO_MODEL`** — single named constant replaces
  inline `OPENROUTER_AUDIO_MODELS[0]` at 11 sites.
- **`countWords`** — `wordCountOf` aliases the module-level helper
  instead of a divergent inline lambda.

#### Docs / build
- **README** — corrected hotkey defaults per OS, removed Mac Intel
  section (build is arm64-only since 1.1.24), replaced hardcoded
  `1.1.1` filenames with `<version>` placeholders.
- **`.env.example`** — `TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC`
  documented default corrected from 3600 to 86400 (matches code).
- **`install/win/build.bat`** — JS-string backslash escape bug fixed
  (`\b`, `\t`, etc. in user paths). Pass via env var instead.
- **Mac build rules** — arm64-only (M-series); Intel x64 dropped from
  electron-builder target and `dist` script.
- **Renderer trace log bridge** — `console.log("[trace ...]")` lines
  mirror to `main.log` via `webContents.on("console-message", ...)`;
  enables packaged-build debugging without DevTools.

### [Unreleased prior to 1.1.25]
1.1.2 → 1.1.24: 22 release commits between 1.1.1 and 1.1.25
covering tail-cut recovery (1.1.13 → 1.1.16 ladder), parallel
race + Finalize-before-CloseStream (1.1.17 → 1.1.19), the
Deepgram-WS-not-emitting-is_final root cause investigation
(1.1.20 → 1.1.22), the overlay waveform red-line fix (1.1.23) and
the comment-in-template hotkey breakage + restore (1.1.24).
See `git log --oneline --grep "release"` for the full chain.

## [1.1.1] — 2026-04-25

Enterprise-grade storage layer (SSOT) and a dense wave of pre-launch
hardening. Shipped to global users the day after 1.1.0-rc was cut;
**24 audit passes** went into this release, ~105 unique bugs
identified and triaged across the stack.

Final tag at commit `a9a6da9` (chain: pass-15 → … → pass-24c).

### Added (passes 18–24)

#### Persistence / SSOT
- **Shared `backend/storage.py`** — every persistent file write
  (config, upscale presets, archive registry, API token, encryption
  key, recording transcripts, job results, live-recovery meta,
  legacy migration copies) routes through four primitives:
  `atomic_write_bytes`, `atomic_write_text`, `atomic_write_json`,
  `rotate_backup`. Each guarantees atomicity (`tmp + os.replace`),
  durability (`fsync` on file + parent dir on POSIX), recoverability
  (`.bak` rotation where applicable), and matches the
  `<path>.tmp-<hex>` convention swept by `_sweep_orphan_tmp_files`.
- **Config schema versioning** (`SCHEMA_VERSION=2`). Legacy 1.0.x
  configs (no `schema_version`) auto-migrated on load. Pre-migration
  version captured BEFORE `_migrate_schema` mutates it (pass-23 M
  fix), so the stamp-back-to-disk path actually fires for
  beta-shaped configs with encrypted keys.
- **Config `.bak` recovery.** `load_config` falls back to backup
  on parse failure of the primary; backup rotated on every save.
- **Config shape validation.** Wrongly-typed subtrees (e.g.
  `providers: "string"` from a buggy client) reset to defaults
  with a warning instead of crashing.

#### Async + concurrency
- **6 sync routes converted to `async def`** with `asyncio.to_thread`
  offload + per-cache `asyncio.Lock` rebuild gating. Historical batch
  included the Graph route; Graph is now dormant and the backend route is
  no longer registered. Current routes include GET
  `/api/recordings`, `/recordings/stats/summary`,
  `/recordings/{name}`, DELETE `/api/recordings`, POST
  `/recordings/pick-folder`, `/recordings/open-folder`,
  `/live/recoveries/{id}/promote`. Cold-cache scans no longer pin
  executor threads or starve the event loop.
- **`JobStore.shutdown(timeout=1.5)`** in lifespan post-yield drains
  in-flight transcription workers via `cancel_futures=True` +
  daemon-thread join. Prevents the half-written `result.json` /
  `.txt` corruption on Electron SIGTERM.
- **Whisper LRU model cache** (default 2, env-overridable). Cycling
  through tiny→base→small→medium→large-v3 no longer OOM-kills
  on 8 GB hosts.
- **Whisper `run_in_executor` 60 s timeout** in live transcription
  prevents wedged CUDA-OOM hangs from freezing the WS forwarder.
- **`http_retry pool_block=False` + pool_connections=8.** Stalled
  upstream providers no longer freeze the FastAPI executor by
  pinning all 64 connection slots.

#### Desktop
- **Progressive boot-loading UI** — `_bootLoadingDataUrl` shows a
  pulse + live timer immediately during the 5–60 s cold-start;
  120 s → 60 s ceiling.
- **Smart clipboard restore** — polls clipboard contents and
  ABORTS restore if user copied something new during the paste
  window, instead of unconditionally clobbering after 1200 ms.
- **macOS F-key Mission Control collision detection** —
  `getUserDefault("com.apple.keyboard.fnState", "boolean")` piped
  into shortcut status; renderer badges F-key rows with a tooltip
  offering 3 remediations (toggle OS setting, hold Fn, pick
  non-F-key).
- **OneDrive `%APPDATA%` auto-remediation** — detects when
  corporate KFM Roaming routed AppData into OneDrive sync,
  re-homes `userData` to `%LOCALAPPDATA%\Transcriptor` early in
  init, performs one-time `fs.cpSync` migration with
  `.migrated-from-onedrive` marker.
- **Orphaned 1.0.x `.venv` cleanup** on first 1.1.x launch with a
  working bundled runtime. Three safety guards: marker for
  idempotency, exact-path equality (no symlink escape), Python-venv
  signature check.
- **macOS Accessibility-revocation poll** — 30 s poll surfaces
  `__transcriptorAccessibilityStatus` to renderer.
- **Overlay multi-monitor resilience** — `display-metrics-changed`,
  `display-added`, `display-removed` listeners re-pin the overlay
  to the correct display.
- **Windows tree-kill via `taskkill /T /F`** prevents orphan
  uvicorn workers + ffmpeg grandchildren on shutdown.
- **Richer paste target capture** (pass 22) — single struct with
  appName/pid/windowTitle/windowId/hwnd/className/instanceName
  enables exact-window paste targeting (fixes "paste into wrong
  Chrome tab" reports).

#### Frontend / UX
- **Retranscribe session-gating** + `runUpscaleIfEnabled` integration.
- **API key save errors surface to UI** via `setStatus` + red ring
  + aria-invalid (was silent `console.error`).
- **Mic-enumerate error classification** by `DOMException.name`:
  6 distinct messages instead of one misleading "Permission denied".
- **Boot error overlay** classifies known families
  (port-in-use, permission-denied, missing-module, Python-not-found)
  with raw stderr in `<details>` disclosure (no longer leaks paths
  into the paste buffer).
- **Upscale text capped at 120 000 chars** client-side with
  user-visible "trimmed N chars" status, instead of opaque HTTP 400.
- **Custom upscale-preset delete confirms** before destructive action.
- **Silence-seconds + dB threshold inputs reflect clamped value**
  back into the DOM (UI/state mismatch fix).
- **Audio playback no longer disrupted** by routine
  `loadRecordings` refresh when the source URL hasn't changed.

#### Tests + docs
- **24 unit tests** in `backend/tests/` (15 storage primitives + 9
  config lifecycle + 1 pass-23 M regression) — `python -m unittest
  backend.tests.test_storage backend.tests.test_config -v` runs in
  ~70 ms with zero external dependencies.
- **CHANGELOG.md** Keep-a-changelog format documenting every
  user-facing change.

### Changed
- **Enterprise error redaction** (`backend/main.py `_safe_error_text`).
  Absolute filesystem paths and API-key-shaped tokens are stripped
  from every error string that reaches HTTP response bodies or the
  job store. Full exceptions still `logger.exception`'d locally.
- **API token comparison is constant-time** via
  `secrets.compare_digest` on both HTTP and WebSocket auth paths.
- **Live-recovery PCM spool has a 1 GB ceiling** (~8.7 h of
  16 kHz mono audio). Prevents a runaway session from filling a
  small SSD. Cap configurable via `MAX_LIVE_RECOVERY_BYTES`.
- **`http_retry` connection pool is non-blocking**. Previously,
  stalled upstream providers could freeze the FastAPI executor
  threadpool by pinning all 64 pool slots. Overflow connections
  now open transparently (100–300 ms TLS cost vs. a minute-long
  backend hang).
- **Mic enumeration errors are classified**. `DOMException.name`
  is inspected: `NotAllowedError` → "Permission denied",
  `NotFoundError` → "No microphone detected", `NotReadableError`
  → "Microphone in use by another app", etc. Previously everything
  mapped to the single misleading "Permission denied".
- **Boot-error overlay shows friendly headlines** (port-in-use,
  permission-denied, missing-module, Python-not-found) with the
  raw stderr moved to a `<details>` disclosure. Previously the
  raw text was visible by default and could leak into the paste
  buffer on first Cmd+V.
- **API key save failures surface to the user** via `setStatus`,
  red input ring, and `aria-invalid`. Previously silent
  `console.error` → user had no idea why transcription later
  complained about a missing key.
- **Retranscribe session-gated.** The "Re-transcribe" button now
  captures a session token, checks it before every DOM write, and
  routes through `runUpscaleIfEnabled` so AI rewriting applies to
  retranscripts when enabled.

### Fixed
- Windows SIGTERM orphaning python.exe subtree (→ `taskkill /T /F`).
- hardenedRuntime inconsistency between package.json (false) and
  afterPack.js (true) — now `true` in both.
- Hotkey-registration status never reaching the first renderer
  window (cached + replayed from `did-finish-load`, alongside
  accessibility-trust state and any prior boot error).
- Overlay `overlayLoaded` flag stuck `true` after window destroy +
  recreate, leaving the overlay a permanent blank capsule until
  process restart (pass-24c P0 fix).
- `startBackend` early-out order race: concurrent caller seeing
  momentarily-set `backend` during spawn-then-instant-crash window
  could proceed to loadURL against a backend about to die.
- URL `setWindowOpenHandler` / `will-navigate` now use
  `new URL()` origin parsing instead of vulnerable
  `startsWith(BASE_URL)` prefix-match (suffix-injection fix).
- VBS paste temp file uses `crypto.randomUUID()` instead of
  `Date.now()` (millisecond collision fix).
- `setIgnoreMouseEvents(true, { forward: true })` re-invocation
  on overlay mouse-leave is now platform-gated (macOS-only flag).
- `cscript` VBS-paste timeout 2500 → 5000 ms (Windows Defender
  AV scan budget).
- Audio playback no longer reset to position 0 by routine
  `loadRecordings` refresh when source URL hasn't changed.
- Deepgram "API key is not configured" misrouted to
  region-block/VPN hint; now explicitly classified.
- Upscale placeholder collision via text-equality sentinel
  (replaced with per-session `dataset.upscaleNonce`).
- Whisper `run_in_executor` now wrapped in
  `asyncio.wait_for(timeout=60)` — wedged CUDA-OOM hangs no longer
  freeze the WS forwarder.
- Whisper LRU cache evicts oldest model on insert beyond cap
  (was unbounded, OOM on 8 GB hosts when cycling models).
- Historical sync route handlers (then including graph, stats, promote,
  pickers, DELETE, get_recording) converted to `async def` + `asyncio.to_thread` —
  no longer pin the FastAPI executor pool on cold-cache scans.
- 6 raw `str(e)` error leak sites routed through `_safe_error_text`
  (WS fatal, Deepgram WS connect, save_config, picker errors,
  picker FileNotFound, open-folder errors).
- `_rec_dir_cache` reads/writes guarded by lock (race on
  fresh-cache-stale-timestamp).
- `_register_archive_dir` SSOT consistency — text-only save now
  registers the archive dir like audio save does.
- `http_retry pool_connections` 4 → 8 to absorb steady-state burst
  without TLS re-handshake.
- ffmpeg stderr now bounded at 64 KB via background reader thread
  (prevents OOM from corrupt-input ffmpeg crash loops).
- Click-and-hold overlay buttons leaking intervals when user drags
  off (document-level `pointerup`/`pointercancel`/`blur` cleanup).
- Accessibility-poll `setInterval` handle captured + `.unref()`'d
  + cleared on `before-quit`. Same now applied to
  `shortcutPollTimer`.
- `_ERROR_PATH_REDACT_RE` no longer over-matches URL paths
  containing `/Users`, `/home`, `/var`, `/tmp` (negative
  look-behind).
- `"Deleted undefined recording(s)"` in archive-delete UI (shape
  coercion + surfaces partial failures).
- `.encryption_key` write is now atomic — a crash during first-launch
  keyfile creation no longer produces a zero-length keyfile that
  silently invalidates every previously-encrypted value on next
  load.
- 5 persistence sites still using bare `Path.write_text` migrated
  to SSOT atomic writers (job result `.json`/`.txt` for both local
  and remote, live-recovery meta start + finalize, volatile-path
  migration copy).
- Silence-seconds + dB threshold inputs reflect the clamped value
  back into the DOM (UI/state mismatch fix).
- Custom upscale-preset deletion now confirms with `window.confirm`
  before destroying a user's tuned prompt.
- Upscale text > 120 000 chars trimmed client-side (preserving
  trailing summary) with status notice instead of opaque HTTP 400.
- Window-level mousemove drag-pan handler scope-bound to
  mousedown / mouseup / blur — zero overhead outside an active
  drag instead of fire-and-early-return on every mouse move
  for the lifetime of the renderer.
- Schema-version stamp regression: pre-migration version captured
  before `_migrate_schema` mutates it, so the stamp-back-to-disk
  path actually fires for legacy beta-shaped configs (pass-23 M).

### Infrastructure
- `install/win/build.bat` and `install/linux/build.sh` post-build
  filename hints corrected (1.0.0 → 1.1.1).
- `.gitignore` ignores `.claude/` harness state.

### Security
- Constant-time API-token comparison (`secrets.compare_digest`)
  on both HTTP and WebSocket auth surfaces.
- Absolute filesystem paths redacted from HTTP error responses
  and persisted job errors.
- API-key-shaped token patterns stripped from error strings.
- Live-recovery PCM spool cap prevents disk-fill DoS.
- Config file written atomically with `fsync` + parent-dir `fsync`
  on POSIX.

---

## [1.1.0] — 2026-04-14 (internal RC)

Bundled Python + ffmpeg runtime for zero-setup install on
Windows + macOS. Not publicly shipped — superseded by 1.1.1.

## [1.0.2] — 2026-03-28

Diagnostics + user-friendly network errors.

## [1.0.1] — 2026-03-15

Fixed blank Windows window; version badge; update story.

## [1.0.0] — 2026-03-01

Initial public release.
