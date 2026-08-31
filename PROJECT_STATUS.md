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
