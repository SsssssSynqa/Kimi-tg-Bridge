# Telegram Kimi Bridge

一个零依赖的 Telegram Bot API 桥，把 Telegram 机器人接到一个常驻的 **Kimi Code CLI** 会话上——原有的 Codex 引擎也仍然可用。

支持私聊、群聊、仅 @ 触发、增量群上下文、群消息成批回复、bot 接龙上限、发送限流、图片与文件附件、可选的私聊工具执行、需本人拍板的命令审批、崩溃安全的消息投递。在 `tui` 模式下，Kimi 的交互界面常驻在一个 tmux 会话里，你可以随时 attach 进去——Telegram 和终端看到的是同一个正在运行的它。

English documentation: [README.md](README.md).

> **衍生自 [Codex-tg-Bridge](https://github.com/HailSyner/Codex-tg-Bridge)。**
> 本项目最初是那座桥的一份拷贝，在原有 Codex `spawn` / `daemon` 两种引擎之外，
> 增加了 Kimi Code CLI 引擎（`codexMode: "kimi"`）。
> 传输层的全部工作——增量群上下文、成批回复、崩溃安全投递、审批模型、限流——都来自那里。
> 如果你要的是 Codex 桥，请直接用上游项目。

## 这是什么

Telegram Kimi Bridge 让你用一个 Telegram 机器人作为常驻 Kimi Code CLI 会话的轻量前端。它面向个人自动化、小范围可信群组，以及 bot 之间的协作场景——如果你需要，还可以再开一个终端窗口，看着同一个会话。

## 运行要求

- macOS、Linux 或任何能跑 Node.js 的机器
- Node.js 20+
- 从 [@BotFather](https://t.me/BotFather) 申请的 Telegram bot token
- 同一台机器上已安装并登录 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)
  （或者 Codex——如果你要跑原有的 `codexMode` 引擎）
- PATH 里有 `tmux`——仅 `kimiEngine: "tui"` 需要
- 机器人要能收到你想让它收到的消息：
  - 想让它看到群里所有消息，就在 BotFather 里关掉 Privacy Mode。
  - 想让别的 bot 触发它，就打开 bot 之间的通信开关。

## 快速开始

```bash
git clone https://github.com/HailSyner/Kimi-tg-Bridge.git
cd Kimi-tg-Bridge
cp .env.example .env
cp config.example.json config.json
```

编辑 `.env`：

```bash
TELEGRAM_BOT_TOKEN=1234567890:your-real-token
```

编辑 `config.json`：

- `allowedUserIds` 填你自己的 Telegram 数字用户 ID。
- `workdir` 填 CLI 的工作目录。
- `codexMode` 设为 `"kimi"`，`kimiPath` 指向你的 `kimi` 可执行文件。
- 群 ID 填进 `allowedGroups`。
- 在你完全理解工具安全模型之前，`privateToolsEnabled` 保持 `false`。

把 `AGENTS.example.md` 里的协议复制到 `workdir` 对应的 `AGENTS.md`。长的人格设定、隐私规则、群 profile 都写在那里。不要把长行为提示写进 `config.json`——桥每轮只发很短的模式标记加动态 Telegram 载荷。

然后运行：

```bash
npm run check
npm start
```

在 Telegram 里给机器人发 `/start`。只要你的用户 ID 在白名单里，它就会回话。

## Telegram 命令

私聊命令：

- `/start`：确认桥是通的。
- `/status`：桥的模式、当前 thread、群数量，以及投递队列（等待中、在途、进死信的）。
- `/session`：当前会话 ID。
- `/resume <session-id>` 或 `/attach <session-id>`：把桥切到已有的会话。
- `/tools`：私聊工具模式是否开启、可写范围、网络权限，以及群聊只读规则。
- `/new`：新建一个 thread，旧的 thread ID 会在本地留底。
- `/retry_update <update-id>`：把一条进了死信队列的 Telegram update 放回重试队列。

仅 owner 可用的运维命令：

- `/reload_config`：进程内重读 `config.json`，热替换 `allowedGroups`、`mentionPatterns`、`mentionContext`。静态字段（`codexMode`、`model`、`timeoutMs`、`keychain*`）仍需重启才生效。
- `/restart_bridge`：干净退出，由进程管理器拉起。新进程会把原来那条"重启中"的消息编辑成完成提示。
- `/restart_daemon`：不停桥，直接用 `launchctl kickstart` 重启 Codex daemon（仅 macOS + daemon 模式）。
- `/force_restart_bridge`、`/force_restart_daemon`：同上，但允许在有 turn 进行中时强制执行。不带 `force_` 时两者会拒绝，而不是打断正在跑的活。

群命令（见[动态群授权](#动态群授权)）：

- `/<前缀>_on`、`/<前缀>_off`、`/<前缀>_all`、`/<前缀>_quiet`
- `/flow <1-200>`、`/flow off`、`/flow`：临时覆盖、关闭或查看当前群的 bot 连发上限；覆盖值六小时后自动失效。

## 获取 Telegram ID

把 [@getidsbot](https://t.me/getidsbot) 拉进对话，用它输出的 ID：

- 你的私聊用户 ID 填 `allowedUserIds`。
- 群 ID 填 `allowedGroups`。
- 想让特定 bot 触发本 bot，把它的 ID 填进该群的 `allowedUserIds`。

群 ID 通常长这样：`-1001234567890`。

## 配置

完整字段见 `config.example.json`。最重要的几个：

| 键 | 含义 |
| --- | --- |
| `botName` / `ownerName` | 会带进 Telegram 短载荷的名字。 |
| `allowedUserIds` | 允许私聊的 Telegram 用户 ID。 |
| `ownerUserId` | 谁可以用运维命令、审批按钮和群开关门指令。默认取 `allowedUserIds` 的第一个。 |
| `mentionPatterns` | 额外的唤醒词。在 `requireMention` 的群里，消息含其中任意一个也算叫了它。 |
| `gateCommandPrefix` | 群开关门指令的前缀，默认取 `botName`。 |
| `workdir` | CLI 的工作目录。 |
| `model` | 传给 CLI 的模型覆盖。`reasoningEffort` / `serviceTier` 仅对 Codex 引擎有效。 |
| `kimiPath` | `kimi` 可执行文件路径。 |
| `kimiEngine` | `"spawn"`（无头，每轮一个进程）或 `"tui"`（tmux 里常驻的交互界面）。 |
| `tmuxSession` | 承载 Kimi TUI 的 tmux 会话名，仅 `kimiEngine: "tui"` 用。 |
| `nativeVision` | 模型自己能读图就设 `true`；否则由视觉模型转写成文字。 |
| `maxDeltaChars` | 群增量上下文的字符预算（默认 4000，`0` 关闭）。 |
| `privateToolsEnabled` | 为 `true` 时，私聊可以让 Codex 在受限的 workspace-write 沙箱里干活。 |
| `toolWritableRoots` | 私聊工具模式允许写入的绝对路径（或相对配置文件的路径）。 |
| `toolNetworkAccess` | 私聊工具模式的网络权限，默认 `false`。 |
| `codexMode` | `"spawn"`（自起子进程）或 `"daemon"`（共享会话，见下文）。 |
| `daemonSocketPath` | 覆盖 daemon socket 路径。留空则用 `$CODEX_HOME/app-server-control/app-server-control.sock`。 |
| `daemonLaunchdLabel` | `/restart_daemon` 用的 launchd label。 |
| `approvalTimeoutMs` | 审批卡片多久没人按就自动拒绝，默认 60000。 |
| `desktopSync` | 可选开启：把这个 thread 在 Codex Desktop 侧边栏里的那一行改干净。 |
| `liveLogEnabled` | 可选开启：把每条进出消息写成本地 JSONL 存档。 |
| `outboxEnabled` | 可选开启：让本机脚本通过追加文件来发消息。 |

群级选项：

- `requireMention`：为 `true` 时，群消息必须 @ 它、回复它，或者命中 `mentionPatterns` 唤醒词。
- `allowAllHumanUsers` / `allowAllBotUsers`：允许该群里任意真人 / 任意 bot 触发。`allowAllBotUsers` 要慎用。
- `allowUnaddressedBotMessages`：白名单里的 bot 不用 @ 也能触发。
- `maxConsecutiveBotMessages`：防止 bot 之间无限接龙。任何真人消息都会把计数清零。
- `disableReplyQuote`：回复时不带引用，避免两个 bot 之间垒出一长串可见的回复链。
- `mentionContext`：保留多少条群历史、每次带多少条过去。
- `profile`：短标识，会带进载荷，让 `AGENTS.md` 里选中对应的群 profile。
- `batchTiming`：该群的消息收集窗口。热闹的群可以调长，减少模型调用。

`promptInstructions` 是刻意不提供的。长的群行为规则和隐私规则应该写在 `AGENTS.md`，不要塞进每轮的桥 prompt。

### 把 token 放进 macOS Keychain

除了 `.env`，你也可以让 token 完全不落盘：

```bash
security add-generic-password -U -a bot-token -s com.example.kimi-bridge -w 'YOUR_TOKEN'
```

然后在 `config.json` 里加：

```json
{
  "keychainService": "com.example.kimi-bridge",
  "keychainAccount": "bot-token"
}
```

两者都存在时，环境变量 `TELEGRAM_BOT_TOKEN` 优先。

## 终端 ↔ Telegram：同一个会话

正是这一部分，让这座桥不像一个机器人，而更像一个你能从两个地方够到的同一个助手。

`codexMode: "kimi"` 下有两种引擎，由 `kimiEngine` 选择。

### `kimiEngine: "spawn"`（默认）

无头模式，每轮起一个进程。每一轮执行：

```bash
kimi [--session <id>] -p <prompt> --output-format stream-json
```

从 stdout 读回两类 JSONL：

```
{"role":"assistant","content":"..."}                        -> 回复正文
{"role":"meta","type":"session.resume_hint","session_id":…}  -> 会话锚点
```

没有常驻子进程。真正把对话接下去的是那个 session id，桥会把它落盘，所以重启之后是
**接着原来的会话**，而不是重新开一个。resume 一个已经不存在的会话时，CLI 会以非零码退出并在
stderr 打印 `Session "<id>" not found.`——桥的 fail-closed 判定就钉在这句上，而不是默默开一个
新会话把你的历史丢掉。

简单、稳，但终端里什么都看不到。

### `kimiEngine: "tui"`

把每一轮**注入到一个常驻的交互式 Kimi TUI** 里，它活在 tmux 会话中（`tmuxSession`，默认 `skald-tg`）。
你 attach 进那个 tmux，就能看到真实的界面——思考过程、工具调用、审批对话框——而 Telegram 谈的是同一个
活着的会话。回复从该会话的 `wire.jsonl` 里捕获。

```bash
tmux attach -t skald-tg
```

有两种对话框从 Telegram 那头是看不见的，桥替你处理：

- **工具审批**——转成一张带「同意 / 拒绝」按钮的 Telegram 卡片发给本人（见[命令审批](#命令审批)）。
  没有这一层，一个需要审批的 TUI 轮次就会卡在只有键盘前才看得到的对话框上：她在等回复，它在等按键。
- **缓存过期**——自动选择 *Continue as-is* 保住完整上下文，并记进日志，让这个选择是可见的。

同一轮最多重新注入三次就放弃；无上限重试只会在它的 pane 里刷出一堆一模一样的粘贴。

### 群上下文有字符预算

`recentGroupContextDelta` 同时受**条数**（`maxStoredMessages`）和**字符预算**
（`maxDeltaChars`，默认 4000）两道限制。只限条数是不够的：在一个活跃群里且
`requireMention: true` 时，长时间没被 @ 的 bot 会攒下很大的未读增量，而**一个过大的批次可能被上游
内容过滤整个拒掉**。更糟的是这样一轮一旦进了会话历史，之后每个请求都带着它——包括压缩在内——
足以把会话永久卡死。

超出预算时丢掉**最旧**的未读、保住最近的，并把 `omitted` 置真，让模型知道前面还有没读到的消息，
而不是以为自己看到了全部。`maxDeltaChars: 0` 可关闭该预算。

### 原有的 Codex 引擎

`codexMode: "spawn"` 与 `codexMode: "daemon"` 继承自
[Codex-tg-Bridge](https://github.com/HailSyner/Codex-tg-Bridge)，目前仍然可用——daemon 模式让
Telegram 和 `codex --remote` 终端共用同一个活着的 `codex app-server` 线程。那套装法、它的
LaunchAgent、Codex Desktop 侧边栏同步及其取舍，都在上游项目里有文档，这里不再重复。

### 终端 turn 的审批怎么走

共享 thread 上的**每一个** turn 的审批请求，桥都会收到，包括你在终端里发起的那些。桥刻意不把它们当成自己的来答：

- 危险命令照样直接拒，不管是谁发起的。
- 空的、畸形的文件变更请求直接拒——一张没有信息的卡片，谁也没法做决定。
- 其余来自"不是桥发起的 turn"的请求，一律转成 Telegram 卡片交给 owner 拍板，绝不自动批准，哪怕所有目标都在 `toolWritableRoots` 里面。

在这条规则存在之前，桥会默默拒掉 owner 自己终端会话里的审批：一句在键盘上敲的 `open ~/.codex` 会被连拒两次，而且没有任何解释。群聊 turn 不受影响——它们的 turn id 桥认识，保持硬只读。

## 命令审批

开了 `privateToolsEnabled` 之后，CLI 在跑命令、写文件之前会来问。桥把这些请求分成三档：

1. **自动批准**——只有无副作用的只读检查命令（`ls`、`cat`、`rg`、`git status/diff/log` 等），不能有管道、命令替换或重定向，且 cwd 在 `toolWritableRoots` 内。仅仅"在可写范围内"是不够的。
2. **自动拒绝**——危险命令（递归删除、`sudo`、hard reset、force push、磁盘操作、破坏性 `launchctl`、管道进 shell、疑似 token 的文本）、只读或群聊 turn 里的一切写操作，以及畸形载荷。
3. **转给你拍板**——其余全部，发成一张 Telegram 卡片，带上命令、cwd、以及落在可写范围外的写入目标，两个按钮：**✅ 批准** / **❌ 拒绝**。

几个值得记住的细节：

- **每一次写文件都会转发**，包括写在可写范围内的路径。没有静默写入。
- cwd 安全的命令照样可以通过 `>`、`cp`、`mv`、`tee`、`dd of=`、`curl -o` 写到别处。这些目标会被解析出来列在卡片上。
- 没有"本轮内自动批准"这种选项。每个请求都要单独按一次。
- 没人按的卡片会在 `approvalTimeoutMs`（默认 60 秒）后自动拒绝，卡片会被改写说明超时。如果期间 daemon 断了或桥被强制重启，卡片会被改成"已失效"，而不是留在那儿看起来还能点。
- 命令和路径文本在离开这台机器之前，会对常见密钥形态做遮蔽（OpenAI/Anthropic key、GitHub token、AWS key、Bearer token、JWT、PEM 块、URL 里的凭据、通用 `key=value`）。
- spawn 模式没有异步审批通道，所以文件变更是直接拒绝而不是静默批准。想要按钮就用 daemon 模式。

## 群上下文：增量投递

每次被叫都重塞一遍最近的群消息，既费 token，又让模型重读它已经答过的话。所以每个 `(chatId, threadId)` 组合会记一个游标，指向它已经处理过的最大 message id：

- 群 turn 只收到游标之后的新消息，字段是 `recentContextDelta`。
- `contextWindow.omittedPreviouslySentMessages` 告诉模型：更早的消息是**因为你已经看过**才没带，不是"前面什么都没发生"。
- 游标只在本批全部回复都被 Telegram 接收之后才推进。模型或发送失败时保留旧游标，重试仍能看到这些消息。
- 增量投递不会只取最新的一小段：所有还在缓冲区里、没被看过的消息都会带上，避免 15 条的展示窗口悄悄吞掉更早的上下文。
- 游标的 key 含 thread id，所以只有显式 `/new` 或 `/resume` 才会开一个新的上下文窗口。

游标存在 `.state/group-context-cursors.json`（0600，原子写）。

## 可靠投递

每条进来的 update 都会先 fsync 进日志，**然后** Telegram 的轮询 offset 才推进——崩溃时是重放，不是丢消息。

- 准备和入队严格按 `update_id` 顺序；完成状态只在真正发送成功之后才记录。
- 私聊的模型输出连同生成它的 thread id 会在投递前 fsync，所以"生成完之后崩溃"会重发缓存的那条回复，而不是给 thread 再加一轮模型对话。
- 群聊生成会 fsync 精确的批次成员、解析出的回复、生成用的 thread，以及每条回复的 ack。恢复时绝不会把旧批次和新消息混编，也不会重发本地已确认的回复。
- `/new`、`/resume`、`/reload_config`、`/retry_update` 和两个重启命令都走 operation intent/result 日志，重放不会重复已完成的切换，也不会把重启打成死循环。
- 连续失败会指数退避，最后进一条看得见的死信记录，而不是悄悄跳过。`/status` 看计数，`/retry_update <id>` 放回一条。
- 运维日志会压缩，但每条被接收的原始 update 还会另外 fsync 一份到只追加的存档里，那个存档永不轮转、永不压缩。

投递是刻意做成 at-least-once 的。极少数情况下仍可能重复发出一条消息：Telegram 已经接收了 `sendMessage`，但网络响应在桥观察到之前丢了——Telegram 没有提供任何幂等键能堵上这个缝。但**重复的模型对话**不会发生，缓存的输出挡住了。

## 动态群授权

把 bot 拉进新群，通常意味着改 `config.json` 再重启。下面这几条仅 owner 可用的指令让你在群里当场搞定。前缀取自 `gateCommandPrefix`（默认是 `botName`），所以叫 `Codex` 的 bot 认这几条：

- `/<prefix>_on`——授权本群，默认保守（仅 @ 触发、不接未点名的 bot 消息、bot 接龙上限低）
- `/<prefix>_off`——撤销这层授权
- `/<prefix>_all`——本群所有消息都进
- `/<prefix>_quiet`——切回仅 @ 触发

动态授权存在 `.state/dynamic-groups.json`（0600），和 `allowedGroups` 是相互独立的两层。这些指令永远不改 `config.json`，也永远不会删掉静态配置的群。非 owner 发的会被一句话拒掉并消费掉；状态文件损坏时是 fail-closed，不会被静默覆盖重建。

## 私聊工具模式

桥默认只读。只有当你确实想让 Telegram 私聊在本机干活时，才把 `privateToolsEnabled` 设成 `true`。

开启之后：

- 私聊使用受限的 `workspaceWrite` 沙箱。
- 写入范围限制在 `toolWritableRoots`。
- 除非 `toolNetworkAccess: true`，否则没有网络。
- 群来源的本地工作区工具始终机械只读；Telegram 回复、表情、编辑和附件由桥自身负责，绝不受这道边界影响。
- 命令和文件审批按[命令审批](#命令审批)那一节的规则走。

这里的"只读"是一条文件系统写入边界，不等于"没有任何可读工具"：群聊 turn 依然能对沙箱可见的文件跑只读 shell 操作。群 prompt 会告诉模型不要用工具，写入/网络审批也会被拒，但这不是密码学意义上的硬保证。

这终究是一个远程控制面。`allowedUserIds` 要收紧，bot token 要保密，共享账号上不要开工具模式。

## Prompt 协议和作用域隔离

桥默认只用一个常驻 CLI 会话，所以私聊、群聊和任何接进来的终端共享同一份历史。这正是 daemon 模式的意义——但也意味着风格和隐私的串味需要你自己管：

- 稳定的 Telegram 规则写在工作区的 `AGENTS.md` 里，从 `AGENTS.example.md` 开始改。
- 每轮的 prompt 刻意很短：一个模式标记（如 `TG_PRIVATE`、`TG_GROUP_BATCH`）加一段带当前消息的 JSON 载荷。
- 群 profile 定义在 `AGENTS.md` 里，通过短短的 `profile` 键选中。
- 群来源的本地写入始终拒绝；私聊工具仍跟随全局 `privateToolsEnabled`，Telegram 通信始终可用。

需要更强隔离，就跑多个桥实例、用各自的 thread。

## 仅 @ 触发和最近上下文

安静的群保持 `requireMention: true`。桥不会去接普通群消息，但仍会在内存里记住最近投递到的那些。当有人 @ 它、回复它，或者用了 `mentionPatterns` 里的唤醒词时，最近的消息会作为上下文一起带过去，这样 Codex 才看得懂"上面那个东西"指的是什么。

`mentionContext.messageCount` 默认是 `10`。这份历史只在内存里。

一个重要的 Telegram 限制：机器人只能记住 Telegram 真的投递给它的消息。如果 BotFather 的 Privacy Mode 开着，普通群消息可能根本到不了桥这边。想要"被叫时带上前情"，就把那些群的 Privacy Mode 关掉。

## 附件

Telegram 的 `photo` 消息和图片文档会下载到 `telegram-images/`，作为 `localImage` 输入交给 Codex。

普通文件下载到 `telegram-files/`。桥会把文件元信息、本地路径和可提取的文本预览一起放进 prompt。

`.txt`、`.md`、`.json`、`.csv`、`.html`、`.js`、`.ts`、`.py`、`.yaml` 这类常见文本/代码/数据文件会直接抽取预览。macOS 上 `.doc`、`.docx`、`.rtf`、`.odt` 在有 `textutil` 时会调用它。不支持的二进制文件照样会下载，但只带元信息和路径；Codex 被明确告知，没有预览时不要假装自己读过文件内容。

附件缓存已在 git 忽略之列。默认跳过超过 10 MB 的图片和超过 20 MB 的文件。

## 本地 outbox

开启 `"outboxEnabled": true` 之后，往 `.state/outbox.jsonl` 追加一行就能发消息：

```bash
echo '{"chatId":"123456789","text":"备份完成"}' >> .state/outbox.jsonl
```

适合定时任务和脚本——不用再申请第二个 bot token 就能发到同一个对话里。不写 `chatId` 就发给 owner。

## 测试

```bash
npm run check   # 检查每个模块的语法
npm test        # 跑完整测试
```

测试覆盖了安全敏感的部分：危险命令名单、写入目标解析、自动批准白名单、密钥遮蔽、外部/终端 turn 的审批路由、群开关门指令的授权、可靠收件箱的崩溃重放，以及 desktop-sync 的 SQL 编码。

改动 `command-policy.mjs`、`redact.mjs`、`gate-command.mjs`、`durable-update-inbox.mjs`，或者两个 Codex 客户端里的审批路径之后，**必须**跑一遍。其中好几条用例，都是因为早期版本真的漏过一个 bug 才写下来的。

## Token 轮换

如果你把 token 贴进过聊天、issue 或日志，就换掉它：

1. 打开 [@BotFather](https://t.me/BotFather)。
2. 用 `/revoke` 或 token 管理流程。
3. 替换 `.env` 里的 `TELEGRAM_BOT_TOKEN`（或更新 Keychain 条目）。
4. 重启桥。

永远不要提交 `.env`。

## macOS LaunchAgent

模板在 `launchd/com.example.kimi-bridge.plist`。

先改路径，再安装：

```bash
cp launchd/com.example.kimi-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.kimi-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.kimi-bridge
```

查看状态：

```bash
launchctl print gui/$(id -u)/com.example.kimi-bridge
```

`/restart_bridge` 能生效，靠的就是 `KeepAlive`：桥退出，launchd 几秒内把它拉起来。任何"退出即重启"的进程管理器（systemd、pm2 等）同理。

## 安全注意事项

- 永远不要提交 `.env`、`config.json`、`.state/`、日志、下载的图片和文件。
- `allowedUserIds` 要收窄；如果不止一个用户，显式设好 `ownerUserId`。
- 不需要就别开私聊工具模式。
- 群级的 `allowAllBotUsers` 可能造成接龙循环。只临时用，或者配一个很严的 `maxConsecutiveBotMessages`。
- 不要把 `toolWritableRoots` 设成家目录或根目录。
- `liveLogEnabled` 会把明文聊天内容写到磁盘上。它默认关闭是有原因的。
- `desktopSync` 会写 Codex 自己的状态数据库。不需要那一行侧边栏记录就别开。

## 常见问题

- 收不到群消息：在 BotFather 里关掉 Privacy Mode。
- 看不见别的 bot：在 BotFather 里打开 Bot to Bot Communication Mode。
- 在某个群里没反应：把群 ID 加进 `allowedGroups`，或者在群里发 `/<前缀>_on`。
- 回话太频繁：打开 `requireMention`，或调低 `maxConsecutiveBotMessages`。
- 图片被忽略：确认 Telegram 是以 `photo` 或图片文档发的，且不超过 `imageMaxBytes`。
- 文件被忽略：确认没超过 `fileMaxBytes`；如果没有文本预览，看看是不是二进制或不支持的格式。
- 私聊工具不干活：查 `/tools`，确认 `privateToolsEnabled: true`，并确认目标路径在 `toolWritableRoots` 内。
- 终端窗口报只读：你 attach 的时候没带 `-s workspace-write --add-dir`，见[上面第 3 步](#3-给终端窗口配一条快捷命令)。
- Telegram 里有回复但终端里什么都看不到：要么还在 spawn 模式，要么 TUI resume 的 thread id 和 `.state/session.txt` 里的不是同一个。
- 桥起来了但每条消息都报 thread 错误：锁定的 thread 恢复失败了。这是刻意的——它绝不会静默新建一个替代 thread，因为那在对话里读起来就是失忆。用 `/resume <thread-id>` 或 `/new` 明确处理。

## License

MIT
