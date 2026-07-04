# Vendor Pi `ai` + `agent` 骨架设计

- 日期：2026-07-04
- 状态：已通过设计评审，待写实施计划
- 仓库：`LoopIQ-AgentHarness`（当前为空目录）
- 上游：`Agent/pi`（earendil-works monorepo）

## 1. 背景与目标

在空仓库 `LoopIQ-AgentHarness` 中，基于 Pi 的 `ai` 与 `agent` 两个包构建一个新 Agent。
当前阶段的唯一目标是**搭骨架跑通**：把两个包的源码 vendor（复制/fork）进来，配好
monorepo 构建，做到能编译、能跑起一个最小 Agent 示例。

本仓未来会作为**被依赖的库**，被其他 repo（包括 LoopIQ，使用 bun）消费。因此必须
产出标准 npm 包（`dist` 下 `.js` + `.d.ts`）。生产方工具链（npm/tsgo）与消费方工具链
（bun）相互独立，互不冲突。

### 关键决策（已确认）

| 决策项 | 结论 |
|--------|------|
| 搬移方式 | Vendor / Fork：复制源码进本仓，脱离 Pi 上游 |
| 用途 | 先搭骨架跑通，具体产品用途后续再定 |
| 仓库结构 | Monorepo，保留 `ai` 与 `agent` 两个独立包 |
| 工具链 | 镜像 Pi：npm workspaces + tsgo + biome + vitest（方法 1） |
| 依赖分发 | 暂不管（npm publish / git / 本地 link 以后再定） |
| 包命名 | `@loopiq/ai` + `@loopiq/agent-core` |

## 2. "跑通"的验收标准（Definition of Done）

1. `npm install` 成功，两包通过 workspace 互链。
2. `npm run build` 成功，`packages/ai/dist` 与 `packages/agent/dist` 都产出 `.js` + `.d.ts`。
3. 最小示例 `examples/smoke.ts` 用 **faux provider** 跑通一次 Agent 对话（不联网、不需要
   API key），打印出助手回复。
4. `npm test` 能运行；vendor 过来的联网类单测允许失败/跳过，离线核心用例通过。

## 3. 明确不做（Out of Scope）

- 不做发布 / 依赖分发（npm publish、git 依赖、本地 link 等，后续单独决定）。
- 不搬 `coding-agent` / `orchestrator` / `tui`。
- 不改 `ai` / `agent` 的业务逻辑，只做"能编译能跑"的最小适配。
- 不运行联网的 `generate-models` codegen（用已提交的生成文件）。

## 4. 目录结构

```
LoopIQ-AgentHarness/
├── package.json              # 根：private, workspaces: ["packages/*"], scripts(build/test/check/smoke)
├── tsconfig.base.json        # 照搬 Pi（ES2022 / Node16 / strict / declaration ...）
├── tsconfig.json             # 根 references（可选）
├── biome.json                # 照搬 Pi（tab / width 3 / line 120 + 规则）
├── .gitignore / .npmrc       # 照搬
├── examples/
│   └── smoke.ts              # 新增：faux provider 冒烟示例
└── packages/
    ├── ai/                   # vendor @loopiq/ai（原 @earendil-works/pi-ai）
    │   ├── package.json      # name 改名；build 改为跳过联网 codegen
    │   ├── tsconfig.build.json
    │   ├── vitest.config.ts
    │   ├── src/              # 整个 src 照搬（含已生成的 *.generated.ts / *.models.ts）
    │   └── scripts/          # 保留 generate-*.ts，但默认不在 build 里跑
    └── agent/                # vendor @loopiq/agent-core（原 @earendil-works/pi-agent-core）
        ├── package.json      # 依赖改为 "@loopiq/ai": "*"
        ├── tsconfig.build.json  # paths 别名改为 @loopiq/ai
        ├── vitest.config.ts     # alias 到 ../ai/src（改名后照搬）
        └── src/                 # 整个 src 照搬（含 harness/）
```

## 5. 工具链（方法 1，镜像 Pi）

| 项 | 选择 | 备注 |
|----|------|------|
| 包管理 | npm workspaces | 一条 `npm install` 互链两包 |
| 编译 | tsgo（`@typescript/native-preview`） | 产出 `.js` + `.d.ts`；不稳可退回标准 `tsc` |
| lint/format | biome | 照搬 `biome.json`，非必需但一并带上 |
| 测试 | vitest | 照搬两包的 config |

**构建顺序**：先 `ai` 后 `agent`（agent 的 `tsconfig.build.json` 的 `paths` 指向
`../ai/dist/*.d.ts`，必须先 build ai）。根 `package.json` 的 build 脚本按此顺序串联。

### 名词说明（供参考）

- **tsgo**：TypeScript 编译器的 Go 原生实现（`@typescript/native-preview`，即 TS7 / tsc-go），
  用法兼容 `tsc`，编译更快，目前 preview 阶段。只负责把 `.ts` 编译成 `.js` / `.d.ts`。
- **npm workspaces**：npm 内置的 monorepo 机制。根 `package.json` 声明 `workspaces` 后，
  一次 `npm install` 装齐所有子包并软链到根 `node_modules`，子包之间可直接 import，无需发布。
- **biome**：Rust 写的 lint + format 一体工具（替代 ESLint + Prettier），不参与编译。

## 6. 关键适配点

1. **跳过联网 codegen**：`ai/package.json` 的 build 从
   `generate-models && generate-image-models && tsgo` 改为直接
   `tsgo -p tsconfig.build.json`。原因：`generate-models.ts` 会联网抓取各家模型列表，但生成
   结果 `models.generated.ts` 及各 `*.models.ts` 已提交在 `src/` 中，直接编译即可。生成脚本
   保留在 `scripts/` 供日后手动更新。

2. **包改名批量替换**（全仓）：
   - `@earendil-works/pi-ai` → `@loopiq/ai`（含子路径 `/providers/*`、`/compat`、`/api/*` 等）
   - `@earendil-works/pi-agent-core` → `@loopiq/agent-core`
   - 涉及位置：`agent/src` 所有 import、两包 `package.json` 的 `name` 与 dependencies、
     `agent/tsconfig.build.json` 的 `paths`、`agent/vitest.config.ts` 的 alias。

3. **冒烟示例形态**（伪代码，最终以 vendor 后真实 API 为准）：

   ```ts
   import { Agent } from "@loopiq/agent-core";
   import { /* faux 构造，见 ai/src/providers/faux.ts */ } from "@loopiq/ai";
   // 构造 faux model → new Agent({ initialState: { systemPrompt, model } })
   // agent.subscribe(event => 打印 text_delta) → await agent.prompt("Hello")
   ```

   加根脚本 `npm run smoke` 运行（用 tsx / node 直跑 ts，或跑编译后的 js）。

## 7. 迁移步骤（高层）

1. 搭根骨架：根 `package.json`、`tsconfig.base.json`、`tsconfig.json`、`biome.json`、
   `.gitignore`、`.npmrc`。
2. Vendor `ai`：照搬 `packages/ai/{src,scripts}` + 配置；改 `name` = `@loopiq/ai`；
   build 改为纯 `tsgo`；保留 `exports` / `bin`。
3. Vendor `agent`：照搬 `packages/agent/{src}` + 配置；改 `name` = `@loopiq/agent-core`；
   依赖改 `"@loopiq/ai": "*"`。
4. 批量改名：替换所有 import / paths / alias（见适配点 2）。
5. 装依赖 + 编译：`npm install` → `npm run build`（先 ai 后 agent），确认两个 `dist`
   都出 `.js` + `.d.ts`。
6. 写冒烟示例 `examples/smoke.ts` + 根脚本 `npm run smoke`。
7. 跑测试 `npm test`，记录联网失败用例（允许），确认离线核心用例通过。

## 8. 风险与待验证点

- **tsgo preview 兼容性**：可能编译报错；预案是退回标准 `tsc`（配置几乎不用改）。
- **faux 的确切 API**：`ai/src/providers/faux.ts` 的导出/构造方式需在写示例时按真实源码确认。
- **编译依赖顺序**：agent 的 `tsconfig.paths` 指向 `../ai/dist/*.d.ts`，必须先 build ai。
- **vendor 单测联网**：部分用例会真连各家 API，跑通阶段允许失败/跳过。
- **git 初始化**：当前 `LoopIQ-AgentHarness` 非 git 仓库；如需版本管理需先 `git init`（待确认）。
