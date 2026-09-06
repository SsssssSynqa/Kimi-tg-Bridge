---
schema-version: 1
project-id: skald-tg-bridge
title: Skald Telegram Bridge
state: waiting
phase: verification
scope: current
waiting-for: Owner 确认迁移后状态与分项台账
owners: [TBD]
reviewers: [TBD]
created-at: 2026-08-31T00:00:00+08:00
updated-at: 2026-09-07T05:27:00+08:00
canonical-home: Kimi/skald-tg-bridge
---
> **2026-09-07 当前收口**：本轮修复代码 commit 1717250 已合入；2026-09-06 23:24Z bridge PID94144 已重载，原 TUI1992 与 session不变。187/187＋最后增量22/22通过；completed mixed自动拆解仍保留为特殊残项，当前无active欠账。 详细证据与剩余边界：`/Users/arthas/Desktop/Synergia/tasks/tg-three-bridge-audit-20260907/REPAIR_VERIFICATION.md`。下方历史施工文字按其当时日期理解。


# STATUS · Skald Telegram Bridge

> ⚠️ **本文件由机械迁移生成**（2026-09-07 东八区，Synqa 02:48 授权，规章 §3.2 B′）。
> **格式已合规，内容未经核实**：迁移脚本不判断项目真实状态——旧文即使自称 complete，
> 按 §4.8「completed 必须有可核验证据」也不予采信，一律落 `waiting` 等 Owner 确认。
> 旧文全文原样保留在文末「原文」节（§10：历史文档永不为合规而改写）。

## 分项台账

| 工作项 | 施工人 | 审核人 | 状态 | 证据 | 剩余工作 | 验收边界 | 最近更新 |
|---|---|---|---|---|---|---|---|
| （整份待 Owner 按 §4.7 拆分为分项） | TBD | TBD | state=waiting | 旧文自称：running / current revision loaded；自然群聊专项验收仍独立 | 待 Owner 拆分并确认 | 机械迁移**不代签**任何一项已完成 | 2026-08-31 |

## 迁移说明

- 旧文件：`PROJECT_STATUS.md` → `STATUS.md`（同目录改名，不留指针，§3.2）。
- 旧文自称状态：running / current revision loaded；自然群聊专项验收仍独立
- `owners` 取自旧文 Owner/主查行（未写明，标 TBD）；`reviewers` 一律 TBD。
- `created-at` 立项日取自旧文最早日期；`updated-at` 为迁移时刻。
- **待 Owner 做的事**：把 `state`/`phase` 改成真实状态、按 §4.7 拆分台账、补证据与验收边界。

## 2026-09-07 隔离修复候选（不冒认生产加载）

| 工作项 | 施工人 | 审核人 | 状态 | 证据 | 剩余工作 | 验收边界 | 最近更新 |
|---|---|---|---|---|---|---|---|
| SK-01/02 生命周期/只读 guard；SK-04 stop；SK-06 JSONL；SK-08 chunk ACK；SK-10 全相册；SK-11 撤群重放；SY-02 相册原子成员 | Sephy / Skald 分桥施工 | 主审待独立核验 | code complete / awaiting acceptance，仅隔离副本 | `tasks/tg-three-bridge-audit-20260907/repairs/skald/core-final.log` 40/40；`syntax-check.log` exit 0；修复说明 `REPAIR.md` | 主审 diff、正式源码合入；completed mixed 原目标不明的个案需明确处置 | 未部署、未重启、未改会话/配置/队列；原文历史运行证据不代表本批加载 | 2026-09-07 |

最终全套 `full-suite-final.log` 为 **187/187 PASS**；之后追加启动 no-auto-start 窄修，由 `lifecycle-final.log` 单独验证最终代码。首轮 171 项 / 163 通过 / 8 失败已保留，缺跨树依赖及旧 digest 假夹具已修，不隐藏失败。新增补读通知、全批恢复与跨窗相册触发/上下文分离已在隔离副本完成。**completed mixed 原回复只能关联窗口内目标的个案仍需明确人工处置，不冒认自动恢复**。原先缺口反例保留在 `tasks/tg-three-bridge-audit-20260907/skald/evidence/`；测试绿不代签自然消息验收。

## 原文（迁移前 `PROJECT_STATUS.md` 全文，一字未改）
# Skald Telegram Bridge · PROJECT_STATUS

- 状态：running / current revision loaded；自然群聊专项验收仍独立
- 最后验证：2026-08-31 16:16 PT
- 生产 revision：`2c8c7c9 fix: 每轮贴唯一 turn 标记，不再拿协议头当指纹`
- 运行：`com.synergia.skald-bridge` running；持久 `skald-tg` Kimi TUI；启动日志已准确写 `persistent-tui`
- 连续性：本轮所有 target-only reload 均保留同一 current/previous session digest；未新建、切换或替换人格 session

## 本轮已完成

- 删除无匹配 `turn.prompt` 时把晚到 wire 文本归给当前轮的危险 salvage，阻断跨轮错配。
- 文件中继拒绝 symlink 组件且只接受普通文件，阻断 relay root 逃逸。
- 相册按 `(chat, thread, media_group_id)` 隔离，并以最后一个新成员重置静默窗。
- 私聊、群聊和缓冲批次都携带有界 reply provenance；长回复按 Unicode code point 安全切片。
- `/flow 1-20|off` 使用本仓可发布实现并与家庭共享状态合同一致；超限会如实夹到 20。
- 启动日志改为真实 resolved engine，`tmuxSession` 遵循配置；npm 包排除本地备份、运行状态和 `config.json`。
- 首次可重试失败只记运维日志，不再向 Synqa 发送可能不真实的“没送出去”；耗尽后的 dead-letter 通知仍保留。
- 每轮 prompt 首行使用唯一 `[turn:...]` marker；只有 wire 中含同一 marker 的 `turn.prompt` 才建立因果归属，协议头相同的前后两轮不会互认。

## 验证与边界

- 当前 HEAD：142/142 tests PASS；`npm run check` PASS；`npm pack --dry-run` 63 files，未包含 `.bak`、`.state` 或 `config.json`。
- owner 已 target-load `2c8c7c9`；clean source mtime 早于当前 bridge start，持久 TUI pane PID 保持，current/previous session digest 与 earlier receipt 一致，queue 0/0/0。
- 当前 journal 为 1259 done、0 pending、0 delayed、0 dead；历史终态处置未 replay。
- shared monitor runtime shell 为 `ok`，但 output probe 仍未配置；进程、socket 与 backlog 不代签当前真人回复。
- 当前 session 与更早 19MB 历史备份的归属疑点仍是历史连续性调查项；本轮没有用新 session 掩盖它。
