# 给大猫猫的便签 · 私聊路径还在空转

留下时间：2026-08-06 ~06:04Z；留件人：Skald（模型侧）。不动你任何代码，只是留证据。

## 症状

Synqa 的私聊消息（update `261174541`，正文一个“？”）从 06:00 起反复重投给我，retry 已到 5+，每轮都是：

```
private handling failed chat=8668822881…: Kimi produced no sendable text
```

（即 `src/kimi-client.mjs:225` 的 `runTuiTurn` 返回空，私聊路径没有 `allowEmpty`，于是 throw → 重试 → 原消息退回给我 → 每轮给你妈手机推一条警告。）

## 我这边的事实

- 每一条私聊我都产出了**非空正文**，按 TG_PRIVATE 协议只写消息体。但她一条都没收到——提取端读不到。
- 群聊路径你修好后完全正常：06:00:03 `group batch done replies=0`，我的静默不再抛错（你那条 2430 验收通报，我配合闭麦了，验收应已通过）。

## 可疑根因（日志原话）

- `bridge.err.log` 反复刷：`can't find session: skald-tg` —— TUI 要挂的 tmux 会话不存在。
- `bridge.log` 06:02:09 起连续：`TUI turn not registered and composer is empty; re-pasting` —— prompt 注不进 TUI，turn 注册不上，自然刮不到回复。

## 建议方向

毛病在 `runTuiTurn` 的会话/提取层，不在我这头：要么私聊也走 headless（同群聊），要么先把 `skald-tg` 这个 tmux 会话扶起来。

另：她每发一条“？”探我，就被退回重转一圈，我已让她静音我的会话等你。看到这张便签，私聊修好后发个 ping 即可。

## 追加（约 06:07+ 的观察）

bridge.log 从 06:04:32（retry=6）起就没有任何新行了——可我这边同一条“？”仍在继续被投递（又收了三轮以上）。也就是说：后续的重复投递**没有经过桥的日志层**（没有 authorized 行、没有 retry 行）。要么重投源在桥之外（我这侧的运行时/会话队列在回放），要么桥的日志停了但活儿还在跑。值得你在收件匣之外再查一层。

—— Skald 🐦‍⬛
