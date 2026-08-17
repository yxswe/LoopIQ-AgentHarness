"""Convert LoopIQ CLI events into a validated Harbor ATIF trajectory."""

from __future__ import annotations

import json
import os
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    ContentPart,
    FinalMetrics,
    ImageSource,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json


class TrajectoryConversionError(ValueError):
    """Raised when native LoopIQ evidence cannot form an honest trajectory."""


class _TrajectoryBuilder:
    def __init__(self) -> None:
        self.steps: list[Step] = []
        self.calls: dict[str, Step] = {}
        self.pending_results: dict[str, ObservationResult] = {}
        self.completed_calls: set[str] = set()
        self.pending_provider_responses: list[dict[str, Any]] = []
        self.event_counts: Counter[str] = Counter()
        self.event_count = 0
        self.last_source_sequence: int | None = None
        self.started: dict[str, Any] | None = None
        self.terminal: dict[str, Any] | None = None

    def add(self, event: dict[str, Any], line_number: int) -> None:
        self._validate_envelope(event, line_number)
        event_type = event["type"]
        self.event_counts[event_type] += 1
        self.event_count += 1

        if event_type == "run_started":
            self.started = event
        elif event_type == "message_completed":
            self._record_message(event, line_number)
        elif event_type == "tool_completed":
            self._record_tool_completed(event, line_number)
        elif event_type == "provider_response":
            self.pending_provider_responses.append(
                {
                    "status": event.get("status"),
                    "headers": event.get("headers") or {},
                }
            )
        elif event_type == "run_completed":
            self.terminal = event

    def build(self) -> Trajectory:
        if self.started is None:
            raise TrajectoryConversionError("missing run_started event")
        if self.terminal is None:
            raise TrajectoryConversionError("missing run_completed event")
        if self.pending_results:
            call_ids = ", ".join(sorted(self.pending_results))
            raise TrajectoryConversionError(
                f"tool results have no matching assistant tool call: {call_ids}"
            )
        if not self.steps:
            raise TrajectoryConversionError("event stream contains no ATIF steps")

        started = self.started
        terminal = self.terminal
        provider_id, model_id = self._started_model(started)
        final_metrics = self._final_metrics(terminal)
        terminal_extra = {
            key: terminal.get(key)
            for key in ("status", "reason", "stopReason", "error")
            if terminal.get(key) is not None
        }
        root_extra: dict[str, Any] = {
            "loopiq_run_id": started["runId"],
            "workspace_dir": started.get("workspaceDir"),
            "thinking_level": started.get("thinkingLevel"),
            "terminal": terminal_extra,
            "native_event_count": self.event_count,
            "native_event_counts": dict(sorted(self.event_counts.items())),
        }
        if self.pending_provider_responses:
            root_extra["unmatched_provider_responses"] = len(
                self.pending_provider_responses
            )

        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=started["sessionId"],
            trajectory_id=started["runId"],
            agent=Agent(
                name="loopiq",
                version=str(started.get("cliVersion") or "unknown"),
                model_name=f"{provider_id}/{model_id}",
                extra={
                    "provider_id": provider_id,
                    "thinking_level": started.get("thinkingLevel"),
                },
            ),
            steps=self.steps,
            final_metrics=final_metrics,
            extra=root_extra,
        )

    def _validate_envelope(self, event: dict[str, Any], line_number: int) -> None:
        if event.get("schema") != "loopiq.cli.event":
            raise TrajectoryConversionError(
                f"line {line_number}: unsupported event schema {event.get('schema')!r}"
            )
        if event.get("schemaVersion") != 1:
            raise TrajectoryConversionError(
                f"line {line_number}: unsupported schemaVersion "
                f"{event.get('schemaVersion')!r}"
            )
        event_type = event.get("type")
        if not isinstance(event_type, str) or not event_type:
            raise TrajectoryConversionError(
                f"line {line_number}: event type must be a non-empty string"
            )
        if self.terminal is not None:
            raise TrajectoryConversionError(
                f"line {line_number}: event appears after run_completed"
            )

        if event_type == "run_started":
            if self.started is not None or self.event_count != 0:
                raise TrajectoryConversionError(
                    f"line {line_number}: run_started must be the first and only start"
                )
            self._required_identity(event, line_number)
            self._started_model(event)
            return

        if self.started is None:
            raise TrajectoryConversionError(
                f"line {line_number}: event appears before run_started"
            )
        session_id, run_id = self._required_identity(event, line_number)
        if session_id != self.started["sessionId"] or run_id != self.started["runId"]:
            raise TrajectoryConversionError(
                f"line {line_number}: sessionId/runId does not match run_started"
            )
        if event_type == "run_completed":
            if event.get("status") not in {"completed", "failed", "aborted"}:
                raise TrajectoryConversionError(
                    f"line {line_number}: unsupported terminal status "
                    f"{event.get('status')!r}"
                )
            return

        sequence = event.get("sourceSequence")
        if isinstance(sequence, bool) or not isinstance(sequence, int):
            raise TrajectoryConversionError(
                f"line {line_number}: sourceSequence must be an integer"
            )
        if (
            self.last_source_sequence is not None
            and sequence <= self.last_source_sequence
        ):
            raise TrajectoryConversionError(
                f"line {line_number}: sourceSequence {sequence} is not monotonic"
            )
        self.last_source_sequence = sequence

    @staticmethod
    def _required_identity(event: dict[str, Any], line_number: int) -> tuple[str, str]:
        session_id = event.get("sessionId")
        run_id = event.get("runId")
        if not isinstance(session_id, str) or not session_id:
            raise TrajectoryConversionError(
                f"line {line_number}: sessionId must be a non-empty string"
            )
        if not isinstance(run_id, str) or not run_id:
            raise TrajectoryConversionError(
                f"line {line_number}: runId must be a non-empty string"
            )
        return session_id, run_id

    @staticmethod
    def _started_model(event: dict[str, Any]) -> tuple[str, str]:
        model = event.get("model")
        if not isinstance(model, dict):
            raise TrajectoryConversionError("run_started.model must be an object")
        provider_id = model.get("providerId")
        model_id = model.get("modelId")
        if not isinstance(provider_id, str) or not provider_id:
            raise TrajectoryConversionError(
                "run_started.model.providerId must be a non-empty string"
            )
        if not isinstance(model_id, str) or not model_id:
            raise TrajectoryConversionError(
                "run_started.model.modelId must be a non-empty string"
            )
        return provider_id, model_id

    def _record_message(self, event: dict[str, Any], line_number: int) -> None:
        message = event.get("message")
        if not isinstance(message, dict):
            raise TrajectoryConversionError(
                f"line {line_number}: message_completed.message must be an object"
            )
        role = message.get("role")
        if role == "user":
            self.steps.append(
                Step(
                    step_id=len(self.steps) + 1,
                    timestamp=event.get("timestamp"),
                    source="user",
                    message=self._content(message.get("content"), line_number),
                )
            )
            return
        if role == "assistant":
            self._record_assistant(event, message, line_number)
            return
        if role == "toolResult":
            call_id = message.get("toolCallId")
            if not isinstance(call_id, str) or not call_id:
                raise TrajectoryConversionError(
                    f"line {line_number}: toolResult message has no toolCallId"
                )
            if call_id not in self.completed_calls:
                result = {
                    "content": message.get("content"),
                    "details": message.get("details"),
                }
                self._record_result(
                    call_id=call_id,
                    content=self._result_content(result, line_number),
                    extra={
                        "tool_name": message.get("toolName"),
                        "is_error": bool(message.get("isError")),
                        "details": message.get("details"),
                    },
                    line_number=line_number,
                )
            return
        raise TrajectoryConversionError(
            f"line {line_number}: unsupported completed message role {role!r}"
        )

    def _record_assistant(
        self,
        event: dict[str, Any],
        message: dict[str, Any],
        line_number: int,
    ) -> None:
        content = message.get("content")
        if not isinstance(content, list):
            raise TrajectoryConversionError(
                f"line {line_number}: assistant content must be an array"
            )
        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        redacted_thinking_blocks = 0
        for part in content:
            if not isinstance(part, dict):
                raise TrajectoryConversionError(
                    f"line {line_number}: assistant content part must be an object"
                )
            part_type = part.get("type")
            if part_type == "text":
                text = part.get("text")
                if not isinstance(text, str):
                    raise TrajectoryConversionError(
                        f"line {line_number}: assistant text part must contain text"
                    )
                text_parts.append(text)
            elif part_type == "thinking":
                thinking = part.get("thinking")
                if part.get("redacted"):
                    redacted_thinking_blocks += 1
                elif isinstance(thinking, str) and thinking:
                    thinking_parts.append(thinking)
            elif part_type == "toolCall":
                call_id = part.get("id")
                name = part.get("name")
                if not isinstance(call_id, str) or not call_id:
                    raise TrajectoryConversionError(
                        f"line {line_number}: tool call id must be a non-empty string"
                    )
                if not isinstance(name, str) or not name:
                    raise TrajectoryConversionError(
                        f"line {line_number}: tool call name must be a non-empty string"
                    )
                if call_id in self.calls:
                    raise TrajectoryConversionError(
                        f"line {line_number}: duplicate tool call id {call_id!r}"
                    )
                tool_calls.append(
                    ToolCall(
                        tool_call_id=call_id,
                        function_name=name,
                        arguments=self._arguments(part.get("arguments")),
                    )
                )
            else:
                raise TrajectoryConversionError(
                    f"line {line_number}: unsupported assistant content type "
                    f"{part_type!r}"
                )

        extra_payload = {
            key: message.get(key)
            for key in (
                "api",
                "provider",
                "responseModel",
                "responseId",
                "diagnostics",
                "stopReason",
                "errorMessage",
            )
            if message.get(key) is not None
        }
        if self.pending_provider_responses:
            extra_payload["providerResponses"] = self.pending_provider_responses
            self.pending_provider_responses = []
        if redacted_thinking_blocks:
            extra_payload["redactedThinkingBlocks"] = redacted_thinking_blocks

        started = self.started or {}
        provider = message.get("provider")
        model = message.get("model")
        if not isinstance(model, str) or not model:
            _, model = self._started_model(started)
        if not isinstance(provider, str) or not provider:
            provider, _ = self._started_model(started)
        step = Step(
            step_id=len(self.steps) + 1,
            timestamp=event.get("timestamp"),
            source="agent",
            model_name=f"{provider}/{model}",
            reasoning_effort=started.get("thinkingLevel"),
            message="".join(text_parts),
            reasoning_content="\n".join(thinking_parts) or None,
            tool_calls=tool_calls or None,
            metrics=self._metrics(message.get("usage"), line_number),
            llm_call_count=1,
            extra={"loopiq": extra_payload} if extra_payload else None,
        )
        self.steps.append(step)
        for tool_call in tool_calls:
            self.calls[tool_call.tool_call_id] = step
            pending = self.pending_results.pop(tool_call.tool_call_id, None)
            if pending is not None:
                self._attach_result(step, pending)

    def _record_tool_completed(self, event: dict[str, Any], line_number: int) -> None:
        call_id = event.get("toolCallId")
        if not isinstance(call_id, str) or not call_id:
            raise TrajectoryConversionError(
                f"line {line_number}: tool_completed has no toolCallId"
            )
        if call_id in self.completed_calls:
            raise TrajectoryConversionError(
                f"line {line_number}: duplicate tool completion for {call_id!r}"
            )
        result = event.get("result")
        details = result.get("details") if isinstance(result, dict) else None
        self._record_result(
            call_id=call_id,
            content=self._result_content(result, line_number),
            extra={
                "tool_name": event.get("toolName"),
                "is_error": bool(event.get("isError")),
                "details": details,
            },
            line_number=line_number,
        )

    def _record_result(
        self,
        *,
        call_id: str,
        content: str | list[ContentPart] | None,
        extra: dict[str, Any],
        line_number: int,
    ) -> None:
        if call_id in self.completed_calls:
            raise TrajectoryConversionError(
                f"line {line_number}: duplicate tool result for {call_id!r}"
            )
        self.completed_calls.add(call_id)
        cleaned_extra = {
            key: value for key, value in extra.items() if value is not None
        }
        observation = ObservationResult(
            source_call_id=call_id,
            content=content,
            extra=cleaned_extra or None,
        )
        owner = self.calls.get(call_id)
        if owner is None:
            self.pending_results[call_id] = observation
        else:
            self._attach_result(owner, observation)

    @staticmethod
    def _attach_result(step: Step, result: ObservationResult) -> None:
        if step.observation is None:
            step.observation = Observation(results=[result])
        else:
            step.observation.results.append(result)

    @staticmethod
    def _arguments(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if value is None:
            return {}
        return {"value": value}

    @classmethod
    def _content(cls, value: Any, line_number: int) -> str | list[ContentPart]:
        if isinstance(value, str):
            return value
        if not isinstance(value, list):
            raise TrajectoryConversionError(
                f"line {line_number}: message content must be a string or array"
            )
        parts: list[ContentPart] = []
        contains_image = False
        for part in value:
            if not isinstance(part, dict):
                raise TrajectoryConversionError(
                    f"line {line_number}: message content part must be an object"
                )
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                parts.append(ContentPart(type="text", text=part["text"]))
            elif part.get("type") == "image":
                mime_type = part.get("mimeType")
                data = part.get("data")
                if mime_type not in {
                    "image/jpeg",
                    "image/png",
                    "image/gif",
                    "image/webp",
                } or not isinstance(data, str):
                    raise TrajectoryConversionError(
                        f"line {line_number}: image content has invalid data or MIME type"
                    )
                contains_image = True
                parts.append(
                    ContentPart(
                        type="image",
                        source=ImageSource(
                            media_type=mime_type,
                            path=f"data:{mime_type};base64,{data}",
                        ),
                    )
                )
            else:
                raise TrajectoryConversionError(
                    f"line {line_number}: unsupported message content type "
                    f"{part.get('type')!r}"
                )
        if contains_image:
            return parts
        return "".join(part.text or "" for part in parts)

    @classmethod
    def _result_content(
        cls, result: Any, line_number: int
    ) -> str | list[ContentPart] | None:
        if result is None:
            return None
        if isinstance(result, dict) and "content" in result:
            return cls._content(result.get("content"), line_number)
        if isinstance(result, str):
            return result
        return json.dumps(result, ensure_ascii=False, sort_keys=True)

    @classmethod
    def _metrics(cls, usage: Any, line_number: int) -> Metrics | None:
        if usage is None:
            return None
        if not isinstance(usage, dict):
            raise TrajectoryConversionError(
                f"line {line_number}: assistant usage must be an object"
            )
        input_tokens = cls._token_count(usage.get("input", 0), "input", line_number)
        output_tokens = cls._token_count(usage.get("output", 0), "output", line_number)
        cache_read_tokens = cls._token_count(
            usage.get("cacheRead", 0), "cacheRead", line_number
        )
        cache_write_tokens = cls._token_count(
            usage.get("cacheWrite", 0), "cacheWrite", line_number
        )
        reasoning_tokens = usage.get("reasoning")
        if reasoning_tokens is not None:
            reasoning_tokens = cls._token_count(
                reasoning_tokens, "reasoning", line_number
            )
        total_tokens = cls._token_count(
            usage.get("totalTokens", input_tokens + output_tokens + cache_read_tokens),
            "totalTokens",
            line_number,
        )
        cost = usage.get("cost")
        cost_total = cost.get("total") if isinstance(cost, dict) else None
        cost_usd = float(cost_total) if isinstance(cost_total, (int, float)) else None
        if cost_usd is not None and cost_usd <= 0:
            cost_usd = None
        return Metrics(
            prompt_tokens=input_tokens + cache_read_tokens,
            completion_tokens=output_tokens,
            cached_tokens=cache_read_tokens,
            cost_usd=cost_usd,
            extra={
                "cache_write_tokens": cache_write_tokens,
                "reasoning_tokens": reasoning_tokens,
                "reported_total_tokens": total_tokens,
            },
        )

    def _final_metrics(self, terminal: dict[str, Any]) -> FinalMetrics:
        usage = terminal.get("usage")
        measured = isinstance(usage, dict) and usage.get("state") != "unknown"
        if not measured:
            return FinalMetrics(
                total_steps=len(self.steps),
                extra={"usage_state": "unknown"},
            )
        assert isinstance(usage, dict)
        input_tokens = self._terminal_token_count(usage.get("inputTokens", 0))
        output_tokens = self._terminal_token_count(usage.get("outputTokens", 0))
        cached_tokens = self._terminal_token_count(usage.get("cacheReadTokens", 0))
        cache_write_tokens = self._terminal_token_count(
            usage.get("cacheWriteTokens", 0)
        )
        cost = usage.get("costUsd")
        cost_usd = float(cost) if isinstance(cost, (int, float)) and cost > 0 else None
        extra = {
            "usage_state": usage.get("state"),
            "cache_write_tokens": cache_write_tokens,
            "inference_messages": usage.get("inferenceMessages"),
            "note": usage.get("note"),
        }
        return FinalMetrics(
            total_prompt_tokens=input_tokens + cached_tokens,
            total_completion_tokens=output_tokens,
            total_cached_tokens=cached_tokens,
            total_cost_usd=cost_usd,
            total_steps=len(self.steps),
            extra={key: value for key, value in extra.items() if value is not None},
        )

    @staticmethod
    def _token_count(value: Any, name: str, line_number: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise TrajectoryConversionError(
                f"line {line_number}: usage.{name} must be a non-negative integer"
            )
        return value

    @staticmethod
    def _terminal_token_count(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise TrajectoryConversionError(
                "run_completed usage token counts must be non-negative integers"
            )
        return value


def convert_loopiq_events(events_path: Path) -> Trajectory:
    """Read LoopIQ JSONL evidence and return a validated ATIF-v1.7 trajectory."""
    builder = _TrajectoryBuilder()
    try:
        with events_path.open("r", encoding="utf-8") as stream:
            for line_number, raw_line in enumerate(stream, start=1):
                if not raw_line.strip():
                    continue
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError as error:
                    raise TrajectoryConversionError(
                        f"line {line_number}: invalid JSON: {error.msg}"
                    ) from error
                if not isinstance(event, dict):
                    raise TrajectoryConversionError(
                        f"line {line_number}: event must be a JSON object"
                    )
                builder.add(event, line_number)
    except OSError as error:
        raise TrajectoryConversionError(
            f"could not read native events: {error}"
        ) from error

    return builder.build()


def write_loopiq_trajectory(events_path: Path, output_path: Path) -> Trajectory:
    """Validate LoopIQ events and atomically write Harbor's trajectory.json."""
    trajectory = convert_loopiq_events(events_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(format_trajectory_json(trajectory.to_json_dict()))
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
    return trajectory
