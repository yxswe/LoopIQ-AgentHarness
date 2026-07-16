# Claude Code Onboarding 指南

本文档介绍如何从零把 Claude Code 跑起来，并让它通过本地 `copilot-api` 网关
接入 GitHub Copilot。整体分三步：

1. 安装 Claude Code（含依赖）。
2. 安装 Docker，并把 `copilot-api` 编译成本地镜像、以「开机自启 + 崩溃自启」方式常驻运行。
3. 在全局 `~/.claude` 写入 `settings.json`，把 Claude Code 指向本地网关端口，并安装配套插件。

> 网关默认监听端口 **4141**。下文所有配置都基于该端口，如果你改了端口，记得同步替换。

---

## 第一步：安装 Claude Code

### 1.1 依赖说明

| 场景 | 是否需要 Node.js | 说明 |
| --- | --- | --- |
| 原生安装器（推荐） | 否 | 官方原生二进制，零 Node 依赖，自带自动更新 |
| npm 安装 / 运行 SDK、插件 | 是，Node.js 18+ | 走 Node 生态时需要 |
| Windows 原生安装 | 否 | 建议额外装 **Git for Windows**，让 Claude Code 能调用 Bash |

> 说明：本方案里 `copilot-api` 用 **Docker** 运行，宿主机**不需要**单独安装 Node.js 或 Bun。
> 只有当你想用 `npx` 方式（而非 Docker）跑网关时，才需要 Node.js（>= 22.13.0 才启用 token 用量存储）。

### 1.2 安装命令

**macOS（原生安装器，推荐）**

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows PowerShell（原生安装器，推荐）**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Windows CMD（原生安装器）**

```bat
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

**npm 方式（备选 / 需要 Node 18+）**

```sh
npm install -g @anthropic-ai/claude-code
```

### 1.3 验证安装

```sh
claude --version
claude doctor
```

`claude doctor` 会做一次安装与环境自检，出现异常时优先看它的输出。

---

## 第二步：安装 Docker 并运行 copilot-api

`copilot-api` 是一个本地 AI 网关，对外暴露 OpenAI / Anthropic 兼容接口，把
Claude Code 的请求转发给 GitHub Copilot。仓库：<https://github.com/caozhiyuan/copilot-api>

### 2.1 安装 Docker Desktop（并设置开机自启）

1. 下载安装 Docker Desktop：
   - macOS：<https://www.docker.com/products/docker-desktop/>
   - Windows：同上（需开启 WSL2）。
2. 设置 Docker 开机自启（保证宿主机开机后 Docker 守护进程会拉起容器）：
   - 打开 **Docker Desktop → Settings → General**
   - 勾选 **Start Docker Desktop when you sign in to your computer**

### 2.2 拉取仓库并编译镜像

```sh
git clone https://github.com/caozhiyuan/copilot-api.git
cd copilot-api
docker build -t copilot-api .
```

> 镜像基于 `oven/bun` 构建，`Dockerfile` 中已 `EXPOSE 4141`，并内置了 HEALTHCHECK。

### 2.3 首次鉴权：登录 GitHub Copilot

网关首次运行需要登录 GitHub Copilot。用 `--auth` 进入交互式登录，并把凭据写入挂载卷（后续重启复用）：

**macOS / Linux**

```sh
mkdir -p ./copilot-data
docker run -it --rm \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  copilot-api --auth
```

**Windows PowerShell**

```powershell
mkdir copilot-data
docker run -it --rm `
  -v "${PWD}/copilot-data:/root/.local/share/copilot-api" `
  copilot-api --auth
```

按提示完成 GitHub 设备码（device code）OAuth 登录。凭据会保存在宿主机的
`./copilot-data` 目录（容器内对应 `/root/.local/share/copilot-api`）。

> 备选：如果你已经有 GitHub token，也可以在 2.4 的运行命令里加 `-e GH_TOKEN=你的token` 直接注入，跳过交互式登录。

### 2.4 常驻运行（开机自启 + 崩溃自启）

```sh
docker run -d \
  --name copilot-api \
  --restart unless-stopped \
  -p 4141:4141 \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  copilot-api
```

参数说明：

- `-d`：后台运行。
- `--restart unless-stopped`：**崩溃自动重启**，且 Docker 启动时（即宿主机开机后）**自动拉起**，除非你手动 `docker stop`。
- `-p 4141:4141`：把容器端口 4141 映射到宿主机。
- `-v .../copilot-data:...`：挂载 2.3 生成的鉴权数据，避免每次重启都要重新登录。

> `--restart unless-stopped` 配合 2.1 的「Docker 开机自启」即可实现完整的开机自启 + 崩溃自启。
> 如果希望即使手动停过也在开机时重启，可把策略换成 `--restart always`。

### 2.5 验证网关

```sh
curl http://localhost:4141/v1/models
```

能返回模型列表即成功。也可以在浏览器打开用量面板：

```
http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage
```

常用运维命令：

```sh
docker logs -f copilot-api     # 查看日志
docker restart copilot-api     # 手动重启
docker stop copilot-api        # 停止（stop 后 unless-stopped 不会再自启）
```

---

## 第三步：配置 Claude Code 接入网关

### 3.1 在全局 `~/.claude` 建立 `settings.json`

Claude Code 会读取用户级全局配置：

- macOS / Linux：`~/.claude/settings.json`
- Windows：`%USERPROFILE%\.claude\settings.json`

新建该目录与文件，写入以下内容（`ANTHROPIC_BASE_URL` 的端口须与第二步一致）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4-8",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0"
  },
  "permissions": {
    "deny": [
      "mcp__ide__executeCode"
    ]
  }
}
```

关键项说明：

- `ANTHROPIC_BASE_URL`：指向本地网关，**端口必须等于第二步映射的端口**（默认 4141）。
- `ANTHROPIC_AUTH_TOKEN`：本地网关默认不校验，填任意占位值 `dummy` 即可。
- `ANTHROPIC_MODEL` / `..._OPUS/SONNET/HAIKU_MODEL`：按仓库要求，搭配 Claude Code 时统一使用模型 ID **`claude-opus-4-8`**。
  - 若想让后台小任务（HAIKU 档）省额度，可把 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 换成更轻的模型。
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`：避免在系统提示里注入计费/版本信息，防止 prompt cache 失效。
- 关闭 `PROMPT_SUGGESTION` / `AWAY_SUMMARY`：避免不必要地消耗额度。

> 该 `settings.json` 也可以放到某个项目根目录的 `.claude/settings.json` 里，仅对该项目生效；放全局则对所有项目生效。

### 3.2 安装配套插件（仓库推荐）

按仓库指引，配置完成后安装 Claude Code 插件，以获得 subagent 标记注入与 GPT tool-search 桥接能力。在 Claude Code 交互界面里执行：

```
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git
/plugin install agent-inject@copilot-api-marketplace
/plugin install tool-search@copilot-api-marketplace
```

- `agent-inject`：在 `SubagentStart` 时注入标记，让网关正确推断 `x-initiator: agent`。
- `tool-search`：注册 `tool_search` MCP 桥接（用于 GPT Responses 延迟工具加载）。

### 3.3 启动并验证

在任意项目目录下运行：

```sh
claude
```

如果一切正常，Claude Code 会通过 `http://localhost:4141` 走本地网关、使用
`claude-opus-4-8` 模型工作。可以先发一句简单问候确认链路通畅。

---

## 常见问题排查

| 现象 | 排查方向 |
| --- | --- |
| `claude` 连不上 / 报网络错误 | 确认容器在跑：`docker ps` 里能看到 `copilot-api`；`curl http://localhost:4141/v1/models` 是否有响应 |
| 端口冲突 | 换端口：运行时 `-p 8080:4141`，同时把 `ANTHROPIC_BASE_URL` 改成 `http://localhost:8080` |
| 每次重启都要重新登录 | 确认 2.4 挂载了与 2.3 相同的 `copilot-data` 卷 |
| 开机后容器没起来 | 确认 Docker Desktop 已开启「开机自启」，且容器用了 `--restart unless-stopped/always` |
| 模型不可用 | 确认 GitHub 账号已订阅 Copilot；用 `docker logs -f copilot-api` 看鉴权日志 |
