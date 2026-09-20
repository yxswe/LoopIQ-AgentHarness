from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SUPERVISOR = Path(__file__).with_name("supervisor.py")


class SupervisorTest(unittest.TestCase):
    def run_supervisor(
        self, command: list[str], timeout: float = 2
    ) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.txt"
            events_path = root / "events.jsonl"
            stderr_path = root / "stderr.log"
            manifest_path = root / "manifest.json"
            input_path.write_text("hello")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SUPERVISOR),
                    "--stdin-file",
                    str(input_path),
                    "--events",
                    str(events_path),
                    "--stderr",
                    str(stderr_path),
                    "--manifest",
                    str(manifest_path),
                    "--adapter-version",
                    "test",
                    "--harbor-revision",
                    "harbor-test",
                    "--harbor-session-id",
                    "session-test",
                    "--harbor-context-id",
                    "context-test",
                    "--loopiq-revision",
                    "loopiq-test",
                    "--model",
                    "openai/test",
                    "--timeout-sec",
                    str(timeout),
                    "--grace-sec",
                    "0.1",
                    "--",
                    *command,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            return result, json.loads(manifest_path.read_text())

    def test_records_one_native_terminal(self) -> None:
        started = json.dumps(
            {
                "schema": "loopiq.cli.event",
                "schemaVersion": 1,
                "type": "run_started",
                "sessionId": "session",
                "runId": "run",
            }
        )
        terminal = json.dumps(
            {
                "schema": "loopiq.cli.event",
                "schemaVersion": 1,
                "type": "run_completed",
                "sessionId": "session",
                "runId": "run",
                "status": "completed",
            }
        )
        result, manifest = self.run_supervisor(
            [sys.executable, "-c", f"print({started!r}); print({terminal!r})"]
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(manifest["nativeTerminal"]["state"], "present")
        self.assertEqual(manifest["nativeTerminal"]["eventCount"], 2)
        self.assertFalse(manifest["process"]["timedOut"])

    def test_rejects_mismatched_run_identity(self) -> None:
        started = json.dumps(
            {
                "schema": "loopiq.cli.event",
                "schemaVersion": 1,
                "type": "run_started",
                "sessionId": "session",
                "runId": "first",
            }
        )
        terminal = json.dumps(
            {
                "schema": "loopiq.cli.event",
                "schemaVersion": 1,
                "type": "run_completed",
                "sessionId": "session",
                "runId": "second",
                "status": "completed",
            }
        )
        result, manifest = self.run_supervisor(
            [sys.executable, "-c", f"print({started!r}); print({terminal!r})"]
        )
        self.assertEqual(result.returncode, 125)
        self.assertEqual(manifest["nativeTerminal"]["state"], "invalid")

    def test_terminates_a_remaining_process_group_after_cli_exit(self) -> None:
        started = json.dumps(
            {
                "schema": "loopiq.cli.event",
                "schemaVersion": 1,
                "type": "run_started",
                "sessionId": "session",
                "runId": "run",
            }
        )
        terminal = json.dumps(
            {
                "schema": "loopiq.cli.event",
                "schemaVersion": 1,
                "type": "run_completed",
                "sessionId": "session",
                "runId": "run",
                "status": "completed",
            }
        )
        script = (
            "import subprocess; "
            "subprocess.Popen(['sleep', '10']); "
            f"print({started!r}); print({terminal!r})"
        )
        result, manifest = self.run_supervisor([sys.executable, "-c", script])
        self.assertEqual(result.returncode, 0)
        self.assertTrue(manifest["process"]["remainingGroupDetected"])
        self.assertFalse(manifest["process"]["groupCleanupFailed"])
        self.assertIn("SIGTERM", manifest["process"]["signalsSent"])

    def test_terminates_the_process_group_after_the_inner_deadline(self) -> None:
        result, manifest = self.run_supervisor(
            [sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.1
        )
        self.assertEqual(result.returncode, 124)
        self.assertTrue(manifest["process"]["timedOut"])
        self.assertIn("SIGINT", manifest["process"]["signalsSent"])
        self.assertEqual(manifest["nativeTerminal"]["state"], "missing")


if __name__ == "__main__":
    unittest.main()
