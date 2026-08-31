# Telegram Kimi Bridge

A small, zero-dependency Telegram Bot API bridge that connects a Telegram bot to a persistent **Kimi Code CLI** session — with the original Codex engines still supported.

It supports private chats, group chats, mention-only mode, delta group context, batched group replies, bot-loop limits, outbound rate limiting, image and file attachments, optional private-chat tool execution, owner-approved command execution, and crash-safe message delivery. In `tui` mode the Kimi TUI stays alive in a tmux session you can attach to, so Telegram and your terminal look at the same running assistant.

中文文档见 [README.zh-CN.md](README.zh-CN.md).

> **Derived from [Codex-tg-Bridge](https://github.com/HailSyner/Codex-tg-Bridge).**
> This project started as a copy of that bridge and adds a Kimi Code CLI engine
> (`codexMode: "kimi"`) alongside the original Codex `spawn` / `daemon` modes.
> All of the transport-level work — delta group context, batched replies,
> crash-safe delivery, the approval model, rate limiting — comes from there.
> If you want a Codex bridge, use the upstream project directly.

## What This Is

Telegram Kimi Bridge lets you run a Telegram bot as a lightweight front end for a persistent Kimi Code CLI session. It is designed for personal automation, small trusted groups, and bot-to-bot workflows where you want your CLI assistant available from Telegram — and, if you want it, from a terminal window showing the very same session.

## Requirements

- macOS, Linux, or another machine that can run Node.js
- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) installed and authenticated on the same machine
  (or Codex, if you want to run one of the original `codexMode` engines)
- `tmux` on PATH — only for `kimiEngine: "tui"`
- The Telegram bot must be able to receive the messages you want:
  - Disable BotFather Privacy Mode if the bot should see all group messages.
  - Enable bot-to-bot communication if you want another bot to trigger it.

## Quick Start

```bash
git clone https://github.com/HailSyner/Kimi-tg-Bridge.git
cd Kimi-tg-Bridge
cp .env.example .env
cp config.example.json config.json
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=1234567890:your-real-token
```

Edit `config.json`:

- Set `allowedUserIds` to your Telegram numeric user ID.
- Set `workdir` to the folder where the CLI should run.
- Set `codexMode` to `"kimi"` and point `kimiPath` at your `kimi` binary.
- Add any group chat IDs under `allowedGroups`.
- Leave `privateToolsEnabled` as `false` until you understand the tool safety model.

Copy the protocol from `AGENTS.example.md` into the `AGENTS.md` file for your configured `workdir`. Put long persona, privacy, and group-profile rules there. Do not put long behavior prompts in `config.json`; the bridge sends only short mode markers plus dynamic Telegram payloads on each turn.

Then run:

```bash
npm run check
npm start
```

Send `/start` to your bot in Telegram. If your user ID is authorized, it should reply.

## Telegram Commands

Private-chat commands:

- `/start`: confirm the bridge is reachable.
- `/status`: bridge mode, active thread, group counts, and the delivery queue (pending, in-flight, dead-lettered).
- `/session`: show the active session ID.
- `/resume <session-id>` or `/attach <session-id>`: switch the bridge to an existing session.
- `/tools`: show whether private tool mode is enabled, writable roots, network mode, and the group-chat read-only rule.
- `/new`: start a fresh session while preserving the previous session ID locally.
- `/retry_update <update-id>`: put one dead-lettered Telegram update back in the queue.

Owner-only operations:

- `/reload_config`: re-read `config.json` in place and hot-swap `allowedGroups`, `mentionPatterns`, and `mentionContext`. Static fields (`codexMode`, `model`, `timeoutMs`, `keychain*`) still need a restart.
- `/restart_bridge`: exit cleanly so the process manager restarts the bridge. The replacement process edits the original "restarting" message into a confirmation.
- `/restart_daemon`: restart the Codex daemon via `launchctl kickstart` without stopping the bridge (macOS + Codex daemon mode only).
- `/force_restart_bridge`, `/force_restart_daemon`: same, but allowed while a turn is in flight. Without `force_`, both refuse rather than interrupting work.

Group commands (see [Dynamic Group Authorization](#dynamic-group-authorization)):

- `/<prefix>_on`, `/<prefix>_off`, `/<prefix>_all`, `/<prefix>_quiet`
- `/flow <1-20>`, `/flow off`, `/flow`: temporarily override, clear, or inspect the bot-to-bot consecutive-message limit for the current group. The override expires after six hours; larger values are reported and clamped to 20.

## Getting Telegram IDs

Invite [@getidsbot](https://t.me/getidsbot) to a chat, then use its output:

- Your private user ID goes into `allowedUserIds`.
- Group IDs go under `allowedGroups`.
- Bot IDs can be listed in group `allowedUserIds` if you want specific bots to trigger this bot.

Group IDs usually look like `-1001234567890`.

## Configuration

See `config.example.json` for the full set. The options that matter most:

| Key | Meaning |
| --- | --- |
| `botName` / `ownerName` | Names included in the short Telegram payload. |
| `allowedUserIds` | Telegram user IDs allowed to use private chat. |
| `ownerUserId` | Who may use ops commands, approval buttons, and gate commands. Defaults to the first entry of `allowedUserIds`. |
| `mentionPatterns` | Extra wake words. In a `requireMention` group, a message containing one of these counts as addressing the bot. |
| `gateCommandPrefix` | Prefix for the group gate commands. Defaults to `botName`. |
| `workdir` | Working directory for the CLI. |
| `model` | Model override passed to the CLI. `reasoningEffort` / `serviceTier` apply to the Codex engines only. |
| `privateToolsEnabled` | When `true`, private chats can run the CLI in restricted workspace-write mode. |
| `toolWritableRoots` | Absolute (or config-relative) paths private tool mode may write inside. |
| `toolNetworkAccess` | Network access for private tool mode. Default `false`. |
| `codexMode` | `"kimi"` (Kimi Code CLI), or the inherited Codex engines `"spawn"` / `"daemon"`. |
| `kimiPath` | Path to the `kimi` binary. |
| `kimiEngine` | `"spawn"` (headless, one process per turn) or `"tui"` (persistent TUI in tmux). |
| `tmuxSession` | tmux session hosting the Kimi TUI. `kimiEngine: "tui"` only. |
| `nativeVision` | `true` if the model reads images itself; otherwise a vision model transcribes them. |
| `maxDeltaChars` | Character budget for group delta context (default 4000, `0` disables). |
| `daemonSocketPath` | Override the daemon socket. Empty means `$CODEX_HOME/app-server-control/app-server-control.sock`. |
| `daemonLaunchdLabel` | launchd label used by `/restart_daemon`. |
| `approvalTimeoutMs` | How long an approval card waits before auto-declining. Default 60000. |
| `desktopSync` | Codex engines only. Opt-in: rewrite this thread's row in the Codex Desktop sidebar. |
| `liveLogEnabled` | Opt-in: write a local JSONL transcript of every message in and out. |
| `outboxEnabled` | Opt-in: let local scripts send messages by appending to a file. |

Per-group options:

- `requireMention`: when `true`, group messages must mention the bot, reply to it, or hit a `mentionPatterns` wake word.
- `allowAllHumanUsers` / `allowAllBotUsers`: let any human / any bot in that group trigger the bridge. Use `allowAllBotUsers` carefully.
- `allowUnaddressedBotMessages`: lets listed bot users trigger without mentioning this bot.
- `maxConsecutiveBotMessages`: stops accidental bot-to-bot loops. Any human message resets the counter.
- `disableReplyQuote`: send replies without quoting, which keeps two chatty bots from building a visible reply chain.
- `mentionContext`: how much recent group history to keep and deliver.
- `profile`: short key included in the payload so your `AGENTS.md` can select the matching group profile.
- `batchTiming`: per-group collection windows. Use longer windows for busy groups to reduce model calls.

`promptInstructions` is intentionally not used. Long group behavior and privacy rules belong in `AGENTS.md`, not in per-message bridge prompts.

### Storing the token in the macOS Keychain

Instead of `.env`, you can keep the token out of the filesystem entirely:

```bash
security add-generic-password -U -a bot-token -s com.example.kimi-bridge -w 'YOUR_TOKEN'
```

Then add to `config.json`:

```json
{
  "keychainService": "com.example.kimi-bridge",
  "keychainAccount": "bot-token"
}
```

`TELEGRAM_BOT_TOKEN` in the environment always wins if both are present.

## Terminal ↔ Telegram: One Session

This is the part that makes the bridge feel less like a bot and more like one assistant you can reach from two places.

With `codexMode: "kimi"` there are two engines, selected by `kimiEngine`.

### `kimiEngine: "spawn"` (default)

Headless, one process per turn. Each turn runs:

```bash
kimi [--session <id>] -p <prompt> --output-format stream-json
```

and reads two kinds of JSONL lines back from stdout:

```
{"role":"assistant","content":"..."}                        -> the reply
{"role":"meta","type":"session.resume_hint","session_id":…}  -> the session anchor
```

There is no long-lived child process. The session id is what carries the conversation
forward, and the bridge persists it so a restart resumes the same session instead of
starting a new one. Resuming a session that no longer exists exits non-zero with
`Session "<id>" not found.` — the bridge keys its fail-closed detection on exactly that,
rather than silently opening a fresh session and losing your history.

Simple and robust, but your terminal shows nothing.

### `kimiEngine: "tui"`

Turns are injected into a **persistent interactive Kimi TUI** running inside a tmux
session (`tmuxSession`, default `skald-tg`). Attach to that tmux and you see the real
interface — thinking, tool calls, approval dialogs — while Telegram talks to the same
live session. Replies are captured from the session's `wire.jsonl`.

```bash
tmux attach -t skald-tg
```

Two dialogs are invisible from Telegram and are handled for you:

- **Tool approval** — forwarded to the owner as a Telegram card with Approve / Decline
  buttons (see [Approval Requests](#approval-requests)). Without this a TUI turn needing
  approval would hang on a dialog only visible at the keyboard.
- **Cache expiry** — answered automatically with *Continue as-is*, preserving the full
  context, and logged so the choice is visible.

A turn is re-injected at most three times before the bridge gives up; unbounded retries
would flood the pane with identical pastes.

The reply extractor only accepts text after the matching `turn.prompt`. Text that merely
arrives after injection may belong to an older terminal turn, so it is never reassigned to
the new Telegram message. Relay-file markers likewise accept regular files below the relay
directory only; symlink components are rejected.

### Group context has a character budget

`recentGroupContextDelta` is capped by **both** a message count (`maxStoredMessages`)
and a character budget (`maxDeltaChars`, default 4000). Count alone is not enough: in an
active group with `requireMention: true`, a bot that has not been mentioned for a while
accumulates a large unread delta, and one oversized batch can be rejected outright by an
upstream content filter. Worse, once such a turn lands in the session history every later
request carries it — including compaction — which can wedge the session permanently.

When the budget is exceeded the **oldest** unread messages are dropped, the most recent
are kept, and `omitted` is set so the model knows earlier messages exist rather than
assuming it saw everything. Set `maxDeltaChars: 0` to disable the budget.

### The original Codex engines

`codexMode: "spawn"` and `codexMode: "daemon"` are inherited from
[Codex-tg-Bridge](https://github.com/HailSyner/Codex-tg-Bridge) and still work — daemon
mode shares one live `codex app-server` thread between Telegram and a `codex --remote`
terminal. That setup, its LaunchAgent, the Codex Desktop sidebar sync and its trade-offs
are documented in the upstream project; they are not repeated here.

### How approvals behave for terminal turns

In `tui` mode the bridge sees approval requests for *every* turn in the shared session, including turns you started at the keyboard. It deliberately does not answer those as if they were its own:

- A dangerous command is still refused outright, whoever started it.
- A malformed file-change payload is refused, because a blank card is not a decision anyone can make.
- Everything else from a turn the bridge did not start is forwarded to the owner as a Telegram card — never auto-approved, even when every target is inside `toolWritableRoots`.

Before this rule existed, the bridge silently declined approvals belonging to the owner's own terminal session, and a harmless command typed at the keyboard would be refused twice with no explanation. Group turns are unaffected: their turn ids are known to the bridge and stay hard read-only.

## Approval Requests

When `privateToolsEnabled` is on, the CLI asks before running commands or writing files. The bridge sorts those requests into three buckets:

1. **Auto-approved** — only side-effect-free inspection commands (`ls`, `cat`, `rg`, `git status/diff/log`, …) with no shell composition, substitution or redirection, running inside `toolWritableRoots`. Being inside the roots is not by itself enough.
2. **Auto-declined** — dangerous commands (recursive deletion, `sudo`, hard reset, force push, disk operations, destructive `launchctl`, piping into a shell, token-shaped text), anything during a read-only or group turn, and malformed payloads.
3. **Forwarded to you** — everything else, as a Telegram card with the command, its cwd, and any write targets outside the roots, plus two buttons: **✅ Approve** / **❌ Decline**.

Details worth knowing:

- **Every file write is forwarded**, including paths inside the writable roots. There is no silent write.
- A command whose cwd is safe can still write elsewhere via `>`, `cp`, `mv`, `tee`, `dd of=`, or `curl -o`. Those targets are extracted and listed on the card.
- There is no "approve for the rest of this turn". Every request needs its own tap.
- Unanswered cards auto-decline after `approvalTimeoutMs` (default 60s) and the card is edited to say so. If the daemon connection drops or the bridge force-restarts while a card is pending, it is edited to say it is no longer valid rather than being left looking actionable.
- Command and path text is redacted for common secret shapes (OpenAI/Anthropic keys, GitHub tokens, AWS keys, Bearer tokens, JWTs, PEM blocks, URL credentials, generic `key=value` pairs) before it leaves the machine.
- In `kimiEngine: "spawn"` there is no asynchronous approval channel, so file changes are declined rather than silently approved. Use `tui` mode if you want the buttons.

## Group Context: Delta Delivery

Re-sending the same recent messages on every mention wastes tokens and makes the model re-read what it already answered. Instead, each `(chatId, threadId)` pair keeps a cursor of the highest message id it has processed:

- A group turn receives only messages newer than the cursor, as `recentContextDelta`.
- `contextWindow.omittedPreviouslySentMessages` tells the model that older messages were left out because it already read them — not that nothing happened before.
- The cursor advances only after every reply in the batch has been accepted by Telegram. A model or send failure keeps the old cursor so a retry still sees those messages.
- Delta delivery never takes only the newest tail: every still-buffered unseen message is delivered, so a small display window cannot silently skip older context.
- The cursor key includes the thread id, so only an explicit `/new` or `/resume` starts a fresh context window.

Cursors live in `.state/group-context-cursors.json` (0600, atomic write).

## Reliable Delivery

Every inbound update is fsync'd to a journal **before** the Telegram poll offset advances, so a crash replays instead of dropping messages.

- Preparation and enqueue happen in `update_id` order; completion is recorded only after the actual send finishes.
- Private model output and its generating thread id are fsync'd before delivery, so a crash after generation re-sends the cached reply rather than adding a second model turn to the thread.
- Group generation fsyncs the exact batch membership, the parsed replies, the generating thread, and each accepted reply index. Recovery never regroups an old batch with newer input, and never resends a reply already acknowledged locally.
- `/new`, `/resume`, `/reload_config`, `/retry_update` and both restart commands use an operation intent/result journal, so a replay does not repeat a completed thread switch or loop a restart.
- Repeated failures back off exponentially and end in a visible dead-letter entry instead of silently advancing. `/status` shows the counts; `/retry_update <id>` requeues one.
- The operational journal compacts over time, but every accepted raw update is also fsync'd once to an append-only archive that is never rotated.

Delivery is intentionally at-least-once. A rare duplicate outbound message is still possible if Telegram accepts `sendMessage` but the network response is lost before the bridge observes it — Telegram exposes no idempotency key that can close that gap. A duplicate *model turn* is prevented by the cached output.

## Dynamic Group Authorization

Adding the bot to a new group normally means editing `config.json` and restarting. These owner-only commands do it from inside the group, in real time. The prefix comes from `gateCommandPrefix` (defaulting to `botName`), so a bot named `Kimi` answers to:

- `/<prefix>_on` — authorize this group, with conservative defaults (mention-only, no unaddressed bot messages, low bot-loop limit)
- `/<prefix>_off` — remove that authorization
- `/<prefix>_all` — read every message in this group
- `/<prefix>_quiet` — back to mention-only

Dynamic authorizations live in `.state/dynamic-groups.json` (0600) and are a separate layer from `allowedGroups`. These commands never edit `config.json` and never remove a statically configured group. A non-owner attempt is consumed with a short refusal, and a corrupt state file fails closed rather than being silently replaced.

## Private Tool Mode

By default the bridge is read-only. Set `privateToolsEnabled: true` only if you want Telegram private chats to perform local Codex work.

When private tool mode is enabled:

- Private chats use a restricted `workspaceWrite` sandbox.
- Writes are limited to `toolWritableRoots`.
- Network access is disabled unless `toolNetworkAccess: true`.
- Group-origin workspace tools are always mechanically read-only; Telegram replies, reactions, edits, and attachments are bridge-owned and never blocked by this boundary.
- Command and file approvals follow the rules in [Approval Requests](#approval-requests).

Read-only here is a filesystem-write boundary, not a claim that read-capable tools are absent: a group turn can still run read-only shell operations against files the sandbox can see. The group prompt tells the model not to use tools and write/network approvals are denied, but this is not a cryptographic no-tools guarantee.

This is a remote-control surface. Keep `allowedUserIds` strict, keep your bot token private, and do not enable tool mode on a shared account.

## Prompt Protocol And Scope Isolation

The bridge uses a single persistent CLI session by default, so private chats, group chats and any attached terminal share one history. That is the point of daemon mode — but it means style and privacy bleed are your responsibility:

- Stable Telegram rules live in your workspace `AGENTS.md`; start from `AGENTS.example.md`.
- Per-turn prompts are intentionally small: a mode marker such as `TG_PRIVATE` or `TG_GROUP_BATCH` plus a JSON payload with the current message(s).
- Group profiles are defined in `AGENTS.md` and selected by the short `profile` key.
- Group-origin workspace writes are always denied. This never disables Telegram transport tools; private-chat tools still follow the global `privateToolsEnabled` setting.

If you need stronger isolation, run separate bridge instances with separate threads.

## Mention-Only With Recent Context

For quieter groups, keep `requireMention: true`. The bridge will not answer ordinary group messages, but it still remembers the latest delivered ones in memory. When someone mentions the bot, replies to it, or uses a `mentionPatterns` wake word, recent messages travel along as context so Codex understands references like "that thing above".

The default `mentionContext.messageCount` is `10`. This history is in memory only.

Important Telegram limitation: the bot can only remember messages Telegram actually delivers. If BotFather Privacy Mode is enabled, ordinary group messages may never reach the bridge. Disable Privacy Mode for groups where you want mention-triggered context.

## Attachments

Telegram `photo` messages and image documents are downloaded into `telegram-images/` and passed to the CLI as `localImage` inputs.

Regular files are downloaded into `telegram-files/`. The bridge includes file metadata, the local path, and any extractable text preview in the prompt.

Text previews are extracted directly for common text/code/data files such as `.txt`, `.md`, `.json`, `.csv`, `.html`, `.js`, `.ts`, `.py`, `.yaml`. On macOS, `.doc`, `.docx`, `.rtf` and `.odt` use `textutil` when available. Unsupported binary files are still downloaded, but only metadata and the path are included; Codex is told not to pretend it read a body it never saw.

Attachment caches are ignored by git. By default, images over 10 MB and files over 20 MB are skipped.

## Local Outbox

With `"outboxEnabled": true`, appending a line to `.state/outbox.jsonl` sends a message:

```bash
echo '{"chatId":"123456789","text":"backup finished"}' >> .state/outbox.jsonl
```

Useful for cron jobs and scripts that want to reach the same chat without a second bot token. Omit `chatId` to send to the owner.

## Tests

```bash
npm run check   # syntax check every module
npm test        # full suite
```

The suite covers the security-sensitive parts: the dangerous-command list, the write-target extractor, the auto-approve allowlist, secret redaction, approval routing for external/terminal turns, gate-command authorization, crash replay of the durable inbox, and the desktop-sync SQL encoding.

Run it after **any** change to `command-policy.mjs`, `redact.mjs`, `gate-command.mjs`, `durable-update-inbox.mjs`, or the approval paths in either Codex client. Several of those cases exist because a real bug slipped through an earlier version.

## Token Rotation

If you paste a token into a chat, issue tracker, or log, rotate it:

1. Open [@BotFather](https://t.me/BotFather).
2. Use `/revoke` or the token-management flow for your bot.
3. Replace `TELEGRAM_BOT_TOKEN` in `.env` (or update the Keychain entry).
4. Restart the bridge.

Never commit `.env`.

## macOS LaunchAgent

A LaunchAgent template is included in `launchd/com.example.kimi-bridge.plist`.

Edit paths first, then install:

```bash
cp launchd/com.example.kimi-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.kimi-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.kimi-bridge
```

Check status:

```bash
launchctl print gui/$(id -u)/com.example.kimi-bridge
```

`KeepAlive` is what makes `/restart_bridge` work: the bridge exits, launchd starts it again within seconds. Any supervisor that restarts on exit (systemd, pm2, …) works the same way.

## Safety Notes

- Never commit `.env`, `config.json`, `.state/`, logs, downloaded images, or downloaded files.
- Keep `allowedUserIds` narrow, and set `ownerUserId` explicitly if more than one user is allowed.
- Keep private tool mode off unless you need it.
- Group-wide `allowAllBotUsers` can create loops. Use it temporarily or with a strict `maxConsecutiveBotMessages`.
- Do not set `toolWritableRoots` to your home directory or filesystem root.
- `liveLogEnabled` writes plaintext chat content to disk. It is off by default for a reason.
- `desktopSync` (Codex engines only) writes into Codex's own state database. Leave it off unless you want the sidebar row.

## Troubleshooting

- No group messages arrive: disable Privacy Mode in BotFather.
- Bot cannot see other bots: enable Bot to Bot Communication Mode in BotFather.
- Bot ignores a group: add the group ID to `allowedGroups`, or send `/<prefix>_on` in the group.
- Bot replies too often: turn on `requireMention` or lower `maxConsecutiveBotMessages`.
- Images are ignored: make sure Telegram sends them as `photo` or image documents under `imageMaxBytes`.
- Files are ignored: make sure they are under `fileMaxBytes`; if a file has no text preview, check whether its format is binary or unsupported.
- Private tool work does not happen: check `/tools`, confirm `privateToolsEnabled: true`, and make sure the target path is inside `toolWritableRoots`.
- The terminal window says read-only: you attached without `-s workspace-write --add-dir`. See [step 3 above](#3-add-a-shortcut-command-for-the-terminal-window).
- The bot answers in Telegram but the terminal shows nothing: you are still in spawn mode, or the TUI resumed a different thread id than `.state/session.txt`.
- The bridge starts but refuses every message with a thread error: the locked thread could not be resumed. This is deliberate — it never silently creates a replacement thread, because that reads as amnesia. Use `/resume <thread-id>` or `/new`.

## License

MIT
