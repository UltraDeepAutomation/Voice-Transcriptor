/**
 * Capture level — the single source of truth for every decision the
 * renderer makes about raw amplitude: "did this frame carry speech?"
 * and "did this session carry any at all?".
 *
 * Why it exists (BUGS_AUDIT_2026-09-03 §4.3). Chromium's automatic gain
 * control was on, so the level a session starts at is a property of the
 * AGC, not of the speaker: all three recordings measured on 2026-09-03
 * opened at 0 dBFS peak with a 7 dB crest factor — a signal sitting in
 * the limiter — and slid 10–15 dB over the first five to ten seconds
 * without ever coming back. A recording made in June sat at −24 dB
 * throughout. A constant like `rms >= 0.003` means "speech" in the first
 * of those and "loud speech only" in the second; on the tail of a
 * recording that has slid to −28 dB it means nothing at all.
 *
 * So nothing here compares against a fixed amplitude. The session's own
 * quietest passage is measured as it arrives, and speech is what rises
 * a fixed number of decibels above it — which is a property of speech
 * (a spoken syllable stands well clear of the room it is spoken in) and
 * not of the gain the capture stack happened to choose.
 *
 * The ONE absolute anchor is digital silence: the floor of a dead
 * capture pipeline, which is not a level at all but the absence of one.
 * It is defined once, in `mic-health.ts`, and imported here so the two
 * modules cannot drift.
 *
 * Pure: no DOM, no state beyond the tracker the caller owns.
 * Unit-tested in tests/audio-levels.test.ts.
 */

import { DEAD_PEAK_FLOOR, DEAD_RMS_FLOOR } from "./mic-health";

/**
 * How far above the session's own noise floor a frame must rise before
 * it counts as speech, and how far above that threshold a frame's PEAK
 * must rise to count on its own.
 *
 * 12 dB (a factor of 4) is the gap between a room and someone speaking
 * in it; it is also small enough that the quiet end of a phrase still
 * clears it. The peak rule catches a short transient — a single
 * plosive, the first consonant of a word cut off by the stop — whose
 * energy never lasts long enough to lift the frame's RMS.
 */
const SPEECH_OVER_FLOOR_RATIO = 4;
const SPEECH_PEAK_CREST_RATIO = 4;

/**
 * How the noise-floor estimate follows the signal: fast down, very
 * slowly up.
 *
 * Down fast, because the floor must find the room quickly — the pause
 * between two words is all the evidence there is, and a floor that lags
 * it would classify the following syllable against the previous word's
 * energy. Up slowly, and ONLY from frames that are not already speech:
 * the floor is an estimate of the room, and letting a long phrase feed
 * it makes the speech measure itself, drift the threshold up behind its
 * own energy, and go silent halfway through a sentence.
 *
 * The threshold is never derived from a floor below `FLOOR_MIN_RMS`.
 * A dead pipeline reports exact zeros, and four times zero is still
 * zero — every sample would qualify as speech. One 16-bit LSB of RMS is
 * the smallest floor that means anything.
 */
const FLOOR_FALL = 0.25;
const FLOOR_RISE = 0.0008;
const FLOOR_MIN_RMS = DEAD_PEAK_FLOOR;

/** Running measurement of one capture session's own level. */
export interface CaptureLevel {
  /** Frames observed so far. */
  frames: number;
  /** Adaptive estimate of the session's noise floor, in RMS. */
  floorRms: number;
  /** Sum of squared per-frame RMS, for the session average. */
  sumSquaredRms: number;
  /** Loudest single-sample magnitude seen. */
  peakMax: number;
  /** Frames that carried speech relative to the floor at the time. */
  speechFrames: number;
}

export interface CaptureLevelSummary {
  frames: number;
  /**
   * Session RMS: the square root of the MEAN OF THE SQUARES of the
   * per-frame RMS. Averaging the per-frame RMS directly under-reports
   * dynamic audio and inflates false-silence verdicts.
   */
  averageRms: number;
  peakMax: number;
  floorRms: number;
  /**
   * The capture pipeline delivered no signal at all — not "a quiet
   * room" but "an ADC that is not running". This is the one verdict
   * that is absolute, and it is the one a level can never fake.
   */
  digitalSilence: boolean;
  /** At least one frame rose above the session's own noise floor. */
  carriedSpeech: boolean;
}

export function createCaptureLevel(): CaptureLevel {
  return {
    frames: 0,
    floorRms: 0,
    sumSquaredRms: 0,
    peakMax: 0,
    speechFrames: 0,
  };
}

/** RMS a frame must reach, given the floor measured so far. */
function speechRmsThreshold(level: CaptureLevel): number {
  return Math.max(level.floorRms, FLOOR_MIN_RMS) * SPEECH_OVER_FLOOR_RATIO;
}

/**
 * Fold one captured frame into the session's level, and answer whether
 * that frame carried speech.
 *
 * The verdict is taken against the floor as it stood BEFORE this frame,
 * so a loud frame cannot lift the floor it is being judged against.
 */
export function observeCaptureFrame(level: CaptureLevel, rms: number, peak: number): boolean {
  const frameRms = Number.isFinite(rms) && rms > 0 ? rms : 0;
  const framePeak = Number.isFinite(peak) && peak > 0 ? peak : 0;
  const threshold = speechRmsThreshold(level);
  const isSpeech = level.frames > 0
    && (frameRms >= threshold || framePeak >= threshold * SPEECH_PEAK_CREST_RATIO);

  if (level.frames === 0) {
    level.floorRms = frameRms;
  } else if (frameRms < level.floorRms) {
    level.floorRms += (frameRms - level.floorRms) * FLOOR_FALL;
  } else if (!isSpeech) {
    level.floorRms += (frameRms - level.floorRms) * FLOOR_RISE;
  }
  level.frames += 1;
  level.sumSquaredRms += frameRms * frameRms;
  if (framePeak > level.peakMax) level.peakMax = framePeak;
  if (isSpeech) level.speechFrames += 1;
  return isSpeech;
}

export function summarizeCaptureLevel(level: CaptureLevel): CaptureLevelSummary {
  const averageRms = level.frames > 0 ? Math.sqrt(level.sumSquaredRms / level.frames) : 0;
  return {
    frames: level.frames,
    averageRms,
    peakMax: level.peakMax,
    floorRms: level.floorRms,
    digitalSilence: level.frames > 0
      && level.peakMax < DEAD_PEAK_FLOOR
      && averageRms < DEAD_RMS_FLOOR,
    carriedSpeech: level.speechFrames > 0,
  };
}
