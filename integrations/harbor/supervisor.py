"""Run one LoopIQ CLI process group and persist a trial-local terminal manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CLI_EVENT_SCHEMA = "loopiq.cli.event"
CLI_EVENT_SCHEMA_VERSION = 1


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_record(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    size = 0
    if path.exists():
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
    return {
        "path": str(path),
        "bytes": size,
        "sha256": digest.hexdigest() if path.exists() else None,
    }


def read_run_events(
    events_path: Path,
) -> tuple[
    str,
    dict[str, Any] | None,
    dict[str, Any] | None,
    int,
    str | None,
]:
    if not events_path.exists():
        return "missing", None, None, 0, None
    started: dict[str, Any] | None = None
    terminal: dict[str, Any] | None = None
    started_count = 0
    terminal_count = 0
    validation_error: str | None = None
    previous_sequence: int | None = None
    event_count = 0

    def invalidate(reason: str) -> None:
        nonlocal validation_error
        if validation_error is None:
            validation_error = reason

    with events_path.open(encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                invalidate(f"line {line_number} is not valid JSON")
                continue
            event_count += 1
            if not isinstance(event, dict):
                invalidate(f"line {line_number} is not a JSON object")
                continue
            if (
                event.get("schema") != CLI_EVENT_SCHEMA
                or event.get("schemaVersion") != CLI_EVENT_SCHEMA_VERSION
            ):
                invalidate(f"line {line_number} has an unsupported event schema")
            event_type = event.get("type")
            if event_type == "run_started":
                started_count += 1
                started = event
                if not isinstance(event.get("sessionId"), str) or not isinstance(
                    event.get("runId"), str
                ):
                    invalidate("run_started is missing its Session or Run identity")
            elif event_type == "run_completed":
                terminal_count += 1
                terminal = event
                if event.get("status") not in {"completed", "failed", "aborted"}:
                    invalidate("run_completed has an unsupported status")
            elif event_type != "command_failed" and started is None:
                invalidate(f"line {line_number} appears before run_started")

            if (
                started is not None
                and event_type not in {"run_started", "command_failed"}
                and (
                    event.get("sessionId") != started.get("sessionId")
                    or event.get("runId") != started.get("runId")
                )
            ):
                invalidate(
                    f"line {line_number} does not match the accepted Run identity"
                )

            sequence = event.get("sourceSequence")
            if sequence is not None:
                if isinstance(sequence, bool) or not isinstance(sequence, int):
                    invalidate(f"line {line_number} has a non-integer source sequence")
                elif previous_sequence is not None and sequence <= previous_sequence:
                    invalidate(
                        f"line {line_number} has a non-monotonic source sequence"
                    )
                else:
                    previous_sequence = sequence

    if started_count > 1:
        invalidate(f"expected at most one run_started event, found {started_count}")
    if terminal_count > 1:
        invalidate(f"expected at most one run_completed event, found {terminal_count}")
    if terminal is not None and started is None:
        invalidate("run_completed is present without run_started")
    if validation_error:
        return "invalid", started, terminal, event_count, validation_error
    if terminal is None:
        return "missing", started, None, event_count, None
    return "present", started, terminal, event_count, None


def group_has_live_processes(group_id: int) -> bool:
    result = subprocess.run(
        ["/bin/ps", "-axo", "pgid=,stat="],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise OSError(f"ps failed with exit code {result.returncode}")
    for line in result.stdout.splitlines():
        fields = line.split()
        if (
            len(fields) >= 2
            and fields[0] == str(group_id)
            and not fields[1].startswith("Z")
        ):
            return True
    return False


def signal_group(group_id: int, sent: list[str], target: signal.Signals) -> None:
    try:
        os.killpg(group_id, target)
    except ProcessLookupError:
        return
    sent.append(target.name)


def wait_after_signal(process: subprocess.Popen[bytes], timeout: float) -> bool:
    try:
        process.wait(timeout=timeout)
        return True
    except subprocess.TimeoutExpired:
        return False


def wait_for_group_exit(group_id: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while group_has_live_processes(group_id):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.05, remaining))
    return True


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    os.replace(temporary, path)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdin-file", required=True, type=Path)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--stderr", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--adapter-version", required=True)
    parser.add_argument("--harbor-revision", required=True)
    parser.add_argument("--harbor-session-id", required=True)
    parser.add_argument("--harbor-context-id", required=True)
    parser.add_argument("--loopiq-revision", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout-sec", required=True, type=float)
    parser.add_argument("--grace-sec", required=True, type=float)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("a command is required after --")
    if args.timeout_sec <= 0 or args.grace_sec <= 0:
        parser.error("timeouts must be positive")
    return args


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    args.events.parent.mkdir(parents=True, exist_ok=True)
    args.stderr.parent.mkdir(parents=True, exist_ok=True)
    started_at = iso_now()
    started_monotonic = time.monotonic()
    signals_sent: list[str] = []
    timed_out = False
    remaining_group_detected = False
    group_cleanup_failed = False
    process: subprocess.Popen[bytes] | None = None
    supervisor_error: str | None = None

    try:
        with (
            args.stdin_file.open("rb") as input_file,
            args.events.open("wb") as events_file,
            args.stderr.open("wb") as stderr_file,
        ):
            process = subprocess.Popen(
                args.command,
                stdin=input_file,
                stdout=events_file,
                stderr=stderr_file,
                start_new_session=True,
            )
            try:
                process.wait(timeout=args.timeout_sec)
            except subprocess.TimeoutExpired:
                timed_out = True
                signal_group(process.pid, signals_sent, signal.SIGINT)
                if not wait_after_signal(process, args.grace_sec):
                    signal_group(process.pid, signals_sent, signal.SIGTERM)
                if not wait_after_signal(process, args.grace_sec):
                    signal_group(process.pid, signals_sent, signal.SIGKILL)
                    process.wait()
    except (OSError, subprocess.SubprocessError) as error:
        supervisor_error = f"{type(error).__name__}: {error}"
        if process and process.poll() is None:
            try:
                signal_group(process.pid, signals_sent, signal.SIGKILL)
                process.wait()
            except OSError as cleanup_error:
                supervisor_error += (
                    f"; cleanup failed: {type(cleanup_error).__name__}: {cleanup_error}"
                )

    if process and process.poll() is not None:
        try:
            remaining_group_detected = group_has_live_processes(process.pid)
            if remaining_group_detected:
                signal_group(process.pid, signals_sent, signal.SIGTERM)
                if not wait_for_group_exit(process.pid, args.grace_sec):
                    signal_group(process.pid, signals_sent, signal.SIGKILL)
                    group_cleanup_failed = not wait_for_group_exit(
                        process.pid, args.grace_sec
                    )
        except OSError as cleanup_error:
            group_cleanup_failed = True
            cleanup_message = (
                f"group cleanup failed: {type(cleanup_error).__name__}: {cleanup_error}"
            )
            supervisor_error = (
                f"{supervisor_error}; {cleanup_message}"
                if supervisor_error
                else cleanup_message
            )

    return_code = (
        process.returncode if process and process.returncode is not None else 125
    )
    terminal_state, run_started, terminal, event_count, terminal_error = (
        read_run_events(args.events)
    )
    outcome_mismatch: str | None = None
    if not timed_out and not supervisor_error:
        if return_code == 0 and terminal_state != "present":
            outcome_mismatch = (
                "the CLI exited successfully without one valid run_completed event"
            )
        elif terminal_state == "present":
            completed = terminal is not None and terminal.get("status") == "completed"
            if completed != (return_code == 0):
                outcome_mismatch = "the CLI exit code and run_completed status disagree"
    finished_at = iso_now()
    manifest = {
        "schema": "loopiq.harbor.run_manifest",
        "schemaVersion": 1,
        "adapter": {
            "name": "loopiq",
            "version": args.adapter_version,
            "harborCompatibilityRevision": args.harbor_revision,
        },
        "harbor": {
            "sessionId": args.harbor_session_id,
            "contextId": args.harbor_context_id,
        },
        "loopiq": {
            "revision": args.loopiq_revision,
            "model": args.model,
            "cliVersion": run_started.get("cliVersion") if run_started else None,
            "eventSchema": {
                "name": CLI_EVENT_SCHEMA,
                "version": CLI_EVENT_SCHEMA_VERSION,
            },
        },
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationMs": round((time.monotonic() - started_monotonic) * 1000),
        "process": {
            "pid": process.pid if process else None,
            "returnCode": return_code if return_code >= 0 else None,
            "signal": signal.Signals(-return_code).name if return_code < 0 else None,
            "timedOut": timed_out,
            "signalsSent": signals_sent,
            "remainingGroupDetected": remaining_group_detected,
            "groupCleanupFailed": group_cleanup_failed,
        },
        "nativeTerminal": {
            "state": terminal_state,
            "eventCount": event_count,
            "validationError": terminal_error,
            "runStarted": run_started,
            "event": terminal,
        },
        "outcomeMismatch": outcome_mismatch,
        "files": {
            "events": file_record(args.events),
            "stderr": file_record(args.stderr),
        },
        "supervisorError": supervisor_error,
    }
    write_manifest(args.manifest, manifest)

    if supervisor_error:
        sys.stderr.write(f"LoopIQ supervisor failed; see {args.manifest}\n")
        return 125
    if timed_out:
        sys.stderr.write(f"LoopIQ exceeded the inner deadline; see {args.manifest}\n")
        return 124
    if group_cleanup_failed or terminal_state == "invalid" or outcome_mismatch:
        sys.stderr.write(
            f"LoopIQ produced an invalid supervised outcome; see {args.manifest}\n"
        )
        return 125
    if return_code != 0:
        code = (
            terminal.get("error", {}).get("code")
            if isinstance(terminal, dict)
            else None
        )
        sys.stderr.write(
            f"LoopIQ exited unsuccessfully{f' ({code})' if code else ''}; see {args.manifest}\n"
        )
    return return_code if return_code >= 0 else 128 + (-return_code)


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
