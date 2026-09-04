"""Unit tests for the microphone-health FSM (``frontend/src/mic-health.ts``).

The frontend has no JavaScript test runner and adding one would mean a new
dependency, so the FSM — which is deliberately written as a pure,
clock-injected function — is exercised from the existing pytest suite:
the module is compiled with the TypeScript compiler that already ships in
``frontend/node_modules`` and driven by a small Node scenario runner. Each
scenario asserts a state trajectory, so a regression in the dwell timers or
in the digital-silence discriminator fails the backend suite.

The tests skip (rather than fail) when Node or the frontend's TypeScript
install is unavailable, so a backend-only checkout still runs green.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FSM_SOURCE = REPO_ROOT / "frontend" / "src" / "mic-health.ts"
TSC = REPO_ROOT / "frontend" / "node_modules" / ".bin" / "tsc"

TSCONFIG = {
    "compilerOptions": {
        "target": "es2020",
        "module": "esnext",
        "moduleResolution": "bundler",
        "strict": True,
        "rootDir": "src",
        "outDir": "out",
    },
    "include": ["src/mic-health.ts"],
}

# Scenario runner. Each scenario is a list of steps; every step advances the
# injected clock and feeds one observation, then records the resulting state.
_DRIVER = """
import { nextMicHealth, initialSnapshot, isDigitalSilence,
         DEAD_PEAK_FLOOR, PROBE_TIMEOUT_MS, SILENT_CONFIRM_MS,
         MAX_SAMPLE_GAP_MS } from "__MODULE__";

const SCENARIOS = JSON.parse(process.env.MIC_HEALTH_SCENARIOS);
const out = {};
for (const [name, steps] of Object.entries(SCENARIOS)) {
  let snap = initialSnapshot();
  let now = 1000;
  const trail = [];
  const notices = [];
  for (const step of steps) {
    now += step.advanceMs || 0;
    const res = nextMicHealth({ nowMs: now, last: snap, obs: step.obs });
    snap = res.next;
    trail.push(snap.state);
    notices.push(res.notice === null ? null : "notice");
  }
  out[name] = { trail, notices, silenceMs: snap.silenceMs, deviceId: snap.deviceId };
}
out.__constants = {
  deadPeakFloor: DEAD_PEAK_FLOOR,
  probeTimeoutMs: PROBE_TIMEOUT_MS,
  silentConfirmMs: SILENT_CONFIRM_MS,
  maxSampleGapMs: MAX_SAMPLE_GAP_MS,
  zeroIsSilence: isDigitalSilence(0, 0),
  oneLsbIsSignal: !isDigitalSilence(0, DEAD_PEAK_FLOOR),
};
process.stdout.write(JSON.stringify(out));
"""


def _silence(advance_ms: int = 50) -> dict:
    return {"advanceMs": advance_ms, "obs": {"kind": "rms", "rms": 0.0, "peak": 0.0}}


def _signal(advance_ms: int = 50, rms: float = 0.05, peak: float = 0.2) -> dict:
    return {"advanceMs": advance_ms, "obs": {"kind": "rms", "rms": rms, "peak": peak}}


def _start(device_id: str = "mic-1") -> dict:
    return {"advanceMs": 0, "obs": {"kind": "session-start", "deviceId": device_id}}


SCENARIOS: dict[str, list[dict]] = {
    # A working microphone: the first sample carrying any signal at all
    # promotes the session to "live".
    "signal_promotes_to_live": [_start(), _signal()],
    # A TCC-blocked stream emits exact zeros forever. It must be flagged,
    # but only after the probe window has elapsed — never on sample one.
    "digital_silence_flags_after_probe_window": [_start()] + [_silence()] * 60,
    "digital_silence_holds_during_probe_window": [_start()] + [_silence()] * 10,
    # A normal pause between sentences is ~0.5 s of near-silence. It must
    # not knock a live session into the error state.
    "short_pause_does_not_flag": [_start(), _signal()] + [_silence()] * 20 + [_signal()],
    # Sustained digital silence mid-session does flag, after the longer
    # in-session dwell.
    "sustained_silence_mid_session_flags": [_start(), _signal()] + [_silence()] * 120,
    # A quiet room still dithers above one LSB: that is not a dead mic.
    "quiet_room_stays_live": [_start()] + [_signal(rms=0.0002, peak=0.0008)] * 40,
    # Recovery: once samples come back the session returns to live.
    "silence_then_recovery": [_start()] + [_silence()] * 60 + [_signal()],
    # OS-level mute and device disconnect are diagnosed by their own events.
    "mute_then_unmute_reprobes": [
        _start(),
        _signal(),
        {"advanceMs": 100, "obs": {"kind": "track-muted", "muted": True}},
        {"advanceMs": 100, "obs": {"kind": "track-muted", "muted": False}},
        _signal(),
    ],
    "track_ended_is_terminal_until_restart": [
        _start(),
        _signal(),
        {"advanceMs": 100, "obs": {"kind": "track-ended"}},
        _signal(),
    ],
    "stream_error_marks_lost": [
        _start(),
        {"advanceMs": 10, "obs": {"kind": "stream-error", "message": "boom"}},
    ],
    "force_silent_is_idempotent": [
        _start(),
        {"advanceMs": 10, "obs": {"kind": "force-silent", "reason": "watchdog"}},
        {"advanceMs": 10, "obs": {"kind": "force-silent", "reason": "watchdog"}},
    ],
    # Nothing may leak past a session boundary.
    "session_stop_returns_to_idle": [
        _start(),
        _signal(),
        {"advanceMs": 10, "obs": {"kind": "session-stop"}},
        _silence(),
    ],
    # Events arriving before a session starts must not invent a state.
    "events_before_start_are_inert": [
        _silence(),
        {"advanceMs": 10, "obs": {"kind": "track-muted", "muted": True}},
        {"advanceMs": 10, "obs": {"kind": "track-ended"}},
    ],
    # A throttled/suspended timer resuming after minutes must not trip a
    # transition from a single observation: the delta is clamped.
    "stalled_timer_gap_is_clamped": [_start(), _silence(600_000)],
}


class MicHealthFsmTest(unittest.TestCase):
    results: dict

    @classmethod
    def setUpClass(cls) -> None:
        node = shutil.which("node")
        # These are the ONLY tests for this module, and a silent skip on
        # a runner without the frontend installed is exactly where the
        # cover is needed most — a fresh clone, or CI. Under ``CI`` the
        # missing toolchain is a FAILURE of the run, not an absence of
        # the test (B-089).
        missing = ""
        if not node:
            missing = "node is not installed"
        elif not TSC.exists():
            missing = "frontend/node_modules is not installed (npm --prefix frontend ci)"
        if missing:
            if os.environ.get("CI"):
                raise AssertionError(
                    f"{missing} — this module is the only cover for "
                    f"{FSM_SOURCE.name}, so CI must not skip it"
                )
            raise unittest.SkipTest(missing)

        cls._tmp = tempfile.TemporaryDirectory()
        work = Path(cls._tmp.name)
        (work / "src").mkdir()
        (work / "src" / "mic-health.ts").write_text(
            FSM_SOURCE.read_text(encoding="utf-8"), encoding="utf-8"
        )
        (work / "tsconfig.json").write_text(json.dumps(TSCONFIG), encoding="utf-8")
        # Marks the emitted .js as ESM so Node can import it directly.
        (work / "package.json").write_text('{"type":"module"}', encoding="utf-8")

        compiled = subprocess.run(
            [str(TSC), "-p", str(work / "tsconfig.json")],
            cwd=work,
            capture_output=True,
            text=True,
        )
        if compiled.returncode != 0:
            raise AssertionError(
                "mic-health.ts failed to compile:\n"
                f"{compiled.stdout}\n{compiled.stderr}"
            )

        module = (work / "out" / "mic-health.js").resolve()
        driver = _DRIVER.replace("__MODULE__", module.as_uri())
        run = subprocess.run(
            [node, "--input-type=module", "-e", driver],
            cwd=work,
            capture_output=True,
            text=True,
            env={**os.environ, "MIC_HEALTH_SCENARIOS": json.dumps(SCENARIOS)},
        )
        if run.returncode != 0:
            raise AssertionError(f"scenario runner failed:\n{run.stderr}")
        cls.results = json.loads(run.stdout)

    @classmethod
    def tearDownClass(cls) -> None:
        tmp = getattr(cls, "_tmp", None)
        if tmp is not None:
            tmp.cleanup()

    def trail(self, name: str) -> list[str]:
        return self.results[name]["trail"]

    # ── discriminator ────────────────────────────────────────────────────

    def test_discriminator_is_digital_silence_not_loudness(self) -> None:
        consts = self.results["__constants"]
        self.assertTrue(consts["zeroIsSilence"])
        self.assertTrue(consts["oneLsbIsSignal"])
        self.assertAlmostEqual(consts["deadPeakFloor"], 1 / 32768)

    # ── happy path ───────────────────────────────────────────────────────

    def test_session_start_enters_probing_and_keeps_device_id(self) -> None:
        self.assertEqual(self.trail("signal_promotes_to_live"), ["probing", "live"])
        self.assertEqual(self.results["signal_promotes_to_live"]["deviceId"], "mic-1")

    def test_quiet_room_is_not_a_broken_microphone(self) -> None:
        trail = self.trail("quiet_room_stays_live")
        self.assertNotIn("silent", trail)
        self.assertEqual(trail[-1], "live")

    # ── dead pipeline detection ──────────────────────────────────────────

    def test_digital_silence_flags_after_probe_window(self) -> None:
        trail = self.trail("digital_silence_flags_after_probe_window")
        self.assertEqual(trail[-1], "silent")
        first_silent = trail.index("silent")
        consts = self.results["__constants"]
        # 50 ms per silence step, with trail index 0 being session-start:
        # the flag must land exactly on the step that crosses the probe
        # window — not earlier (a double-counted dwell) and not later.
        self.assertEqual(first_silent, round(consts["probeTimeoutMs"] / 50))

    def test_probe_window_is_not_tripped_early(self) -> None:
        trail = self.trail("digital_silence_holds_during_probe_window")
        self.assertNotIn("silent", trail)
        self.assertEqual(trail[-1], "probing")

    def test_short_pause_never_flags_a_live_session(self) -> None:
        trail = self.trail("short_pause_does_not_flag")
        self.assertNotIn("silent", trail)
        self.assertEqual(trail[-1], "live")

    def test_sustained_mid_session_silence_flags(self) -> None:
        trail = self.trail("sustained_silence_mid_session_flags")
        self.assertEqual(trail[-1], "silent")
        consts = self.results["__constants"]
        self.assertEqual(trail.index("silent"), round(consts["silentConfirmMs"] / 50) + 1)

    def test_signal_recovery_returns_to_live(self) -> None:
        self.assertEqual(self.trail("silence_then_recovery")[-1], "live")

    def test_stalled_timer_gap_is_clamped(self) -> None:
        # A ten-minute gap must contribute at most one clamped delta, which
        # is far below the probe window, so the state must still be probing.
        self.assertEqual(self.trail("stalled_timer_gap_is_clamped"), ["probing", "probing"])
        consts = self.results["__constants"]
        self.assertEqual(
            self.results["stalled_timer_gap_is_clamped"]["silenceMs"],
            consts["maxSampleGapMs"],
        )

    # ── device events ────────────────────────────────────────────────────

    def test_mute_then_unmute_reprobes_before_claiming_live(self) -> None:
        self.assertEqual(
            self.trail("mute_then_unmute_reprobes"),
            ["probing", "live", "muted", "probing", "live"],
        )

    def test_track_ended_is_terminal_until_next_session(self) -> None:
        self.assertEqual(
            self.trail("track_ended_is_terminal_until_restart"),
            ["probing", "live", "lost", "lost"],
        )

    def test_stream_error_marks_lost(self) -> None:
        self.assertEqual(self.trail("stream_error_marks_lost"), ["probing", "lost"])

    # ── notices are edge-triggered ───────────────────────────────────────

    def test_notice_fires_once_per_entry_into_a_bad_state(self) -> None:
        notices = self.results["digital_silence_flags_after_probe_window"]["notices"]
        self.assertEqual(sum(1 for n in notices if n), 1)

    def test_force_silent_does_not_repeat_its_notice(self) -> None:
        result = self.results["force_silent_is_idempotent"]
        self.assertEqual(result["trail"], ["probing", "silent", "silent"])
        self.assertEqual(sum(1 for n in result["notices"] if n), 1)

    # ── session boundaries ───────────────────────────────────────────────

    def test_session_stop_returns_to_idle_and_samples_stay_inert(self) -> None:
        self.assertEqual(
            self.trail("session_stop_returns_to_idle"),
            ["probing", "live", "idle", "idle"],
        )

    def test_events_before_session_start_are_inert(self) -> None:
        self.assertEqual(
            self.trail("events_before_start_are_inert"), ["idle", "idle", "idle"]
        )


if __name__ == "__main__":
    unittest.main()
