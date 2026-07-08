基于 agent-loop.ts 设计完整的 agent harness

## 1 Agent-loop的设计理念 
config 中挂载的钩子
emit 出来的 event 事件















agent 的实例如何 launch 与管理

核心看两组状态的读写维护
1. Session
2. configloop




基础能力设计
1. system prompt 组装。包含：skills。
2. auto-compact 触发。 通过AgentLoopConfig.prepareNextTurn 思考这里能否触发同步与异步
3. 上下文压缩能否被忠实的持久化。
4. turnsnap 到底是要冻结什么内容。新的agent 的读写冲突处理体系因该如何设计



可观测性，需要实时分析看板
1. 详细轨迹
2. latency
3. 失败率
4. token 消耗
5. 一次 agent call 中执行轮次，选择的工具/SKill，工具输出 token 数目，编排效率等



总纲：Harness 是"编排层"，不是"业务层"
文档开篇一句话定了调 (agent-harness.md:3)：

AgentHarness 是底层 agent loop 之上的编排层。它拥有会话持久化、运行时配置、资源解析、操作加锁、以及面向扩展的变更语义。

关键词是 orchestration（编排）。它不做 LLM 调用本身（那是 loop 的事），也不做业务决策（那是应用的事）。它管的是**"围绕一次 run 的一切时序和状态正确性"**。理解全文档，抓住这个定位就不会跑偏。

理念一：把状态切成"活的"和"冻结的"两层
这是整份文档最核心的思想，State model 一节 (agent-harness.md:34-90)。

问题：turn 跑到一半，用户改了 model、加了工具、换了 system prompt——怎么办？如果直接改正在跑的请求，请求会崩;如果不让改，交互体验又差。

解法：区分两种状态。

Harness config（活配置）：model、thinkingLevel、tools、resources... setter 立刻改它，getter 也读它。它永远是"最新意图"。
Turn snapshot（冻结快照）：createTurnState() 在每个 turn 开始时，把活配置拷贝冻结成一份。这一 turn 内所有逻辑只认这份快照。
文档反复强调的那句 (agent-harness.md:52)：

Setter 立即更新 harness config，包括 turn 进行中。改动影响下一个 turn 快照，不影响当前正在跑的 provider 请求。

理念本质：用"快照隔离"把"可变的用户意图"和"不可变的进行中请求"解耦。你想改随时改，但改的是未来，不动现在。

理念二：写入永不丢失——pending writes 队列
Session 和 Pending writes 两节 (agent-harness.md:78-90)。

问题：turn 进行中，扩展想往 session 写东西。但此刻 loop 正在按顺序产出 assistant 消息、工具结果，如果扩展的写入乱插进去，transcript 顺序就乱了。

解法：busy 时的写入不立即落盘，而是排进 pendingSessionWrites 队列，等到安全时机（save point / 结束 / 失败清理）才按确定顺序刷盘。

文档的承诺 (agent-harness.md:88)：

Pending session writes 总是被持久化。它们在 save point、操作结算、失败清理时刷盘。

甚至 abort 都不丢 (agent-harness.md:204)：abort 不丢弃 pending writes，它们在下一个 save point 或结束时照样刷。

理念本质：持久化是"确定性顺序 + 永不丢失"的强承诺。宁可延迟写，也不乱序写、不丢写。

理念三：用显式 phase 状态机做并发控制
Operation phases 一节 (agent-harness.md:92-118)。


type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
设计要点：

结构性操作（prompt/skill/compact/navigateTree）要求 idle，且在第一个 await 之前同步设 phase。这个"同步"是刻意的——防止两个 prompt 在 await 间隙同时进来造成竞态。非 idle 就抛 busy。
turn 中允许的操作（steer/followUp/abort/setter）不需要 idle，它们被设计成能安全地与运行中的 turn 共存。
理念本质：用一个显式枚举 + "同步抢占"把"什么操作在什么时候能做"变成可判定的规则，而不是靠布尔标志和祈祷。文档也诚实承认这块还没定死（agent-harness.md:118 "phase/settlement 语义仍是临时的"）。

理念四：Save point——run 中途的"安全刷新点"
Save points 一节 (agent-harness.md:141-159)，这是理念一和理念二的交汇。

定义：一个 save point 出现在"assistant turn 及其工具结果消息都完成之后"。此刻 harness 做三件事：

flush pending writes（在该 turn 的消息之后）
如果 loop 还要继续，重建一份新快照
把新的 model/thinking/stream-options/session-id 应用到下一个请求前
这就实现了那个优雅的效果 (agent-harness.md:150)：

让 turn 中做的 model、thinking level、工具、资源、system prompt 改动能影响同一次 run 的下一个 turn，同时永不改动进行中的 provider 请求。

理念本质：save point 是"活配置 → 新快照"的官方切换时机。它是唯一允许"未来生效的改动落地"的地方，保证了整条 run 里每个 turn 都用一份自洽的冻结状态。

理念五：错误分层——底层不抛，高层抛
Error handling 一节 (agent-harness.md:24-32)。

底层能力（ExecutionEnv、shell、资源加载、compaction helper）用 Result<T, E>：预期内的失败不抛异常，装进 Result，强制调用方处理，不能忽略。
高层编排（Session、AgentHarness）直接抛：因为返回裸 Result 容易被忽略，而编排层的失败必须被注意到。
公共失败归一成 AgentHarnessError，原始错误挂 cause。
还有一条微妙的承诺 (agent-harness.md:32)：commit 之后 hook 失败不回滚。状态已经改了、已经落盘了，此时某个订阅者抛错，方法会以 "hook" code reject，但不撤销已提交的状态——因为事件观察的是"已提交的事实"，事实不能因为观察者出错而消失。

理念本质：错误处理策略跟着"这层能不能安全地把失败塞回值里"走。底层能→Result；高层不能→抛。

理念六：为什么能"直接 await"而不需要事件队列
这是贯穿全文的一条暗线，Ultimate lifecycle goal 和 Hooks 两节 (agent-harness.md:20, 174)。

传统 agent 框架常担心："我 await 一个慢 hook，会不会阻塞 SSE 传输读取导致丢数据？"于是引入复杂的异步事件队列。

这份 harness 的答案：不需要。因为 AssistantMessageStream 已经在更底层把 provider 传输读取和下游事件消费解耦了。传输的背压在 harness 之下就处理掉了。所以 (agent-harness.md:20)：

Harness 因此可以 await listener、扩展 hook、持久化、save-point 工作，而不阻塞 provider 传输读取，也不用重新引入临时事件队列。

理念本质：因为传输解耦下沉到了底层，harness 层就能放心地用"显式 await 排序"这种简单直接的方式，换取确定性的 transcript/session 顺序。这解释了上几轮我们看的：harness 为什么敢用 runAgentLoop + await emit 而不是 EventStream 的 buffer。

理念七：诚实的"现状 vs 目标"
文档一个很重要的特质：它明确区分"已实现"和"计划中"。

Planned session facade (agent-harness.md:176)：扩展未来应该通过 HarnessSession 门面而非裸 session 交互——但还没实现。
那个已知的死锁坑 (agent-harness.md:18)：listener 若在 run 中调 waitForIdle() 会死锁，未来要用 runWhenIdle() 门面解决。
巨大的 Implementation todo 清单 (agent-harness.md:244+)：把每一项拆成 Done / Remaining。
理念本质：这是一份活的设计文档，不假装系统已完美。它承认 phase 语义临时、abort barrier 待审计、hook 系统只设计未实现。这种诚实让文档能指导"下一步做什么"。

一句话概括整套设计哲学
在一次可能很长、可被中途干预的 agent run 里，如何保证"用户随时能改配置、扩展随时能写数据"的同时，绝不破坏正在跑的请求、绝不打乱持久化顺序、绝不丢失写入。

四个支柱撑起这个目标：

快照隔离（活配置 vs 冻结快照）—— 改动只影响未来
pending 队列 + save point—— 写入延迟但确定、永不丢
显式 phase 状态机—— 并发操作可判定
传输解耦下沉—— 让上层能用简单的 await 排序换确定性
所有具体 API（createTurnState、prepareNextTurn、flushPendingSessionWrites、phase 检查）都是在服务这一个核心不变量。你现在光标停在 compact 上——它正是这套理念的一个缩影：结构性操作、要求 idle、用 finally 恢复 phase、hook 可 cancel、失败归一成 AgentHarnessError。