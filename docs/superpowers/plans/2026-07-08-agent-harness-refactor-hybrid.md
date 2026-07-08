# AgentHarness 重构实施计划（方案 C — 混合分层）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent loop 并入 harness、消除 `AgentLoopParams` 回调层，并按状态生命周期把职责拆成 `MessageQueues` / `SessionWriter` / `TurnRunner` + 纯函数模块，同时保持公开 API 不变。

**Architecture:** 运行时配置留在门面当字段；每轮用纯函数 `buildTurnState()` 物化快照；`TurnRunner` 短命对象吸收 loop 的 `runLoop`/`streamAssistantResponse` 与 harness 的 `executeTurn`/`handleAgentEvent`/`emitRunFailure`，只依赖 3 个协作对象 + `turnState` 快照 + `refreshTurnState` 闭包。

**Tech Stack:** TypeScript 5.9 + `tsgo`（类型检查即唯一安全网，无运行测试）、`@loopiq/ai`、npm workspaces。

---

## 验证与前提（所有任务通用）

- **唯一验证命令**（在包目录执行）：
  ```bash
  cd "packages/agent-harness" && npm run build
  ```
  该命令运行 `tsgo -p tsconfig.build.json`。**通过 = 退出码 0 且无任何输出**。任何 TS 报错都视为该任务失败，必须修复后再 commit。
- **无运行测试 / 无冒烟脚本**（`examples/` 已空）。因此每个任务除类型检查外，还必须人工核对下方"行为不变量"未被破坏。
- **公开 API 不变**：`AgentHarness` 类的公开方法签名一律不改。
- 每个任务都是"可独立编译的中间态"，顺序不可跳。

### 行为不变量（重构全程必须保持，Task 7/8 尤其核对）

1. 事件发射序列不变：`agent_start` → `turn_start` →（每条 prompt 的 `message_start`/`message_end`）→ 流式 `message_start`/`message_update`/`message_end` → `turn_end` → `save_point` → …（多轮）→ `agent_end` → `settled`。
2. `turn_end` 处理：先 `events.emit(turn_end)`（捕获错误延后抛）→ 记录 `hadPendingMutations` → flush pending → 若 emit 出错则抛 → `emit(save_point, hadPendingMutations)`。
3. save point 之后：再 flush 一次（捕获 save_point 订阅者新入队的写）→ 刷新快照 → drain steer。
4. `agent_end` 处理：flush → **置 phase=idle** → `emit(agent_end)` → `emit(settled, nextTurnCount)`，顺序不变（phase 必须在两次 emit 之前置位）。
5. 流式失败（stopReason error/aborted）：`turn_end(toolResults:[])` → `agent_end` 后直接返回，不进 tool 执行。
6. 运行异常：走 `emitRunFailure`（发 message_start/message_end/turn_end/agent_end + failure message）；若失败上报本身再抛错，则包成 `AgentHarnessError("unknown", AggregateError)`。
7. 队列 drain 原子性：先 splice，emit 失败则 `unshift` 回滚并抛 `normalizeHookError(error)`。
8. `shouldStopAfterTurn` 与 `toolExecution` 在现有 harness 中**从未传入**（`createLoopParams` 未提供），合并后移除该分支、`executeToolCalls` 用默认 `"parallel"`。
9. `streamAssistantResponse` 中 `streamFn || streamSimple` 的 fallback 与 `getApiKey/resolvedApiKey` 在 harness 路径下是**死代码**（harness 总是注入 streamFn，且 apiKey 恒为 undefined）；合并后直接调用 `models.streamSimple`，删除死代码。

---

## Task 1: 更名 `tool-execuation.ts` → `tool-execution.ts`

零风险、独立。修正拼写，先做以便后续 `turn-runner.ts` 一开始就 import 正确文件名。

**Files:**
- Rename: `src/core/tool-execuation.ts` → `src/core/tool-execution.ts`
- Modify: `src/core/agent-loop.ts:23`（更新 import 路径）

- [ ] **Step 1: git mv 更名文件**

```bash
cd "packages/agent-harness"
git mv src/core/tool-execuation.ts src/core/tool-execution.ts
```

- [ ] **Step 2: 更新 agent-loop.ts 的 import**

`src/core/agent-loop.ts` 第 23 行：

```ts
import { executeToolCalls } from "./tool-execution.ts";
```

（原为 `"./tool-execuation.ts"`。此处是当前唯一引用点。）

- [ ] **Step 3: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: rename tool-execuation.ts to tool-execution.ts

Fix long-standing spelling; update its sole importer (agent-loop.ts).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 抽出 `message-factory.ts`（纯函数）

把 `createUserMessage` / `createFailureMessage` 从 `agent-harness.ts` 搬到独立文件。

**Files:**
- Create: `src/core/message-factory.ts`
- Modify: `src/core/agent-harness.ts`（删除两函数定义，改为 import）

- [ ] **Step 1: 创建 message-factory.ts**

`src/core/message-factory.ts` 完整内容（逐字取自 agent-harness.ts:38-63，仅补 import/export）：

```ts
import type { AssistantMessage, ImageContent, Model, UserMessage } from "@loopiq/ai";

export function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

export function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
```

- [ ] **Step 2: 在 agent-harness.ts 删除两函数并 import**

删除 `src/core/agent-harness.ts:38-63`（`createUserMessage` 与 `createFailureMessage` 两个函数定义）。在文件顶部 import 区（`./agent-loop.ts` import 之后）加：

```ts
import { createFailureMessage, createUserMessage } from "./message-factory.ts";
```

（`createFailureMessage` 目前在 `emitRunFailure` 中用到、`createUserMessage` 在多处用到，import 后引用不变。）

- [ ] **Step 3: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: extract message-factory pure functions

Move createUserMessage/createFailureMessage out of the harness facade.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 抽出 `stream-options.ts`（纯函数）

把 `cloneStreamOptions` / `applyStreamOptionsPatch` 搬出。

**Files:**
- Create: `src/core/stream-options.ts`
- Modify: `src/core/agent-harness.ts`（删除两函数，改为 import）

- [ ] **Step 1: 创建 stream-options.ts**

`src/core/stream-options.ts` 完整内容（逐字取自 agent-harness.ts:65-123）：

```ts
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "../base/options.ts";

export function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

export function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}
```

- [ ] **Step 2: 在 agent-harness.ts 删除两函数并 import**

删除 `src/core/agent-harness.ts:65-123`。在 import 区加：

```ts
import { applyStreamOptionsPatch, cloneStreamOptions } from "./stream-options.ts";
```

- [ ] **Step 3: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: extract stream-options pure functions

Move cloneStreamOptions/applyStreamOptionsPatch out of the harness facade.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 抽出 `turn-state.ts`（类型 + 纯函数）

把 `AgentHarnessTurnState` 类型、`createTurnState`、`createContext` 改成纯函数模块。

**Files:**
- Create: `src/core/turn-state.ts`
- Modify: `src/core/agent-harness.ts`（删除 interface + `createTurnState` + `createContext`，改为调用 `buildTurnState`/`buildContext`）

- [ ] **Step 1: 创建 turn-state.ts**

`src/core/turn-state.ts` 完整内容：

```ts
import type { Model } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentMessage } from "../base/messages.ts";
import type {
	AgentContext,
	AgentHarnessOptions,
	AgentHarnessStreamOptions,
	ThinkingLevel,
} from "../base/options.ts";
import type { AgentHarnessResources, AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { Session } from "../base/session-types.ts";
import { cloneStreamOptions } from "./stream-options.ts";

export interface TurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export async function buildTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
>(deps: {
	session: Session;
	env: ExecutionEnv;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: Map<string, TTool>;
	activeToolNames: string[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
}): Promise<TurnState<TSkill, TPromptTemplate, TTool>> {
	const context = await deps.session.buildContext();
	const sessionMetadata = await deps.session.getMetadata();
	const tools = [...deps.tools.values()];
	const activeTools = deps.activeToolNames
		.map((name) => deps.tools.get(name))
		.filter((tool): tool is TTool => tool !== undefined);
	let systemPrompt = "You are a helpful assistant.";
	if (typeof deps.systemPrompt === "string") {
		systemPrompt = deps.systemPrompt;
	} else if (deps.systemPrompt) {
		systemPrompt = await deps.systemPrompt({
			env: deps.env,
			session: deps.session,
			model: deps.model,
			thinkingLevel: deps.thinkingLevel,
			activeTools,
			resources: deps.resources,
		});
	}
	return {
		messages: context.messages,
		resources: deps.resources,
		streamOptions: cloneStreamOptions(deps.streamOptions),
		sessionId: sessionMetadata.id,
		systemPrompt,
		model: deps.model,
		thinkingLevel: deps.thinkingLevel,
		tools,
		activeTools,
	};
}

export function buildContext(
	turnState: TurnState,
	systemPromptOverride?: string,
): AgentContext {
	return {
		systemPrompt: systemPromptOverride ?? turnState.systemPrompt,
		messages: turnState.messages.slice(),
		tools: turnState.activeTools.slice(),
	};
}
```

- [ ] **Step 2: 在 agent-harness.ts 改用 turn-state**

在 `src/core/agent-harness.ts`：

1. 删除 `interface AgentHarnessTurnState<...> { ... }`（当前 127-141）。
2. 删除 `private async createTurnState()` 方法（当前 207-239）。
3. 删除 `private createContext(...)` 方法（当前 346-355）。
4. import 区加：
   ```ts
   import { buildContext, buildTurnState, type TurnState } from "./turn-state.ts";
   ```
5. 加一个私有帮助方法（放在原 `createTurnState` 位置附近）：
   ```ts
   private buildTurnStateFromConfig(): Promise<TurnState<TSkill, TPromptTemplate, TTool>> {
   	return buildTurnState({
   		session: this.session,
   		env: this.env,
   		model: this.model,
   		thinkingLevel: this.thinkingLevel,
   		tools: this.tools,
   		activeToolNames: this.activeToolNames,
   		resources: this.getResources(),
   		streamOptions: this.streamOptions,
   		systemPrompt: this.systemPrompt,
   	});
   }
   ```
6. 全局把类型引用 `AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>` 替换为 `TurnState<TSkill, TPromptTemplate, TTool>`（出现在 `createStreamFn`/`createLoopParams`/`executeTurn` 的签名里）。
7. 把对 `this.createTurnState()` 的调用（在 `prompt`/`skill`/`promptFromTemplate` 与 `createLoopParams.prepareNextTurn` 内）替换为 `this.buildTurnStateFromConfig()`。
8. 把对 `this.createContext(...)` 的调用替换为 `buildContext(...)`（同参数）。

> 注意：本步 harness 仍保留 `createStreamFn`/`createLoopParams`/`executeTurn`，只是它们改用 `TurnState` 类型 + `buildContext`/`buildTurnStateFromConfig`。保持可编译。

- [ ] **Step 3: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: extract turn-state builders into pure module

Turn TurnState type + createTurnState/createContext into buildTurnState/
buildContext pure functions; facade calls buildTurnStateFromConfig().

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 抽出 `SessionWriter`（有状态，长期）

封装 `pendingSessionWrites` 数组 + `flushPendingSessionWrites` 的类型分发。

**Files:**
- Create: `src/session/session-writer.ts`
- Modify: `src/core/agent-harness.ts`（删字段 + 删方法 + 改引用）

- [ ] **Step 1: 创建 session-writer.ts**

`src/session/session-writer.ts` 完整内容（flush 分发逐字取自 agent-harness.ts:241-265）：

```ts
import type { PendingSessionWrite, Session } from "../base/session-types.ts";

export class SessionWriter {
	private pending: PendingSessionWrite[] = [];

	constructor(private readonly session: Session) {}

	enqueue(write: PendingSessionWrite): void {
		this.pending.push(write);
	}

	hasPending(): boolean {
		return this.pending.length > 0;
	}

	async flush(): Promise<void> {
		while (this.pending.length > 0) {
			const write = this.pending[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "active_tools_change") {
				await this.session.appendActiveToolsChange(write.activeToolNames);
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
			}
			this.pending.shift();
		}
	}
}
```

> 类型说明：`PendingSessionWrite` 是 `SessionTreeEntry` 去掉 `id/parentId/timestamp` 的联合（见 base/session-types.ts:159）。上面的 `write.type` 分支即其全部成员，与原 `flushPendingSessionWrites` 一一对应。

- [ ] **Step 2: 在 agent-harness.ts 接入 SessionWriter**

在 `src/core/agent-harness.ts`：

1. import 区加：
   ```ts
   import { SessionWriter } from "../session/session-writer.ts";
   ```
2. 删除字段 `private pendingSessionWrites: PendingSessionWrite[] = [];`（当前 164）。
3. 加字段（放在 `events` 字段附近）：
   ```ts
   private readonly sessionWriter = new SessionWriter(this.session);
   ```
   > 注意：类字段初始化器里引用 `this.session` 要求 `session` 在其之前已赋值。由于 `session` 是在 `constructor` 里 `this.session = options.session` 赋值、而字段初始化器早于构造体执行，**不能**用字段初始化器读 `this.session`。改为在构造函数体内、`this.session = options.session;` 之后显式初始化：
   > ```ts
   > private sessionWriter!: SessionWriter;
   > ```
   > 并在构造函数 `this.session = options.session;` 之后加 `this.sessionWriter = new SessionWriter(this.session);`。
4. 删除方法 `private async flushPendingSessionWrites()`（当前 241-265）。
5. 把所有 `await this.flushPendingSessionWrites()` 调用替换为 `await this.sessionWriter.flush()`（出现在 `handleAgentEvent` 的 turn_end/agent_end、`createLoopParams.prepareNextTurn`、`executeTurn` 的 finally）。
6. 把 `handleAgentEvent` 里 `const hadPendingMutations = this.pendingSessionWrites.length > 0;` 替换为 `const hadPendingMutations = this.sessionWriter.hasPending();`。
7. 把 `setModel`/`setThinkingLevel` 里 `this.pendingSessionWrites.push({ ... })` 替换为 `this.sessionWriter.enqueue({ ... })`（参数不变）。
8. 删除不再使用的 `PendingSessionWrite` import（若 TS 报未使用则移除；`Session`、`AbortResult` 仍需保留）。

- [ ] **Step 3: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: extract SessionWriter for pending session writes

Encapsulate the pending-writes queue and its append dispatch behind a
stateful SessionWriter; facade delegates enqueue/hasPending/flush.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 抽出 `MessageQueues`（有状态，长期）

封装 steer / followUp / nextTurn 三队列 + drain 的原子回滚语义。**不持有 EventBus**：drain 用 `onDrained` 回调把 emit 时机交回调用方，回滚逻辑仍封装在内部。

**Files:**
- Create: `src/queue/message-queues.ts`
- Modify: `src/core/agent-harness.ts`（删三字段 + 删 `drainQueuedMessages` + 改引用）

- [ ] **Step 1: 创建 message-queues.ts**

`src/queue/message-queues.ts` 完整内容：

```ts
import type { UserMessage } from "@loopiq/ai";
import type { AgentMessage } from "../base/messages.ts";
import type { QueueMode } from "../base/options.ts";
import { normalizeHookError } from "../base/types.ts";

export class MessageQueues {
	private steerQueue: UserMessage[] = [];
	private followUpQueue: UserMessage[] = [];
	private nextTurnQueue: AgentMessage[] = [];

	enqueueSteer(message: UserMessage): void {
		this.steerQueue.push(message);
	}

	enqueueFollowUp(message: UserMessage): void {
		this.followUpQueue.push(message);
	}

	enqueueNextTurn(message: AgentMessage): void {
		this.nextTurnQueue.push(message);
	}

	drainSteer(mode: QueueMode, onDrained?: () => Promise<void>): Promise<AgentMessage[]> {
		return this.drain(this.steerQueue, mode, onDrained);
	}

	drainFollowUp(mode: QueueMode, onDrained?: () => Promise<void>): Promise<AgentMessage[]> {
		return this.drain(this.followUpQueue, mode, onDrained);
	}

	async takeNextTurn(onDrained?: () => Promise<void>): Promise<AgentMessage[]> {
		const messages = this.nextTurnQueue.splice(0);
		if (messages.length === 0) return messages;
		try {
			await onDrained?.();
			return messages;
		} catch (error) {
			this.nextTurnQueue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}

	clearForAbort(): { clearedSteer: UserMessage[]; clearedFollowUp: UserMessage[] } {
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		return { clearedSteer, clearedFollowUp };
	}

	snapshot(): { steer: UserMessage[]; followUp: UserMessage[]; nextTurn: AgentMessage[] } {
		return {
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		};
	}

	private async drain(
		queue: UserMessage[],
		mode: QueueMode,
		onDrained?: () => Promise<void>,
	): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await onDrained?.();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}
}
```

> 语义对照：`drain` 复刻原 `drainQueuedMessages`（agent-harness.ts:385-395）；`takeNextTurn` 复刻 `executeTurn` 里 nextTurn 的 splice+回滚（agent-harness.ts:427-436）。`onDrained` 由门面传入 `() => this.emitQueueUpdate()`。

- [ ] **Step 2: 在 agent-harness.ts 接入 MessageQueues**

在 `src/core/agent-harness.ts`：

1. import 区加：
   ```ts
   import { MessageQueues } from "../queue/message-queues.ts";
   ```
2. 删除三个字段 `steerQueue`/`followUpQueue`/`nextTurnQueue`（当前 165-167）。
3. 加字段：
   ```ts
   private readonly queues = new MessageQueues();
   ```
4. 删除方法 `private async drainQueuedMessages(...)`（当前 385-395）。
5. `emitQueueUpdate` 改为读快照：
   ```ts
   private async emitQueueUpdate(): Promise<void> {
   	const snap = this.queues.snapshot();
   	await this.events.emit({
   		type: "queue_update",
   		steer: snap.steer,
   		followUp: snap.followUp,
   		nextTurn: snap.nextTurn,
   	});
   }
   ```
6. `createLoopParams` 里的两处 drain 改为：
   ```ts
   getSteeringMessages: async () => this.queues.drainSteer(this.steeringQueueMode, () => this.emitQueueUpdate()),
   getFollowUpMessages: async () => this.queues.drainFollowUp(this.followUpQueueMode, () => this.emitQueueUpdate()),
   ```
7. `executeTurn` 里 nextTurn 段（当前 427-436）替换为：
   ```ts
   const queued = await this.queues.takeNextTurn(() => this.emitQueueUpdate());
   if (queued.length > 0) {
   	messages = [...queued, messages[0]!];
   }
   ```
8. `steer`/`followUp`/`nextTurn` 三个公开方法里的 `this.xxxQueue.push(createUserMessage(...))` 替换为 `this.queues.enqueueSteer(createUserMessage(...))` / `enqueueFollowUp` / `enqueueNextTurn`（其余逻辑不变，仍 `await this.emitQueueUpdate()`）。
9. `abort` 里 `[...this.steerQueue]`/`[...this.followUpQueue]` + 清空四行替换为：
   ```ts
   const { clearedSteer, clearedFollowUp } = this.queues.clearForAbort();
   ```
10. `handleAgentEvent` 的 agent_end 里 `nextTurnCount: this.nextTurnQueue.length` 替换为 `nextTurnCount: this.queues.snapshot().nextTurn.length`。

- [ ] **Step 3: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: extract MessageQueues for steer/followUp/nextTurn

Encapsulate the three message queues plus drain/rollback semantics; emit
timing stays with the facade via an onDrained callback (no EventBus dep).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 合并 loop，创建 `TurnRunner`（最大一步）

把 `agent-loop.ts` 的 `runAgentLoop`/`runLoop`/`streamAssistantResponse` 与 harness 的 `executeTurn` 运行部分 + `createStreamFn` + `handleAgentEvent` + `emitRunFailure` + `emitBeforeProviderRequest` 合并进新的 `TurnRunner`，消除 `AgentLoopParams` 回调层。删除 `agent-loop.ts`。

> **本步只碰运行驱动**。严格保持"行为不变量" §1–§9。不用 `runAgentLoopContinue`（harness 从不调用）。移除死代码（不变量 §8/§9）。`phase=idle` 通过 `markIdle` 回调在 agent_end 处置位（不变量 §4）。`emitBeforeProviderRequest` 移入 TurnRunner（它只用 `events` + stream-options 纯函数；较 spec §9 的"注入"更省一个闭包，属规划期收紧）。

**Files:**
- Create: `src/core/turn-runner.ts`
- Delete: `src/core/agent-loop.ts`
- Modify: `src/core/agent-harness.ts`（Task 8 再改；本步先让 TurnRunner 就位并让 harness 改用它）

- [ ] **Step 1: 创建 turn-runner.ts（完整文件）**

`src/core/turn-runner.ts`：

```ts
import type { Model, Models, SimpleStreamOptions } from "@loopiq/ai";
import type { AssistantMessage, Context, ToolResultMessage } from "@loopiq/ai/compat";

import type { AgentRunEvent } from "../base/events.ts";
import { type AgentMessage, convertToLlm } from "../base/messages.ts";
import type { AgentContext, AgentHarnessStreamOptions, QueueMode } from "../base/options.ts";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { Session } from "../base/session-types.ts";
import { AgentHarnessError, normalizeHookError, toError } from "../base/types.ts";

import { AgentEventBus } from "./event-bus.ts";
import { createFailureMessage } from "./message-factory.ts";
import { applyStreamOptionsPatch, cloneStreamOptions } from "./stream-options.ts";
import { executeToolCalls } from "./tool-execution.ts";
import { buildContext, type TurnState } from "./turn-state.ts";
import { MessageQueues } from "../queue/message-queues.ts";
import { SessionWriter } from "../session/session-writer.ts";

export interface TurnRunnerDeps<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	session: Session;
	models: Models;
	events: AgentEventBus<TSkill, TPromptTemplate>;
	queues: MessageQueues;
	sessionWriter: SessionWriter;
	signal: AbortSignal;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	turnState: TurnState<TSkill, TPromptTemplate, TTool>;
	refreshTurnState: () => Promise<TurnState<TSkill, TPromptTemplate, TTool>>;
	emitQueueUpdate: () => Promise<void>;
	markIdle: () => void;
}

/**
 * Short-lived run driver for a single agent run. Absorbs the former agent loop
 * plus the harness executeTurn/handleAgentEvent/emitRunFailure logic, without
 * the AgentLoopParams callback layer.
 */
export class TurnRunner<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	private activeTurnState: TurnState<TSkill, TPromptTemplate, TTool>;

	constructor(private readonly deps: TurnRunnerDeps<TSkill, TPromptTemplate, TTool>) {
		this.activeTurnState = deps.turnState;
	}

	async run(prompts: AgentMessage[], context: AgentContext): Promise<AgentMessage[]> {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};
		try {
			await this.handleAgentEvent({ type: "agent_start" });
			await this.handleAgentEvent({ type: "turn_start" });
			for (const prompt of prompts) {
				await this.handleAgentEvent({ type: "message_start", message: prompt });
				await this.handleAgentEvent({ type: "message_end", message: prompt });
			}
			await this.runLoop(currentContext, newMessages);
			return newMessages;
		} catch (error) {
			try {
				return await this.emitRunFailure(this.activeTurnState.model, error, this.deps.signal.aborted);
			} catch (failureError) {
				const cause = new AggregateError(
					[toError(error), toError(failureError)],
					"Agent run failed and failure reporting failed",
				);
				throw new AgentHarnessError("unknown", cause.message, cause);
			}
		}
	}

	private async runLoop(initialContext: AgentContext, newMessages: AgentMessage[]): Promise<void> {
		let currentContext = initialContext;
		let model: Model<any> = this.activeTurnState.model;
		let reasoning: SimpleStreamOptions["reasoning"] =
			this.activeTurnState.thinkingLevel === "off" ? undefined : this.activeTurnState.thinkingLevel;
		let firstTurn = true;
		let pendingMessages: AgentMessage[] = await this.deps.queues.drainSteer(
			this.deps.steeringMode,
			this.deps.emitQueueUpdate,
		);

		while (true) {
			let hasMoreToolCalls = true;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (!firstTurn) {
					await this.handleAgentEvent({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						await this.handleAgentEvent({ type: "message_start", message });
						await this.handleAgentEvent({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				const message = await this.streamAssistant(currentContext, model, reasoning);
				newMessages.push(message);

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					await this.handleAgentEvent({ type: "turn_end", message, toolResults: [] });
					await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
					return;
				}

				const toolCalls = message.content.filter((c) => c.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				hasMoreToolCalls = false;
				if (toolCalls.length > 0) {
					const executedToolBatch = await executeToolCalls(
						currentContext,
						message,
						undefined,
						this.deps.signal,
						(event) => this.handleAgentEvent(event),
						this.deps.events.emitHook.bind(this.deps.events),
					);
					toolResults.push(...executedToolBatch.messages);
					hasMoreToolCalls = !executedToolBatch.terminate;
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await this.handleAgentEvent({ type: "turn_end", message, toolResults });

				// prepareNextTurn inlined: flush writes enqueued during save_point
				// subscribers, then refresh the snapshot for the next request.
				await this.deps.sessionWriter.flush();
				this.activeTurnState = await this.deps.refreshTurnState();
				currentContext = buildContext(this.activeTurnState);
				model = this.activeTurnState.model;
				reasoning =
					this.activeTurnState.thinkingLevel === "off" ? undefined : this.activeTurnState.thinkingLevel;

				pendingMessages = await this.deps.queues.drainSteer(this.deps.steeringMode, this.deps.emitQueueUpdate);
			}

			const followUpMessages = await this.deps.queues.drainFollowUp(
				this.deps.followUpMode,
				this.deps.emitQueueUpdate,
			);
			if (followUpMessages.length > 0) {
				pendingMessages = followUpMessages;
				continue;
			}
			break;
		}

		await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
	}

	private async streamAssistant(
		context: AgentContext,
		model: Model<any>,
		reasoning: SimpleStreamOptions["reasoning"],
	): Promise<AssistantMessage> {
		let messages = context.messages;
		const contextResult = await this.deps.events.emitHook({ type: "context", messages: [...messages] });
		if (contextResult?.messages) {
			messages = contextResult.messages;
		}

		const llmMessages = convertToLlm(messages);
		const llmContext: Context = {
			systemPrompt: context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};

		const turnState = this.activeTurnState;
		const snapshotOptions: AgentHarnessStreamOptions = { ...turnState.streamOptions };
		const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);

		const response = await this.deps.models.streamSimple(model, llmContext, {
			cacheRetention: requestOptions.cacheRetention,
			headers: requestOptions.headers,
			maxRetries: requestOptions.maxRetries,
			maxRetryDelayMs: requestOptions.maxRetryDelayMs,
			metadata: requestOptions.metadata,
			onPayload: async (payload) => await this.deps.events.emitBeforeProviderPayload(model, payload),
			onResponse: async (providerResponse) => {
				const headers = { ...(providerResponse.headers as Record<string, string>) };
				await this.deps.events.emit(
					{ type: "after_provider_response", status: providerResponse.status, headers },
					this.deps.signal,
				);
			},
			reasoning,
			signal: this.deps.signal,
			sessionId: turnState.sessionId,
			timeoutMs: requestOptions.timeoutMs,
			transport: requestOptions.transport,
		});

		let partialMessage: AssistantMessage | null = null;
		let addedPartial = false;

		for await (const event of response) {
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await this.handleAgentEvent({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await this.handleAgentEvent({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "done":
				case "error": {
					const finalMessage = await response.result();
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage;
					} else {
						context.messages.push(finalMessage);
					}
					if (!addedPartial) {
						await this.handleAgentEvent({ type: "message_start", message: { ...finalMessage } });
					}
					await this.handleAgentEvent({ type: "message_end", message: finalMessage });
					return finalMessage;
				}
			}
		}

		const finalMessage = await response.result();
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await this.handleAgentEvent({ type: "message_start", message: { ...finalMessage } });
		}
		await this.handleAgentEvent({ type: "message_end", message: finalMessage });
		return finalMessage;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.deps.events.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async handleAgentEvent(event: AgentRunEvent): Promise<void> {
		const signal = this.deps.signal;
		if (event.type === "message_end") {
			await this.deps.session.appendMessage(event.message);
			await this.deps.events.emit(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.deps.events.emit(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.deps.sessionWriter.hasPending();
			await this.deps.sessionWriter.flush();
			if (eventError) throw eventError;
			await this.deps.events.emit({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			await this.deps.sessionWriter.flush();
			this.deps.markIdle();
			await this.deps.events.emit(event, signal);
			await this.deps.events.emit(
				{ type: "settled", nextTurnCount: this.deps.queues.snapshot().nextTurn.length },
				signal,
			);
			return;
		}
		await this.deps.events.emit(event, signal);
	}

	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage });
		await this.handleAgentEvent({ type: "message_end", message: failureMessage });
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] });
		return [failureMessage];
	}
}
```

> 关键核对点：
> - `handleAgentEvent` 逐字对应 agent-harness.ts:302-329，仅把 `this.session`→`deps.session`、`this.flushPendingSessionWrites`→`deps.sessionWriter.flush`、`this.pendingSessionWrites.length>0`→`deps.sessionWriter.hasPending()`、`this.phase="idle"`→`deps.markIdle()`、`this.nextTurnQueue.length`→`deps.queues.snapshot().nextTurn.length`、`this.events`→`deps.events`。
> - `streamAssistant` 的事件循环逐字对应 agent-loop.ts:283-337，仅把 `emit(...)`→`this.handleAgentEvent(...)`；provider 调用段并入原 `createStreamFn`（agent-harness.ts:357-382）。删除了 agent-loop.ts:267-272 的 `streamFunction`/`getApiKey`/`resolvedApiKey` 死代码（不变量 §9）。
> - `runLoop` 对应 agent-loop.ts:107-235，删除 `shouldStopAfterTurn` 分支（不变量 §8），`prepareNextTurn` 内联为 flush+refresh+重建 context/model/reasoning。

- [ ] **Step 2: 让 agent-harness.ts 的 executeTurn 改用 TurnRunner，删除已迁移的方法**

在 `src/core/agent-harness.ts`（此步只做能让它编译的最小改动；门面彻底瘦身在 Task 8）：

1. 把 import `import { type AgentLoopParams, runAgentLoop } from "./agent-loop.ts";` 改为：
   ```ts
   import { TurnRunner } from "./turn-runner.ts";
   ```
2. 删除方法：`createContext`（若 Task 4 已删则跳过）、`createStreamFn`、`createLoopParams`、`emitBeforeProviderRequest`、`handleAgentEvent`、`emitRunFailure`。
3. 把 `executeTurn` 主体替换为（保留其签名与 nextTurn/before_agent_start 前处理逻辑）：

```ts
private async executeTurn(
	turnState: TurnState<TSkill, TPromptTemplate, TTool>,
	text: string,
	options?: { images?: ImageContent[] },
): Promise<AssistantMessage> {
	let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
	const queued = await this.queues.takeNextTurn(() => this.emitQueueUpdate());
	if (queued.length > 0) {
		messages = [...queued, messages[0]!];
	}
	const beforeResult = await this.events.emitHook({
		type: "before_agent_start",
		prompt: text,
		images: options?.images,
		systemPrompt: turnState.systemPrompt,
		resources: turnState.resources,
	});
	if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

	const abortController = new AbortController();
	this.runAbortController = abortController;
	const runner = new TurnRunner<TSkill, TPromptTemplate, TTool>({
		session: this.session,
		models: this.models,
		events: this.events,
		queues: this.queues,
		sessionWriter: this.sessionWriter,
		signal: abortController.signal,
		steeringMode: this.steeringQueueMode,
		followUpMode: this.followUpQueueMode,
		turnState,
		refreshTurnState: () => this.buildTurnStateFromConfig(),
		emitQueueUpdate: () => this.emitQueueUpdate(),
		markIdle: () => {
			this.phase = "idle";
		},
	});
	try {
		const newMessages = await runner.run(messages, buildContext(turnState, beforeResult?.systemPrompt));
		for (let i = newMessages.length - 1; i >= 0; i--) {
			const message = newMessages[i]!;
			if (message.role === "assistant") {
				return message;
			}
		}
		throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
	} finally {
		try {
			await this.sessionWriter.flush();
		} finally {
			this.runAbortController = undefined;
		}
	}
}
```

4. 删除现在未使用的 import：`convertToLlm`（若曾引入）、`AgentContext`/`StreamFn`（若仅被已删方法使用则移除，注意 `buildContext` 的返回类型不需要门面再显式 import `AgentContext`）。用 `npm run build` 的报错逐个清理未使用 import。

- [ ] **Step 3: 删除 agent-loop.ts**

```bash
cd "packages/agent-harness"
git rm src/core/agent-loop.ts
```

> 确认无其他引用：`agent-loop.ts` 此前唯一 importer 是 agent-harness.ts（已在 Step 2 改掉）。

- [ ] **Step 4: 类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。若报 `AgentLoopParams`/`runAgentLoop`/未使用 import 相关错误，回到 Step 2 清理。

- [ ] **Step 5: 逐条核对行为不变量**

对照本计划顶部"行为不变量 §1–§9"，逐条在 `turn-runner.ts` 中确认：事件序列、turn_end 时序、save point 二次 flush、agent_end 的 phase 时序、失败分支、drain 回滚、无 shouldStopAfterTurn、死代码已删。

- [ ] **Step 6: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: merge agent loop into TurnRunner run driver

Fold runAgentLoop/runLoop/streamAssistantResponse and the harness
executeTurn/handleAgentEvent/emitRunFailure/createStreamFn logic into a
short-lived TurnRunner, eliminating the AgentLoopParams callback layer.
Delete agent-loop.ts and the never-used shouldStopAfterTurn/getApiKey
dead code. Behavior (event sequence, save points, failure reporting)
preserved.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 门面收尾（清理残留 + 整理 + 最终自检）

`agent-harness.ts` 此时功能已正确，本步做最后的字段/import 清理与结构整理，并跑最终自检。

**Files:**
- Modify: `src/core/agent-harness.ts`

- [ ] **Step 1: 核对门面只剩应有内容**

用 Read 通读 `src/core/agent-harness.ts`，确认：

- **保留字段**：`env` / `session` / `models` / `resources` / `streamOptions` / `systemPrompt` / `tools`(Map) / `model` / `thinkingLevel` / `activeToolNames` / `steeringQueueMode` / `followUpQueueMode` / `phase` / `runAbortController` / `runPromise` / `events` / `sessionWriter` / `queues`。
- **已删字段**：`pendingSessionWrites` / `steerQueue` / `followUpQueue` / `nextTurnQueue`（Task 5/6 删）。
- **保留方法**：`validateUniqueNames` / `validateToolNames` / `buildTurnStateFromConfig` / `emitQueueUpdate` / `executeTurn` / `startRunPromise` / `prompt` / `skill` / `promptFromTemplate` / `steer` / `followUp` / `nextTurn` / 所有 getter/setter / `abort` / `waitForIdle` / `subscribe` / `on`。
- **已删方法**：`createTurnState` / `createContext` / `flushPendingSessionWrites` / `drainQueuedMessages` / `createStreamFn` / `createLoopParams` / `emitBeforeProviderRequest` / `handleAgentEvent` / `emitRunFailure`（分散在 Task 4–7 删）。
- **已删本地函数**：`createUserMessage` / `createFailureMessage` / `cloneStreamOptions` / `applyStreamOptionsPatch`（Task 2/3 删；`findDuplicateNames` 仍保留在门面，供 `validateUniqueNames` 用）。
- **已删 interface**：`AgentHarnessTurnState`（Task 4 删）。

- [ ] **Step 2: 清理未使用 import**

跑 `npm run build`，若开启了未使用检测则按报错删；否则人工核对顶部 import，删除不再被引用的符号。预期仍需要的 import 至少含：`AssistantMessage`/`ImageContent`/`Model`/`Models`/`UserMessage`（`@loopiq/ai`）、事件与 options 类型、`AgentHarnessResources`/`AgentTool`/`PromptTemplate`/`Skill`、`ExecutionEnv`、`AgentMessage`、`AbortResult`/`Session`、`AgentHarnessError`/`normalizeHarnessError`/`toError`（注意 `normalizeHookError` 若门面已不再直接用则删）、`TurnRunner`、`buildContext`/`buildTurnState`/`TurnState`、`createUserMessage`/`createFailureMessage`（`createFailureMessage` 若门面已不用则删——它已移入 TurnRunner）、`cloneStreamOptions`（`setStreamOptions`/`getStreamOptions`/构造函数仍用）、`SessionWriter`、`MessageQueues`、`formatSkillInvocation`、`formatPromptTemplateInvocation`。

> 具体保留集以 `npm run build` 为准：任何"declared but never read"报错即删该 import。

- [ ] **Step 3: 最终类型检查**

Run: `cd "packages/agent-harness" && npm run build`
Expected: 退出 0，无输出。

- [ ] **Step 4: 全量回归自检（对照 spec 覆盖 + 不变量）**

逐条确认：

1. 公开 API 未变：`prompt`/`skill`/`promptFromTemplate`/`steer`/`followUp`/`nextTurn`/`getModel`/`setModel`/`getThinkingLevel`/`setThinkingLevel`/`getTools`/`getActiveTools`/`getSteeringMode`/`setSteeringMode`/`getFollowUpMode`/`setFollowUpMode`/`getResources`/`getStreamOptions`/`setStreamOptions`/`abort`/`waitForIdle`/`subscribe`/`on` 签名与改前一致。
2. 目录结构符合 spec §4：新增 `core/turn-runner.ts`、`core/stream-options.ts`、`core/message-factory.ts`、`core/turn-state.ts`、`session/session-writer.ts`、`queue/message-queues.ts`；`core/tool-execution.ts` 已更名；`core/agent-loop.ts` 已删。
3. 行为不变量 §1–§9 全部保持（重点复核 turn-runner.ts）。
4. `agent-harness.ts` 行数落在 spec §10 预估（约 280–340 行）范围附近（非硬性，仅粗核）。

- [ ] **Step 5: Commit**

```bash
cd "packages/agent-harness"
git add -A
git commit -m "$(cat <<'EOF'
refactor: slim AgentHarness facade to config + orchestration

Facade now holds only runtime-config fields plus the MessageQueues /
SessionWriter / EventBus collaborators and forwards to TurnRunner. Public
API unchanged.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review（本计划对照 spec 的检查结果）

**1. Spec 覆盖**：
- spec §5.1 MessageQueues → Task 6 ✅
- spec §5.2 SessionWriter → Task 5 ✅
- spec §5.3 turn-state → Task 4 ✅
- spec §5.4 stream-options → Task 3 ✅
- spec §5.5 message-factory → Task 2 ✅
- spec §5.6 TurnRunner → Task 7 ✅
- spec §5.7 门面 → Task 8（+ 4–7 增量）✅
- spec §4 目录/更名（tool-execution）→ Task 1 ✅
- spec §9 emitQueueUpdate/emitBeforeProviderRequest 归属 → Task 6/7 已定（emitQueueUpdate 门面持有、以闭包传入；emitBeforeProviderRequest 移入 TurnRunner，规划期收紧，已注明）✅

**2. 占位符扫描**：无 TBD/TODO/"稍后实现"；每个改代码的步骤均给出完整代码或精确到行的搬运指令。

**3. 类型一致性**：`TurnState`（非旧名 `AgentHarnessTurnState`）在 turn-state.ts 定义、turn-runner.ts 与门面统一引用；`buildTurnState`/`buildContext`/`SessionWriter.{enqueue,hasPending,flush}`/`MessageQueues.{enqueueSteer,enqueueFollowUp,enqueueNextTurn,drainSteer,drainFollowUp,takeNextTurn,clearForAbort,snapshot}`/`TurnRunner.run` 在定义与调用处签名一致。

**偏差记录**：spec §9 原定 `emitBeforeProviderRequest` 由门面注入 TurnRunner；规划期改为移入 TurnRunner（它只依赖 `events` + stream-options 纯函数），少一个注入闭包。功能等价，已在 Task 7 注明。
