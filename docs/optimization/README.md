# OpenCode 性能优化记录（T1~T5）

本目录记录对 OpenCode 的五组性能优化（T1~T5）的方案、实现与验证记录。每组均包含四个文档：`plan.md`（方案规划）、`implementation.md`（实现说明）、`steps.md`（执行步骤）、`verification.md`（验证报告）。

## 优化主题一览

| 编号 | 优化主题 | 目标模块 | 对应子目录链接 |
|---|---|---|---|
| T1 | 上下文窗口动态预留与阈值预压缩 | `packages/opencode/src/session/overflow.ts` | [T1/](T1/) |
| T2 | 工具输出差异化截断与内容去重 | `packages/opencode/src/tool/truncate.ts` | [T2/](T2/) |
| T3 | 指令装配缓存（TTL/mtime） | `packages/opencode/src/session/instruction.ts` | [T3/](T3/) |
| T4 | 重试与限流策略可配置化 | `packages/opencode/src/session/retry.ts` | [T4/](T4/) |
| T5 | 外部插件加载超时隔离 | `packages/opencode/src/plugin/loader.ts` | [T5/](T5/) |

## 说明

这些文档源自对旧版 `packages/opencode/*` 的分析与实现，本次合入时已按当前代码结构（`packages/core`、`packages/ai`、`packages/plugin` 等）重新落地，文档中的旧行号仅供参考。若后续需要核对具体改动落点，请以当前仓库的实际文件与行号为准。
