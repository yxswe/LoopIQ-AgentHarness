"""Harbor installed-agent adapter for the LoopIQ CLI."""

from __future__ import annotations

import json
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, ClassVar, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from integrations.harbor.trajectory import (
    TrajectoryConversionError,
    write_loopiq_trajectory,
)


class LoopIQ(BaseInstalledAgent):
    """Install a pinned LoopIQ revision and run one isolated CLI Session per trial."""

    SUPPORTS_ATIF = True
    SUPPORTS_RESUME = False
    ADAPTER_VERSION = "0.2.0"
    HARBOR_COMPATIBILITY_REVISION = "cc4b7be7c1ace2621b38c4e2e13ef736a9bc884f"

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
            default="high",
        )
    ]

    _INSTALL_DIR = PurePosixPath("/installed-agent/loopiq")
    _CLI_PATH = _INSTALL_DIR / "packages/cli/dist/cli.js"
    _AGENT_HOME = PurePosixPath("/tmp/loopiq-home")
    _INSTRUCTION_PATH = PurePosixPath("/tmp/loopiq-instruction.txt")
    _TOKEN_PATH = PurePosixPath("/tmp/loopiq-api-token.txt")
    _SUPERVISOR_PATH = PurePosixPath("/installed-agent/loopiq-supervisor.py")
    _EVENTS_PATH = EnvironmentPaths.agent_dir / "loopiq-events.jsonl"
    _STDERR_PATH = EnvironmentPaths.agent_dir / "loopiq-stderr.log"
    _MANIFEST_PATH = EnvironmentPaths.agent_dir / "loopiq-run-manifest.json"
    _TRAJECTORY_PATH = EnvironmentPaths.agent_dir / "trajectory.json"

    def __init__(
        self,
        *args: Any,
        repository_url: str = "https://github.com/yxswe/LoopIQ-AgentHarness.git",
        inner_timeout_sec: float = 300,
        shutdown_grace_sec: float = 10,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if not self._version:
            raise ValueError(
                "LoopIQ Harbor evaluation requires a pinned git revision in agent.version"
            )
        if inner_timeout_sec <= 0 or shutdown_grace_sec <= 0:
            raise ValueError("LoopIQ timeout and grace values must be positive")
        self._repository_url = repository_url
        self._inner_timeout_sec = inner_timeout_sec
        self._shutdown_grace_sec = shutdown_grace_sec

    @staticmethod
    @override
    def name() -> str:
        return "loopiq"

    @override
    def get_version_command(self) -> str | None:
        return "loopiq --version --format json"

    @override
    def parse_version(self, stdout: str) -> str:
        return str(json.loads(stdout)["version"])

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            ("curl", "bash", "git", "ca_certificates", "python3", "procps"),
        )
        install_dir = shlex.quote(self._INSTALL_DIR.as_posix())
        cli_path = shlex.quote(self._CLI_PATH.as_posix())
        repository = shlex.quote(self._repository_url)
        revision = shlex.quote(self._version)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"rm -rf {install_dir} && mkdir -p {install_dir} && "
                f"git -C {install_dir} init && "
                f"git -C {install_dir} remote add origin {repository} && "
                f"git -C {install_dir} fetch --depth 1 origin {revision} && "
                f"git -C {install_dir} checkout --detach FETCH_HEAD && "
                f"cd {install_dir} && npm ci && npm run build && "
                f"chmod 755 {cli_path} && {cli_path} --version"
            ),
        )
        node_result = await self.exec_as_agent(
            environment,
            command='export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; command -v node',
        )
        node_path = (node_result.stdout or "").strip()
        if not node_path:
            raise RuntimeError(
                "LoopIQ installation could not resolve the Node executable"
            )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"ln -sf {shlex.quote(node_path)} /usr/local/bin/node; "
                f"ln -sf {cli_path} /usr/local/bin/loopiq"
            ),
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("LoopIQ model name must use provider/model format")
        provider, _ = self.model_name.split("/", 1)
        if provider == "openai-codex":
            raise ValueError(
                "LoopIQ Harbor evaluation does not support OAuth-only Providers"
            )
        token = self._get_env("LOOPIQ_API_TOKEN")
        if not token:
            raise ValueError(
                "LOOPIQ_API_TOKEN is required for non-interactive LoopIQ evaluation"
            )
        await super().setup(environment)

        await self._upload_config_text(
            environment,
            content=Path(__file__).with_name("supervisor.py").read_text(),
            remote_path=self._SUPERVISOR_PATH.as_posix(),
            filename="loopiq-supervisor.py",
        )
        await self._upload_config_text(
            environment,
            content=token,
            remote_path=self._TOKEN_PATH.as_posix(),
            filename="loopiq-api-token.txt",
        )
        env = {
            "HOME": self._AGENT_HOME.as_posix(),
            "LOOPIQ_BUILD_REVISION": self._version,
        }
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"rm -rf {shlex.quote(self._AGENT_HOME.as_posix())} && "
                    f"mkdir -p {shlex.quote(self._AGENT_HOME.as_posix())} && "
                    f"chmod 700 {shlex.quote(self._AGENT_HOME.as_posix())} && "
                    f"loopiq providers add {shlex.quote(provider)} --auth-method api_token --token-stdin "
                    f"< {shlex.quote(self._TOKEN_PATH.as_posix())}"
                ),
                env=env,
            )
            models_result = await self.exec_as_agent(
                environment,
                command=f"loopiq models list {shlex.quote(provider)} --refresh --format json",
                env=env,
            )
            models = json.loads(models_result.stdout or "[]")
            if not isinstance(models, list) or not any(
                isinstance(model, dict)
                and model.get("providerId") == provider
                and model.get("modelId") == self.model_name.split("/", 1)[1]
                for model in models
            ):
                raise ValueError(f"LoopIQ model is not available: {self.model_name}")
        finally:
            await self.exec_as_agent(
                environment, command=f"rm -f {shlex.quote(self._TOKEN_PATH.as_posix())}"
            )

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        del context
        if not self.model_name:
            raise ValueError("LoopIQ model name is required")
        await self._upload_config_text(
            environment,
            content=instruction,
            remote_path=self._INSTRUCTION_PATH.as_posix(),
            filename="loopiq-instruction.txt",
        )

        cli_flags = self.build_cli_flags()
        command = [
            "loopiq",
            "run",
            "--stdin",
            "--workspace",
            ".",
            "--model",
            self.model_name,
            "--format",
            "jsonl",
        ]
        if cli_flags:
            command.extend(cli_flags.split())
        env = {
            "HOME": self._AGENT_HOME.as_posix(),
            "LOOPIQ_BUILD_REVISION": self._version,
        }
        supervisor_command = " ".join(
            [
                "python3",
                shlex.quote(self._SUPERVISOR_PATH.as_posix()),
                "--stdin-file",
                shlex.quote(self._INSTRUCTION_PATH.as_posix()),
                "--events",
                shlex.quote(self._EVENTS_PATH.as_posix()),
                "--stderr",
                shlex.quote(self._STDERR_PATH.as_posix()),
                "--manifest",
                shlex.quote(self._MANIFEST_PATH.as_posix()),
                "--adapter-version",
                self.ADAPTER_VERSION,
                "--harbor-revision",
                self.HARBOR_COMPATIBILITY_REVISION,
                "--harbor-session-id",
                shlex.quote(self.session_id or "unknown"),
                "--harbor-context-id",
                shlex.quote(str(self.context_id or "unknown")),
                "--loopiq-revision",
                shlex.quote(self._version),
                "--model",
                shlex.quote(self.model_name),
                "--timeout-sec",
                str(self._inner_timeout_sec),
                "--grace-sec",
                str(self._shutdown_grace_sec),
                "--",
                *(shlex.quote(argument) for argument in command),
            ]
        )
        try:
            await self.exec_as_agent(environment, command=supervisor_command, env=env)
        finally:
            await self.exec_as_agent(
                environment,
                command=f"rm -f {shlex.quote(self._INSTRUCTION_PATH.as_posix())}",
            )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        manifest_path = self.logs_dir / self._MANIFEST_PATH.name
        events_path = self.logs_dir / self._EVENTS_PATH.name
        trajectory_path = self.logs_dir / self._TRAJECTORY_PATH.name
        metadata: dict[str, Any] = {
            "manifest": self._MANIFEST_PATH.name,
            "events": self._EVENTS_PATH.name,
            "stderr": self._STDERR_PATH.name,
            "native_terminal_state": "missing",
            "event_schema": {"name": "loopiq.cli.event", "version": 1},
        }
        if not manifest_path.exists():
            metadata["manifest_state"] = "missing"
        else:
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                metadata["manifest_state"] = "invalid"
                metadata["native_terminal_state"] = "invalid"
            else:
                native_terminal = manifest.get("nativeTerminal") or {}
                terminal = native_terminal.get("event") or {}
                usage = terminal.get("usage") or {}
                context.n_input_tokens = int(usage.get("inputTokens", 0)) + int(
                    usage.get("cacheReadTokens", 0)
                )
                context.n_cache_tokens = int(usage.get("cacheReadTokens", 0))
                context.n_output_tokens = int(usage.get("outputTokens", 0))
                cost = float(usage.get("costUsd", 0))
                context.cost_usd = cost if cost > 0 else None
                metadata.update(
                    {
                        "manifest_state": "present",
                        "native_terminal_state": native_terminal.get(
                            "state", "missing"
                        ),
                        "run_status": terminal.get("status"),
                        "run_reason": terminal.get("reason"),
                        "usage_state": usage.get("state", "unknown"),
                    }
                )

        try:
            trajectory = write_loopiq_trajectory(events_path, trajectory_path)
        except (TrajectoryConversionError, OSError, ValueError) as error:
            metadata["trajectory_state"] = "invalid"
            metadata["trajectory_error"] = str(error)[:1000]
            self.logger.warning(
                "Could not convert LoopIQ events at %s to ATIF: %s",
                events_path,
                error,
            )
        else:
            metadata.update(
                {
                    "trajectory": self._TRAJECTORY_PATH.name,
                    "trajectory_state": "present",
                    "trajectory_schema": trajectory.schema_version,
                    "trajectory_steps": len(trajectory.steps),
                }
            )
        context.metadata = metadata
