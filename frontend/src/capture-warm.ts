/**
 * Warm capture — the decisions that let a recording begin with audio
 * already in hand.
 *
 * Why it exists (BUGS_AUDIT_2026-09-03 §4.7). Measured on 2026-09-03,
 * the cold start path costs `getUserMedia: 82 ms → audioContext: 33 ms
 * → first-frame: 172 ms`: for ~310 ms after the hotkey nothing is
 * recording, and the first syllable of a phrase begun on the press is
 * absent from the WAV *and* from the live stream. When the input device
 * is busy the same path is measured in seconds. Nothing downstream can
 * recover audio that was never captured.
 *
 * Two mechanisms remove it, and both are decided here:
 *
 *   1. WARM HOLD — after Stop the MediaStream, AudioContext and capture
 *      worklet are kept alive for a bounded idle window instead of being
 *      torn down, so the next start pays none of those three costs.
 *   2. PRE-ROLL — while held, the worklet keeps the last few hundred
 *      milliseconds of PCM in a ring buffer and hands it over on the
 *      next start, so the recording begins *before* the hotkey press.
 *
 * The same shape is what the reference implementations converged on:
 * Hex keeps a 1 s ring and pre-rolls 450 ms while warm; whisper-local
 * never closes its input stream at all and trims a 500 ms deque while
 * idle, having found that "opening/closing streams per recording was the
 * source of first-word-clipped bugs"; OpenWhispr holds a master stream
 * and clones a track per recording, expiring pre-roll chunks at 2 s.
 *
 * This module is pure: no DOM, no Web Audio, no timers. `main.tsx` owns
 * the resources and asks these functions what to do with them, so every
 * rule below is unit-tested in tests/capture-warm.test.ts rather than
 * only reachable through a live microphone.
 */

/** Verdict shape shared by every decision here: what, and why. */
export interface CaptureDecision {
  /** The reason code, for the support log. Stable, greppable, lowercase. */
  reason: string;
}

export interface WarmHoldDecision extends CaptureDecision {
  hold: boolean;
}

export interface WarmReuseDecision extends CaptureDecision {
  reuse: boolean;
}

/**
 * Input-device labels that mean "this is a Bluetooth microphone".
 *
 * Holding the microphone open on a Bluetooth headset is not free the way
 * it is on a built-in or USB input: as long as *any* application holds
 * the input, the device stays in the Hands-Free Profile, whose uplink is
 * a narrowband mono codec and whose downlink drops the headset out of
 * A2DP — music and call audio audibly degrade, and stay degraded for the
 * whole hold window. MacParakeet and Handy both disable their warm hold
 * on Bluetooth inputs for exactly this reason.
 *
 * The label is the only signal available. Chromium exposes no transport
 * or bus type on `MediaTrackSettings` or `MediaTrackCapabilities` — the
 * settings dictionary carries `deviceId`, `groupId`, channel/rate and the
 * processing flags, and nothing that distinguishes USB from Bluetooth —
 * so a device-name match is not a shortcut here, it is the whole of what
 * the platform will tell us.
 *
 * The list deliberately over-matches. A false positive costs one
 * optimisation (the next recording starts cold, exactly as it does
 * today); a false negative degrades the user's headset audio for 30 s
 * after every dictation. Those are not comparable, so the tie goes to
 * releasing the device.
 */
const BLUETOOTH_LABEL_TOKENS = [
  "bluetooth",
  "hands-free",
  "handsfree",
  "hands free",
  "hfp",
  "a2dp",
  "airpods",
  "beats",
  "headset",
  "wireless",
  "wh-1000",
  "wf-1000",
  "jabra",
  "soundcore",
  "galaxy buds",
];

/**
 * Does this input-device label describe a Bluetooth microphone?
 *
 * Case- and whitespace-insensitive substring match against
 * {@link BLUETOOTH_LABEL_TOKENS}. An empty label is treated as Bluetooth:
 * a device we cannot name is a device we cannot clear, and the safe
 * answer is the one that releases it.
 */
export function isBluetoothInputLabel(label: string): boolean {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return BLUETOOTH_LABEL_TOKENS.some((token) => normalized.includes(token));
}

export interface WarmHoldInput {
  /** `UI_TOKENS.capture.warmHoldMs`. Zero or less disables the hold. */
  warmHoldMs: number;
  /** `MediaStreamTrack.label` of the capture track (or the picker's text). */
  deviceLabel: string;
  /** Does the capture track still exist — i.e. `readyState === "live"`? */
  trackLive: boolean;
  /** `AudioContext.state` at teardown time. */
  contextState: string;
  /**
   * Was the AudioWorklet the capture path for the session that is ending?
   *
   * The pre-roll ring lives inside the worklet, and the ScriptProcessor
   * fallback (§4.5) has no equivalent. A held fallback would keep a
   * main-thread audio node and an open microphone alive and give nothing
   * back for it, so a session that fell back releases everything and the
   * next start goes through the ordinary cold path.
   */
  workletCapture: boolean;
}

/**
 * Should the capture graph survive this Stop?
 *
 * Every "no" is a reason code the trace line carries, so a support log
 * answers "why did this machine never warm-hold?" without a repro.
 */
export function decideWarmHold(input: WarmHoldInput): WarmHoldDecision {
  if (!(input.warmHoldMs > 0)) return { hold: false, reason: "disabled" };
  if (!input.workletCapture) return { hold: false, reason: "script-fallback" };
  if (!input.trackLive) return { hold: false, reason: "track-ended" };
  if (input.contextState !== "running") {
    return { hold: false, reason: `context-${input.contextState || "unknown"}` };
  }
  if (isBluetoothInputLabel(input.deviceLabel)) {
    return { hold: false, reason: "bluetooth" };
  }
  return { hold: true, reason: "held" };
}

export interface WarmReuseInput {
  now: number;
  /** `Date.now()` at the moment the hold was taken. */
  heldSince: number;
  warmHoldMs: number;
  /** `deviceId` the held track reports. */
  heldDeviceId: string;
  /** `deviceId` the picker is currently on; "" means "system default". */
  requestedDeviceId: string;
  trackLive: boolean;
  contextState: string;
}

/**
 * May the held graph be adopted by the recording that is starting?
 *
 * The TTL is re-checked against the wall clock here rather than trusted
 * to the expiry timer, and that is the point: `setTimeout` does not run
 * while the machine is asleep, so a lid closed for two hours would
 * otherwise hand a two-hour-old MediaStream to the next press. The clock
 * comparison catches the sleep case even when the timer has not fired
 * yet, and the track/context checks catch the device that went away
 * while we were not looking.
 */
export function decideWarmReuse(input: WarmReuseInput): WarmReuseDecision {
  if (!(input.warmHoldMs > 0)) return { reuse: false, reason: "disabled" };
  const ageMs = input.now - input.heldSince;
  if (!(ageMs >= 0) || ageMs > input.warmHoldMs) return { reuse: false, reason: "expired" };
  if (!input.trackLive) return { reuse: false, reason: "track-ended" };
  if (input.contextState !== "running") {
    return { reuse: false, reason: `context-${input.contextState || "unknown"}` };
  }
  // An empty request means "whatever the system default is", which the
  // held stream already is — the user has not pinned a device, so there
  // is nothing to disagree with. A pinned device must match exactly.
  if (input.requestedDeviceId && input.requestedDeviceId !== input.heldDeviceId) {
    return { reuse: false, reason: "device-changed" };
  }
  return { reuse: true, reason: "reused" };
}

export interface PreRollInput {
  /** Samples the worklet's ring handed over. */
  sampleCount: number;
  /** Sample rate those samples are in (the AudioContext's rate). */
  sampleRate: number;
  /**
   * How long ago the ring last received a sample, in ms — the
   * AudioContext clock at the `start` message minus the clock at the
   * worklet's last write.
   */
  staleMs: number;
  /** `UI_TOKENS.capture.preRollMaxAgeMs`. */
  maxAgeMs: number;
}

export interface PreRollDecision extends CaptureDecision {
  accept: boolean;
  /** Wall duration of the pre-roll audio, ms. */
  durationMs: number;
  /** Age of its OLDEST sample at the moment of the start, ms. */
  ageMs: number;
}

/**
 * Is this pre-roll still the moment before the press?
 *
 * While the graph is warm and the context is running, the worklet writes
 * to the ring on every render quantum, so `staleMs` is a fraction of a
 * millisecond and the oldest sample is exactly one ring length old. A
 * ring that stopped being written — a suspended context, a machine that
 * slept between two presses — still holds audio, but it is audio from
 * some earlier minute, and splicing it onto the front of a recording
 * would put words the user did not just say into the transcript.
 *
 * So the age that is tested is the age of the OLDEST sample
 * (`staleMs + durationMs`), and the whole ring is dropped when it fails.
 * Trimming the stale part is not better: what remains is still the audio
 * that preceded a pause of unknown length, not the audio that preceded
 * the press. This mirrors OpenWhispr's `PRE_ROLL_MAX_AGE_MS`.
 */
export function decidePreRoll(input: PreRollInput): PreRollDecision {
  const rate = input.sampleRate > 0 ? input.sampleRate : 0;
  const durationMs = rate > 0 ? (input.sampleCount / rate) * 1000 : 0;
  const staleMs = Number.isFinite(input.staleMs) ? Math.max(0, input.staleMs) : 0;
  const ageMs = staleMs + durationMs;
  if (!(input.sampleCount > 0) || !(rate > 0)) {
    return { accept: false, durationMs: 0, ageMs: 0, reason: "empty" };
  }
  if (ageMs > input.maxAgeMs) {
    return { accept: false, durationMs, ageMs, reason: "stale" };
  }
  return { accept: true, durationMs, ageMs, reason: "accepted" };
}

export interface CaptureElapsedInput {
  now: number;
  /** When the renderer was ASKED to record (the hotkey press). */
  startRequestedAt: number;
  /** When the first captured sample of the recording was taken. */
  startAt: number;
}

/**
 * How long the recording in progress has been going, from the earliest
 * clock that has started.
 *
 * There are two, and which one is earlier depends on the path
 * (BUGS_AUDIT_2026-09-03 §4.9). Cold: the press comes first and the
 * first sample lands ~310 ms later, so the press is the honest clock —
 * measuring from the first frame silently added the device start-up to
 * the "too short to keep" floor and threw away one-word dictations.
 * Warm with pre-roll: the recording *contains* audio from before the
 * press, so `startAt` is earlier and it is the honest clock.
 *
 * Taking the earliest of the two is the single rule that is right on
 * both paths. It answers exactly one question — "has this press lasted
 * long enough to be a recording?" — in one place, for the renderer and
 * for the main process alike. Everything the user is shown (the elapsed
 * timer, the saved duration) still runs off `startAt`, because that is
 * the audio the recording actually contains.
 */
export function captureElapsedMs(input: CaptureElapsedInput): number {
  const clocks = [input.startRequestedAt, input.startAt].filter((t) => t > 0);
  if (clocks.length === 0) return 0;
  return Math.max(0, input.now - Math.min(...clocks));
}
