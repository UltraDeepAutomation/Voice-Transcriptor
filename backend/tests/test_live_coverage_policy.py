"""Unit tests for the live-transcript adoption policy.

``frontend/src/live-coverage.ts`` decides whether a stop may reuse what
the live assist already decoded instead of re-transcribing the saved
recording. Getting that wrong in the permissive direction ships a
transcript that is silently missing words, so every rejection path is
pinned here.

The frontend has no JavaScript test runner and adding one would mean a
new dependency, so — as with ``test_mic_health.py`` — the module is
compiled with the TypeScript compiler already present in
``frontend/node_modules`` and driven by a small Node scenario runner.
The tests skip when Node or that install is unavailable.
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
POLICY_SOURCE = REPO_ROOT / "frontend" / "src" / "live-coverage.ts"
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
    "include": ["src/live-coverage.ts"],
}

_DRIVER = """
import { decideLiveTranscriptAdoption } from "__MODULE__";
const CASES = JSON.parse(process.env.ADOPTION_CASES);
const out = {};
for (const [name, input] of Object.entries(CASES)) {
  out[name] = decideLiveTranscriptAdoption(input);
}
process.stdout.write(JSON.stringify(out));
"""


def _coverage(**overrides) -> dict:
    base = {
        "complete": True,
        "coveredSec": 12.0,
        "totalSec": 12.0,
        "droppedSec": 0.0,
        "uncoveredTailSec": 0.0,
    }
    base.update(overrides)
    return base


def _input(**overrides) -> dict:
    envelope_overrides = overrides.pop("envelope", {})
    base = {
        "envelope": {
            "source": "local-assist",
            "text": "the quick brown fox",
            "coverage": _coverage(),
        },
        "assistModel": "small",
        "finalModel": "small",
        "framesNeverSent": 0,
    }
    base.update(overrides)
    if envelope_overrides is None:
        base["envelope"] = None
    elif envelope_overrides:
        base["envelope"] = {**base["envelope"], **envelope_overrides}
    return base


CASES: dict[str, dict] = {
    "happy_path": _input(),
    # Nothing to adopt.
    "no_envelope": _input(envelope=None),
    "envelope_error": _input(envelope={"error": "stream died"}),
    # Deepgram envelopes carry no window coverage and must never be
    # mistaken for an assist transcript.
    "deepgram_source": _input(envelope={"source": "deepgram-stream"}),
    # Client-side loss the backend cannot see.
    "frames_stranded_in_renderer": _input(framesNeverSent=3),
    # Backend-side loss.
    "missing_coverage_report": _input(envelope={"coverage": None}),
    "incomplete_coverage": _input(envelope={"coverage": _coverage(complete=False)}),
    "dropped_window_marked_incomplete": _input(
        envelope={"coverage": _coverage(complete=False, droppedSec=4.2)}
    ),
    "untranscribed_tail_marked_incomplete": _input(
        envelope={"coverage": _coverage(complete=False, uncoveredTailSec=1.8)}
    ),
    "empty_session": _input(envelope={"coverage": _coverage(totalSec=0.0)}),
    # Quality: the assist ran a cheaper model than the final pass would.
    "model_mismatch": _input(assistModel="tiny", finalModel="medium"),
    "blank_assist_model": _input(assistModel="", finalModel=""),
    # Nothing was actually transcribed.
    "empty_transcript": _input(envelope={"text": "   "}),
    # A complete session whose flags are all clean but which reports
    # non-zero diagnostics must still be adopted: `complete` is the SSOT
    # and the numeric fields are rounded diagnostics, not a second rule.
    "complete_with_subepsilon_diagnostics": _input(
        envelope={"coverage": _coverage(droppedSec=0.001, uncoveredTailSec=0.002)}
    ),
}


class LiveTranscriptAdoptionPolicyTests(unittest.TestCase):
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
                    f"{POLICY_SOURCE.name}, so CI must not skip it"
                )
            raise unittest.SkipTest(missing)

        cls._tmp = tempfile.TemporaryDirectory()
        work = Path(cls._tmp.name)
        (work / "src").mkdir()
        (work / "src" / "live-coverage.ts").write_text(
            POLICY_SOURCE.read_text(encoding="utf-8"), encoding="utf-8"
        )
        (work / "tsconfig.json").write_text(json.dumps(TSCONFIG), encoding="utf-8")
        (work / "package.json").write_text('{"type":"module"}', encoding="utf-8")

        compiled = subprocess.run(
            [str(TSC), "-p", str(work / "tsconfig.json")],
            cwd=work,
            capture_output=True,
            text=True,
        )
        if compiled.returncode != 0:
            raise AssertionError(
                "live-coverage.ts failed to compile:\n"
                f"{compiled.stdout}\n{compiled.stderr}"
            )

        module = (work / "out" / "live-coverage.js").resolve()
        driver = _DRIVER.replace("__MODULE__", module.as_uri())
        run = subprocess.run(
            [node, "--input-type=module", "-e", driver],
            cwd=work,
            capture_output=True,
            text=True,
            env={**os.environ, "ADOPTION_CASES": json.dumps(CASES)},
        )
        if run.returncode != 0:
            raise AssertionError(f"policy runner failed:\n{run.stderr}")
        cls.results = json.loads(run.stdout)

    @classmethod
    def tearDownClass(cls) -> None:
        tmp = getattr(cls, "_tmp", None)
        if tmp is not None:
            tmp.cleanup()

    def assert_rejected(self, case: str, reason: str) -> None:
        decision = self.results[case]
        self.assertFalse(decision["adopt"], f"{case} must not be adopted")
        self.assertEqual(decision["reason"], reason)

    def test_complete_same_model_session_is_adopted(self) -> None:
        decision = self.results["happy_path"]
        self.assertTrue(decision["adopt"])
        self.assertEqual(decision["coverage"]["totalSec"], 12.0)

    def test_completeness_flag_is_the_only_tolerance(self) -> None:
        """Rounded diagnostics below the backend epsilon must not veto a
        session the backend already certified — that would be a second,
        silently diverging definition of completeness."""
        self.assertTrue(self.results["complete_with_subepsilon_diagnostics"]["adopt"])

    def test_missing_or_failed_envelope_falls_back(self) -> None:
        self.assert_rejected("no_envelope", "no-envelope")
        self.assert_rejected("envelope_error", "envelope-error")

    def test_non_assist_transport_falls_back(self) -> None:
        self.assert_rejected("deepgram_source", "not-local-assist")

    def test_audio_stranded_in_the_renderer_falls_back(self) -> None:
        """The backend certifies only what it received; frames that never
        left the renderer are invisible to it."""
        self.assert_rejected("frames_stranded_in_renderer", "frames-never-sent")

    def test_absent_coverage_report_falls_back(self) -> None:
        """An older backend sends no coverage; that is not permission."""
        self.assert_rejected("missing_coverage_report", "no-coverage-report")

    def test_incomplete_coverage_falls_back(self) -> None:
        self.assert_rejected("incomplete_coverage", "incomplete-coverage")
        self.assert_rejected("dropped_window_marked_incomplete", "incomplete-coverage")
        self.assert_rejected("untranscribed_tail_marked_incomplete", "incomplete-coverage")

    def test_empty_session_falls_back(self) -> None:
        self.assert_rejected("empty_session", "empty-session")

    def test_cheaper_assist_model_falls_back(self) -> None:
        """Adoption must never silently downgrade transcription quality."""
        self.assert_rejected("model_mismatch", "model-mismatch")
        self.assert_rejected("blank_assist_model", "model-mismatch")

    def test_empty_transcript_falls_back(self) -> None:
        self.assert_rejected("empty_transcript", "empty-transcript")


if __name__ == "__main__":
    unittest.main()
