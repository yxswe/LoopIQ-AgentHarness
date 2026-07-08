# 设计：AgentHarness 重构（方案 C — 混合分层）

日期：2026-07-08
状态：已确认（方案 C）

## 1. 背景与目标

`packages/agent-harness/src/core/agent-harness.ts`（699 行）当前把 8 类职责混在一个类里：

1. 运行时配置持有（model / thinkingLevel / tools / activeToolNames / resources / streamOptions / queueMode）
2. 每轮快照物化（`createTurnState` / `createContext`）
3. session 写队列（`pendingSessionWrites` + `flushPendingSessionWrites` 的大 if-else）
4. steer / followUp / nextTurn 三消息队列 + drain
5. 运行驱动（`executeTurn` / `createLoopParams` / `createStreamFn` / `handleAgentEvent` / `emitRunFailure`）
6. stream options 变换（`cloneStreamOptions` / `applyStreamOptionsPatch` / provider hook 接线）
7. 消息工厂（`createUserMessage` / `createFailureMessage`）
8. 公开 API 门面（`prompt` / `skill` / `steer` / getter/setter / `subscribe` / `on`）

同时 `agent-loop.ts` 通过 `AgentLoopParams` 回调层（`prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages`）与 harness 运行时状态耦合，绕一圈回调。

**目标**：合并 loop 运行驱动进 harness，消除中间回调层，再按"状态生命周期"重新切出职责单一的模块，让结构与功能更清晰。

## 2. 约束（硬性）

- **公开 API 不变**：`AgentHarness` 类所有公开方法签名保持不变。仅内部职责重排。
- **无测试安全网**：靠 `tsgo` 类型检查 + 手工冒烟。因此每一步必须可独立编译。
- 所有沟通用中文（项目约定）。

## 3. 划分准则（统一）

| 判据 | 处理方式 |
|------|---------|
| 有独立、长期的可变状态 | → 有状态对象 |
| 只在一次运行内存在 | → 短命对象 |
| 无状态、纯输入输出变换 | → 纯函数模块 |
| 是 harness "最新配置"的身份 | → 留在门面当字段 |

**与方案 A 的唯一本质差异**：运行时配置不对象化，继续留在门面。门面是"配置持有者 + 编排者"，`TurnRunner` 因此不认识配置对象，协作面更窄。

## 4. 目标目录结构

```
src/core/
  agent-harness.ts      # 门面（~280–340 行）：持有配置字段 + 编排 + 转发
  turn-runner.ts        # 【新】运行驱动（合并 loop + executeTurn 全家桶）
  event-bus.ts          # 已存在，不动
  tool-execution.ts     # 已存在（顺手修正拼写 tool-execuation → tool-execution）
  stream-options.ts     # 【新】纯函数：cloneStreamOptions / applyStreamOptionsPatch
  message-factory.ts    # 【新】纯函数：createUserMessage / createFailureMessage
  turn-state.ts         # 【新】TurnState 类型 + buildTurnState() + buildContext() 纯函数
src/session/
  session-writer.ts     # 【新】pending 写队列 + flush 分发
src/queue/
  message-queues.ts     # 【新】steer/followUp/nextTurn 三队列 + drain
```

## 5. 模块清单（职责 / 状态 / 接口）

### 5.1 `MessageQueues`（有状态，长期）

管理 steer / followUp / nextTurn 三队列。当前分散在门面的 `steerQueue` / `followUpQueue` / `nextTurnQueue` 字段 + `drainQueuedMessages` + `executeTurn` 里的 nextTurn splice 逻辑归入此处。

```ts
class MessageQueues {
  enqueueSteer(msg: UserMessage): void;
  enqueueFollowUp(msg: UserMessage): void;
  enqueueNextTurn(msg: AgentMessage): void;
  drainSteer(mode: QueueMode): AgentMessage[];    // splice + 失败回滚 unshift
  drainFollowUp(mode: QueueMode): AgentMessage[];
  takeNextTurn(): AgentMessage[];                  // splice(0) + 失败回滚
  clearForAbort(): { clearedSteer: UserMessage[]; clearedFollowUp: UserMessage[] };
  snapshot(): { steer: UserMessage[]; followUp: UserMessage[]; nextTurn: AgentMessage[] };
}
```

**已定决策**：`MessageQueues` **不持有 EventBus**，保持纯队列语义。`drainSteer` / `drainFollowUp` / `takeNextTurn` 只负责 splice；`emitQueueUpdate` 由调用方（门面或 TurnRunner）在 drain 后调用。为保持"drain → emit 失败则回滚"的原子性（现 `drainQueuedMessages` 先 splice、emit 失败则 unshift 回滚），drain 方法接收一个 `onDrained?: () => Promise<void>` 回调，在内部 splice 后调用它，失败则回滚并重抛。这样回滚逻辑仍封装在 `MessageQueues` 内，而 emit 具体实现留在门面。

### 5.2 `SessionWriter`（有状态，长期）

封装 `pendingSessionWrites` 数组 + `flushPendingSessionWrites` 的类型分发大 if-else。

```ts
class SessionWriter {
  constructor(session: Session);
  enqueue(write: PendingSessionWrite): void;
  hasPending(): boolean;
  flush(): Promise<void>;       // 逐条 shift 分发到 session.appendXxx
  setSession(session: Session): void;   // 若 session 可替换则需要；否则省略
}
```

flush 的分发逻辑（message / model_change / thinking_level_change / active_tools_change / custom / custom_message / label / session_info / leaf）原样搬入。

### 5.3 `turn-state.ts`（纯函数 + 类型）

把 `AgentHarnessTurnState` 类型、`createTurnState` 的物化逻辑、`createContext` 改为纯函数。

```ts
export interface TurnState<TSkill, TPromptTemplate, TTool> {
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

export async function buildTurnState(deps: {
  session: Session;
  env: ExecutionEnv;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: Map<string, TTool>;
  activeToolNames: string[];
  resources: AgentHarnessResources<TSkill, TPromptTemplate>;
  streamOptions: AgentHarnessStreamOptions;
  systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
}): Promise<TurnState<...>>;

export function buildContext(turnState: TurnState<...>, systemPromptOverride?: string): AgentContext;
```

`buildTurnState` 内部：`session.buildContext()` / `session.getMetadata()` / activeTools 解析 / systemPrompt 解析（string | callback）/ `cloneStreamOptions` —— 原样搬入，只是从读 `this.*` 改为读 `deps.*`。

### 5.4 `stream-options.ts`（纯函数）

`cloneStreamOptions` / `applyStreamOptionsPatch` 原样搬入（当前是文件级私有函数）。

### 5.5 `message-factory.ts`（纯函数）

`createUserMessage` / `createFailureMessage` 原样搬入。

### 5.6 `TurnRunner`（有状态，短命）

**吸收**：合并后的 `runLoop` / `streamAssistantResponse`（来自 agent-loop.ts）+ `executeTurn` / `createStreamFn` / `handleAgentEvent` / `emitRunFailure` / `createContext`（来自 harness）。消除 `AgentLoopParams` 回调层：save-point 刷新、队列 drain、prepareNextTurn 直接在循环体内调用。

```ts
class TurnRunner<TSkill, TPromptTemplate, TTool> {
  constructor(deps: {
    queues: MessageQueues;
    sessionWriter: SessionWriter;
    events: AgentEventBus<TSkill, TPromptTemplate>;
    models: Models;
    signal: AbortSignal;
    steeringMode: QueueMode;
    followUpMode: QueueMode;
    turnState: TurnState<...>;
    refreshTurnState: () => Promise<TurnState<...>>;   // 门面用当前配置重建快照
    emitQueueUpdate: () => Promise<void>;              // drain 后通知（避免 queues 依赖 events）
  });
  run(prompts: AgentMessage[], context: AgentContext): Promise<AgentMessage[]>;
}
```

**关键特征**：`TurnRunner` 不认识运行时配置，只认识"当前 `turnState` + `refreshTurnState` 闭包"。协作面 = `queues + sessionWriter + events` 三者。

循环体内在 save point（turn_end 后）：
1. `events.emit(turn_end)`（捕获错误延后抛）
2. `hadPendingMutations = sessionWriter.hasPending()` → `sessionWriter.flush()`
3. 若 turn_end emit 出错，抛出
4. `events.emit(save_point, hadPendingMutations)`
5. `refreshTurnState()` 重建快照供下一轮
6. `queues.drainSteer(mode)` / `drainFollowUp(mode)`

`handleAgentEvent` 的 message_end→appendMessage、agent_end→flush+phase=idle+settled 逻辑，需要与门面协调 `phase`。方案：`agent_end` 时把"置 idle"交回门面（run() 结束后门面设 phase），或 TurnRunner 通过回调通知门面。实现细节在 plan 阶段定，倾向 run() 正常返回后由门面 finally 复位 phase，agent_end 只 emit。

### 5.7 门面 `AgentHarness`（中等厚度）

保留：
- 配置字段：`model` / `thinkingLevel` / `tools` (Map) / `activeToolNames` / `resources` / `streamOptions` / `steeringQueueMode` / `followUpQueueMode` / `systemPrompt` / `env` / `session` / `models`
- 协作对象：`queues = new MessageQueues()` / `sessionWriter = new SessionWriter(session)` / `events = new AgentEventBus()`
- 运行状态：`phase` / `runAbortController` / `runPromise`
- 校验：`validateUniqueNames` / `validateToolNames`（构造期）
- 编排方法：`prompt` / `skill` / `promptFromTemplate`（各自 `createTurnState` → `new TurnRunner` → run → 提取最后 assistant message）
- 队列入口：`steer` / `followUp` / `nextTurn`（转发到 `queues` + `emitQueueUpdate`）
- getter/setter：直接操作门面字段（`getModel`/`setModel` 等）。setter 里 phase 判定：idle 时 `session.appendXxx`，非 idle 时 `sessionWriter.enqueue`
- `abort` / `waitForIdle` / `subscribe` / `on`
- `buildTurnStateFromConfig()` 私有：调 `buildTurnState({ session, env, model: this.model, ... })`
- `emitQueueUpdate()` 私有：读 `queues.snapshot()` → `events.emit(queue_update)`
- `emitBeforeProviderRequest`：provider hook 接线，供 TurnRunner 的 streamFn 使用（可注入或留门面由 runner 回调）

## 6. 一次 `prompt` 的数据流

```
harness.prompt(text)
  → phase 检查 → phase = "turn" → startRunPromise()
  → turnState = buildTurnStateFromConfig()          # buildTurnState 纯函数物化快照
  → runner = new TurnRunner({ queues, sessionWriter, events, models, signal,
                              turnState, refreshTurnState: () => buildTurnStateFromConfig(),
                              emitQueueUpdate })
  → messages = [createUserMessage(text)] (+ queues.takeNextTurn() + before_agent_start hook)
  → runner.run(messages, buildContext(turnState)):
      循环体内：
        streamAssistantResponse(turnState.model, ...)   # 合并自 loop
        executeToolCalls(...)                           # 复用 tool-execution
        save point → sessionWriter.flush() + refreshTurnState()
        drain → queues.drainSteer/FollowUp() + emitQueueUpdate()
        handleAgentEvent → session.appendMessage + events.emit
  → 门面提取最后一条 assistant message
  → finally: phase = "idle"（正常路径）/ flush pending / 清 runAbortController / finishRunPromise
```

## 7. 依赖拓扑

```
AgentHarness(门面) ── 持有配置字段 + MessageQueues + SessionWriter + EventBus
       │ buildTurnState(纯函数) 物化快照
       │ 每次运行 new
       └──> TurnRunner ──依赖──> MessageQueues + SessionWriter + EventBus
                                 + (turnState + refreshTurnState 闭包 + emitQueueUpdate 闭包)
纯函数模块 turn-state / stream-options / message-factory：门面与 TurnRunner 按需 import
```

## 8. 增量落地顺序（每步可独立编译 + 冒烟）

1. 抽纯函数 `message-factory.ts` / `stream-options.ts`（零风险，纯搬运 + import）。
2. 抽 `turn-state.ts`（`createTurnState`/`createContext` 变纯函数，门面调用它）。
3. 抽 `SessionWriter`（自成一体，门面用它替代 `pendingSessionWrites` + `flushPendingSessionWrites`）。
4. 抽 `MessageQueues`（自成一体，门面用它替代三个 queue 字段 + drain）。
5. 合并 loop + 抽 `TurnRunner`（注入 turnState + refreshTurnState 闭包）——**最大一步，只碰运行驱动**。
6. 门面清理：只留配置字段 + 协作对象 + 转发。
7. 顺手把 `tool-execuation.ts` 更名 `tool-execution.ts`，同步 import。

每步后 `tsgo` 编译 + 手工冒烟，中间态始终可运行，不需要"一把梭"。

## 9. 风险与权衡

- 门面仍持有约 8 个配置字段，比"空壳门面"厚 —— 换来协作简单、贴合"API 不变"。
- 配置读写逻辑分散在门面各 setter，未来做"配置持久化/模型注册表"改动点较分散（可接受）。
- `refreshTurnState` 闭包捕获门面 `this`，需确保 save-point 读到的是"最新配置"（这正是正确语义）。
- `emitQueueUpdate` / `emitBeforeProviderRequest` 的归属**已定**：均留在门面（门面持有 EventBus），以回调闭包注入 `TurnRunner`（`emitQueueUpdate` 供 drain 后通知，`emitBeforeProviderRequest` 供 streamFn 组装 provider 请求）。`MessageQueues` 不反向依赖 EventBus。
- 无测试下最大风险点是第 5 步（合并 loop）。缓解：严格保持 emit 事件序列（agent_start / turn_start / message_start/update/end / turn_end / save_point / agent_end / settled）与错误/abort 分支不变。

## 10. 预估结果

- `agent-harness.ts`：699 → 约 280–340 行。
- 新增 5 个文件（`turn-runner` / `turn-state` / `stream-options` / `message-factory` / `session-writer` / `message-queues` 中，除已存在的外）。
- 删除 `agent-loop.ts` 的独立存在（其 `runLoop` / `streamAssistantResponse` 并入 `turn-runner.ts`；`AgentLoopParams` 回调层消除）。

## 附：不改动的部分

- `event-bus.ts`：不动。
- `tool-execuation.ts`：仅更名 + 修 import，逻辑不动。
- `base/options.ts` 类型：`AgentContext` / `AgentHarnessStreamOptions` 等保持；`AgentLoopTurnUpdate` / `PrepareNextTurnContext` / `ShouldStopAfterTurnContext` 随回调层消除可能变为内部或删除（plan 阶段确认）。
