# 重构方案 A：全状态协作对象（Stateful Collaborators）

## 0. 共同前提（A、C 相同）

- **先合并 loop**：把 `core/agent-loop.ts` 的 `runAgentLoop` / `runAgentLoopContinue` / `runLoop` / `streamAssistantResponse`，与 `core/agent-harness.ts` 的 `executeTurn` / `createLoopParams` / `createContext` / `createStreamFn` / `handleAgentEvent` / `emitRunFailure` / `emitBeforeProviderRequest` 视为同一坨"运行驱动"，**消除中间的 `AgentLoopParams` 回调层**（`prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages` 不再绕一圈回调，直接在循环体内调用协作方）。
- **公开 API 不变**：`AgentHarness` 类的公开方法签名（`prompt` / `skill` / `promptFromTemplate` / `steer` / `followUp` / `nextTurn` / `abort` / `waitForIdle` / `getModel` / `setModel` / `getThinkingLevel` / `setThinkingLevel` / `getTools` / `getActiveTools` / `getResources` / `getStreamOptions` / `setStreamOptions` / `get/setSteeringMode` / `get/setFollowUpMode` / `subscribe` / `on`）全部保持不变。
- **无测试安全网**：当前包内无单测，重构靠 `tsgo` 类型检查 + 手工冒烟。

## 1. 方案核心思想

**几乎所有职责都拆成"有状态的协作对象"**。`AgentHarness` 退化为**极薄门面**，只负责：持有协作对象、把公开方法逐一转发、持有 `phase` 与 `runPromise` 这类顶层生命周期字段。**连运行时配置也独立成 `RuntimeConfig` 对象**。

一句话：把 699 行的 `AgentHarness` 拆成"门面 + 4 个自治对象 + 2 个纯函数模块"。

## 2. 目标目录结构

```
src/core/
  agent-harness.ts      # 门面（薄）：持有协作者、转发公开方法、管 phase/runPromise
  turn-runner.ts        # 【新】运行驱动（合并 loop + executeTurn 全家桶）
  event-bus.ts          # 已存在，不动
  tool-execution.ts     # 已存在（顺手修正拼写 tool-execuation → tool-execution）
src/runtime/
  runtime-config.ts     # 【新】运行时配置对象（含快照构建 createTurnState）
src/session/
  session-writer.ts     # 【新】pending 写队列 + flush 分发 + idle/busy 决策
  session.ts ...        # 已存在，不动
src/queue/
  message-queues.ts     # 【新】steer/followUp/nextTurn 三队列 + drain
src/core/
  stream-options.ts     # 【新】纯函数：clone / applyPatch / 组装 provider 请求参数
  message-factory.ts    # 【新】纯函数：createUserMessage / createFailureMessage
```

## 3. 模块清单（职责 / 状态 / 接口）

### 3.1 `RuntimeConfig`（有状态，长期）

**吸收**：`model` / `thinkingLevel` / `tools` Map / `activeToolNames` / `resources` / `streamOptions` / `steeringQueueMode` / `followUpQueueMode` 全部配置字段；`createTurnState()` 快照构建；`validateUniqueNames` / `validateToolNames` 校验；所有 `get*/set*` 的核心逻辑与 `*_update` 事件触发。

```ts
class RuntimeConfig<TSkill, TPromptTemplate, TTool> {
  // 拥有全部配置状态
  getModel(): Model<any>;
  setModel(model): { previous: Model<any> };      // 仅改内存态，返回旧值供门面发事件/写session
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level): { previous: ThinkingLevel };
  getTools(): TTool[];
  getActiveTools(): TTool[];
  setTools(...) / setActiveTools(...);
  getResources() / setResources(...);
  getStreamOptions() / setStreamOptions(...);
  getSteeringMode() / setSteeringMode() / getFollowUpMode() / setFollowUpMode();
  // 快照：一次 turn 的物化冻结
  createTurnState(deps: { session; env }): Promise<TurnState>;
}
```

> 注意 idle/busy 分支：`setModel` 在 idle 时要写 session、busy 时要塞 pendingWrites。为不让 `RuntimeConfig` 反向依赖 `SessionWriter`，让它**只改内存并返回旧值**，由门面决定"写 session 还是入 pending 队列"。这是 A 方案的一处关键协作约定。

### 3.2 `MessageQueues`（有状态，长期）

**吸收**：`steerQueue` / `followUpQueue` / `nextTurnQueue` + `drainQueuedMessages` + `nextTurn` 的入队 + `abort` 时清空 steer/followUp。

```ts
class MessageQueues {
  enqueueSteer(msg) / enqueueFollowUp(msg) / enqueueNextTurn(msg): void;
  drainSteer(mode): AgentMessage[];      // splice 逻辑，不含 emit
  drainFollowUp(mode): AgentMessage[];
  takeNextTurn(): AgentMessage[];        // splice(0)
  clearForAbort(): { clearedSteer; clearedFollowUp };
  snapshot(): { steer; followUp; nextTurn };  // 供 queue_update 事件
}
```

> `emitQueueUpdate` 留在门面：drain 后由门面广播 `queue_update`，失败回滚由门面 `unshift`。队列对象只管数据，不碰事件总线（避免它依赖 EventBus）。

### 3.3 `SessionWriter`（有状态，长期）

**吸收**：`pendingSessionWrites` 数组 + `flushPendingSessionWrites()` 那段大 if-else 分发。

```ts
class SessionWriter {
  constructor(session: Session);
  enqueue(write: PendingSessionWrite): void;
  hasPending(): boolean;
  flush(): Promise<void>;                 // 逐条 shift + 分发到 session.append*
}
```

### 3.4 `TurnRunner`（有状态，短命——每次运行 new 一个）

**吸收**：合并后的 `runLoop` / `streamAssistantResponse`（来自 loop）+ `executeTurn` / `createContext` / `createStreamFn` / `handleAgentEvent` / `emitRunFailure`。循环体内**直接**做 save-point 刷新与队列 drain（取代原 `AgentLoopParams` 回调）。

```ts
class TurnRunner {
  constructor(deps: {
    config: RuntimeConfig; queues: MessageQueues;
    sessionWriter: SessionWriter; events: AgentEventBus;
    session: Session; models: Models; env: ExecutionEnv;
    signal: AbortSignal;
  });
  run(initialTurnState, prompts): Promise<AgentMessage[]>;
}
```

**A 方案的关键特征**：`TurnRunner` 在循环体里要同时读写 **4 个协作对象**——从 `config` 取新快照（save point）、向 `queues` drain、让 `sessionWriter` flush、经 `events` emit/emitHook。协作面最宽。

### 3.5 纯函数模块（无状态）

- `stream-options.ts`：`cloneStreamOptions` / `applyStreamOptionsPatch` / 组装 `models.streamSimple` 参数。
- `message-factory.ts`：`createUserMessage` / `createFailureMessage`。

## 4. 门面 `AgentHarness` 剩余内容（很薄）

```ts
class AgentHarness {
  private config = new RuntimeConfig(...);
  private queues = new MessageQueues();
  private sessionWriter = new SessionWriter(session);
  private events = new AgentEventBus();
  private phase: Phase = "idle";
  private runPromise?: Promise<void>;

  async prompt(text, opts) {
    if (this.phase !== "idle") throw busy;
    this.phase = "turn";
    const finish = this.startRunPromise();
    try {
      const turnState = await this.config.createTurnState({ session, env });
      const runner = new TurnRunner({ config, queues, sessionWriter, events, ... });
      return await this.runAndExtractAssistant(runner, turnState, text, opts);
    } finally { finish(); }
  }

  getModel() { return this.config.getModel(); }        // 纯转发
  async setModel(m) {
    const { previous } = this.config.setModel(m);
    if (this.phase === "idle") await session.appendModelChange(...);
    else this.sessionWriter.enqueue({ type: "model_change", ... });
    await this.events.emit({ type: "model_update", ... });
  }
  // ...其余 getter/setter 均为 "转发 config + 门面决定 session/pending + 门面发事件"
  subscribe(l) { return this.events.subscribe(l); }
  on(t, h) { return this.events.on(t, h); }
}
```

## 5. 一次 `prompt` 的数据流

```
harness.prompt
  → config.createTurnState()                 # 物化快照
  → new TurnRunner(4个协作对象 + signal)
  → runner.run():
      循环体内：
        streamAssistantResponse(config.model, ...)
        executeToolCalls(...)               # 复用 tool-execution
        save point → sessionWriter.flush() + config.createTurnState()(刷新)
        drain → queues.drainSteer/FollowUp()
        handleAgentEvent → session.appendMessage + events.emit
  → 门面提取最后一条 assistant message
```

## 6. 依赖拓扑

```
AgentHarness(门面) ──持有──> RuntimeConfig, MessageQueues, SessionWriter, EventBus
       │ 每次运行 new
       └──> TurnRunner ──依赖──> RuntimeConfig + MessageQueues + SessionWriter + EventBus + Session/Models
                                   (4 个对象的宽协作面)
纯函数模块 stream-options / message-factory：被 TurnRunner / 门面按需 import
```

## 7. 优点

- **职责分离最彻底**：门面几乎不含逻辑，每个协作对象单一职责、可独立实例化测试。
- **配置集中**：所有配置读写与校验都在 `RuntimeConfig` 一处，未来做"模型注册表""配置持久化"改动只碰一个文件。
- **最贴近教科书式分层**，长期可维护性最高。

## 8. 缺点 / 风险

- **协作协议最复杂**：`TurnRunner` 跨 4 个对象读写，`RuntimeConfig` 的 idle/busy 决策要靠"返回旧值让门面处理"这类约定，容易在 save-point 刷新、abort 屏障处出现细微时序 bug。
- **改动面最大**：一次要新建 4 个对象 + 迁移几乎所有方法体，**在无测试的前提下回归风险最高**。
- **难以增量**：`RuntimeConfig` 和 `TurnRunner` 强耦合，很难只拆一半就编译通过并冒烟，倾向"一把梭"。

## 9. 增量落地顺序（尽量小步）

1. 抽纯函数 `message-factory.ts` / `stream-options.ts`（零风险，先做）。
2. 抽 `SessionWriter`（自成一体，风险低）。
3. 抽 `MessageQueues`（自成一体，风险低）。
4. 抽 `RuntimeConfig`（含 createTurnState + 全部 get/set + 校验）——**大步，需整体冒烟**。
5. 合并 loop + 抽 `TurnRunner`——**最大一步**。
6. 门面收敛为转发层。
7. 顺手把 `tool-execuation.ts` 更名 `tool-execution.ts`。

## 10. 预估结果

- `agent-harness.ts`：699 → 约 150–200 行（纯门面）。
- 新增 6 个文件，单文件都在 200 行内、职责单一。
- 代价：对象间协作协议的设计与调试成本最高。
