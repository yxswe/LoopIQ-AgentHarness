from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from harbor.models.trajectories import Trajectory
from harbor.models.agent.context import AgentContext

from integrations.harbor.loopiq import LoopIQ
from integrations.harbor.trajectory import (
    TrajectoryConversionError,
    convert_loopiq_events,
    write_loopiq_trajectory,
)


FIXTURE = Path(__file__).with_name("fixtures") / "success-events.jsonl"


class TrajectoryTest(unittest.TestCase):
    def test_converts_messages_parallel_tools_usage_and_provider_metadata(self) -> None:
        trajectory = convert_loopiq_events(FIXTURE)

        self.assertEqual(trajectory.schema_version, "ATIF-v1.7")
        self.assertEqual(trajectory.session_id, "session-1")
        self.assertEqual(trajectory.trajectory_id, "run-1")
        self.assertEqual(trajectory.agent.model_name, "litellm-copilot/gpt-5.6-sol")
        self.assertEqual([step.step_id for step in trajectory.steps], [1, 2])
        self.assertEqual(trajectory.steps[0].source, "user")

        agent_step = trajectory.steps[1]
        self.assertEqual(agent_step.message, "I will inspect the workspace.")
        self.assertEqual(
            agent_step.reasoning_content, "I should inspect both locations."
        )
        self.assertEqual(agent_step.reasoning_effort, "high")
        self.assertEqual(agent_step.llm_call_count, 1)
        self.assertEqual(
            [call.tool_call_id for call in agent_step.tool_calls or []],
            ["call-1", "call-2"],
        )
        self.assertEqual(
            [
                result.source_call_id
                for result in (
                    agent_step.observation.results if agent_step.observation else []
                )
            ],
            ["call-2", "call-1"],
        )
        self.assertEqual(agent_step.metrics.prompt_tokens, 12)
        self.assertEqual(agent_step.metrics.completion_tokens, 3)
        self.assertEqual(agent_step.metrics.cached_tokens, 7)
        self.assertEqual(
            agent_step.extra["loopiq"]["providerResponses"][0]["status"], 200
        )

        final_metrics = trajectory.final_metrics
        self.assertIsNotNone(final_metrics)
        assert final_metrics is not None
        self.assertEqual(final_metrics.total_prompt_tokens, 12)
        self.assertEqual(final_metrics.total_completion_tokens, 3)
        self.assertEqual(final_metrics.total_cached_tokens, 7)
        self.assertEqual(final_metrics.total_steps, 2)

    def test_writes_atomic_json_that_harbor_validates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "agent" / "trajectory.json"
            trajectory = write_loopiq_trajectory(FIXTURE, output)

            loaded = Trajectory.model_validate_json(output.read_text(encoding="utf-8"))
            self.assertEqual(loaded, trajectory)
            self.assertEqual(list(output.parent.glob(".trajectory.json.*.tmp")), [])

    def test_rejects_bad_schema_and_version(self) -> None:
        for field, value in (("schema", "other"), ("schemaVersion", 2)):
            with self.subTest(field=field):
                events = self._fixture_events()
                events[0][field] = value
                with self.assertRaises(TrajectoryConversionError):
                    self._convert(events)

    def test_rejects_mismatched_identity(self) -> None:
        events = self._fixture_events()
        events[1]["runId"] = "other-run"
        with self.assertRaisesRegex(TrajectoryConversionError, "does not match"):
            self._convert(events)

    def test_rejects_non_monotonic_sequence(self) -> None:
        events = self._fixture_events()
        events[2]["sourceSequence"] = events[1]["sourceSequence"]
        with self.assertRaisesRegex(TrajectoryConversionError, "not monotonic"):
            self._convert(events)

    def test_rejects_invalid_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text("{not-json}\n", encoding="utf-8")
            with self.assertRaisesRegex(TrajectoryConversionError, "invalid JSON"):
                convert_loopiq_events(path)

    def test_rejects_missing_terminal_without_fabricating_success(self) -> None:
        events = self._fixture_events()[:-1]
        with self.assertRaisesRegex(TrajectoryConversionError, "missing run_completed"):
            self._convert(events)

    def test_accepts_aborted_terminal(self) -> None:
        events = self._fixture_events()
        events[-1] = {
            "schema": "loopiq.cli.event",
            "schemaVersion": 1,
            "type": "run_completed",
            "sessionId": "session-1",
            "runId": "run-1",
            "status": "aborted",
            "reason": "aborted",
            "stopReason": "aborted",
            "usage": {"state": "unknown"},
        }
        trajectory = self._convert(events)
        self.assertEqual(trajectory.extra["terminal"]["status"], "aborted")
        self.assertEqual(trajectory.final_metrics.extra["usage_state"], "unknown")

    def test_rejects_tool_result_without_matching_call(self) -> None:
        events = self._fixture_events()
        events[4]["toolCallId"] = "missing-call"
        with self.assertRaisesRegex(TrajectoryConversionError, "no matching"):
            self._convert(events)

    def test_post_run_hook_writes_trajectory_and_context_metadata(self) -> None:
        events = self._fixture_events()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "loopiq-events.jsonl").write_text(
                FIXTURE.read_text(encoding="utf-8"), encoding="utf-8"
            )
            (root / "loopiq-run-manifest.json").write_text(
                json.dumps(
                    {
                        "nativeTerminal": {
                            "state": "present",
                            "event": events[-1],
                        }
                    }
                ),
                encoding="utf-8",
            )
            adapter = LoopIQ(
                logs_dir=root,
                model_name="litellm-copilot/gpt-5.6-sol",
                version="revision",
            )
            context = AgentContext()

            adapter.populate_context_post_run(context)

            self.assertTrue((root / "trajectory.json").is_file())
            self.assertEqual(context.n_input_tokens, 12)
            self.assertEqual(context.n_cache_tokens, 7)
            self.assertEqual(context.n_output_tokens, 3)
            self.assertEqual(context.metadata["trajectory_state"], "present")
            self.assertEqual(context.metadata["trajectory_steps"], 2)

    def test_post_run_hook_reports_conversion_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "loopiq-events.jsonl").write_text("{not-json}\n", encoding="utf-8")
            adapter = LoopIQ(
                logs_dir=root,
                model_name="litellm-copilot/gpt-5.6-sol",
                version="revision",
            )
            context = AgentContext()

            adapter.populate_context_post_run(context)

            self.assertFalse((root / "trajectory.json").exists())
            self.assertEqual(context.metadata["trajectory_state"], "invalid")
            self.assertIn("invalid JSON", context.metadata["trajectory_error"])

    @staticmethod
    def _fixture_events() -> list[dict]:
        return [json.loads(line) for line in FIXTURE.read_text().splitlines()]

    @staticmethod
    def _convert(events: list[dict]) -> Trajectory:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text(
                "".join(f"{json.dumps(event)}\n" for event in events),
                encoding="utf-8",
            )
            return convert_loopiq_events(path)


if __name__ == "__main__":
    unittest.main()
