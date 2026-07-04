# Vendor Pi `ai` + `agent` 骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Pi 的 `ai` 与 `agent` 两个包 vendor 进 `LoopIQ-AgentHarness`，配好 npm workspaces monorepo，编译出 dist，并用 faux provider 冒烟示例（离线）跑通一次 Agent 对话。

**Architecture:** npm workspaces monorepo，`packages/ai`（`@loopiq/ai`）为基础 LLM 库，`packages/agent`（`@loopiq/agent-core`）依赖它。用 tsgo 编译成 `dist`（`.js`+`.d.ts`）。ai 的联网 codegen 跳过（生成文件已提交在 src）。

**Tech Stack:** Node ≥22.19、npm workspaces、tsgo（`@typescript/native-preview`，可退回 `tsc`）、biome、vitest、tsx。

**上游源路径（复制来源）：** `/Users/yangxiao/Documents/github repos/Agent/pi`（下称 `$PI`）
**目标仓库：** `/Users/yangxiao/Documents/github repos/LoopIQ-AgentHarness`（下称 `$ROOT`，已 `git init`，分支 main）

**改名规则（全仓一致）：**
- `@earendil-works/pi-ai` → `@loopiq/ai`
- `@earendil-works/pi-agent-core` → `@loopiq/agent-core`

---

## 文件结构

会创建 / 修改：

- Create `$ROOT/package.json` — 根 workspace 配置 + 脚本
- Create `$ROOT/tsconfig.base.json` — 编译基础配置（照搬 Pi）
- Create `$ROOT/tsconfig.json` — 根类型检查配置（paths 精简为两包 + 改名）
- Create `$ROOT/biome.json` — lint/format（照搬并精简 includes）
- Create `$ROOT/.gitignore`、`$ROOT/.npmrc`
- Create `$ROOT/packages/ai/**` — 复制自 `$PI/packages/ai`（src、scripts、配置），改 name/build
- Create `$ROOT/packages/agent/**` — 复制自 `$PI/packages/agent`（src、配置），改 name/依赖/paths/alias
- Create `$ROOT/examples/smoke.ts` — faux 冒烟示例

---

## Task 1: 根骨架脚手架

**Files:**
- Create: `$ROOT/package.json`
- Create: `$ROOT/tsconfig.base.json`
- Create: `$ROOT/tsconfig.json`
- Create: `$ROOT/biome.json`
- Create: `$ROOT/.gitignore`
- Create: `$ROOT/.npmrc`

- [ ] **Step 1: 写根 `package.json`**

```json
{
	"name": "loopiq-agent-harness",
	"private": true,
	"type": "module",
	"workspaces": ["packages/*"],
	"scripts": {
		"clean": "npm run clean --workspaces --if-present",
		"build": "cd packages/ai && npm run build && cd ../agent && npm run build",
		"test": "npm run test --workspaces --if-present",
		"check": "biome check --write .",
		"smoke": "tsx examples/smoke.ts"
	},
	"devDependencies": {
		"@biomejs/biome": "2.3.5",
		"@types/node": "22.19.19",
		"@typescript/native-preview": "7.0.0-dev.20260120.1",
		"shx": "0.4.0",
		"tsx": "4.22.1",
		"typescript": "5.9.3"
	},
	"engines": {
		"node": ">=22.19.0"
	}
}
```

- [ ] **Step 2: 写 `tsconfig.base.json`（照搬 Pi）**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "Node16",
		"lib": ["ES2022"],
		"strict": true,
		"erasableSyntaxOnly": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"inlineSources": true,
		"inlineSourceMap": false,
		"moduleResolution": "Node16",
		"resolveJsonModule": true,
		"allowImportingTsExtensions": true,
		"rewriteRelativeImportExtensions": true,
		"experimentalDecorators": true,
		"emitDecoratorMetadata": true,
		"useDefineForClassFields": false,
		"types": ["node"]
	}
}
```

- [ ] **Step 3: 写 `tsconfig.json`（paths 精简为两包 + 改名）**

```json
{
	"extends": "./tsconfig.base.json",
	"compilerOptions": {
		"noEmit": true,
		"paths": {
			"*": ["./*"],
			"@loopiq/ai": ["./packages/ai/src/index.ts"],
			"@loopiq/ai/oauth": ["./packages/ai/src/oauth.ts"],
			"@loopiq/ai/*": ["./packages/ai/src/*.ts", "./packages/ai/src/providers/*.ts"],
			"@loopiq/ai/dist/*": ["./packages/ai/src/*"],
			"@loopiq/agent-core": ["./packages/agent/src/index.ts"],
			"@loopiq/agent-core/*": ["./packages/agent/src/*"],
			"typebox": ["./node_modules/typebox"]
		}
	},
	"include": ["packages/*/src/**/*", "packages/*/test/**/*", "examples/**/*"],
	"exclude": ["**/dist/**"]
}
```

- [ ] **Step 4: 写 `biome.json`（照搬，includes 精简掉不存在的路径）**

```json
{
	"$schema": "https://biomejs.dev/schemas/2.3.5/schema.json",
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true,
			"style": {
				"noNonNullAssertion": "off",
				"useConst": "error",
				"useNodejsImportProtocol": "off"
			},
			"suspicious": {
				"noExplicitAny": "off",
				"noControlCharactersInRegex": "off",
				"noEmptyInterface": "off"
			}
		}
	},
	"formatter": {
		"enabled": true,
		"formatWithErrors": false,
		"indentStyle": "tab",
		"indentWidth": 3,
		"lineWidth": 120
	},
	"files": {
		"includes": [
			"packages/*/src/**/*.ts",
			"packages/*/test/**/*.ts",
			"examples/**/*.ts",
			"!**/node_modules/**/*",
			"!**/*.generated.ts",
			"!**/*.models.ts"
		]
	}
}
```

- [ ] **Step 5: 写 `.gitignore`**

```gitignore
node_modules/
dist/
*.log
.DS_Store
*.tsbuildinfo
packages/*/dist/
*.cpuprofile
.env
.vscode/
.idea/
.claude/
coverage/
.nyc_output/
```

- [ ] **Step 6: 写 `.npmrc`**

```
save-exact=true
```

> 说明：Pi 的 `.npmrc` 还有 `min-release-age=2`（禁止安装 2 天内新发布的包）。此处省略，避免拉不到 tsgo 的 dev 预览版而阻塞。

- [ ] **Step 7: 提交**

```bash
cd "$ROOT"
git add package.json tsconfig.base.json tsconfig.json biome.json .gitignore .npmrc
git commit -m "chore: scaffold npm workspaces monorepo root"
```

---

## Task 2: Vendor `ai` 包并改名

**Files:**
- Create: `$ROOT/packages/ai/` （复制自 `$PI/packages/ai`）
- Modify: `$ROOT/packages/ai/package.json`
- Modify: `$ROOT/packages/ai/**`（改名替换）

- [ ] **Step 1: 复制 ai 包（仅需 src、scripts、配置，不含 node_modules/dist）**

```bash
cd "$ROOT"
mkdir -p packages/ai
cp -R "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/src" packages/ai/src
cp -R "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/scripts" packages/ai/scripts
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/package.json" packages/ai/package.json
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/tsconfig.build.json" packages/ai/tsconfig.build.json
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/vitest.config.ts" packages/ai/vitest.config.ts
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/bedrock-provider.d.ts" packages/ai/bedrock-provider.d.ts
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/ai/bedrock-provider.js" packages/ai/bedrock-provider.js
```

- [ ] **Step 2: 全仓改名替换（ai 包内）**

在 `packages/ai` 下，把所有文件里的 `@earendil-works/pi-ai` 替换为 `@loopiq/ai`（用编辑器/脚本；影响 src 内自引用与 package.json 的 name）。

Run（验证残留应为 0）:
```bash
cd "$ROOT"
grep -rl "@earendil-works/pi-ai" packages/ai | wc -l
```
Expected: `0`

- [ ] **Step 3: 修改 `packages/ai/package.json` 的 build 脚本（跳过联网 codegen）与 canvas devDep**

把 `scripts.build` 从
`"npm run generate-models && npm run generate-image-models && tsgo -p tsconfig.build.json"`
改为：
```json
"build": "tsgo -p tsconfig.build.json"
```
并从 `devDependencies` 中删除 `"canvas": "3.2.3"`（原生模块，避免 install 编译失败；仅影响图像测试）。其余 dependencies / exports / bin / name(`@loopiq/ai`) 保持。

- [ ] **Step 4: 提交**

```bash
cd "$ROOT"
git add packages/ai
git commit -m "feat: vendor pi ai package as @loopiq/ai"
```

---

## Task 3: Vendor `agent` 包并改名/改依赖

**Files:**
- Create: `$ROOT/packages/agent/`（复制自 `$PI/packages/agent`）
- Modify: `$ROOT/packages/agent/package.json`
- Modify: `$ROOT/packages/agent/tsconfig.build.json`
- Modify: `$ROOT/packages/agent/vitest.config.ts`
- Modify: `$ROOT/packages/agent/src/**`（改名替换）

- [ ] **Step 1: 复制 agent 包**

```bash
cd "$ROOT"
mkdir -p packages/agent
cp -R "/Users/yangxiao/Documents/github repos/Agent/pi/packages/agent/src" packages/agent/src
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/agent/package.json" packages/agent/package.json
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/agent/tsconfig.build.json" packages/agent/tsconfig.build.json
cp "/Users/yangxiao/Documents/github repos/Agent/pi/packages/agent/vitest.config.ts" packages/agent/vitest.config.ts
```

- [ ] **Step 2: 全仓改名替换（agent 包内，两条规则）**

在 `packages/agent` 下替换：
- `@earendil-works/pi-agent-core` → `@loopiq/agent-core`
- `@earendil-works/pi-ai` → `@loopiq/ai`

这会同时改到：`src` 内所有 import（`@loopiq/ai`、`@loopiq/ai/compat`）、`package.json` 的 `name` 与 dependency、`tsconfig.build.json` 的 `paths`、`vitest.config.ts` 的 alias 正则。

Run（验证残留应为 0）:
```bash
cd "$ROOT"
grep -rl "@earendil-works" packages/agent | wc -l
```
Expected: `0`

- [ ] **Step 3: 确认 `packages/agent/package.json` 依赖指向本地 ai**

把 `dependencies["@loopiq/ai"]` 的版本从 `^0.80.3` 改为 `"*"`（用 workspace 本地版本，避免版本不匹配）。

- [ ] **Step 4: 确认 `packages/agent/tsconfig.build.json` 的 paths 已改名**

内容应为（改名后）：
```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "./dist",
		"paths": {
			"@loopiq/ai": ["../ai/dist/index.d.ts"],
			"@loopiq/ai/*": ["../ai/dist/*.d.ts", "../ai/dist/providers/*.d.ts"]
		},
		"rootDir": "./src"
	},
	"include": ["src/**/*.ts"],
	"exclude": ["node_modules", "dist", "**/*.d.ts", "src/**/*.d.ts"]
}
```

- [ ] **Step 5: 提交**

```bash
cd "$ROOT"
git add packages/agent
git commit -m "feat: vendor pi agent package as @loopiq/agent-core"
```

---

## Task 4: 安装依赖并编译两包

**Files:** 无（生成 `node_modules`、`packages/*/dist`）

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd "$ROOT"
npm install
```
Expected: 安装成功；`node_modules/@loopiq/ai`、`node_modules/@loopiq/agent-core` 为指向 `packages/*` 的软链。

验证软链:
```bash
ls -la node_modules/@loopiq
```
Expected: `ai` 与 `agent-core` 两个 symlink。

- [ ] **Step 2: 编译（先 ai 后 agent）**

Run:
```bash
cd "$ROOT"
npm run build
```
Expected: 无错误退出。若 tsgo 报错，退回标准 tsc（临时把两包 build 改为 `tsc -p tsconfig.build.json` 再试）。

- [ ] **Step 3: 验证产物含 `.js` 与 `.d.ts`**

Run:
```bash
cd "$ROOT"
ls packages/ai/dist/index.js packages/ai/dist/index.d.ts packages/ai/dist/compat.js packages/agent/dist/index.js packages/agent/dist/index.d.ts
```
Expected: 五个文件都存在。

- [ ] **Step 4: 提交（记录构建可用；dist 不入库，提交 lockfile）**

```bash
cd "$ROOT"
git add package-lock.json
git commit -m "chore: add package-lock after workspace install"
```

---

## Task 5: faux 冒烟示例（离线跑通 Agent）

**Files:**
- Create: `$ROOT/examples/smoke.ts`

- [ ] **Step 1: 写 `examples/smoke.ts`**

```ts
import { registerFauxProvider, fauxAssistantMessage } from "@loopiq/ai/compat";
import { Agent } from "@loopiq/agent-core";

async function main(): Promise<void> {
	// 注册一个离线 faux provider，并预置一条回复
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("Hello from the faux model! 2 + 2 = 4.")]);
	const model = faux.getModel();

	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant. Keep responses concise.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	// 流式打印助手输出
	agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await agent.prompt("What is 2 + 2?");
	process.stdout.write("\n");

	const last = agent.state.messages[agent.state.messages.length - 1];
	if (last.role !== "assistant") {
		throw new Error(`Expected assistant message, got ${last.role}`);
	}
	const text = last.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
	if (!text.includes("4")) {
		throw new Error(`Smoke assertion failed: reply did not contain "4": ${text}`);
	}

	faux.unregister();
	console.log("[smoke] OK");
}

main().catch((error) => {
	console.error("[smoke] FAILED:", error);
	process.exit(1);
});
```

- [ ] **Step 2: 运行冒烟（需先完成 Task 4 的 build，示例经包名解析到 dist）**

Run:
```bash
cd "$ROOT"
npm run smoke
```
Expected: 先流式打印出含 "4" 的回复，最后一行为 `[smoke] OK`，退出码 0。

- [ ] **Step 3: 提交**

```bash
cd "$ROOT"
git add examples/smoke.ts package.json
git commit -m "test: add offline faux-provider smoke example"
```

---

## Task 6: 运行 vendor 单测并记录结果

**Files:** 无

- [ ] **Step 1: 跑测试**

Run:
```bash
cd "$ROOT"
npm test
```
Expected: vitest 在两包中运行。离线核心用例通过；**允许**因联网（真实调用各家 API）或图像（已移除 canvas）导致的用例失败/跳过。

- [ ] **Step 2: 记录失败清单**

把失败用例归类为「联网类 / 图像类 / 其他」。若出现「其他」类失败（与网络/canvas 无关的真实编译或逻辑错误），需回到对应包排查后再判定骨架是否跑通。

- [ ] **Step 3: 提交（若为记录用途新增了说明文件则提交，否则跳过）**

```bash
cd "$ROOT"
git add -A
git commit -m "chore: record vendored test baseline" || echo "nothing to commit"
```

---

## 完成判据（对齐 spec 的 DoD）

- [ ] `npm install` 成功，两包 workspace 互链（Task 4 Step 1）
- [ ] `npm run build` 成功，两个 dist 均出 `.js`+`.d.ts`（Task 4 Step 3）
- [ ] `npm run smoke` 离线跑通、打印含 "4" 的回复并输出 `[smoke] OK`（Task 5 Step 2）
- [ ] `npm test` 可运行，离线核心用例通过（Task 6 Step 1）
