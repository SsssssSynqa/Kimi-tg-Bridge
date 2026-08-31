'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLOW_DIR = path.join(os.homedir(), '.synergia');
const FLOW_FILE = path.join(FLOW_DIR, 'group-flow.json');
// \d{1,6}：位数放宽不是为了支持六位上限，而是为了让 /flow 99999 这类离谱输入
// 也能被**认出来**并给出解释。四位正则不匹配时它不报错也不生效，直接当成一句
// 普通聊天发进群 —— Synqa 会以为设好了，其实什么都没发生。
const FLOW_COMMAND = /^\/flow(?:@\w+)?(?:\s+(off|stop|end|\d{1,6}))?\s*$/i;
// 上限 20 是 Synqa 定的（2026-08-31，原话「20轮你们怎么也能做完了吧」）。
// ⚠️ 必须与 Synergia/shared/group-flow.cjs 保持一致：两份代码读写同一个
// ~/.synergia/group-flow.json，常量不一致就会出现「谁先抢到回执锁，她听到的
// 数字就不一样」——同一条命令两种说法，比没有这个功能更糟。
const MAX_LIMIT = 20;

function readFlow() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.groups ? parsed : { groups: {} };
  } catch {
    return { groups: {} };
  }
}

function writeFlow(state) {
  try {
    fs.mkdirSync(FLOW_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${FLOW_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, FLOW_FILE);
    return true;
  } catch {
    return false;
  }
}

function flowLimitFor(chatId, now = Date.now()) {
  const entry = readFlow().groups?.[String(chatId)];
  if (!entry || (entry.expiresAt && now > Number(entry.expiresAt))) return null;
  const limit = Number(entry.limit);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : null;
}

function parseFlowCommand(text) {
  const match = FLOW_COMMAND.exec(String(text || '').trim());
  if (!match) return null;
  const arg = match[1];
  if (!arg) return { action: 'status' };
  if (/^\d+$/.test(arg)) {
    const asked = Number(arg);
    const limit = Math.min(Math.max(1, asked), MAX_LIMIT);
    return { action: 'set', limit, asked, clamped: limit !== asked };
  }
  return { action: 'clear' };
}

function applyFlowCommand(chatId, command, { ttlMs = 6 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const state = readFlow();
  if (!state.groups) state.groups = {};
  const key = String(chatId);
  if (command.action === 'set') {
    state.groups[key] = { limit: command.limit, setAt: now, expiresAt: now + ttlMs };
    writeFlow(state);
    return {
      ok: true,
      action: 'set',
      limit: command.limit,
      asked: command.asked,
      clamped: Boolean(command.clamped),
      maxLimit: MAX_LIMIT,
      expiresAt: state.groups[key].expiresAt,
    };
  }
  if (command.action === 'clear') {
    const had = Boolean(state.groups[key]);
    delete state.groups[key];
    writeFlow(state);
    return { ok: true, action: 'clear', had };
  }
  return { ok: true, action: 'status', limit: flowLimitFor(key, now) };
}

module.exports = { FLOW_FILE, flowLimitFor, parseFlowCommand, applyFlowCommand, readFlow };
