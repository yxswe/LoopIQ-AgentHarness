# 支持场景说明(Support Scenarios)

本文件记录 AgentHarness 中部分设计的实际使用场景,便于理解各能力"为什么存在、什么时候用"。

---

## nextTurn — 预置给下一轮的用户消息

`nextTurn(text)` 把用户消息压入 `nextTurnQueue`,在**下一次** `prompt`/`skill` 启动时,拼在用户新消息**前面**一起发给 agent。

### 与 steer / followUp 的区别

harness 有三个用户消息队列,区别在于**注入时机**和**能否在空闲(idle)时入队**:

| 队列 | 入队时机限制 | 注入点 | 语义 |
|---|---|---|---|
| `steerQueue`(steer) | 仅运行中,idle 报错 | 当前 run 的 **turn 之间**拉取 | 打断/纠偏:agent 正在跑,插一句改变它当前方向 |
| `followUpQueue`(followUp) | 仅运行中,idle 报错 | 当前 run 快结束时追加 | 追问:当前 run 干完后紧接着继续 |
| `nextTurnQueue`(nextTurn) | **无限制**,idle 也能入队 | **下一次** run 启动时,拼在新消息前面 | 预置:趁空闲/忙时先攒着,下一轮开跑时一起带上 |

关键差异:`nextTurn` 没有 `phase === "idle"` 校验——另两个在 agent 空闲时调用会报错,而 `nextTurn` **随时可入队**。因为它影响的不是"当前这次运行",而是"未来某次运行"。

### 典型场景

- 用户在 agent 空闲时连打多条消息,不想每条都触发一次完整 run:前几条用 `nextTurn` 攒着,最后一条 `prompt` 一次性带上全部。
- 系统想在下一轮对话开头自动注入一段上下文/提醒(如"用户刚切换了项目"),但当前没有正在跑的 run 可供 steer。
- UI 上"排队发送":趁模型还在输出时先写好下一句,本轮结束后下一轮自动带出。

排队消息拼在本次 prompt 文本**之前**,因此它们是"下一轮的开场白"。

---

## emitBeforeProviderRequest — 请求前动态调整传输层选项

`before_provider_request` 钩子在**每次真正向大模型发请求之前**触发,让应用层能针对该次请求动态修改传输层选项(header、超时、重试、metadata、cacheRetention、transport)。钩子返回一个 patch,叠加在 harness 基础 `streamOptions` 之上;多个钩子会**依次叠加**,互不干扰。

### 典型场景

1. **动态注入请求头(最常见)**
   - 追踪/可观测:trace-id、request-id,把每次 LLM 调用串进分布式链路
   - 计费/配额归属:按当前用户或租户注入 `X-Tenant-Id`,让网关按 header 计费
   - 实验分组:A/B 标记,让代理层路由到不同模型版本

2. **按会话状态调整超时/重试**
   - 长上下文、复杂推理的 turn 调高 `timeoutMs`
   - 交互式低延迟 turn 调低超时、减少 `maxRetries` 让其快速失败
   - 检测到后端降级/高负载时临时收紧重试上限

3. **认证 / 密钥轮换**:token 在长会话中可能过期;钩子每次请求前运行,正好注入最新 `Authorization` 或按需刷新,比"启动时设一次"更可靠。

4. **请求路由 / transport 切换**:按 payload 大小或 provider 切换 `transport`。

5. **缓存策略微调**:对昂贵可复用的 system prompt turn 打开/延长 `cacheRetention`,对一次性请求关闭。

### 与 before_provider_payload 的区别

- `before_provider_request`:改**传输层选项**(header/超时/重试/metadata)——请求"怎么发"
- `before_provider_payload`:改**请求体本身**(消息、工具定义等)——发给模型的"内容是什么",更底层、更少用
