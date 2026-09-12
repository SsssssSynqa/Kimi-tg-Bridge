#!/usr/bin/env node
import { deliverDurableNotice } from './durable-notice-outbox.mjs';

// Telegram <-> Codex bridge.
//
// One Telegram bot, one persistent Codex thread. Private chats, group chats,
// and (in daemon mode) a `codex --remote` terminal session all talk to the
// same thread, so the conversation is continuous no matter where it happens.
//
// The pieces that are easy to miss when reading top to bottom:
//   - Durable inbox: every Telegram update is fsync'd before the poll offset
//     advances, so a crash replays instead of dropping messages.
//   - Delta group context: each (chat, thread) pair remembers the last message
//     id it has already seen, and only newer messages are sent as context.
//   - Approval forwarding: requests that are neither clearly safe nor clearly
//     dangerous become a Telegram card with Approve/Decline buttons.
//   - Desktop sync (opt-in): rewrites the thread's row in the Codex Desktop
//     sidebar so a bridge conversation is findable there.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexAppClient } from './codex-client.mjs';
import { CodexDaemonClient } from './codex-daemon-client.mjs';
import { KimiCliClient } from './kimi-client.mjs';
import { syncDesktopMetadata } from './desktop-sync.mjs';
import { deliverDurablePrivateReply, DurableUpdateInbox } from './durable-update-inbox.mjs';
import { createDowntimeHooks, handleCatchupCommand } from './downtime-hooks.mjs';
import { handleGateCommand, normalizeGatePrefix, readDynamicGroups } from './gate-command.mjs';
import { canTriggerInGroup } from './group-membership.mjs';
import { buildTelegramReplyContext } from './telegram-reply-context.mjs';
import { splitTelegramText } from './telegram-text-split.mjs';
import { createRequire as __flowRequire } from 'node:module';
// 全家共用的续场开关（/flow N）。四座桥各自独立进程、模块系统还不一样，
// 所以状态放在一个大家都读的文件里，Synqa 发一条命令四座都认。
const groupFlow = __flowRequire(import.meta.url)('./group-flow.cjs');
const groupMigration = __flowRequire(import.meta.url)('../../../shared/group-migration.cjs');

// Synqa 的表情＝放行信号（2026-08-31）。
//
// 她的原话：群里几个 bot 在一起时连发上限一到就停，"强制插话我也很尴尬啊！
// 我就只能『Syner加油』"。计数器只认人类**消息**，于是她被迫当人肉复位键。
// 现在她点个表情就把该群计数器清零 —— 等于说了句"继续"，但不必真的开口。
//
// 只认 owner 的表情：否则任何群成员都能解开刷屏保护。
function handleOwnerReaction(update) {
  const r = update?.message_reaction;
  if (!r || !r.chat) return;
  const chatId = String(r.chat.id);
  if (!allowedUserIds.has(String(r.user?.id || ''))) return;
  // 只在真的加了表情时放行；取消表情不算。
  if (!Array.isArray(r.new_reaction) || !r.new_reaction.length) return;
  const had = groupBotRuns.get(chatId) || 0;
  if (!had) return;
  groupBotRuns.set(chatId, 0);
  const emoji = r.new_reaction.map((x) => x?.emoji || x?.type).filter(Boolean).join('');
  log(`[reaction] owner 表情放行 chat=${chatId} emoji=${emoji} 连发计数 ${had} → 0`);
}

// /flow N ｜ /flow off ｜ /flow —— 全家共用的续场开关。四座桥都执行写入（幂等），
// 但**只有一座回话**：谁先抢到这条命令的回执锁谁说，其余静默。否则 Synqa 发一条
// 命令收四条确认，比原来更吵 —— 她要的正是"发一次就行，不用挨个点名"。
async function handleFlowCommand({ rawText, chatId, fromId, messageId, send, isOwner }) {
  const command = groupFlow.parseFlowCommand(rawText);
  if (!command) return false;
  if (!isOwner) return true;
  const result = groupFlow.applyFlowCommand(chatId, command);
  let speak = false;
  try {
    const lockDir = path.join(os.tmpdir(), 'synergia-flow-ack');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `${chatId}-${messageId}`), 'ack', { flag: 'wx' });
    speak = true;
  } catch (_) { speak = false; }
  if (!speak) return true;
  if (result.action === 'set') {
    const until = new Date(result.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    // 被削顶时如实说出来，不假装她写的数生效了。
    const note = result.clamped ? `（你写的是 ${result.asked}，上限 ${result.maxLimit}，按 ${result.limit} 生效）` : '';
    await send(`续场模式：连发上限临时抬到 ${result.limit}${note}（${until} 自动恢复，或 /flow off 手动关）。全家都收到了。`);
  } else if (result.action === 'clear') {
    await send(result.had ? '续场模式已关，连发上限回到默认。' : '本来就没开着。');
  } else {
    await send(result.limit ? `续场模式开着，上限 ${result.limit}。` : '续场模式没开，走默认上限。');
  }
  return true;
}

import {
  GroupConversationBatcher,
  PriorityTaskQueue,
  isNonConversationalBotMessage,
  isStopInstruction,
  parseBatchReplies,
} from './group-batcher.mjs';
import { SendRateLimiter } from './rate-limit.mjs';
import { redactSensitiveText } from './redact.mjs';
import {
  buildMessageTextWithAttachments,
  downloadTelegramAttachments,
  getTelegramMessageEntities,
  getTelegramMessageText,
  hasTelegramAttachments,
} from './telegram-image-utils.mjs';
import { PendingGroupImages } from './pending-group-images.mjs';
import { createPollStallWatchdog, DEFAULT_STALL_MS } from './poll-stall-watchdog.mjs';
import { createAlbumBatcher, DEFAULT_ALBUM_WINDOW_MS } from './telegram-album-batcher.mjs';
import { withTransportRetry } from './telegram-transport-retry.mjs';
import { telegramToolMode } from './tool-mode-policy.mjs';
import { buildHandoffPrompt, writeHandoff } from './handoff.mjs';
import {
  DEFAULT_THRESHOLDS,
  crossedThresholds,
  formatContextAlert,
  parsePaneContextPercent,
  // 2026-08-16 修：这个一直在 checkContextUsage 里被调用却从没 import 过，
  // ReferenceError 被那圈 catch 吞掉了 —— 水位报警的 tokensLabel 一直是空的。
  parsePaneContextLabel,
  readWireContextTokens,
} from './context-usage.mjs';
import {
  buildCarryover,
  buildWakePrompt,
  carryoverMessage,
  writeCarryoverFile,
} from './carryover.mjs';

const DEFAULT_CONFIG = Object.freeze({
  botName: 'Codex',
  ownerName: 'the authorized user',
  allowedUserIds: [],
  ownerUserId: '',
  allowedGroups: {},
  mentionPatterns: [],
  gateCommandPrefix: '',
  codexPath: '/usr/local/bin/codex',
  codexMode: 'spawn',
  kimiPath: 'kimi',
  daemonSocketPath: '',
  daemonLaunchdLabel: 'com.example.codex-daemon',
  workdir: process.cwd(),
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  serviceTier: 'fast',
  privateToolsEnabled: false,
  toolWritableRoots: [],
  toolNetworkAccess: false,
  timeoutMs: 600000,
  imageMaxBytes: 10 * 1024 * 1024,
  fileMaxBytes: 20 * 1024 * 1024,
  attachmentTextMaxChars: 12000,
  desktopSync: false,
  liveLogEnabled: false,
  liveLogMaxChars: 6000,
  outboxEnabled: false,
  outboxPollMs: 1000,
  approvalTimeoutMs: 60000,
  groupQueueMaxPerChat: 100,
  privateQueueMax: 50,
  updateMaxInFlight: 100,
  updateJournalCompactBytes: 8 * 1024 * 1024,
  updateMaxAttempts: 12,
  updateRetryBaseMs: 3000,
  updateRetryMaxMs: 5 * 60 * 1000,
  mentionContext: {
    enabled: true,
    messageCount: 10,
    maxStoredMessages: 50,
    maxMessageChars: 800,
    recordAllDeliveredMessages: true,
  },
  rateLimit: {
    enabled: true,
    minIntervalMs: 10000,
  },
  batchTiming: {},
});

// Structured output for group turns: at most two replies, each optionally
// quoting a message id. Malformed output is dropped rather than published.
const GROUP_REPLY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['replies'],
  properties: {
    replies: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'replyToMessageId'],
        properties: {
          text: { type: 'string' },
          replyToMessageId: { type: ['integer', 'null'] },
        },
      },
    },
  },
});

function parseArgs(argv) {
  const args = { configPath: 'config.json', checkOnly: false, testPrompt: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') args.configPath = argv[++index];
    else if (arg === '--check') args.checkOnly = true;
    else if (arg === '--test') args.testPrompt = argv.slice(index + 1).join(' ') || 'Say hello in one sentence.';
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readEnvFile(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {}
}

function readPrivateFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

// Atomic + fsync'd. Session ids and poll offsets must survive a crash or power
// loss intact; a half-written offset would replay or skip real messages.
function writePrivateFile(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
  let directoryFd;
  try {
    directoryFd = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryFd);
  } catch {
    // Directory fsync is not supported on every filesystem.
  } finally {
    if (directoryFd != null) fs.closeSync(directoryFd);
  }
}

function resolvePath(baseDir, maybePath) {
  if (!maybePath) return maybePath;
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(baseDir, maybePath);
}

// 2026-09-10 Synqa 要求：全家在 TG 里读到的消息时间与各桥日志一律东八区并标注，
// 免得把 UTC 当本地时间算错。只作用于 ①喂给模型的 prompt ②人读的日志；
// durable journal / live log / pending images 等持久化字段保持 ISO UTC 不动。
// 不依赖宿主时区，将来搬 VPS 输出不变。
function tsCN(input = Date.now()) {   // 人读：2026-09-10 06:36:00+08
  const ms = input instanceof Date ? input.getTime() : Number(input);
  return `${new Date(ms + 288e5).toISOString().slice(0, 19).replace('T', ' ')}+08`;
}
function isoCN(input = Date.now()) {  // 模型读：严格 ISO 8601 带偏移
  const ms = input instanceof Date ? input.getTime() : Number(input);
  return `${new Date(ms + 288e5).toISOString().slice(0, 19)}+08:00`;
}

function log(message) {
  console.log(`${tsCN()} ${redactSensitiveText(message)}`);
}

const args = parseArgs(process.argv);
const configPath = path.resolve(args.configPath);
const bridgeRoot = path.dirname(configPath);
readEnvFile(path.join(bridgeRoot, '.env'));

const config = {
  ...DEFAULT_CONFIG,
  ...readJson(configPath),
};
config.rateLimit = { ...DEFAULT_CONFIG.rateLimit, ...(config.rateLimit || {}) };
config.batchTiming = { ...DEFAULT_CONFIG.batchTiming, ...(config.batchTiming || {}) };
config.mentionContext = { ...DEFAULT_CONFIG.mentionContext, ...(config.mentionContext || {}) };

const batchTimingKeys = [
  'singleMessageMs',
  'sameSenderIdleMs',
  'sameSenderMaxMs',
  'multiSenderIdleMs',
  'multiSenderMaxMs',
];

function normalizeBatchTiming(value = {}) {
  return Object.fromEntries(
    batchTimingKeys
      .map((key) => [key, Number(value?.[key])])
      .filter(([, number]) => Number.isFinite(number) && number >= 0),
  );
}

// The token never has to live in a file: put it in the environment, in .env,
// or (macOS) in the Keychain and reference it from config.
function readBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  if (!config.keychainService || !config.keychainAccount) return '';
  try {
    return execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', config.keychainAccount, '-s', config.keychainService, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    throw new Error(
      `Telegram token not found in Keychain: service=${config.keychainService} account=${config.keychainAccount}`,
    );
  }
}

const token = readBotToken();
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Put it in .env, the process environment, or the macOS Keychain.');
  process.exit(1);
}

const allowedUserIds = new Set((config.allowedUserIds || []).map(String));
if (!allowedUserIds.size) {
  console.error('config.allowedUserIds must contain at least one Telegram user id.');
  process.exit(1);
}

// Owner-only surfaces (ops commands, approval buttons, gate commands) answer
// to exactly one id. It defaults to the first allowed user.
const ownerUserId = String(config.ownerUserId || [...allowedUserIds][0]);
const gateCommandPrefix = normalizeGatePrefix(config.gateCommandPrefix || config.botName);

const allowedGroups = new Map(Object.entries(config.allowedGroups || {}));
const mentionPatterns = (config.mentionPatterns || []).map(String).filter(Boolean);
const mentionPatternsLower = mentionPatterns.map((value) => value.toLowerCase()).filter(Boolean);
const mentionContextGlobal = { ...config.mentionContext };
const globalGroupBatchTiming = normalizeBatchTiming(config.batchTiming || {});
const workdir = resolvePath(bridgeRoot, config.workdir);
const codexPath = config.codexPath || 'codex';
const kimiPath = config.kimiPath || DEFAULT_CONFIG.kimiPath;
const timeoutMs = Number(config.timeoutMs || DEFAULT_CONFIG.timeoutMs);
const privateToolsEnabled = config.privateToolsEnabled === true;
const toolWritableRoots = Array.isArray(config.toolWritableRoots) && config.toolWritableRoots.length
  ? config.toolWritableRoots.map((root) => resolvePath(bridgeRoot, root))
  : [workdir];
const stateDir = resolvePath(bridgeRoot, config.stateDir || '.state');
const imageCacheDir = resolvePath(bridgeRoot, config.imageCacheDir || 'telegram-images');
const fileCacheDir = resolvePath(bridgeRoot, config.fileCacheDir || 'telegram-files');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const sessionPath = path.join(stateDir, 'session.txt');
const previousSessionPath = path.join(stateDir, 'session.previous.txt');
const offsetPath = path.join(stateDir, 'offset.txt');
const dynamicGroupsPath = path.join(stateDir, 'dynamic-groups.json');
const groupContextCursorsPath = path.join(stateDir, 'group-context-cursors.json');
const pendingGroupImagesPath = path.join(stateDir, 'pending-group-images.json');
const updateInboxPath = path.join(stateDir, 'telegram-updates.journal.jsonl');
const updateRawArchivePath = path.join(stateDir, 'telegram-updates.raw.jsonl');
const liveLogPath = path.join(stateDir, 'telegram-live.jsonl');
const outboxPath = path.join(stateDir, 'outbox.jsonl');
const outboxOffsetPath = path.join(stateDir, 'outbox.offset');
const restartStatePath = path.join(stateDir, 'restart-state.json');
// Handoffs live with Skald's own work, not in the bridge's state dir: they are
// notes he wrote, meant to outlive any bridge reinstall.
const handoffRoot = config.handoffDir
  ? resolvePath(bridgeRoot, config.handoffDir)
  : path.join(workdir, '交接');
const contextAlertPath = path.join(stateDir, 'context-alerts.json');

const telegramApi = `https://api.telegram.org/bot${token}`;
const checkOnly = args.checkOnly;
let sessionId = readPrivateFile(sessionPath) || null;
let updateOffset = Number(readPrivateFile(offsetPath) || 0);
let outboxOffset = Number(readPrivateFile(outboxOffsetPath) || 0);
let botId = '';
let botUsername = '';
const groupHistories = new Map();
const groupBotRuns = new Map();
const modelQueue = new PriorityTaskQueue();
const privateMessageQueue = new PriorityTaskQueue({ maxSize: Number(config.privateQueueMax || 50) });
const rateLimiter = new SendRateLimiter({
  enabled: config.rateLimit.enabled,
  minIntervalMs: config.rateLimit.minIntervalMs,
  stateDir: path.join(stateDir, 'rate-limit'),
  log,
});
const durableInbox = new DurableUpdateInbox(updateInboxPath, {
  compactBytes: Number(config.updateJournalCompactBytes || DEFAULT_CONFIG.updateJournalCompactBytes),
  rawArchivePath: updateRawArchivePath,
});

// 停机协议闸门（Plan v3.2 步骤 5/6）：停机期间只挡「进模型」，收件与落盘照常。
const downtime = createDowntimeHooks({ durableInbox, log, stateDir });
const pendingGroupImages = new PendingGroupImages({
  filePath: pendingGroupImagesPath,
  imageRoot: imageCacheDir,
  maxEntriesPerChat: Number(config.pendingGroupImageMaxPerChat || 50),
  log,
});
const inFlightUpdates = new Map();
const inFlightGroupBatches = new Set();
let durableDispatchPromise = null;
let processingOutbox = false;
// Set by /restart_daemon; consumed by the client's onReady callback.
let pendingDaemonRestartChat = null;
// token -> { resolve, timer, chatId, messageId, summaryText, method, isNewProto }
const pendingApprovals = new Map();

function batchTimingForGroup(chatId) {
  const groupConfig = groupConfigFor(chatId) || {};
  return {
    ...globalGroupBatchTiming,
    ...normalizeBatchTiming(groupConfig.batchTiming || {}),
  };
}

// Static config.json groups win over dynamically authorized ones. This lookup
// runs on every send and every batch tick, so the dynamic file is cached and
// only re-parsed when its mtime changes — that still picks up an edit made by
// hand while the bridge is running.
let dynamicGroups = {};
let dynamicGroupsMtimeMs = -1;

function refreshDynamicGroups(force = false) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dynamicGroupsPath).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (!force && mtimeMs === dynamicGroupsMtimeMs) return;
  dynamicGroupsMtimeMs = mtimeMs;
  dynamicGroups = readDynamicGroups(dynamicGroupsPath);
}

refreshDynamicGroups(true);

function groupConfigFor(chatId) {
  return allowedGroups.get(String(chatId)) || dynamicGroups[String(chatId)] || null;
}

function numberOption(value, fallback, min = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

function mentionContextOptions(groupConfig = {}) {
  return {
    ...mentionContextGlobal,
    ...(groupConfig.mentionContext || {}),
  };
}

function truncateText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function passiveHistoryText(rawText, messageHasAttachments, options) {
  const text = truncateText(rawText, numberOption(options.maxMessageChars, 800, 80));
  if (text) return messageHasAttachments ? `${text} [sent attachment(s)]` : text;
  return messageHasAttachments ? '[sent attachment(s)]' : '';
}

function rememberGroupMessage(message, options) {
  if (options.enabled === false) return;
  const maxMessageChars = numberOption(options.maxMessageChars, 800, 80);
  const text = truncateText(message.text, maxMessageChars);
  if (!text) return;

  const key = String(message.chatId);
  const history = groupHistories.get(key) || [];
  history.push({
    messageId: message.messageId,
    sentAt: message.sentAt,
    sender: message.senderName,
    username: message.senderUsername || null,
    senderIsBot: message.senderIsBot,
    text,
  });

  const requestedCount = numberOption(options.messageCount, 10, 0);
  const maxStoredMessages = Math.max(
    Math.floor(numberOption(options.maxStoredMessages, 50, 1)),
    Math.floor(requestedCount),
  );
  if (history.length > maxStoredMessages) history.splice(0, history.length - maxStoredMessages);
  groupHistories.set(key, history);
}

function messageHitsMentionPatterns(rawText) {
  if (!mentionPatternsLower.length) return false;
  const lower = String(rawText || '').toLowerCase();
  return mentionPatternsLower.some((pattern) => lower.includes(pattern));
}

// ---------------------------------------------------------------------------
// Delta group context
//
// Re-sending the same recent messages on every mention wastes tokens and makes
// the model re-read what it already answered. Each (chatId, threadId) pair
// keeps a cursor of the highest message id it has processed, and only newer
// messages travel as context. The cursor advances only after every reply in a
// batch has been accepted by Telegram, so a failure replays the same context.
// ---------------------------------------------------------------------------

const groupContextCursors = new Map();
try {
  if (fs.existsSync(groupContextCursorsPath)) {
    const raw = JSON.parse(fs.readFileSync(groupContextCursorsPath, 'utf8'));
    for (const [key, value] of Object.entries(raw || {})) {
      if (typeof value === 'number' && Number.isFinite(value) && key.includes('::')) {
        groupContextCursors.set(key, value);
      }
    }
  }
} catch (error) {
  console.error(`could not load ${groupContextCursorsPath}; starting with empty cursors: ${error.message}`);
}

function saveGroupContextCursors() {
  writePrivateFile(groupContextCursorsPath, JSON.stringify(Object.fromEntries(groupContextCursors.entries())));
}

function recentGroupContextDelta(chatId, threadId, options, currentBatchMessageIds = new Set()) {
  const empty = { messages: [], previousContextThroughMessageId: null, omitted: false };
  if (options.enabled === false) return empty;
  const configuredCount = Math.max(0, Math.floor(numberOption(options.messageCount, 10, 0)));
  if (!configuredCount) return empty;
  const maxStored = Math.max(
    Math.floor(numberOption(options.maxStoredMessages, 50, 1)),
    configuredCount,
  );
  const history = groupHistories.get(String(chatId)) || [];
  const cursor = groupContextCursors.get(`${chatId}::${threadId || ''}`) || 0;
  // Every unseen message is delivered, not just the newest N: a small display
  // window must never silently swallow older context the model has not read.
  const unseen = history
    .filter((message) => Number(message.messageId) > cursor)
    .filter((message) => !currentBatchMessageIds.has(Number(message.messageId)))
    .slice(0, maxStored);
  // 2026-08-30：条数上限（maxStored，默认 50）挡不住字符体积。
  // 实证：在一个活跃群里且 requireMention=true 时，bot 越久没被 @、未读 delta 攒得越多；
  // 8/29 那次攒到 49 条 / 8670 字符，整批被 Kimi 判 400 high risk。逐条验证过
  // 里面没有任何单句有罪（颜文字、"还不如杀了我"、图片单独发全部通过），
  // 是整包累加越过风控阈值：同一批内容切到 5689 字通过、5824 字被拒。
  // 更糟的是那一轮一旦写进历史，之后每个请求都带着它 → 连 compaction 都被拒，
  // 桥从此永久 400（历史有毒→说不了话→压不掉历史，死锁）。
  //
  // 这里加一道总字符预算。保留上面那条注释的原意（不悄悄吞掉未读上下文），
  // 只是不让它无限膨胀：超预算时**从最旧的开始丢、保住最近的**，
  // 并把 omitted 置真，让模型知道前面还有没读到的，而不是假装完整。
  // maxDeltaChars=0 关闭本预算，行为与 8/30 之前完全一致。
  const charBudget = Math.max(0, Math.floor(numberOption(options.maxDeltaChars, 4000, 0)));
  let messages = unseen;
  let budgetDropped = false;
  if (charBudget > 0) {
    const kept = [];
    let used = 0;
    for (let i = unseen.length - 1; i >= 0; i -= 1) {
      const size = String(unseen[i]?.text || '').length + 120;  // 120 ≈ 每条的元数据开销
      if (used + size > charBudget && kept.length > 0) { budgetDropped = true; break; }
      used += size;
      kept.unshift(unseen[i]);
    }
    messages = kept;
  }
  return {
    messages,
    previousContextThroughMessageId: cursor > 0 ? cursor : null,
    // With no cursor the earlier messages truly did not happen for this thread;
    // with one, they happened and were already delivered.
    // budgetDropped：这一批因字符预算砍掉了更早的未读，同样必须算 omitted，
    // 否则模型会以为自己看到了全部。
    omitted: cursor > 0 || budgetDropped,
  };
}

function advanceGroupContextCursor(chatId, threadId, batchMessageIds) {
  if (!threadId) return;
  const key = `${chatId}::${threadId}`;
  const newCursor = batchMessageIds.reduce((max, id) => Math.max(max, Number(id) || 0), 0);
  if (!newCursor) return;
  const oldCursor = groupContextCursors.get(key) || 0;
  if (newCursor <= oldCursor) return;
  groupContextCursors.set(key, newCursor);
  try {
    saveGroupContextCursors();
  } catch (error) {
    log(`could not persist ${groupContextCursorsPath}: ${error.message} (in-memory cursor updated)`);
  }
}

// ---------------------------------------------------------------------------
// Codex client
// ---------------------------------------------------------------------------

// codexMode: 'spawn' (v1, default) spawns a `codex app-server --stdio` child
// per bridge process. State is per-process: Codex.app or `codex --remote` on
// the same machine each get their own isolated thread state.
//
// codexMode: 'daemon' (v2) connects to a long-running `codex app-server
// --listen unix://PATH` daemon. The bridge and a `codex --remote unix://PATH`
// TUI then share one thread, and the daemon broadcasts events to both.
// codexMode: 'kimi' (skald-tg-bridge) spawns one `kimi -p … --output-format
// stream-json` process per turn; session continuity lives in kimi's own
// session store, keyed by the persisted session id in .state/session.txt.
const codexMode = config.codexMode === 'daemon'
  ? 'daemon'
  : config.codexMode === 'kimi'
    ? 'kimi'
    : 'spawn';
const defaultDaemonSocket = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'app-server-control/app-server-control.sock',
);
const daemonSocketPath = config.daemonSocketPath
  ? resolvePath(bridgeRoot, config.daemonSocketPath)
  : defaultDaemonSocket;

function syncThreadToDesktop(threadId, preview) {
  if (config.desktopSync !== true || !threadId) return;
  syncDesktopMetadata({
    threadId,
    title: `${config.botName} via Telegram`,
    preview: String(preview || '').slice(0, 200),
    cwd: workdir,
    log,
  });
}

function makeCodexClient() {
  const sharedOpts = {
    workdir,
    threadId: sessionId,
    model: config.model || DEFAULT_CONFIG.model,
    effort: config.reasoningEffort || DEFAULT_CONFIG.reasoningEffort,
    serviceTier: config.serviceTier || DEFAULT_CONFIG.serviceTier,
    timeoutMs,
    toolWritableRoots,
    toolNetworkAccess: config.toolNetworkAccess === true,
    log,
    onReady: (threadId) => {
      // Only an explicit /new or /resume may change the locked thread. Clients
      // fail closed on resume errors, so an unexpected change is a security
      // event rather than a routine fallback.
      if (sessionId && sessionId !== threadId) {
        log(`Codex thread switched: ${sessionId} -> ${threadId} (previous id saved)`);
        writePrivateFile(previousSessionPath, sessionId);
      }
      sessionId = threadId;
      writePrivateFile(sessionPath, threadId);
      log(`Codex ${codexMode} ready; session ${threadId}`);
      syncThreadToDesktop(threadId, '(bridge started, waiting for the first message)');
      if (pendingDaemonRestartChat) {
        const target = pendingDaemonRestartChat;
        pendingDaemonRestartChat = null;
        sendMessage(target, '✅ Codex daemon restarted and the bridge reconnected.')
          .catch((error) => log(`daemon restart notice failed: ${error.message}`));
      }
    },
    onThreadChange: (info) => {
      if (info?.previousThreadId) {
        log(`Codex thread could not be resumed (reason=${info.reason}); keeping ${info.previousThreadId} locked`);
      }
      if (info?.blocked) {
        sendMessage(
          ownerUserId,
          `⚠️ The locked thread ${info.previousThreadId} could not be resumed. The bridge failed closed and did not`
          + ' create a replacement thread. Use /resume <thread-id> or /new to decide explicitly.',
        ).catch((error) => log(`fail-closed notice failed: ${error.message}`));
      }
    },
    onSecurityEvent: (event) => {
      const params = event.params || {};
      const command = Array.isArray(params.command) ? params.command.join(' ') : params.command;
      const summary = redactSensitiveText(
        command || params.error || params.reason || params.method || params.grantRoot || '',
      );
      log(`tool approval ${event.kind} decision=${event.decision}${summary ? ` summary=${summary.slice(0, 240)}` : ''}`);
    },
  };

  if (codexMode === 'kimi') {
    const kimiEngine = config.kimiEngine === 'tui' ? 'tui' : 'spawn';
    log(`Kimi mode: ${kimiEngine === 'tui' ? 'persistent-tui' : 'spawn-per-turn'} (kimiPath=${kimiPath})`);
    // model falls back to kimi's own default_model when unset — the codex
    // default from DEFAULT_CONFIG must never leak into `kimi -m`.
    return new KimiCliClient({
      ...sharedOpts,
      model: config.model || '',
      kimiPath,
      turnStateDir: path.join(stateDir, 'kimi-turns'),
      vision: config.vision || null,
      // The subscription K3 declares image_in and the CLI ships ReadMediaFile,
      // so the agent can open the archived original itself. Transcription stays
      // configured for backends without vision; nativeVision picks which one.
      nativeVision: config.nativeVision === true,
      engine: kimiEngine,
      tmuxSession: config.tmuxSession || config.kimiTmuxSession || 'skald-tg',
      tmuxBin: config.tmuxBin || undefined,
      // Synqa's call (2026-08-06): every approval goes to Telegram. The TUI
      // dialog is invisible from a phone, so an unforwarded request is a turn
      // that silently waits forever.
      requestUserApproval: forwardApprovalToTelegram,
      // Synqa's call (2026-08-26): cache expiry must keep the one complete
      // session, continue without compaction, and tell her what happened.
      onCacheHintContinue: () => sendMessage(
        ownerUserId,
        '鸦鸦检测到 Kimi 的 Cache expired 提示，已按你的设置保留完整上下文继续；本次没有 compact。',
      ),
    });
  }
  if (codexMode === 'daemon') {
    log(`Codex mode: daemon (socket=${daemonSocketPath})`);
    return new CodexDaemonClient({
      ...sharedOpts,
      socketPath: daemonSocketPath,
      requestUserApproval: forwardApprovalToTelegram,
      onDisconnect: (reason) => clearPendingApprovals(`daemon ${reason}`),
    });
  }
  log(`Codex mode: spawn (codexPath=${codexPath})`);
  return new CodexAppClient({ ...sharedOpts, codexPath });
}

const codex = checkOnly ? null : makeCodexClient();
// Downtime may dissolve only dispatch groups proven not to have entered Kimi.
// Unknown accepted turns stay attached to their original receipt/wire marker.
durableInbox.groupModelLifecycle = (batch) => {
  // Live queue closures still own their work; only crash-persisted dispatch
  // groups without an in-process owner may be rebound by recovery.
  if (batch.updateIds.some(id => inFlightUpdates.has(id))) return { state: 'scheduler-active' };
  if (!(codex instanceof KimiCliClient) || codex.engine !== 'tui') return { state: 'unknown' };
  try { codex.reconcilePendingTurns(); } catch (error) {
    if (error.code !== 'KIMI_OUTCOME_UNKNOWN') return { state: 'unknown', error: String(error.message) };
  }
  const receipt = codex.turnLedger.read(`group:${batch.batchId}`);
  if (!receipt) return { state: 'unsubmitted' };
  return { ...receipt, receiptPath: codex.turnLedger.filePath(receipt.requestId) };
};

// ---------------------------------------------------------------------------
// Telegram I/O
// ---------------------------------------------------------------------------

async function telegramOnce(method, params = {}) {
  const response = await fetch(`${telegramApi}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const data = await response.json();

  if (!response.ok || !data.ok) {
    const description = String(data.description || response.statusText || 'unknown error');
    const error = new Error(`Telegram ${method} failed: ${description}`);
    // The retry layer needs the status to tell a wobbling Telegram (5xx, retry)
    // from a real answer (4xx, surface it).
    error.status = response.status;
    error.telegramDescription = description;
    throw error;
  }

  return data.result;
}

// 2026-08-15: one timed-out sendMessage used to cost a whole reply — Kimi's
// text stayed in the terminal and Synqa got nothing. Transport faults are
// absorbed here so they never reach the durable layer, which "recovers" by
// regenerating the entire turn.
// onAttempt fires before every attempt so the poll watchdog can restart its
// clock: a legitimate retry chain takes minutes, a hung socket does not.
async function telegram(method, params = {}, { onAttempt = null } = {}) {
  return withTransportRetry((attempt) => {
    if (typeof onAttempt === 'function') onAttempt(attempt);
    return telegramOnce(method, params);
  }, {
    onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
      log(`telegram ${method} transport fault ${attempt}/${maxAttempts}, retrying in ${delayMs}ms: ${error.message}`);
    },
  });
}

function truncateLiveText(value, maxChars = Number(config.liveLogMaxChars || 6000)) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function compactLiveAttachment(attachment) {
  return {
    fileName: attachment.fileName || path.basename(attachment.path || '') || null,
    mimeType: attachment.mimeType || null,
    width: attachment.width || null,
    height: attachment.height || null,
    fileSize: attachment.fileSize || null,
    source: attachment.source || null,
    path: attachment.path || null,
  };
}

// Optional local transcript of everything in and out. Off by default: it is
// plaintext chat content sitting on disk.
function appendLiveLog(event) {
  if (config.liveLogEnabled !== true) return;
  try {
    fs.appendFileSync(
      liveLogPath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), sessionId, ...event })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.chmodSync(liveLogPath, 0o600);
  } catch (error) {
    log(`live log write failed: ${error.message}`);
  }
}

const DICE_EMOJI = ['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'];

function privateChunkDelivery(updateId) {
  if (updateId == null) return null;
  return {
    isAcked: (index, text) => Boolean(durableInbox.privateChunkAck(updateId, index, text)),
    ack: (index, text, result) => durableInbox.markPrivateChunkAck(updateId, index, text, result),
  };
}

function groupChunkDelivery(batchId, replyIndex) {
  return {
    isAcked: (index, text) => Boolean(durableInbox.groupChunkAck(batchId, replyIndex, index, text)),
    ack: (index, text, result) => durableInbox.markGroupChunkAck(batchId, replyIndex, index, text, result),
  };
}

function groupStillAuthorized(chatId) {
  refreshDynamicGroups();
  return Boolean(groupConfigFor(chatId));
}

function mayDispatchUpdate(update) {
  return typeof downtime.shouldDispatch !== 'function' || downtime.shouldDispatch(update);
}

async function sendMessage(chatId, text, replyToMessageId = null, options = {}) {
  const groupConfig = groupConfigFor(chatId);
  // Some groups read better without quote-replies (it keeps two bots from
  // building a visible reply chain at each other).
  if (groupConfig?.disableReplyQuote === true) replyToMessageId = null;

  // A reply that is exactly one dice emoji becomes a real Telegram dice roll.
  if (DICE_EMOJI.includes(String(text ?? '').trim())) {
    const diceText = String(text).trim();
    if (options.delivery?.isAcked(0, diceText)) return true;
    const params = { chat_id: chatId, emoji: diceText };
    if (replyToMessageId) params.reply_parameters = { message_id: replyToMessageId };
    const result = await rateLimiter.run(
      chatId,
      async () => {
        if (options.shouldSend && !options.shouldSend()) return { skipped: true };
        const sent = await telegram('sendDice', params);
        options.delivery?.ack(0, diceText, sent);
        return sent;
      },
      { shouldSend: options.shouldSend },
    );
    return !result?.skipped;
  }

  const chunks = splitTelegramText(text, 4000, `(${config.botName} produced no sendable text.)`);
  for (const [index, chunk] of chunks.entries()) {
    if (options.delivery?.isAcked(index, chunk)) continue;
    const params = { chat_id: chatId, text: chunk };
    if (index === 0 && replyToMessageId) {
      params.reply_parameters = { message_id: replyToMessageId };
    }
    const result = await rateLimiter.run(
      chatId,
      async () => {
        if (options.shouldSend && !options.shouldSend()) return { skipped: true };
        const sent = await telegram('sendMessage', params);
        // Persist the known Telegram ACK before rate-limit state or live-log
        // housekeeping can fail. Unknown network outcomes remain at-least-once.
        options.delivery?.ack(index, chunk, sent);
        return sent;
      },
      { shouldSend: options.shouldSend },
    );
    if (result?.skipped) return false;
    appendLiveLog({
      direction: 'out',
      chatId: String(chatId),
      messageId: result?.message_id || null,
      replyToMessageId: index === 0 ? replyToMessageId : null,
      chunkIndex: index,
      chunkCount: chunks.length,
      text: truncateLiveText(chunk),
    });
  }
  return true;
}

async function reactToMessage(chatId, messageId, emoji) {
  await telegram('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

// Optional outbox: append {"chatId": "...", "text": "..."} lines to
// .state/outbox.jsonl and the bridge sends them. Handy for cron jobs and
// scripts that want to reach the same chat without a second bot token.
async function processOutbox() {
  if (config.outboxEnabled !== true || processingOutbox) return;
  processingOutbox = true;

  try {
    if (!fs.existsSync(outboxPath)) return;

    const lines = fs.readFileSync(outboxPath, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (outboxOffset > lines.length) outboxOffset = 0;

    for (let index = outboxOffset; index < lines.length; index += 1) {
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch (error) {
        log(`outbox line ${index + 1} is not valid JSON, skipped: ${error.message}`);
        outboxOffset = index + 1;
        writePrivateFile(outboxOffsetPath, String(outboxOffset));
        continue;
      }

      const text = String(event.text || '').trim();
      if (!text) {
        log(`outbox line ${index + 1} has no text, skipped`);
        outboxOffset = index + 1;
        writePrivateFile(outboxOffsetPath, String(outboxOffset));
        continue;
      }

      const chatId = String(event.chatId || ownerUserId || '');
      if (!chatId) {
        log(`outbox line ${index + 1} has no chat id to send to`);
        return;
      }

      await sendMessage(chatId, text);
      log(`outbox sent line=${index + 1} chat=${chatId}`);
      outboxOffset = index + 1;
      writePrivateFile(outboxOffsetPath, String(outboxOffset));
    }
  } finally {
    processingOutbox = false;
  }
}

function secureRuntimeFiles() {
  for (const filePath of [
    liveLogPath,
    updateInboxPath,
    updateRawArchivePath,
    `${updateRawArchivePath}.offset`,
    outboxPath,
    pendingGroupImagesPath,
  ]) {
    try { if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildPrivatePrompt(text, context, images = [], files = []) {
  const payload = {
    mode: 'TG_PRIVATE',
    botName: config.botName,
    ownerName: config.ownerName,
    sender: context.senderName || context.senderUsername || 'unknown sender',
    username: context.senderUsername || null,
    images: images.length,
    files: files.length,
    toolMode: {
      enabled: privateToolsEnabled,
      writableRoots: privateToolsEnabled ? toolWritableRoots : [],
      networkAccess: privateToolsEnabled && config.toolNetworkAccess === true,
    },
    replyTo: context.replyTo || null,
    text,
  };
  return [
    'TG_PRIVATE',
    'Follow the Telegram bridge protocol from AGENTS.md. Reply with the Telegram message body only.',
    JSON.stringify(payload),
  ].join('\n');
}

function replyTargetIdsForBatch(batch) {
  return [...new Set(batch.flatMap(message => message.downtimeContextOnly ? []
    : message.replyTargetIds || [message.messageId]).map(Number))];
}

function buildGroupBatchPrompt(batch, {
  superseding,
  recentContextDelta = null,
  pendingContextImageCount = 0,
}) {
  const chatTitle = batch.at(-1)?.chatTitle || 'group';
  const chatId = String(batch.at(-1)?.chatId || '');
  const groupConfig = groupConfigFor(chatId) || {};
  const imageCount = batch.reduce((sum, message) => sum + (message.images || []).length, 0)
    + Number(pendingContextImageCount || 0);
  const fileCount = batch.reduce((sum, message) => sum + (message.files || []).length, 0);
  const messages = batch.map((message) => ({
    messageId: message.messageId,
    sentAt: isoCN(message.sentAt || message.receivedAt),
    sender: message.senderName,
    username: message.senderUsername || null,
    senderIsBot: message.senderIsBot,
    contextOnly: message.downtimeContextOnly === true || message.contextOnly === true,
    ...(message.albumSources ? { albumSources: message.albumSources, replyTargetIds: message.replyTargetIds || [] } : {}),
    replyTo: message.replyTo || null,
    text: message.text,
    images: (message.images || []).map((image) => ({
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      fileSize: image.fileSize,
      // Files already carry their path; images did not, so a group turn could
      // never point the media-reading tool at the picture it was discussing.
      path: image.path,
    })),
    files: (message.files || []).map((file) => ({
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      source: file.source,
      path: file.path,
      textPreviewStatus: file.textPreviewStatus,
    })),
  }));
  // contextWindow tells the model that anything older was deliberately left
  // out because it already read it — not that nothing happened before.
  const payload = {
    mode: 'TG_GROUP_BATCH',
    botName: config.botName,
    ownerName: config.ownerName,
    chatId,
    chatTitle,
    profile: groupConfig.profile || null,
    ...(batch.some(message => message.albumSources) ? { replyTargetIds: replyTargetIdsForBatch(batch),
      triggerPolicy: 'Only replyTargetIds are reply triggers; contextOnly album sources provide the intact original media/caption, not independent old requests.' } : {}),
    superseding,
    imageCount,
    pendingContextImageCount: Number(pendingContextImageCount || 0),
    fileCount,
    contextWindow: {
      mode: 'delta_since_last_group_turn',
      previousContextThroughMessageId: recentContextDelta?.previousContextThroughMessageId ?? null,
      omittedPreviouslySentMessages: Boolean(recentContextDelta?.omitted),
    },
    recentContextDelta: recentContextDelta?.messages || [],
    messages,
  };

  return [
    'TG_GROUP_BATCH',
    'Follow the Telegram bridge protocol from AGENTS.md. Strict JSON only:'
    + ' {"replies":[{"text":"...","replyToMessageId":123|null}],"react":"👀"|null}',
    JSON.stringify(payload),
  ].join('\n');
}

async function askCodex(text, context, images = [], files = [], requestId = null) {
  const result = await codex.ask(
    buildPrivatePrompt(text, context, images, files),
    images,
    { toolMode: telegramToolMode({ isGroup: false, privateToolsEnabled }), ...(requestId ? { requestId } : {}) },
  );
  sessionId = codex.threadId || result.threadId;
  syncThreadToDesktop(
    result.threadId,
    `[private] ${context.senderName || context.senderUsername || '?'}: ${String(text).slice(0, 100)}`,
  );
  return { reply: result.reply, threadId: result.threadId };
}

// ---------------------------------------------------------------------------
// Group batches
// ---------------------------------------------------------------------------

function serializeDurableGroupMessage(message) {
  return {
    chatId: String(message.chatId || ''),
    chatTitle: String(message.chatTitle || ''),
    messageId: Number(message.messageId),
    text: String(message.text || ''),
    replyTo: structuredClone(message.replyTo || null),
    images: structuredClone(message.images || []),
    files: structuredClone(message.files || []),
    senderId: String(message.senderId || ''),
    senderIsBot: message.senderIsBot === true,
    senderUsername: String(message.senderUsername || ''),
    senderName: String(message.senderName || ''),
    sentAt: Number(message.sentAt || 0),
    receivedAt: Number(message.receivedAt || Date.now()),
    _durableUpdateId: Number(message._durableUpdateId),
    _pendingGroupImageTokens: [...(message._pendingGroupImageTokens || [])],
    ...(message.downtimeContextOnly ? { downtimeContextOnly: true, contextOnly: true } : {}),
    ...(message.albumSources ? { albumSources: structuredClone(message.albumSources), replyTargetIds: [...(message.replyTargetIds || [])] } : {}),
  };
}

function durableGroupBatchId(chatId, updateIds) {
  const range = `${Math.min(...updateIds)}-${Math.max(...updateIds)}`;
  return `${chatId}:${range}:${crypto.randomUUID()}`;
}

function durableBatchIdFromMessages(batch) {
  const ids = [...new Set(batch.map((message) => message._durableGroupBatchId).filter(Boolean))];
  if (ids.length !== 1) throw new Error(`group batch durable ownership ambiguous ids=${ids.join(',') || 'none'}`);
  return ids[0];
}

async function generateGroupReplies(batch, options) {
  const chatId = batch.at(-1).chatId;
  const updateIds = [...new Set(batch.flatMap((message) => {
    const id = Number(message._durableUpdateId);
    return durableInbox.albumForUpdate(id)?.updateIds || [id];
  }))];
  if (!updateIds.length || updateIds.some((updateId) => !Number.isSafeInteger(updateId))) {
    throw new Error(`group batch is missing durable update ids chat=${chatId}`);
  }
  const throughMessageId = Math.max(...batch.map((message) => Number(message.messageId) || 0));
  const pending = pendingGroupImages.pending(chatId, {
    throughMessageId,
    limit: Number(config.pendingGroupImageMaxPerTurn || 4),
  });
  for (const message of batch) message._pendingGroupImageTokens = pending.tokens;
  const durableBatchId = options.replayBatchId || durableGroupBatchId(chatId, updateIds);
  if (!options.replayBatchId) {
    durableInbox.markGroupBatch({
      batchId: durableBatchId,
      chatId,
      updateIds,
      preparedMessages: batch.map(serializeDurableGroupMessage),
      modelLifecycleVersion: 1,
    });
  }
  for (const message of batch) message._durableGroupBatchId = durableBatchId;
  const revokedResult = () => {
    for (const message of batch) message._authorizationRevoked = true;
    return [];
  };
  if (!groupStillAuthorized(chatId)) return revokedResult();

  const typing = setInterval(() => {
    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  typing.unref();

  try {
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const currentImages = batch.flatMap((message) => message.images || []);
    const images = [...currentImages, ...pending.images].filter((image, index, all) => {
      const identity = image.sha256 || image.path;
      return all.findIndex((candidate) => (candidate.sha256 || candidate.path) === identity) === index;
    });
    const groupConfig = groupConfigFor(chatId) || {};
    const contextOptions = mentionContextOptions(groupConfig);
    const currentBatchMessageIds = new Set(batch.map((m) => Number(m.messageId)).filter(Number.isFinite));
    const recentContextDelta = recentGroupContextDelta(
      chatId,
      sessionId,
      contextOptions,
      currentBatchMessageIds,
    );
    const result = await modelQueue.run(
      () => groupStillAuthorized(chatId) ? codex.ask(buildGroupBatchPrompt(batch, {
        ...options,
        recentContextDelta,
        pendingContextImageCount: pending.images.length,
      }), images, {
        // Every group-origin model turn is mechanically read-only. Telegram
        // reply/reaction happens later in this bridge and is not a Kimi tool,
        // so communication remains available while local mutation is denied.
        toolMode: telegramToolMode({ isGroup: true, privateToolsEnabled }),
        outputSchema: GROUP_REPLY_SCHEMA,
        requestId: `group:${durableBatchId}`,
        // Silence is a valid group outcome (mention-only): an empty turn must
        // settle as "no replies", not as a failure that retries the same batch
        // until it dead-letters and pages Synqa.
        allowEmpty: true,
      }) : { authorizationRevoked: true },
      0,
    );
    // Pin the exact thread that generated this batch: an explicit /new or
    // /resume can land between generation and the Telegram send.
    if (result.authorizationRevoked) return revokedResult();
    for (const message of batch) {
      message._processedThreadId = result.threadId;
      message._pendingGroupImageTokens = pending.tokens;
    }
    sessionId = codex.threadId || result.threadId;
    const lastMessage = batch.at(-1);
    syncThreadToDesktop(
      result.threadId,
      `[${lastMessage?.chatTitle || chatId}] ${lastMessage?.senderName || '?'}: ${String(lastMessage?.text || '').slice(0, 100)}`,
    );
    const replies = parseBatchReplies(result.reply, replyTargetIdsForBatch(batch));
    durableInbox.markGroupBatchReplies(durableBatchId, replies, result.threadId);
    return replies;
  } finally {
    clearInterval(typing);
  }
}

async function notifyGroupFailure(chatId, error, batch) {
  const source = batch.at(-1)?.chatTitle || chatId;
  await sendMessage(
    ownerUserId,
    `[bridge-status] ${config.botName} failed to generate a group reply for "${source}". This batch was stopped and`
    + ` bot-triggered replies are paused briefly. Error: ${redactSensitiveText(error.message)}`,
  );
}

const groupBatcher = new GroupConversationBatcher({
  getTiming: batchTimingForGroup,
  generateReplies: generateGroupReplies,
  sendReply: async (chatId, reply, batch, shouldSend, { replyIndex } = {}) => {
    const durableBatchId = durableBatchIdFromMessages(batch);
    if (!Number.isInteger(replyIndex) || replyIndex < 0) {
      throw new Error(`group batch replyIndex is invalid batch=${durableBatchId}`);
    }
    if (durableInbox.isGroupReplyAcked(durableBatchId, replyIndex)) {
      log(`group reply already acked, not resending batch=${durableBatchId} reply=${replyIndex}`);
      return true;
    }
    const validTargets = new Set(replyTargetIdsForBatch(batch));
    const fallbackMessageId = [...batch].reverse().find((message) => !message.senderIsBot && validTargets.has(Number(message.messageId)))?.messageId
      || [...validTargets].at(-1) || null;
    const sent = await sendMessage(
      chatId,
      reply.text,
      reply.replyToMessageId || fallbackMessageId,
      { shouldSend: () => groupStillAuthorized(chatId) && shouldSend(),
        delivery: groupChunkDelivery(durableBatchId, replyIndex) },
    );
    if (sent) durableInbox.markGroupReplyAck(durableBatchId, replyIndex);
    return sent;
  },
  onReact: (chatId, messageId, emoji) => groupStillAuthorized(chatId) ? reactToMessage(chatId, messageId, emoji) : undefined,
  notifyFailure: notifyGroupFailure,
  onBatchComplete: async (chatId, batch) => {
    if (batch.some((message) => message._authorizationRevoked)) {
      durableInbox.markGroupBatchDone(durableBatchIdFromMessages(batch), 'group-authorization-revoked');
      return;
    }
    const processedThreadIds = [...new Set(batch.map((message) => message._processedThreadId).filter(Boolean))];
    if (processedThreadIds.length !== 1) {
      throw new Error(`group batch thread ownership ambiguous chat=${chatId}`);
    }
    advanceGroupContextCursor(chatId, processedThreadIds[0], batch.map((message) => message.messageId));
    const pendingTokens = [...new Set(batch.flatMap((message) => message._pendingGroupImageTokens || []))];
    pendingGroupImages.consume(chatId, pendingTokens);
    durableInbox.markGroupBatchDone(durableBatchIdFromMessages(batch));
  },
  maxPendingMessages: Number(config.groupQueueMaxPerChat || 100),
  log,
  timing: config.batchTiming,
});

// ---------------------------------------------------------------------------
// Owner-only ops commands
// ---------------------------------------------------------------------------

// Hot-swaps the parts of config.json that can change safely in place. Static
// fields (codexMode, model, timeoutMs, keychain*) still need a restart.
function reloadConfig() {
  const next = readJson(configPath);
  if (!Array.isArray(next.allowedUserIds)) throw new Error('allowedUserIds must be an array');
  if (!next.allowedGroups || typeof next.allowedGroups !== 'object') throw new Error('allowedGroups must be an object');
  const nextUsers = next.allowedUserIds.map(String).filter(Boolean);
  if (!nextUsers.length) throw new Error('allowedUserIds must not be empty');
  const nextGroups = Object.entries(next.allowedGroups).map(([chatId, group]) => {
    if (!/^-?\d+$/.test(chatId) || !group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`allowedGroups.${chatId} is invalid`);
    }
    const normalized = { ...group };
    if (normalized.maxConsecutiveBotMessages != null) {
      const limit = Number(normalized.maxConsecutiveBotMessages);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error(`${chatId}.maxConsecutiveBotMessages is invalid`);
      }
      normalized.maxConsecutiveBotMessages = limit;
    }
    if (normalized.batchTiming != null) normalized.batchTiming = normalizeBatchTiming(normalized.batchTiming);
    return [chatId, normalized];
  });
  const nextPatterns = (next.mentionPatterns || []).map(String).map((value) => value.trim()).filter(Boolean);
  const nextMentionContext = { ...DEFAULT_CONFIG.mentionContext, ...(next.mentionContext || {}) };
  for (const key of ['messageCount', 'maxStoredMessages', 'maxMessageChars']) {
    const value = Number(nextMentionContext[key]);
    if (!Number.isInteger(value) || value < 0 || value > 100000) throw new Error(`mentionContext.${key} is invalid`);
    nextMentionContext[key] = value;
  }
  if (nextMentionContext.maxStoredMessages < nextMentionContext.messageCount) {
    throw new Error('mentionContext.maxStoredMessages must not be smaller than messageCount');
  }
  const nextBatchTiming = normalizeBatchTiming(next.batchTiming || {});

  // Commit only after every field has parsed and validated.
  allowedUserIds.clear();
  for (const userId of nextUsers) allowedUserIds.add(userId);
  allowedGroups.clear();
  for (const [chatId, group] of nextGroups) allowedGroups.set(chatId, group);
  mentionPatterns.length = 0;
  mentionPatterns.push(...nextPatterns);
  mentionPatternsLower.length = 0;
  mentionPatternsLower.push(...mentionPatterns.map((value) => value.toLowerCase()).filter(Boolean));
  for (const key of Object.keys(mentionContextGlobal)) delete mentionContextGlobal[key];
  Object.assign(mentionContextGlobal, nextMentionContext);
  for (const key of Object.keys(globalGroupBatchTiming)) delete globalGroupBatchTiming[key];
  Object.assign(globalGroupBatchTiming, nextBatchTiming);
  return {
    groups: allowedGroups.size,
    mentionPatterns: mentionPatterns.length,
    mentionContextMessageCount: mentionContextGlobal.messageCount,
  };
}

async function handleReloadConfig(message, durableUpdateId = null) {
  const chatId = String(message.chat.id);
  if (String(message.from.id) !== ownerUserId) {
    await sendMessage(chatId, '❌ /reload_config is owner-only.');
    return;
  }
  const operation = durableUpdateId == null
    ? { status: 'intent' }
    : durableInbox.beginOperation(durableUpdateId, 'reload-config', {});
  let reply;
  if (operation.status === 'result') {
    reply = String(operation.result.reply || '✅ Config reload already completed.');
  } else {
    try {
      const summary = reloadConfig();
      reply = [
        '✅ Config reloaded in place',
        `  groups: ${summary.groups}`,
        `  mention patterns: ${summary.mentionPatterns}`,
        `  group context window: ${summary.mentionContextMessageCount}`,
        '(codexMode / model / timeoutMs / keychain* keep their old values; use /restart_bridge for those)',
      ].join('\n');
      log(`/reload_config done groups=${summary.groups} patterns=${summary.mentionPatterns}`);
    } catch (error) {
      reply = `❌ Reload failed, the previous config is still active: ${error.message}`;
      log(`/reload_config failed: ${error.message}`);
    }
    if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { reply });
  }
  await sendDurablePrivateText(durableUpdateId, chatId, reply);
}

function activeTurnInfo() {
  const running = modelQueue.running ? 1 : 0;
  const queued = modelQueue.tasks.length;
  return { running, queued, total: running + queued };
}

async function handleRestartBridge(message, { force = false, durableUpdateId = null } = {}) {
  const chatId = String(message.chat.id);
  if (String(message.from.id) !== ownerUserId) {
    await sendMessage(chatId, '❌ /restart_bridge is owner-only.');
    return;
  }
  const info = activeTurnInfo();
  if (!force && info.total > 0) {
    await sendMessage(
      chatId,
      `⚠️ ${info.total} turn(s) in flight (running=${info.running} queued=${info.queued}).`
      + ' Use /force_restart_bridge to interrupt them.',
    );
    return;
  }
  if (force) clearPendingApprovals('bridge force restart');
  const operation = durableUpdateId == null
    ? { status: 'intent' }
    : durableInbox.beginOperation(durableUpdateId, 'restart-bridge', { chatId, force });
  if (operation.status === 'result') {
    // The previous process made the handoff durable and then died before its
    // update could be marked done. This *is* the replacement process: consume
    // the update instead of restarting again.
    durableInbox.markDone(durableUpdateId);
    log(`restart-bridge operation already completed; not looping update=${durableUpdateId}`);
    return;
  }
  const ack = await sendDurablePrivateText(
    durableUpdateId,
    chatId,
    force ? '🔄 Restarting the bridge (forced)...' : '🔄 Restarting the bridge...',
    { rawTelegram: true },
  );
  if (!ack?.message_id) throw new Error('restart acknowledgement has no message_id');
  // Short-lived handoff: the next process edits that same message so the owner
  // sees the restart complete instead of a message that just stops updating.
  try {
    writePrivateFile(restartStatePath, JSON.stringify({
      chat_id: chatId,
      message_id: ack.message_id,
      timestamp: Date.now(),
      trigger: 'bridge',
      force,
    }));
  } catch (error) {
    log(`could not write ${restartStatePath}: ${error.message} (restart continues, only the ack edit is lost)`);
  }
  if (durableUpdateId != null) {
    try {
      // This command terminates the process, so its normal completion promise
      // can never settle. Persist done once the acknowledgement and handoff
      // are durable, before exiting.
      durableInbox.completeOperation(durableUpdateId, { ackMessageId: ack.message_id, handoffWritten: true });
      durableInbox.markDone(durableUpdateId);
    } catch (error) {
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: ack.message_id,
        text: `❌ Bridge not restarted: could not commit durable state for update ${durableUpdateId}`,
      }).catch(() => {});
      throw error;
    }
  }
  log(`/restart_bridge force=${force} -> exit(0); the process manager restarts it`);
  codex?.close();
  process.exit(0);
}

async function handleRestartDaemon(message, { force = false, durableUpdateId = null } = {}) {
  const chatId = String(message.chat.id);
  if (String(message.from.id) !== ownerUserId) {
    await sendMessage(chatId, '❌ /restart_daemon is owner-only.');
    return;
  }
  if (codexMode !== 'daemon') {
    await sendMessage(chatId, 'This bridge runs in spawn mode; there is no daemon to restart.');
    return;
  }
  if (process.platform !== 'darwin') {
    await sendMessage(chatId, '/restart_daemon uses launchctl and only works on macOS. Restart the daemon manually.');
    return;
  }
  const info = activeTurnInfo();
  if (!force && info.total > 0) {
    await sendMessage(
      chatId,
      `⚠️ ${info.total} turn(s) in flight. Use /force_restart_daemon`
      + ' (the bridge reconnects automatically, but those turns are lost).',
    );
    return;
  }
  // A non-forced daemon restart also clears approvals via onDisconnect; this
  // covers the forced path, where in-flight turns die immediately.
  if (force) clearPendingApprovals('daemon force restart');
  const operation = durableUpdateId == null
    ? { status: 'intent' }
    : durableInbox.beginOperation(durableUpdateId, 'restart-daemon', { chatId, force });
  if (operation.status === 'result') {
    log(`restart-daemon operation already completed; skipping duplicate kickstart update=${durableUpdateId}`);
    return;
  }
  pendingDaemonRestartChat = chatId;
  await sendDurablePrivateText(
    durableUpdateId,
    chatId,
    force
      ? '🔄 Restarting the Codex daemon (forced); the bridge will reconnect...'
      : '🔄 Restarting the Codex daemon; the bridge will reconnect...',
  );
  // Detached: the bridge stays up and the daemon client's reconnect loop takes
  // the new daemon. onReady then posts the confirmation.
  const child = spawn(
    '/bin/launchctl',
    ['kickstart', '-k', `gui/${process.getuid()}/${config.daemonLaunchdLabel || DEFAULT_CONFIG.daemonLaunchdLabel}`],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { kickstartSpawned: true });
  log(`/restart_daemon force=${force} -> detached launchctl kickstart`);
}

// ---------------------------------------------------------------------------
// Approval forwarding (Telegram inline keyboard)
// ---------------------------------------------------------------------------

const APPROVAL_TOKEN_RE = /^apr:([0-9a-f]{8}):(accept|decline)$/;

function truncateForKeyboard(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function approvalSummaryText({ method, reason, summary }) {
  const reasonText = ({
    'network-requested': '🌐 the command asked for network access',
    'cwd-outside-roots': '📂 working directory is outside the writable roots',
    'paths-outside-roots': '📂 file paths are outside the writable roots',
    'command-writes-outside-roots': '📂 the command writes outside the writable roots',
    'manual-confirmation-required': '🔐 not on the read-only allowlist, needs your confirmation',
    'external-client-turn': '🖥️ from a terminal session attached to the same thread',
  })[reason] || reason;

  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const paths = (summary.filePaths || []).slice(0, 5);
    const overflow = (summary.filePaths || []).length - paths.length;
    return [
      `❓ ${config.botName} wants to write files (${reasonText})`,
      summary.grantRoot ? `  grantRoot: ${truncateForKeyboard(redactSensitiveText(summary.grantRoot), 120)}` : '',
      ...paths.map((p) => `  • ${truncateForKeyboard(redactSensitiveText(p), 120)}`),
      overflow > 0 ? `  ...and ${overflow} more` : '',
    ].filter(Boolean).join('\n');
  }

  const targetsOutsideRoots = summary.targetsOutsideRoots || [];
  return [
    `❓ ${config.botName} wants to run a command (${reasonText})`,
    `  command: ${truncateForKeyboard(redactSensitiveText(summary.command), 200)}`,
    `  cwd: ${truncateForKeyboard(redactSensitiveText(summary.cwd), 200)}`,
    summary.networkRequested ? '  🌐 network access requested' : '',
    ...targetsOutsideRoots.slice(0, 3).map((t) => `  ⚠️ writes: ${truncateForKeyboard(redactSensitiveText(t), 150)}`),
    targetsOutsideRoots.length > 3 ? `  ...and ${targetsOutsideRoots.length - 3} more write targets` : '',
  ].filter(Boolean).join('\n');
}

// Invalidate cards that can no longer be answered, so a late tap does not try
// to reply on a dead connection or to a request id that no longer exists.
function clearPendingApprovals(reason) {
  if (pendingApprovals.size === 0) return;
  const tokens = [...pendingApprovals.keys()];
  log(`clearing ${tokens.length} pending approval(s): ${reason}`);
  for (const token of tokens) {
    const pending = pendingApprovals.get(token);
    if (!pending) continue;
    pendingApprovals.delete(token);
    clearTimeout(pending.timer);
    telegram('editMessageText', {
      chat_id: pending.chatId,
      message_id: pending.messageId,
      text: `${pending.summaryText}\n\n⚠️ ${reason} — this request is no longer valid. Retry it to get a new card.`,
    }).catch(() => {});
    try { pending.resolve('decline'); } catch {}
  }
}

async function forwardApprovalToTelegram(info) {
  const approvalToken = crypto.randomBytes(4).toString('hex');
  const summaryText = approvalSummaryText(info);
  const timeoutSeconds = Math.round(Number(config.approvalTimeoutMs || DEFAULT_CONFIG.approvalTimeoutMs) / 1000);
  const ack = await telegram('sendMessage', {
    chat_id: ownerUserId,
    text: summaryText,
    reply_markup: JSON.stringify({
      // Two buttons only. There is deliberately no "approve for the rest of
      // this turn": every forwarded request needs its own tap.
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `apr:${approvalToken}:accept` },
        { text: '❌ Decline', callback_data: `apr:${approvalToken}:decline` },
      ]],
    }),
  });
  log(`approval forwarded token=${approvalToken} method=${info.method} reason=${info.reason} msg=${ack.message_id}`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingApprovals.get(approvalToken);
      if (!pending) return;
      pendingApprovals.delete(approvalToken);
      telegram('editMessageText', {
        chat_id: pending.chatId,
        message_id: pending.messageId,
        text: `${pending.summaryText}\n\n⏱️ No answer within ${timeoutSeconds}s — declined automatically.`,
      }).catch(() => {});
      log(`approval token=${approvalToken} timed out -> auto decline`);
      resolve('decline');
    }, Number(config.approvalTimeoutMs || DEFAULT_CONFIG.approvalTimeoutMs));
    pendingApprovals.set(approvalToken, {
      resolve,
      timer,
      chatId: ownerUserId,
      messageId: ack.message_id,
      summaryText,
      method: info.method,
      isNewProto: info.isNewProto,
    });
  });
}

async function handleCallbackQuery(callback) {
  const callbackQueryId = callback.id;
  const fromId = String(callback.from?.id || '');
  const data = String(callback.data || '');

  if (fromId !== ownerUserId) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: '❌ Only the owner can answer approvals.',
    }).catch(() => {});
    log(`callback_query from non-owner=${fromId} rejected`);
    return;
  }
  const match = data.match(APPROVAL_TOKEN_RE);
  if (!match) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: '⚠️ Invalid approval token.',
    }).catch(() => {});
    return;
  }
  const [, approvalToken, action] = match;
  const pending = pendingApprovals.get(approvalToken);
  if (!pending) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: '⚠️ This approval already timed out or was answered.',
      show_alert: true,
    }).catch(() => {});
    return;
  }
  pendingApprovals.delete(approvalToken);
  clearTimeout(pending.timer);
  const labelMap = { accept: '✅ Approved', decline: '❌ Declined' };
  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: labelMap[action] || action,
  }).catch(() => {});
  await telegram('editMessageText', {
    chat_id: pending.chatId,
    message_id: pending.messageId,
    text: `${pending.summaryText}\n\n${labelMap[action] || action}`,
  }).catch(() => {});
  pending.resolve(action);
  log(`approval token=${approvalToken} answered=${action}`);
}

// ---------------------------------------------------------------------------
// Private chat
// ---------------------------------------------------------------------------

async function sendDurablePrivateText(
  durableUpdateId,
  chatId,
  text,
  { threadId = sessionId, rawTelegram = false } = {},
) {
  if (durableUpdateId == null) {
    if (rawTelegram) return telegram('sendMessage', { chat_id: chatId, text });
    await sendMessage(chatId, text);
    return null;
  }

  let delivery = durableInbox.privateDelivery(durableUpdateId);
  if (!delivery) {
    delivery = durableInbox.markPrivateGenerated(durableUpdateId, { reply: text, threadId, chatId });
  }
  if (delivery.sent) {
    log(`durable private reply already acked, not resending update=${durableUpdateId}`);
    return delivery.sendResult;
  }

  let sendResult = null;
  if (rawTelegram) {
    sendResult = await telegram('sendMessage', { chat_id: chatId, text: delivery.reply });
  } else {
    await sendMessage(chatId, delivery.reply, null, { delivery: privateChunkDelivery(durableUpdateId) });
  }
  durableInbox.markPrivateSendAck(durableUpdateId, sendResult);
  return sendResult;
}

async function processPrivateMessage(message, text, context, images = [], files = [], durableUpdateId = null) {
  const chatId = String(message.chat.id);
  const fromId = String(message.from.id);
  log(`authorized private message chat=${chatId} from=${fromId}`);

  if (/^\/start$/i.test(text)) {
    await sendMessage(chatId, `${config.botName} is online.`);
    return;
  }

  if (/^\/status$/i.test(text)) {
    const inboxStats = durableInbox.stats();
    const deadIds = durableInbox.deadUpdates().slice(0, 10).map((entry) => entry.updateId);
    await sendMessage(
      chatId,
      [
        `${config.botName} bridge online | mode: ${codexMode}`,
        `thread: ${sessionId || 'not created yet'}`,
        `groups: ${allowedGroups.size} static + ${Object.keys(dynamicGroups).length} dynamic`,
        `updates: pending=${inboxStats.pending} (backoff=${inboxStats.delayed}) in-flight=${inFlightUpdates.size}`
        + ` group-replay=${inFlightGroupBatches.size} dead=${inboxStats.dead}`,
        deadIds.length ? `dead ids: ${deadIds.join(', ')}${inboxStats.dead > deadIds.length ? '...' : ''}` : '',
      ].filter(Boolean).join('\n'),
    );
    return;
  }

  if (/^\/catchup(?:@\w+)?(?:\s|$)/i.test(text)) {
    // 崩溃安全：整条 /catchup 是一次 durable operation。看到「有 intent 没 result」= 上次喂到一半崩了，
    // 绝不自动重喂整包（Plan P0 ①：一旦 outcome-unknown 只能查证或人工决策）。
    const priorOperation = durableUpdateId == null ? null : durableInbox.operation(durableUpdateId);
    if (priorOperation?.status === 'result') {
      await sendDurablePrivateText(durableUpdateId, chatId, String(priorOperation.result.reply || '已处理'));
      return;
    }
    if (priorOperation?.status === 'intent') {
      await sendMessage(chatId, '⚠️ 上一次 /catchup 送到一半没确认完，为免把整包重新塞进会话，这次不自动重放。确认要重读请发 /catchup <digest-id> --again。');
      durableInbox.completeOperation(durableUpdateId, { reply: 'catchup 中断，未自动重放' });
      return;
    }
    if (durableUpdateId != null) durableInbox.beginOperation(durableUpdateId, 'catchup', { text });
    const reading = currentContextReading();
    let summary = '已处理 /catchup';
    await handleCatchupCommand({
      text,
      isOwner: String(message.from.id) === ownerUserId,
      contextPercent: reading?.percent ?? null,
      contextCapacityTokens: Number(config.contextCapacityTokens || 1_000_000),
      log,
      send: async (reply) => { summary = reply; await sendMessage(chatId, reply); },
      deliver: async (prompt, part) => {
        summary = `已送入补读 ${part.digestId}（${part.index}/${part.of}）`;
        const generated = await modelQueue.run(() => askCodex(prompt, { source: 'downtime-catchup', digestId: part.digestId }));
        await sendMessage(chatId, generated.reply);
      },
    });
    if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { reply: summary });
    return;
  }

  if (/^\/session$/i.test(text)) {
    await sendMessage(chatId, `Current Codex thread: ${sessionId || 'not created yet'}`);
    return;
  }

  if (/^\/tools$/i.test(text)) {
    await sendMessage(
      chatId,
      [
        `Private tool mode: ${privateToolsEnabled ? 'enabled' : 'disabled'}`,
        `Writable roots: ${toolWritableRoots.join(', ')}`,
        `Network access: ${config.toolNetworkAccess === true ? 'enabled' : 'disabled'}`,
        'Group workspace tools: opt-in per group; Telegram replies/reactions are never blocked.',
      ].join('\n'),
    );
    return;
  }

  const retryUpdateMatch = text.match(/^\/retry_update\s+(\d+)$/i);
  if (retryUpdateMatch) {
    if (fromId !== ownerUserId) {
      await sendMessage(chatId, '❌ /retry_update is owner-only.');
      return;
    }
    const updateId = Number(retryUpdateMatch[1]);
    const operation = durableUpdateId == null
      ? { status: 'intent' }
      : durableInbox.beginOperation(durableUpdateId, 'retry-update', { targetUpdateId: updateId });
    let reply;
    if (operation.status === 'result') {
      reply = String(operation.result.reply);
    } else {
      const requeued = durableInbox.requeueDead(updateId);
      const recoveredPriorSuccess = !requeued && durableInbox.updateState(updateId) === 'received';
      reply = requeued || recoveredPriorSuccess
        ? `✅ update ${updateId} moved back from the dead-letter queue.`
        : `update ${updateId} is not in the dead-letter queue, or its original record is unavailable.`;
      if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { reply });
      if (requeued || recoveredPriorSuccess) {
        dispatchDurableUpdates().catch((error) => log(`manual retry dispatch failed update=${updateId}: ${error.message}`));
      }
    }
    await sendDurablePrivateText(durableUpdateId, chatId, reply);
    return;
  }

  // Writes a handoff and changes nothing else — the safe way to see what /new
  // would save before committing to a switch that cannot be undone.
  if (/^\/ctx$/i.test(text)) {
    const reading = currentContextReading();
    if (!reading) {
      await sendMessage(chatId, '读不到水位（TUI 状态行和 wire 都没给出数字）');
      return;
    }
    const filled = Math.round(reading.percent / 5);
    const bar = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, 20 - filled));
    await sendMessage(chatId, [
      '🐦‍⬛ 鸦鸦的上下文',
      `${bar} ${reading.percent}%`,
      reading.label || '',
      `session ${sessionId || '未知'}`,
    ].filter(Boolean).join('\n'));
    return;
  }

  if (/^\/handoff$/i.test(text)) {
    try {
      const { filePath, text: handoffText } = await writeHandoffNow(chatId);
      await sendMessage(chatId, `${handoffMessage(filePath, handoffText)}\n\n（session 没动，还是原来那个。）`);
    } catch (error) {
      log(`/handoff failed: ${error.message}`);
      await sendMessage(chatId, `❌ 交接没写成：${error.message}`);
    }
    return;
  }

  // /carryover = 精炼预演。跟 /refine 跑同一段抽取代码，但什么都不换 ——
  // 让她先看清会带走什么，再决定要不要真换。
  if (/^\/carryover$/i.test(text)) {
    try {
      await sendMessage(chatId, '🔍 精炼预演中（session 不动）…');
      const payload = await buildCarryover(codex.wirePath(sessionId));
      const filePath = writeCarryoverFile({
        root: handoffRoot, sessionId, body: payload.body, report: payload,
      });
      await sendMessage(chatId, `${carryoverMessage(filePath, payload)}\n\n（session 没动。要带着它换窗就发 /refine。）`);
    } catch (error) {
      log(`/carryover failed: ${error.message}`);
      await sendMessage(chatId, `❌ 精炼没做成：${error.message}`);
    }
    return;
  }

  const newThreadMatch = text.match(/^\/(force_)?(new|refine)$/i);
  if (newThreadMatch) {
    // Synqa (2026-08-15): 「我/new的时候再写交接然后直接换」。
    // Switching is one-way — whatever lived only in the old window dies with it.
    // So: write the handoff, put it on disk, and only then switch. If it cannot
    // be written we do NOT switch; /force_new is the deliberate way past that.
    //
    // 2026-08-16 加 /refine：new 是搬家只带一封信，refine 是把重要的东西装箱
    // 带走 —— 交接笔记之外再落一份"上一窗的原话摘录"，换完让新 session 自己
    // 读回来。两个都在她手里，不替她选。
    const forceSwitch = Boolean(newThreadMatch[1]);
    const withCarryover = newThreadMatch[2].toLowerCase() === 'refine';
    const previousSessionId = sessionId;
    let handoffPath = null;
    let carryoverPath = null;

    if (!forceSwitch) {
      try {
        await sendMessage(chatId, '📝 先让鸦鸦写交接，写完再换…');
        const { filePath, text: handoffText } = await writeHandoffNow(chatId);
        handoffPath = filePath;
        await sendMessage(chatId, handoffMessage(filePath, handoffText));
      } catch (error) {
        log(`handoff before /${newThreadMatch[2]} failed: ${error.message}`);
        await sendMessage(
          chatId,
          `❌ 交接没写成：${error.message}\n\n**没有换 session，旧的还在。**`
          + `\n可以再发一次 /${newThreadMatch[2]} 重试；确定不要交接就发 /force_${newThreadMatch[2]}。`,
        );
        return;
      }
    }

    if (withCarryover) {
      try {
        await sendMessage(chatId, '🗂 正在精炼上一窗的原话…');
        const payload = await buildCarryover(codex.wirePath(previousSessionId));
        carryoverPath = writeCarryoverFile({
          root: handoffRoot, sessionId: previousSessionId, body: payload.body, report: payload,
        });
        await sendMessage(chatId, carryoverMessage(carryoverPath, payload));
      } catch (error) {
        log(`carryover before /refine failed: ${error.message}`);
        if (!forceSwitch) {
          // 精炼是 /refine 的全部意义，做不出来就没有换的理由 —— 旧窗留着。
          await sendMessage(
            chatId,
            `❌ 精炼没做成：${error.message}\n\n**没有换 session，旧的还在。**`
            + '\n可以再发一次 /refine 重试；只要干净重开就发 /new。',
          );
          return;
        }
        await sendMessage(chatId, `⚠️ 精炼没做成（${error.message}），但 force 了，继续换。`);
      }
    }
    const operation = durableUpdateId == null
      ? { status: 'intent', payload: { previousThreadId: sessionId } }
      : durableInbox.beginOperation(durableUpdateId, 'new-thread', { previousThreadId: sessionId });
    if (operation.status === 'result') {
      sessionId = String(operation.result.threadId);
    } else {
      const previousThreadId = operation.payload.previousThreadId || null;
      const persistedThreadId = readPrivateFile(sessionPath) || null;
      if (persistedThreadId && persistedThreadId !== previousThreadId) {
        // onReady persists the new id synchronously. If the process died after
        // the switch but before the operation result, recover that exact id
        // rather than creating a second replacement thread.
        sessionId = persistedThreadId;
      } else {
        if (previousThreadId) writePrivateFile(previousSessionPath, previousThreadId);
        sessionId = await modelQueue.run(() => codex.newThread(), 20);
      }
      if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { threadId: sessionId });
    }
    await sendDurablePrivateText(
      durableUpdateId,
      chatId,
      `A fresh Codex thread is ready: ${sessionId}\nThe previous thread id was saved for /resume.`,
      { threadId: sessionId },
    );

    // 换完之后叫新 session 自己去读那两份东西。不把历史灌进去 —— 他自己 Read
    // 回来更像"取回记忆"，也接得上 AGENTS.md 里既有的「醒来先读萨迦」纪律。
    if (withCarryover && (handoffPath || carryoverPath)) {
      try {
        const turn = await modelQueue.run(
          () => askCodex(
            buildWakePrompt({ handoffPath, carryoverPath, previousSessionId }),
            { isGroup: false, chatId, senderName: config.ownerName, senderIsBot: false },
            [],
          ),
          20,
        );
        const reply = String(turn?.reply || '').trim();
        if (reply) await sendMessage(chatId, reply);
        log(`wake prompt delivered to ${sessionId}`);
      } catch (error) {
        log(`wake prompt failed: ${error.message}`);
        await sendMessage(
          chatId,
          `⚠️ 新 session 已经建好了，但引导他读交接那一步失败了：${error.message}`
          + `\n你直接跟他说一句「先读 ${carryoverPath || handoffPath}」也一样。`,
        );
      }
    }
    return;
  }

  // Kimi session ids carry a `session_` prefix in front of the UUID; codex
  // thread ids are the bare UUID. Accept both so /resume works in every mode.
  const resumeMatch = text.match(/^\/(?:resume|attach)\s+((?:session_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (resumeMatch) {
    const targetThreadId = resumeMatch[1].toLowerCase();
    const operation = durableUpdateId == null
      ? { status: 'intent', payload: { targetThreadId, previousThreadId: sessionId } }
      : durableInbox.beginOperation(durableUpdateId, 'resume-thread', {
        targetThreadId,
        previousThreadId: sessionId,
      });
    if (operation.status === 'result') {
      sessionId = String(operation.result.threadId);
    } else {
      const persistedThreadId = readPrivateFile(sessionPath) || null;
      if (persistedThreadId === operation.payload.targetThreadId) {
        sessionId = persistedThreadId;
      } else {
        if (sessionId && sessionId !== targetThreadId) writePrivateFile(previousSessionPath, sessionId);
        sessionId = await modelQueue.run(() => codex.resumeThread(targetThreadId), 20);
      }
      if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { threadId: sessionId });
    }
    await sendDurablePrivateText(durableUpdateId, chatId, `Switched to Codex thread: ${sessionId}`, { threadId: sessionId });
    return;
  }

  if (/^\/reload_config$/i.test(text)) {
    await handleReloadConfig(message, durableUpdateId);
    return;
  }
  const restartBridgeMatch = text.match(/^\/(force_)?restart_bridge$/i);
  if (restartBridgeMatch) {
    await handleRestartBridge(message, { force: Boolean(restartBridgeMatch[1]), durableUpdateId });
    return;
  }
  const restartDaemonMatch = text.match(/^\/(force_)?restart_daemon$/i);
  if (restartDaemonMatch) {
    await handleRestartDaemon(message, { force: Boolean(restartDaemonMatch[1]), durableUpdateId });
    return;
  }

  const typing = setInterval(() => {
    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  typing.unref();

  try {
    const startedAt = Date.now();
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    if (durableUpdateId == null) {
      const generated = await modelQueue.run(() => askCodex(text, context, images, files), 10);
      await sendMessage(chatId, generated.reply);
    } else {
      await deliverDurablePrivateReply({
        inbox: durableInbox,
        updateId: durableUpdateId,
        chatId,
        generate: () => modelQueue.run(() => askCodex(text, context, images, files, `private:${durableUpdateId}`), 10),
        send: async (reply) => {
          await sendMessage(chatId, reply, null, { delivery: privateChunkDelivery(durableUpdateId) });
          return null;
        },
        onReplay: (delivery) => {
          log(`crash replay using the persisted reply update=${durableUpdateId} thread=${delivery.threadId || '?'}`);
          if (delivery.sent) log(`crash replay skipping an already acked send update=${durableUpdateId}`);
        },
      });
    }
    log(`private reply sent chat=${chatId} from=${fromId} elapsed_ms=${Date.now() - startedAt}`);
  } catch (error) {
    log(`private handling failed chat=${chatId}: ${error.message}`);
    throw error;
  } finally {
    clearInterval(typing);
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleMessage(message, durableUpdateId = null, albumMessages = []) {
  const rawText = getTelegramMessageText(message);
  const messageHasAttachments = hasTelegramAttachments(message);
  if (!message || (!rawText && !messageHasAttachments)) return {};

  const fromId = String(message.from?.id || '');
  const chatId = String(message.chat?.id || '');
  const senderIsBot = Boolean(message.from?.is_bot);
  const senderUsername = String(message.from?.username || '');
  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
    || senderUsername
    || fromId;
  const sentAt = Number(message.date || 0) * 1000 || Date.now();
  const isPrivate = message.chat?.type === 'private';
  const isGroup = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
  let groupConfig = null;
  let groupMentionContext = null;
  let shouldRememberCurrentGroupMessage = false;

  const capturePassiveGroupImages = async () => {
    for (const source of [message, ...albumMessages]) {
      const hasPhoto = Array.isArray(source.photo) && source.photo.length > 0;
      const hasImageDocument = String(source.document?.mime_type || '').toLowerCase().startsWith('image/');
      if (!hasPhoto && !hasImageDocument) continue;
      const { images } = await downloadTelegramAttachments(source, {
        token, imageCacheDir, fileCacheDir, log,
        maxImageBytes: Number(config.imageMaxBytes || DEFAULT_CONFIG.imageMaxBytes),
        maxFileBytes: Number(config.fileMaxBytes || DEFAULT_CONFIG.fileMaxBytes),
        maxPreviewChars: Number(config.attachmentTextMaxChars || DEFAULT_CONFIG.attachmentTextMaxChars),
      });
      const sourceUpdate = source === message ? durableUpdateId
        : durableInbox.albumForUpdate(durableUpdateId)?.updates.find((u) => u.message?.message_id === source.message_id)?.update_id;
      const tokens = pendingGroupImages.record({
        chatId, messageId: source.message_id, updateId: sourceUpdate ?? null,
        sentAt: new Date(Number(source.date || 0) * 1000 || sentAt).toISOString(), images,
      });
      if (tokens.length) log(`quiet group image queued chat=${chatId} message=${source.message_id} images=${tokens.length}`);
    }
  };

  if (isPrivate) {
    if (!allowedUserIds.has(fromId)) {
      log(`ignore unauthorized private message from=${fromId || '?'}`);
      return {};
    }
  } else if (isGroup) {
    refreshDynamicGroups();
    const staticGroupConfig = allowedGroups.get(chatId) || null;
    // Gate commands run before the authorization check: /<prefix>_on is how a
    // group gets authorized in the first place.
    if (!senderIsBot && await handleFlowCommand({
      rawText, chatId, fromId, messageId: message.message_id,
      send: (text) => sendMessage(chatId, text),
      isOwner: String(fromId) === String(config.ownerUserId || '') || allowedUserIds.has(String(fromId)),
    })) return;
    if (!senderIsBot && await handleGateCommand({
      message,
      rawText,
      chatId,
      fromId,
      isGroup,
      senderIsBot,
      ownerUserId,
      dynamicGroupsPath,
      commandPrefix: gateCommandPrefix,
      botName: config.botName,
      staticGroupConfig,
      sendMessage,
      log,
    })) {
      refreshDynamicGroups(true);
      return {};
    }

    groupConfig = staticGroupConfig || dynamicGroups[chatId] || null;
    if (!groupConfig) {
      log(`ignore unauthorized group chat=${chatId || '?'} from=${fromId || '?'}`);
      return {};
    }

    groupMentionContext = mentionContextOptions(groupConfig);
    // 2026-09-01 Synqa 定的边界：**要拦的只有除她之外的私聊；群里不拦人。**
    // 她原话：「不光是家人，他到了外面的群里功能应该一样啊，外面的人和机也应该
    // 能叫醒他才对」。
    //
    // 旧默认是反的：groupAllowedUsers 只有她一个，allowAllHumanUsers /
    // allowAllBotUsers 默认未设，于是在群里**除了她谁都叫不醒他** —— 家人不行、
    // 棠棠咪豹 West 这些朋友也不行。他在外面的群等于半个哑巴。日志里
    // "ignore unauthorized group member" 从 8/22 基线重写起每天几百条，
    // 8/30 峰值 1183 条；而会客室里 Syner 发过 2186 条、修理铺子 1215 条，
    // 桥原始都收到了，一条都没进他视野。
    //
    // 现在群里默认全开：谁说话都能触发。要不要开口仍由 requireMention /
    // 唤醒词 / 连发上限 / 他自己的判断把关 —— 那些才是该管"回不回"的闸。
    // 显式设为 false 时仍可收紧（保留逃生口，但不再是默认）。
    // 私聊那道门（allowedUserIds）一行未动：那道才是真该拦的。
    const senderCanTrigger = canTriggerInGroup(
      { senderId: fromId, senderIsBot },
      groupConfig,
      config.allowedUserIds,
    );
    const shouldRecordDeliveredMessage = groupMentionContext.recordAllDeliveredMessages === true || senderCanTrigger;
    const rememberPassiveGroupMessage = () => {
      if (!shouldRecordDeliveredMessage) return;
      rememberGroupMessage({
        chatId,
        messageId: message.message_id,
        text: passiveHistoryText(rawText, messageHasAttachments, groupMentionContext),
        senderIsBot,
        senderUsername,
        senderName,
        sentAt,
      }, groupMentionContext);
    };

    if (senderIsBot && isNonConversationalBotMessage(rawText)) {
      log(`ignore bridge/status bot message chat=${chatId} from=${fromId}`);
      return {};
    }

    if (!senderCanTrigger) {
      rememberPassiveGroupMessage();
      await capturePassiveGroupImages();
      log(`ignore unauthorized group member chat=${chatId} from=${fromId || '?'}`);
      return {};
    }

    if (!senderIsBot) groupBotRuns.set(chatId, 0);

    const entities = getTelegramMessageEntities(message);
    const mentioned = entities.some((entity) => {
      if (entity.type !== 'mention') return false;
      return rawText
        .slice(entity.offset, entity.offset + entity.length)
        .toLowerCase() === `@${botUsername.toLowerCase()}`;
    });
    const repliedToBot = String(message.reply_to_message?.from?.id || '') === botId;
    const addressedCommand = new RegExp(
      `^\\/(?:start|status|new)@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    ).test(rawText);
    const allowUnaddressedBot = senderIsBot && groupConfig.allowUnaddressedBotMessages === true;
    const stopInstruction = !senderIsBot && isStopInstruction(rawText);
    // Being called by name counts as being addressed, not just an @mention.
    const mentionPatternHit = !senderIsBot && messageHitsMentionPatterns(rawText);

    if (
      groupConfig.requireMention !== false
      && !mentioned
      && !repliedToBot
      && !addressedCommand
      && !allowUnaddressedBot
      && !stopInstruction
      && !mentionPatternHit
    ) {
      rememberPassiveGroupMessage();
      await capturePassiveGroupImages();
      return {};
    }

    shouldRememberCurrentGroupMessage = shouldRecordDeliveredMessage;

    if (senderIsBot) {
      const previousRun = groupBotRuns.get(chatId) || 0;
      const nextRun = previousRun + 1;
      groupBotRuns.set(chatId, nextRun);
      // 续场模式优先：Synqa 临时抬高的上限盖过本群配置。她要这个是因为几个 bot
      // 聊起来时上限一到就停，得她开口才续 —— 而她本没在参与。
      const flowLimit = groupFlow.flowLimitFor(chatId);
      const runLimit = flowLimit || Number(groupConfig.maxConsecutiveBotMessages || 8);
      if (nextRun > runLimit) {
        rememberPassiveGroupMessage();
        await capturePassiveGroupImages();
        log(`pause consecutive bot conversation chat=${chatId} from=${fromId} count=${nextRun}`);
        return {};
      }
    }
  } else {
    return {};
  }

  const mentionPattern = botUsername
    ? new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    : null;
  const captionOrText = (mentionPattern ? rawText.replace(mentionPattern, '') : rawText).trim();
  const attachmentOptions = {
    token,
    imageCacheDir,
    fileCacheDir,
    log,
    maxImageBytes: Number(config.imageMaxBytes || DEFAULT_CONFIG.imageMaxBytes),
    maxFileBytes: Number(config.fileMaxBytes || DEFAULT_CONFIG.fileMaxBytes),
    maxPreviewChars: Number(config.attachmentTextMaxChars || DEFAULT_CONFIG.attachmentTextMaxChars),
  };
  const { images, files, notes: attachmentNotes } = await downloadTelegramAttachments(message, attachmentOptions);
  // 相册的其余几条只带图（caption 通常只在第一条上），并进同一轮：
  // 一次发三张图 = 一个 turn、一次回答。
  for (const extra of albumMessages) {
    try {
      const more = await downloadTelegramAttachments(extra, attachmentOptions);
      images.push(...more.images);
      files.push(...more.files);
      if (Array.isArray(more.notes) && Array.isArray(attachmentNotes)) attachmentNotes.push(...more.notes);
    } catch (error) {
      // 相册里掉一张图，不让整轮回复陪葬。
      log(`album attachment download failed message=${extra?.message_id}: ${error.message}`);
    }
  }
  const text = buildMessageTextWithAttachments(captionOrText, images, files, attachmentNotes);
  if (!text && !images.length && !files.length) {
    if (isGroup && shouldRememberCurrentGroupMessage) {
      rememberGroupMessage({
        chatId,
        messageId: message.message_id,
        text: passiveHistoryText(rawText, messageHasAttachments, groupMentionContext),
        senderIsBot,
        senderUsername,
        senderName,
        sentAt,
      }, groupMentionContext);
    }
    return {};
  }

  const context = {
    isGroup,
    chatId,
    chatTitle: message.chat?.title || groupConfig?.title || '',
    senderIsBot,
    senderUsername,
    senderName,
    groupProfile: groupConfig?.profile || '',
    replyTo: buildTelegramReplyContext(message, botUsername),
  };

  appendLiveLog({
    direction: 'in',
    chatType: isPrivate ? 'private' : 'group',
    chatId,
    chatTitle: context.chatTitle || null,
    messageId: message.message_id || null,
    sentAt: new Date(sentAt).toISOString(),
    senderId: fromId,
    senderName,
    senderUsername: senderUsername || null,
    senderIsBot,
    text: truncateLiveText(text),
    images: images.map(compactLiveAttachment),
    files: files.map(compactLiveAttachment),
  });

  if (isPrivate) {
    return {
      completion: privateMessageQueue.run(
        () => processPrivateMessage(message, text, context, images, files, durableUpdateId),
        10,
      ),
    };
  }

  if (shouldRememberCurrentGroupMessage) {
    rememberGroupMessage({
      chatId,
      messageId: message.message_id,
      text,
      senderIsBot,
      senderUsername,
      senderName,
      sentAt,
    }, groupMentionContext);
  }

  log(`authorized group message chat=${chatId} from=${fromId} sender=${senderUsername || senderName} bot=${senderIsBot}`);
  const queued = groupBatcher.enqueue({
    chatId,
    chatTitle: context.chatTitle,
    messageId: message.message_id,
    replyTo: context.replyTo,
    text,
    images,
    files,
    senderId: fromId,
    senderIsBot,
    senderUsername,
    senderName,
    sentAt,
    receivedAt: Date.now(),
    _durableUpdateId: Number(durableUpdateId),
  });
  return { completion: queued.completion };
}

async function checkConnection() {
  const me = await telegram('getMe');
  botId = String(me.id);
  botUsername = String(me.username || '');
  console.log(`Telegram OK: @${me.username} (${me.id})`);
}

// ---------------------------------------------------------------------------
// Durable dispatch
// ---------------------------------------------------------------------------

async function prepareTelegramUpdate(update, albumMessages = []) {
  if (update.callback_query) {
    return { completion: handleCallbackQuery(update.callback_query) };
  }
  if (update.message) return (await handleMessage(update.message, Number(update.update_id), albumMessages)) || {};
  return {};
}

function updateRetryOptions(error = null) {
  return {
    countAttempt: error?.retryWithoutAttempt !== true,
    maxAttempts: Math.max(1, Number(config.updateMaxAttempts || DEFAULT_CONFIG.updateMaxAttempts)),
    baseDelayMs: Math.max(250, Number(config.updateRetryBaseMs || DEFAULT_CONFIG.updateRetryBaseMs)),
    maxDelayMs: Math.max(1000, Number(config.updateRetryMaxMs || DEFAULT_CONFIG.updateRetryMaxMs)),
  };
}

function recordUpdateFailure(update, error, phase) {
  const updateId = Number(update.update_id);
  const errorText = redactSensitiveText(error?.message || String(error || 'unknown'));
  const groupBatch = durableInbox.groupBatchForUpdate(updateId);
  if (groupBatch?.state === 'dead') {
    log(`group batch ${groupBatch.batchId} is already dead-lettered; not counting update=${updateId} again`);
    return;
  }
  let retry;
  try {
    retry = groupBatch
      ? durableInbox.markGroupBatchRetry(groupBatch.batchId, errorText, updateRetryOptions(error))
      : durableInbox.markRetry(updateId, errorText, updateRetryOptions(error));
  } catch (journalError) {
    log(`update ${updateId} failed during ${phase}, and the retry state could not be written: ${journalError.message}`);
    return;
  }

  if (retry.alreadyScheduled) return;

  if (retry.dead) {
    log(`update ${updateId} failed during ${phase} and moved to dead-letter (attempts=${retry.attempts}): ${errorText}`);
    sendMessage(
      ownerUserId,
      `⚠️ Telegram update ${updateId} failed ${retry.attempts} times and moved to the dead-letter queue; the original`
      + ` record is retained. Use /retry_update ${updateId} to try again. Phase: ${phase}\nError: ${errorText}`,
    ).catch((noticeError) => log(`dead-letter notice failed update=${updateId}: ${noticeError.message}`));
    return;
  }

  log(`update ${updateId} failed during ${phase}, retry=${retry.attempts} next=${tsCN(retry.nextAttemptAt)}: ${errorText}`);
  const privateChatId = update.message?.chat?.type === 'private' ? String(update.message.chat.id || '') : '';
  // 2026-08-31：不再向她本人推「没送出去」这条。
  //
  // 她那次问日记，收到的是：一条 Cache 通知 + 这条"没送出去" + 一句冷冰冰的
  // "重复投递，答案不变"，而 Skald 真正写的完整回复被吞了。三条噪音一条正餐没有。
  //
  // 这条通知的问题不只是吵，它**说的还不是真的**：触发点是 matched 判定失败，
  // 而消息此刻往往已经进了 TUI、agent 甚至已经答完了。告诉她"没送出去、不用重发"，
  // 她看到的却是对方随后自言自语——比不说更伤。
  //
  // 真正的失败她一定会知道：重试耗尽会进 dead-letter 并单独通知（上面那段）。
  // 中途的每一次重试属于运维细节，写进日志给我们看就够了，不该占用她的屏幕。
  if (retry.attempts === 1 && privateChatId && allowedUserIds.has(privateChatId)) {
    log(`[retry] update=${updateId} 首次重试（不打扰她，仅记日志）phase=${phase}`);
  } else if (retry.attempts === 1) {
    sendMessage(
      ownerUserId,
      `⚠️ Telegram update ${updateId} did not complete and is queued for a local retry; no need to resend. Phase: ${phase}`,
    ).catch((noticeError) => log(`first retry notice failed update=${updateId}: ${noticeError.message}`));
  }
}

async function replayDurableGroupBatch(record) {
  if (!record.updateIds.every((id) => {
    const update = durableInbox.rawUpdate(id);
    return !update || mayDispatchUpdate(update);
  })) return false;
  if (!groupStillAuthorized(record.chatId)) {
    durableInbox.markGroupBatchDone(record.batchId, 'group-authorization-revoked');
    log(`group replay retained as terminal without model/send: authorization revoked batch=${record.batchId}`);
    return true;
  }

  const batch = record.preparedMessages.map((message) => ({
    ...message,
    _durableGroupBatchId: record.batchId,
  }));
  if (
    !batch.length
    || batch.some((message) => {
      const updateId = Number(message._durableUpdateId);
      return !Number.isSafeInteger(updateId) || updateId < 0;
    })
  ) {
    throw new Error(`durable group batch ${record.batchId} has invalid contents`);
  }

  let replies = record.replies;
  let threadId = record.threadId;
  if (replies == null) {
    replies = await generateGroupReplies(batch, { superseding: false, replayBatchId: record.batchId });
    if (batch.some((message) => message._authorizationRevoked)) {
      durableInbox.markGroupBatchDone(record.batchId, 'group-authorization-revoked');
      return true;
    }
    const refreshed = durableInbox.groupBatchForUpdate(record.updateIds[0]);
    threadId = refreshed?.threadId || batch[0]?._processedThreadId || null;
  } else {
    for (const message of batch) message._processedThreadId = threadId;
  }

  const chatId = String(record.chatId || batch.at(-1)?.chatId || '');
  for (const [replyIndex, reply] of replies.slice(0, 2).entries()) {
    if (durableInbox.isGroupReplyAcked(record.batchId, replyIndex)) {
      log(`crash replay skipping an acked reply batch=${record.batchId} reply=${replyIndex}`);
      continue;
    }
    const validTargets = new Set(replyTargetIdsForBatch(batch));
    const fallbackMessageId = [...batch].reverse().find((message) => !message.senderIsBot && validTargets.has(Number(message.messageId)))?.messageId
      || [...validTargets].at(-1) || null;
    const sent = await sendMessage(
      chatId,
      reply.text,
      reply.replyToMessageId || fallbackMessageId,
      { shouldSend: () => groupStillAuthorized(chatId), delivery: groupChunkDelivery(record.batchId, replyIndex) },
    );
    if (!sent) throw new Error(`crash replay send skipped batch=${record.batchId} reply=${replyIndex}`);
    durableInbox.markGroupReplyAck(record.batchId, replyIndex);
  }

  if (!threadId) throw new Error(`crash replay has no threadId batch=${record.batchId}`);
  advanceGroupContextCursor(chatId, threadId, batch.map((message) => message.messageId));
  durableInbox.markGroupBatchDone(record.batchId);
  log(`crash replay done batch=${record.batchId} updates=${record.updateIds.join(',')}`);
}

function recordGroupBatchReplayFailure(record, error) {
  const errorText = redactSensitiveText(error?.message || String(error || 'unknown'));
  let retry;
  try {
    retry = durableInbox.markGroupBatchRetry(record.batchId, errorText, updateRetryOptions(error));
  } catch (journalError) {
    log(`group batch ${record.batchId} replay failed, and the retry state could not be written: ${journalError.message}`);
    return;
  }
  if (retry.alreadyScheduled) return;
  if (retry.dead) {
    log(`group batch ${record.batchId} replay failed and moved to dead-letter: ${errorText}`);
    sendMessage(
      ownerUserId,
      `⚠️ Telegram group batch ${record.batchId} failed ${retry.attempts} times and moved to the dead-letter queue;`
      + ` the original record is retained. Use /retry_update ${record.updateIds[0]} to try again.\nError: ${errorText}`,
    ).catch((noticeError) => log(`group dead-letter notice failed batch=${record.batchId}: ${noticeError.message}`));
    return;
  }
  log(`group batch ${record.batchId} replay failed, retry=${retry.attempts} next=${tsCN(retry.nextAttemptAt)}: ${errorText}`);
  if (retry.attempts === 1) {
    sendMessage(
      ownerUserId,
      `⚠️ Telegram group batch ${record.batchId} did not complete and is queued for a local retry; no need to resend.`,
    ).catch((noticeError) => log(`group replay notice failed batch=${record.batchId}: ${noticeError.message}`));
  }
}

async function replayPendingDurableGroupBatches() {
  for (const record of durableInbox.pendingGroupBatches(Date.now(), { shouldDispatch: mayDispatchUpdate })) {
    // A live in-process batcher run owns these promises. Exact replay is only
    // for crash/retry recovery, never a second concurrent sender while the
    // original generation or delivery is still running.
    if (record.updateIds.some((updateId) => inFlightUpdates.has(updateId))) break;
    if (inFlightGroupBatches.has(record.batchId)) continue;
    inFlightGroupBatches.add(record.batchId);
    try {
      await replayDurableGroupBatch(record);
    } catch (error) {
      recordGroupBatchReplayFailure(record, error);
      break;
    } finally {
      inFlightGroupBatches.delete(record.batchId);
    }
  }
}

// 2026-08-30：Telegram 的相册不是一条消息，是 N 条共享 media_group_id 的 update。
// 不聚合就一张图回一条。albumWindowMs=0 可退回逐条行为。
const albumWindowMs = config.albumWindowMs === undefined
  ? DEFAULT_ALBUM_WINDOW_MS
  : Math.max(0, Number(config.albumWindowMs) || 0);
const albumBatcher = albumWindowMs > 0 ? createAlbumBatcher({ windowMs: albumWindowMs }) : null;
let albumFlushTimer = null;
// 窗口到点得有人来收：轮询可能正卡在 30s 长轮询上，等它回来太晚。
function scheduleAlbumFlush(waitMs) {
  if (albumFlushTimer) return;
  albumFlushTimer = setTimeout(() => {
    albumFlushTimer = null;
    dispatchDurableUpdates().catch((error) => log(`album flush dispatch failed: ${error.message}`));
  }, Math.max(50, Number(waitMs) || 50));
  albumFlushTimer.unref?.();
}

async function runDurableDispatch() {
  // 停机闸门：暂停期间一条都不进模型。poller 仍在收件、仍在落盘、仍在推进 offset，
  // 记录留在 received，恢复后按规则分类（外群弃读 / 超 6h 进 digest / 私聊逐条）。
  if (!downtime.gateOpen()) return;
  downtime.consumeResume();
  await downtime.flushCatchupNotices({
    send: (text, { noticeId, ownerId, isCurrent }) => deliverDurableNotice({
      directory: path.join(stateDir, 'catchup-notice-outbox'), noticeId, ownerId, text, isCurrent,
      send: (chatId, body, options) => sendMessage(chatId, body, null, options),
    }),
  });
  await replayPendingDurableGroupBatches();
  const maxInFlight = Math.max(1, Number(config.updateMaxInFlight || DEFAULT_CONFIG.updateMaxInFlight));
  const pendingSnapshot = durableInbox.pendingUpdates(Date.now(), { shouldDispatch: mayDispatchUpdate }).filter(mayDispatchUpdate);
  for (const update of pendingSnapshot) {
    const updateId = Number(update.update_id);
    if (inFlightUpdates.has(updateId)) continue;
    if (inFlightUpdates.size >= maxInFlight) break;

    // 相册聚合：每条 update 仍独立落盘，合并只发生在这里；窗口没到就跳过本轮，
    // 挂定时器到点再来，不 sleep 在收消息那条路上。
    let albumMessages = [];
    let albumBatchKey = null;
    if (albumBatcher) {
      try {
        const existing = durableInbox.albumForUpdate(updateId);
        let membership = existing;
        if (!membership) {
          const plan = albumBatcher.plan(update, pendingSnapshot);
          if (plan.action === 'wait') { scheduleAlbumFlush(plan.waitMs); continue; }
          if (plan.action === 'merge') {
            if (Number(plan.updates[0].update_id) !== updateId) continue;
            membership = durableInbox.markAlbumBatch(plan.updates);
            albumBatchKey = plan.batchKey;
          }
        }
        if (membership) {
          if (membership.primaryUpdateId !== updateId) continue;
          const [, ...rest] = membership.updates;
          albumMessages = rest.map((sibling) => sibling.message).filter(Boolean);
          albumBatchKey ||= membership.albumKey;
          if (albumMessages.length) log(`album merged chat=${update.message?.chat?.id} items=${albumMessages.length + 1}`);
        }
      } catch (error) {
        recordUpdateFailure(update, error, 'album-membership');
        break;
      }
    }

    let prepared;
    try {
      // Preparation is deliberately ordered: authorization, attachment
      // download and enqueue happen in update_id order. The long-running
      // model/send work is represented by `completion`, so later updates can
      // still join the same group batch.
      prepared = await prepareTelegramUpdate(update, albumMessages);
    } catch (error) {
      recordUpdateFailure(update, error, 'prepare');
      break;
    }

    const completion = Promise.resolve(prepared?.completion);
    const tracked = completion
      .then(() => {
        durableInbox.markDone(updateId);
        // markDone commits frozen album/group membership in one journal event.
        if (albumBatchKey) albumBatcher?.forget(albumBatchKey);
      })
      .catch((error) => {
        recordUpdateFailure(update, error, 'completion');
      })
      .finally(() => {
        inFlightUpdates.delete(updateId);
      });
    inFlightUpdates.set(updateId, tracked);
  }
}

function dispatchDurableUpdates() {
  if (durableDispatchPromise) return durableDispatchPromise;
  durableDispatchPromise = runDurableDispatch().finally(() => {
    durableDispatchPromise = null;
  });
  return durableDispatchPromise;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Synqa (2026-08-15): 「通知，然后90%再通知一次，我/new的时候再写交接然后直接换」
//
// Read-only by design. It never blocks a turn, never writes a handoff, never
// switches anything — it just makes sure the ceiling is never a surprise.
// One alert per threshold per session; a new session starts the count over.
function readContextAlertState() {
  try {
    const parsed = JSON.parse(readPrivateFile(contextAlertPath) || '{}');
    return {
      sessionId: parsed.sessionId || null,
      notified: Array.isArray(parsed.notified) ? parsed.notified.map(Number) : [],
    };
  } catch {
    return { sessionId: null, notified: [] };
  }
}

// Single source of truth for the water level: /ctx and the alert timer must
// never be able to disagree with each other (2026-08-16).
function currentContextReading() {
  // The TUI status line is the figure Kimi itself computes, so it can never
  // disagree with what she sees on screen. wire.jsonl only covers the gap when
  // the bar is not rendered.
  let percent = null;
  let label = '';
  try {
    const pane = typeof codex?.capturePane === 'function' ? codex.capturePane() : null;
    percent = parsePaneContextPercent(pane);
    label = parsePaneContextLabel(pane);
  } catch { /* pane unavailable; fall through to the wire */ }

  if (percent == null && typeof codex?.wirePath === 'function' && sessionId) {
    const capacity = Number(config.contextCapacityTokens || 1_000_000);
    const tokens = readWireContextTokens(codex.wirePath(sessionId));
    if (tokens && capacity > 0) {
      percent = Math.round((tokens / capacity) * 100);
      label = `${(tokens / 1000).toFixed(1)}k/${Math.round(capacity / 1000)}k`;
    }
  }
  return percent == null ? null : { percent, label };
}

async function checkContextUsage() {
  const ownerChatId = String(config.ownerUserId || '').trim();
  if (!ownerChatId || !sessionId) return;

  const reading = currentContextReading();
  if (!reading) return;
  const { percent, label } = reading;

  const state = readContextAlertState();
  if (state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    state.notified = [];
  }
  const thresholds = Array.isArray(config.contextAlertThresholds) && config.contextAlertThresholds.length
    ? config.contextAlertThresholds.map(Number)
    : DEFAULT_THRESHOLDS;
  const hits = crossedThresholds(percent, state.notified, thresholds);
  if (!hits.length) {
    // Still persist a session change so a fresh session cannot inherit old marks.
    writePrivateFile(contextAlertPath, JSON.stringify(state));
    return;
  }
  for (const threshold of hits) {
    await sendMessage(ownerChatId, formatContextAlert({
      percent,
      threshold,
      sessionId,
      tokensLabel: label,
    }));
    state.notified.push(threshold);
    log(`context alert sent threshold=${threshold} percent=${percent} session=${sessionId}`);
  }
  writePrivateFile(contextAlertPath, JSON.stringify(state));
}

// Shared by /handoff and /new. /new is one-way, so it can never be used to
// rehearse this; /handoff runs the identical path and changes nothing, which is
// how she (and I) can check the handoff is any good before it matters.
async function writeHandoffNow(chatId) {
  const turn = await modelQueue.run(
    () => askCodex(
      buildHandoffPrompt({ sessionId }),
      { isGroup: false, chatId, senderName: config.ownerName, senderIsBot: false },
      [],
    ),
    20,
  );
  const filePath = writeHandoff({ root: handoffRoot, sessionId, text: turn?.reply || '' });
  log(`handoff written: ${filePath}`);
  return { filePath, text: String(turn.reply) };
}

function handoffMessage(filePath, text) {
  const preview = text.slice(0, 800);
  return `📝 交接已存：${filePath}\n\n${preview}${text.length > 800 ? '\n\n…（全文在文件里）' : ''}`;
}

async function finishPendingRestartAck() {
  try {
    if (!fs.existsSync(restartStatePath)) return;
    const state = JSON.parse(fs.readFileSync(restartStatePath, 'utf8'));
    const age = Date.now() - Number(state.timestamp || 0);
    if (age < 30000 && state.chat_id && state.message_id && state.trigger === 'bridge') {
      await telegram('editMessageText', {
        chat_id: state.chat_id,
        message_id: state.message_id,
        text: `✅ Bridge restarted (${(age / 1000).toFixed(1)}s${state.force ? ', forced' : ''})`,
      }).catch((error) => log(`restart ack edit failed: ${error.message}`));
      log(`restart ack edited chat=${state.chat_id} msg=${state.message_id} age=${age}ms`);
    } else {
      log(`restart state is stale or invalid (age=${age}ms); skipping the ack edit`);
    }
    fs.unlinkSync(restartStatePath);
  } catch (error) {
    log(`restart state check failed: ${error.message}`);
  }
}

async function poll() {
  secureRuntimeFiles();
  const maintenanceTimer = setInterval(() => {
    secureRuntimeFiles();
    durableInbox.compactIfNeeded();
  }, 24 * 60 * 60 * 1000);
  maintenanceTimer.unref();

  await checkConnection();
  // Constructor pre-start is intentionally asynchronous. After a bridge
  // reload the old TUI can disappear during Telegram connection startup,
  // leaving launchd healthy but `Skald` with nothing to attach to. Re-check
  // the visible TUI at the end of startup and wait until it is attachable.
  if (codexMode === 'kimi' && config.kimiEngine === 'tui' && sessionId && codex.turnLedger.pending().length === 0) {
    await codex.ensureTui(sessionId);
  }
  log(
    `${config.botName} Telegram bridge started; private users ${[...allowedUserIds].join(',')};`
    + ` groups ${[...allowedGroups.keys()].join(',') || 'none'}; session ${sessionId || 'new'}`,
  );
  await finishPendingRestartAck();

  if (config.outboxEnabled === true) {
    const outboxTimer = setInterval(() => {
      processOutbox().catch((error) => log(`outbox processing failed: ${error.message}`));
    }, Number(config.outboxPollMs || DEFAULT_CONFIG.outboxPollMs));
    outboxTimer.unref();
    await processOutbox();
  }

  const durableRetryTimer = setInterval(() => {
    dispatchDurableUpdates().catch((error) => log(`durable retry dispatch failed: ${error.message}`));
  }, Math.max(1000, Math.min(30000, Number(config.updateRetryBaseMs || DEFAULT_CONFIG.updateRetryBaseMs))));
  durableRetryTimer.unref();
  await dispatchDurableUpdates();

  // Context ceiling watch. Runs off the poll loop so a slow read can never
  // delay a message, and failures stay silent in the log rather than reaching her.
  const contextWatchTimer = setInterval(() => {
    checkContextUsage().catch((error) => log(`context watch failed: ${error.message}`));
  }, Math.max(15000, Number(config.contextWatchIntervalMs || 60000)));
  contextWatchTimer.unref();
  checkContextUsage().catch((error) => log(`context watch failed: ${error.message}`));

  // Only the getUpdates leg is watched. Reply generation runs in this same
  // loop and can legitimately take minutes, so the watchdog must stay quiet
  // between endPoll() and the next beginPoll().
  const pollWatchdog = createPollStallWatchdog({
    stallMs: Number(config.pollStallMs) || DEFAULT_STALL_MS,
    onStall: (stuckMs) => {
      log(`poll stalled: getUpdates hung ${Math.round(stuckMs / 1000)}s with no return and no abort;`
        + ' exiting so launchd restarts a bridge that can actually hear her');
      process.exit(1);
    },
  });
  pollWatchdog.start();

  for (;;) {
    try {
      const updates = await telegram('getUpdates', {
        offset: updateOffset,
        timeout: 30,
        // message_reaction 必须显式列出，Telegram 默认不投递。
        // 用途见 handleOwnerReaction：owner 点表情＝放行，不必开口插话。
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
      }, { onAttempt: () => pollWatchdog.beginPoll() });
      pollWatchdog.endPoll();

      for (const update of updates) {
        // 群升级检测：普通群升 supergroup 时 chat.id 会变，旧 ID 从此收不到消息、
        // 而白名单还是旧的 —— 表现就是"它突然不理我了"。只记账并通知，
        // **不自动改配置**：白名单是安全边界，得由她确认后跑迁移脚本。
        groupMigration.handleUpdate(update, {
          log,
          notify: (text) => sendMessage(ownerUserId, text),
        });
        // 表情不进 durable inbox：它是低频、尽力而为的信号，重放一个旧表情
        // 没有意义。处理完只推进 offset。
        if (update.message_reaction) {
          try { handleOwnerReaction(update); } catch (error) {
            log(`处理表情失败 update=${update.update_id}: ${error.message}`);
          }
          updateOffset = Math.max(updateOffset, Number(update.update_id) + 1);
          writePrivateFile(offsetPath, String(updateOffset));
          continue;
        }
        // Durable acceptance has to happen before the Telegram offset moves:
        // otherwise a crash here loses the update for good.
        durableInbox.recordReceived(update);
        updateOffset = Math.max(updateOffset, Number(update.update_id) + 1);
        writePrivateFile(offsetPath, String(updateOffset));
      }
      await dispatchDurableUpdates();
    } catch (error) {
      pollWatchdog.endPoll();
      log(`poll failed; retrying in 3s: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

if (args.testPrompt) {
  askCodex(args.testPrompt, { isGroup: false, senderName: config.ownerName }, [])
    .then((generated) => {
      console.log(generated.reply);
      codex.close();
      process.exit(0);
    })
    .catch((error) => {
      console.error(error.message);
      codex?.close();
      process.exit(1);
    });
} else if (checkOnly) {
  checkConnection().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  poll().catch((error) => {
    console.error(error.message);
    codex?.close();
    process.exit(1);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    codex?.close();
    process.exit(0);
  });
}
