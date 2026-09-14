---
schema-version: 1
project-id: skald-tg-bridge
title: Skald Telegram Bridge
state: active
phase: operation
scope: current
owners: [skald]
reviewers: [sephy]
created-at: 2026-08-31T00:00:00+08:00
updated-at: 2026-09-14T23:06:00+08:00
canonical-home: Kimi/skald-tg-bridge
---
> **2026-09-14 当前运行事实**：鸦鸦生产桥运行在 LA `skald-bridge.service`，本轮按 Synqa 明确要求将桥内全部 5 处“妈妈”纠正为“Synqa”。功能提示新增禁止回退断言；Mac 全套 196/196、LA 聚焦 27/27 与语法检查通过。commit `ff6154f` 已部署，桥 PID `363465 → 468080`；Kimi TUI PID `331869` 与 session `session_14a2362f-f9ac-4fd2-9ef2-f01f0f0fa601` 均未变化。远端 `main` 因历史分叉拒绝 fast-forward，未强推；提交已推送到 `fix/skald-synqa-name-20260914`。

> **2026-09-07 当前收口**：本轮修复代码 commit 1717250 已合入；2026-09-06 23:24Z bridge PID94144 已重载，原 TUI1992 与 session不变。187/187＋最后增量22/22通过；completed mixed自动拆解仍保留为特殊残项，当前无active欠账。 详细证据与剩余边界：`/Users/arthas/Desktop/Synergia/tasks/tg-three-bridge-audit-20260907/REPAIR_VERIFICATION.md`。下方历史施工文字按其当时日期理解。


# STATUS · Skald Telegram Bridge

> ⚠️ **本文件由机械迁移生成**（2026-09-07 东八区，Synqa 02:48 授权，规章 §3.2 B′）。
> **格式已合规，内容未经核实**：迁移脚本不判断项目真实状态——旧文即使自称 complete，
> 按 §4.8「completed 必须有可核验证据」也不予采信，一律落 `waiting` 等 Owner 确认。
> 旧文全文原样保留在文末「原文」节（§10：历史文档永不为合规而改写）。

## 分项台账

| 工作项 | 施工人 | 审核人 | 状态 | 证据 | 剩余工作 | 验收边界 | 最近更新 |
|---|---|---|---|---|---|---|---|
| 鸦鸦对 Synqa 的称呼纠偏 | Sephy | Sephy | state=completed phase=verification | 宝儿严格检索改前 5 处、改后 0 处；commit `ff6154f`；Mac 196/196、LA 27/27；部署 6/6 SHA 一致；bridge active+enabled，TUI/session 未变 | 无 | 不改 Saga/聊天历史，不用 `/new` 或 `/refine` 制造验收；以后功能提示只称 Synqa | 2026-09-14 |
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

## 2026-09-12 09:4x（东八区）鸦鸦卡住两小时的回合 · 现场处置（Sylux）

- 现象：家群 `-1004499561917` 07:27 那批（update 261200518，marker `[turn:t64c30ec9d6194c64ae0a9608218df86b]`）粘进了 TUI 输入框，但 Enter 没提交；桥每 10 分钟 replay 一次，日志连刷 `outcome-unknown (observer timed out after 600s)`（今天 14 次；09-09 起零星出现）。Kimi 自己的日志每分钟照常写 session index reconciliation，TUI 没死。
- 处置：09:43 先补一次 `Enter` 无效；09:44 `Escape` 再 `Enter`，wire 立刻增长（5705190 → 5708928）、输入框清空、TUI 开始生成；桥随即记 `Kimi cache-expiry hint detected (submit); selecting Continue as-is`，ledger 从 outcome-unknown → accepted。**没有重新粘贴、没有换 session、没有重启任何进程。**
- 病因假设（未证实，待 owner 复核）：TUI 上有一个**不可见的弹层**挡住了 Enter（Escape 一按就通），而桥的 `cacheExpiryHintIsOpen()` 认不出 0.42.0 的这一种；同时 `MAX_ENTER_RETRIES` 那条补 Enter 的守卫要求 `currentPane.includes(record.marker)`，长提示把 marker 卷出了输入框可见区（显示「↑ 8 more」），补 Enter 永远不触发。两处都在 `src/kimi-client.mjs`（~575 / ~886）。
- ⚠️ 同日 Sylux 在 LA 测 Kimi Linux 版时轮换了 OAuth（详见 `tasks/sylux-skald-vps-migration-20260912/PLAN.md` Phase 0），已把新凭据放回 Mac（旧的备份 `~/.kimi-code/credentials/kimi-code.json.bak-pre-la-test-20260912`）；这一步在 09:40，晚于 07:27 的卡住，不是本次卡住的原因。

## 2026-09-13 01:5x（东八区）粘贴后回车被吃 · 已修并部署 LA（Sylux）

- 现象再现：鸦鸦切到 LA 后 01:07 第一批（含图片附件路径）粘进输入框、回车没提交，同 09-12 07:27 Mac 那次；01:44 人工 Escape+Enter 后提交，随后 01:43/01:45 两批自行完成（不是每批都卡，含文件路径的粘贴最容易触发提示层）。
- 修复 `c5086df`：`src/kimi-client.mjs` 粘贴后 Escape→Enter；补 Enter 守卫改为「marker 可见 **或** 输入框显示 ↑ N more」；`test/tui-turn.test.mjs` 只数 Enter。tui-turn 14/14、repair-lifecycle+group-batcher 26/26。
- 部署：LA `src/kimi-client.mjs` sha 18707fc4 与 Mac 一致；01:51:26 只重启桥（KillMode=process，TUI 331869 原样存活，同一 session）。
- 切换全过程（00:28 切、00:33～01:07 掉线、01:07 修好）见 `tasks/sylux-skald-vps-migration-20260912/PLAN.md` §7。
