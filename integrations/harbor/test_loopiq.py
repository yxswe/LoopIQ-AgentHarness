"""Tests for the Harbor-side LoopIQ adapter lifecycle."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from harbor.agents.installed.base import (
    NetworkConnectionError,
    NonZeroAgentExitCodeError,
)
from harbor.environments.base import ExecResult

from integrations.harbor.loopiq import LoopIQ


class _SetupLoopIQ(LoopIQ):
    async def install(self, environment: Any) -> None:
        del environment


class _RecordingEnvironment:
    default_user = None

    def __init__(self) -> None:
        self.exec_calls: list[dict[str, Any]] = []
        self.uploads: dict[str, str] = {}

    async def upload_file(self, source_path: Path, target_path: str) -> None:
        self.uploads[target_path] = source_path.read_text(encoding="utf-8")

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        self.exec_calls.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        stdout = ""
        if "loopiq models list custom-openai" in command:
            stdout = json.dumps(
                [
                    {
                        "providerId": "custom-openai",
                        "modelId": "gpt-5.6-sol",
                    }
                ]
            )
        return ExecResult(stdout=stdout, stderr="", return_code=0)


class LoopIQSetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_custom_provider_configuration_uses_agent_home(self) -> None:
        custom_provider = {
            "baseUrl": "http://host.docker.internal:4000/v1",
            "modelId": "gpt-5.6-sol",
            "modelName": "GPT-5.6 SOL",
            "contextWindow": 1_050_000,
            "maxTokens": 128_000,
            "reasoning": True,
        }
        with tempfile.TemporaryDirectory() as directory:
            adapter = _SetupLoopIQ(
                logs_dir=Path(directory),
                model_name="custom-openai/gpt-5.6-sol",
                version="revision",
                extra_env={
                    "LOOPIQ_API_TOKEN": "proxy-token",
                    "LOOPIQ_CUSTOM_PROVIDER": json.dumps(custom_provider),
                },
            )
            environment = _RecordingEnvironment()

            await adapter.setup(environment)

        config_path = "/tmp/loopiq-home/.loopiq/agent.json"
        self.assertIn(config_path, environment.uploads)
        self.assertNotIn("/tmp/loopiq-home/agent.json", environment.uploads)
        self.assertEqual(
            json.loads(environment.uploads[config_path])["customProvider"],
            custom_provider,
        )

        setup_calls = [
            call
            for call in environment.exec_calls
            if call["env"] and call["env"].get("HOME") == "/tmp/loopiq-home"
        ]
        self.assertTrue(setup_calls)
        self.assertTrue(
            any(
                "mkdir -p /tmp/loopiq-home/.loopiq" in call["command"]
                for call in setup_calls
            )
        )
        self.assertTrue(
            any(
                config_path in call["command"] and "chmod 600" in call["command"]
                for call in setup_calls
            )
        )
        self.assertTrue(
            any(
                "loopiq providers add custom-openai" in call["command"]
                for call in setup_calls
            )
        )


class LoopIQInstallTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_transient_network_steps_without_retrying_build(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            adapter = LoopIQ(
                logs_dir=Path(directory),
                model_name="custom-openai/gpt-5.6-sol",
                version="revision",
            )
            system_dependencies = AsyncMock(
                side_effect=[NetworkConnectionError("Connection timed out"), None]
            )
            bootstrap_attempts = 0

            async def exec_as_agent(
                environment: Any,
                command: str,
                **kwargs: Any,
            ) -> ExecResult:
                nonlocal bootstrap_attempts
                del environment, kwargs
                if "npm ci" in command:
                    bootstrap_attempts += 1
                    if bootstrap_attempts == 1:
                        raise NonZeroAgentExitCodeError(
                            "npm error code ERR_SSL_WRONG_VERSION_NUMBER"
                        )
                if "command -v node" in command:
                    return ExecResult(
                        stdout="/root/.nvm/versions/node/v22/bin/node\n",
                        stderr="",
                        return_code=0,
                    )
                return ExecResult(stdout="", stderr="", return_code=0)

            agent_exec = AsyncMock(side_effect=exec_as_agent)
            root_exec = AsyncMock(
                return_value=ExecResult(stdout="", stderr="", return_code=0)
            )
            with (
                patch.object(
                    adapter,
                    "ensure_system_dependencies",
                    system_dependencies,
                ),
                patch.object(adapter, "exec_as_agent", agent_exec),
                patch.object(adapter, "exec_as_root", root_exec),
                patch("integrations.harbor.loopiq.asyncio.sleep", AsyncMock()) as sleep,
            ):
                await adapter.install(object())

        self.assertEqual(system_dependencies.await_count, 2)
        self.assertEqual(bootstrap_attempts, 2)
        commands = [call.kwargs["command"] for call in agent_exec.await_args_list]
        self.assertEqual(sum("npm run build" in command for command in commands), 1)
        self.assertTrue(
            all(
                "npm run build" not in command
                for command in commands
                if "npm ci" in command
            )
        )
        self.assertEqual(sleep.await_count, 2)

    async def test_does_not_retry_non_network_installation_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            adapter = LoopIQ(
                logs_dir=Path(directory),
                model_name="custom-openai/gpt-5.6-sol",
                version="revision",
            )
            system_dependencies = AsyncMock(return_value=None)
            agent_exec = AsyncMock(
                side_effect=NonZeroAgentExitCodeError("npm error code ERESOLVE")
            )
            with (
                patch.object(
                    adapter,
                    "ensure_system_dependencies",
                    system_dependencies,
                ),
                patch.object(adapter, "exec_as_agent", agent_exec),
                patch("integrations.harbor.loopiq.asyncio.sleep", AsyncMock()) as sleep,
            ):
                with self.assertRaisesRegex(
                    NonZeroAgentExitCodeError,
                    "ERESOLVE",
                ):
                    await adapter.install(object())

        self.assertEqual(agent_exec.await_count, 1)
        self.assertEqual(sleep.await_count, 0)


if __name__ == "__main__":
    unittest.main()
