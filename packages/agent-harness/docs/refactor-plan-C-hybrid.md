# 重构方案 C：混合分层（Hybrid — 按状态生命周期划分）

## 0. 共同前提（A、C 相同）

- **先合并 loop**：把 `core/agent-loop.ts` 的 `runAgentLoop` / `runAgentLoopContinue` / `runLoop` / `streamAssistantResponse`，与 `core/agent-harness.ts` 的 `executeTurn` / `createLoopParams` / `createContext` / `createStreamFn` / `handleAgentEvent` / `emitRunFailure` / `emitBeforeProviderRequest` 视为同一坨"运行驱动"，**消除中间的 `AgentLoopParams` 回调层**（`prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages` 不再绕一圈回调，直接在循环体内调用）。
- **公开 API 不变**：`AgentHarness` 类的公开方法签名全部保持不变（同 A）。
- **无测试安全网**：靠 `tsgo` 类型检查 + 手工冒烟。

## 1. 方案核心思想

用**一条统一准则**切分，而不是把所有东西都对象化：

| 判据 | 处理方式 |
|------|---------|
| 有独立、长期的可变状态 | → 拆成**有状态对象** |
| 只在一次运行内存在 | → 拆成**短命对象** |
| 无状态、纯输入输出变换 | → 拆成**纯函数模块** |
| 是 harness "最新配置"的身份 | → **留在门面当字段** |

与 A 的**唯一本质差异**：**运行时配置（model/thinking/tools/resources/streamOptions/queueMode）不对象化，继续留在门面**。因此门面不是空壳，而是"配置持有者 + 编排者"；`TurnRunner` 的协作面因此更窄。

## 2. 目标目录结构

```
src/core/
  agent-harness.ts      # 门面（中等）：持有配置字段 + 编排 + 转发；含 createTurnState
  turn-runner.ts        # 【新】运行驱动（合并 loop + executeTurn 全家桶）
  event-bus.ts          # 已存在，不动
  tool-execution.ts     # 已存在（顺手修正拼写）
  stream-options.ts     # 【新】纯函数：clone / applyPatch / 组装 provider 请求参数
  message-factory.ts    # 【新】纯函数：createUserMessage / createFailureMessage
  turn-state.ts         # 【新】纯函数 + 类型：TurnState 类型 + buildTurnState() + buildContext()
src/session/
  session-writer.ts     # 【新】pending 写队列 + flush 分发
src/queue/
  message-queues.ts     # 【新】steer/followUp/nextTurn 三队列 + drain
```

> 对照 A：**没有 `runtime/runtime-config.ts`**。配置留在门面；快照构建从"配置对象的方法"降为"纯函数 `buildTurnState(deps)`"。

## 3. 模块清单（职责 / 状态 / 接口）

### 3.1 `MessageQueues`（有状态，长期）— 同 A

```ts
class MessageQueues {
  enqueueSteer / enqueueFollowUp / enqueueNextTurn(msg): void;
  drainSteer(mode) / drainFollowUp(mode): AgentMessage[];
  takeNextTurn(): AgentMessage[];
  clearForAbort(): { clearedSteer; clearedFollowUp };
  snapshot(): { steer; followUp; nextTurn };
}
```

### 3.2 `SessionWriter`（有状态，长期）— 同 A

```ts
class SessionWriter {
  constructor(session: Session);
  enqueue(write: PendingSessionWrite): void;
  hasPending(): boolean;
  flush(): Promise<void>;
}
```

### 3.3 `TurnRunner`（有状态，短命）— 依赖面比 A 窄

**吸收**：合并后的 `runLoop` / `streamAssistantResponse` + `executeTurn` / `createStreamFn` / `handleAgentEvent` / `emitRunFailure`。save-point 刷新与队列 drain 在循环体内直接做。

```ts
class TurnRunner {
  constructor(deps: {
    queues: MessageQueues;
    sessionWriter: SessionWriter;
    events: AgentEventBus;
    models: Models;
    signal: AbortSignal;
    // 配置以「快照 + 重建函数」形式注入，而非整个 config 对象：
    turnState: TurnState;
    refreshTurnState: () => Promise<TurnState>;   // 门面用当前配置 + buildTurnState 组装
  });
  run(prompts): Promise<AgentMessage[]>;
}
```

**C 方案的关键特征**：`TurnRunner` **不认识 `RuntimeConfig`**，只认识"当前 `turnState` + 一个 `refreshTurnState` 闭包"。配置怎么来的它不关心。协作面 = `queues + sessionWriter + events` 三者，比 A 少一个（配置那一维被"快照+闭包"抹平）。

### 3.4 `turn-state.ts`（纯函数 + 类型）

**吸收**：`AgentHarnessTurnState` 类型、`createTurnState` 的物化逻辑、`createContext`。改为接收依赖、返回快照的纯函数。

```ts
export interface TurnState { messages; resources; streamOptions; sessionId;
  systemPrompt; model; thinkingLevel; tools; activeTools; }

export async function buildTurnState(deps: {
  session; env; model; thinkingLevel; tools; activeToolNames;
  resources; streamOptions; systemPrompt;
}): Promise<TurnState>;

export function buildContext(turnState, systemPromptOverride?): AgentContext;
```

### 3.5 纯函数模块 — 同 A

- `stream-options.ts`：`cloneStreamOptions` / `applyStreamOptionsPatch` / 组装 `models.streamSimple` 参数（含 provider hook 接线）。
- `message-factory.ts`：`createUserMessage` / `createFailureMessage`。

## 4. 门面 `AgentHarness` 剩余内容（中等厚度）

```ts
class AgentHarness {
  // —— 配置字段仍留在门面（与 A 的最大区别）——
  private model; private thinkingLevel; private tools = new Map();
  private activeToolNames; private resources; private streamOptions;
  private steeringQueueMode; private followUpQueueMode;
  // —— 协作对象 ——
  private queues = new MessageQueues();
  private sessionWriter = new SessionWriter(session);
  private events = new AgentEventBus();
  private phase: Phase = "idle";
  private runPromise?: Promise<void>;

  private buildTurnStateFromConfig() {
    return buildTurnState({ session, env, model: this.model, ... });   // 调纯函数
  }

  async prompt(text, opts) {
    if (this.phase !== "idle") throw busy;
    this.phase = "turn";
    const finish = this.startRunPromise();
    try {
      const turnState = await this.buildTurnStateFromConfig();
      const runner = new TurnRunner({
        queues: this.queues, sessionWriter: this.sessionWriter, events: this.events,
        models: this.models, signal,
        turnState,
        refreshTurnState: () => this.buildTurnStateFromConfig(),   // 闭包捕获门面配置
      });
      return await this.runAndExtractAssistant(runner, text, opts);
    } finally { finish(); }
  }

  getModel() { return this.model; }                    // 直接读字段
  async setModel(m) {
    const previous = this.model; this.model = m;        // 直接改字段
    if (this.phase === "idle") await session.appendModelChange(...);
    else this.sessionWriter.enqueue({ type: "model_change", ... });
    await this.events.emit({ type: "model_update", model: m, previousModel: previous, source: "set" });
  }
  // 其余 getter/setter 同理，直接操作门面字段
}
```

## 5. 一次 `prompt` 的数据流

```
harness.prompt
  → buildTurnStateFromConfig()               # 纯函数物化快照（读门面字段）
  → new TurnRunner({ queues, sessionWriter, events, turnState, refreshTurnState })
  → runner.run():
      循环体内：
        streamAssistantResponse(turnState.model, ...)
        executeToolCalls(...)                # 复用 tool-execution
        save point → sessionWriter.flush() + refreshTurnState()   # 闭包重建，不认识 config 对象
        drain → queues.drainSteer/FollowUp()
        handleAgentEvent → session.appendMessage + events.emit
  → 门面提取最后一条 assistant message
```

## 6. 依赖拓扑

```
AgentHarness(门面) ── 持有配置字段 + MessageQueues + SessionWriter + EventBus
       │ buildTurnState(纯函数) 物化快照
       │ 每次运行 new
       └──> TurnRunner ──依赖──> MessageQueues + SessionWriter + EventBus + (turnState + refreshTurnState 闭包)
                                   (3 个对象 + 快照，协作面比 A 窄一维)
纯函数模块 turn-state / stream-options / message-factory：门面与 TurnRunner 按需 import
```

## 7. 优点

- **划分准则统一自然**：读代码时"为什么这块是对象/函数/门面字段"有一致答案。
- **`TurnRunner` 协作面更窄**：只跟 3 个对象 + 快照打交道，配置怎么来的被闭包抹平，save-point 时序更好推理。
- **可增量、可分步冒烟**：每一步都能独立编译通过（见 §9），无测试下更安全。
- **贴合"公开 API 不变"约束**：配置留门面，getter/setter 直接操作字段，几乎零改动。

## 8. 缺点 / 风险

- 门面仍持有约 8 个配置字段，**比 A 的空壳门面"胖"一些**（但换来协作简单）。
- 配置读写逻辑分散在门面各 setter 里，未来若要做"模型注册表/配置持久化"，改动点比 A 分散（A 集中在 `RuntimeConfig`）。
- `refreshTurnState` 闭包捕获门面 `this`，需注意别在闭包里意外读到"过期"字段（但这正是 save-point"读最新配置"的正确语义）。

## 9. 增量落地顺序（每步可独立编译+冒烟）

1. 抽纯函数 `message-factory.ts` / `stream-options.ts`（零风险）。
2. 抽 `turn-state.ts`（把 createTurnState/createContext 变纯函数，门面调用它）。
3. 抽 `SessionWriter`（自成一体）。
4. 抽 `MessageQueues`（自成一体）。
5. 合并 loop + 抽 `TurnRunner`（注入 turnState + refreshTurnState 闭包）——**最大一步，但只碰运行驱动**。
6. 门面清理：只留配置字段 + 协作对象 + 转发。
7. 顺手把 `tool-execuation.ts` 更名 `tool-execution.ts`。

> 相比 A，第 4 步之后配置仍在门面、门面始终可用，**每一步都是可运行的中间态**，不需要"一把梭"。

## 10. 预估结果

- `agent-harness.ts`：699 → 约 280–340 行（配置字段 + setter + 编排）。
- 新增 5 个文件（比 A 少一个 `runtime-config.ts`），单文件职责单一。
- 代价：门面比 A 厚；配置逻辑不如 A 集中。

---

## 附：A vs C 一页速览

| 维度 | 方案 A（全对象化） | 方案 C（混合分层） |
|------|------------------|------------------|
| 运行时配置 | 独立成 `RuntimeConfig` 对象 | 留在门面当字段 |
| 门面厚度 | 极薄（纯转发，~150–200 行） | 中等（配置+编排，~280–340 行） |
| `TurnRunner` 协作面 | 4 个对象（含 config） | 3 个对象 + 快照闭包 |
| 快照构建 | `RuntimeConfig.createTurnState()` 方法 | `buildTurnState()` 纯函数 |
| 新增文件数 | 6 | 5 |
| 增量友好度 | 低（config↔runner 强耦合，倾向一把梭） | 高（每步可独立编译冒烟） |
| 配置逻辑集中度 | 高（都在 RuntimeConfig） | 中（分散在门面 setter） |
| 无测试下的回归风险 | 较高 | 中 |
| 长期"配置扩展"友好度 | 高 | 中 |
| 最适合 | 已有测试、追求极致分层 | 无测试、要稳步推进、贴合当前约束 |
