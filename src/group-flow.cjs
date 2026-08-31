'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLOW_DIR = path.join(os.homedir(), '.synergia');
const FLOW_FILE = path.join(FLOW_DIR, 'group-flow.json');
const FLOW_COMMAND = /^\/flow(?:@\w+)?(?:\s+(off|stop|end|\d{1,4}))?\s*$/i;
const MAX_LIMIT = 200;

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
    return { action: 'set', limit: Math.min(Math.max(1, Number(arg)), MAX_LIMIT) };
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
    return { ok: true, action: 'set', limit: command.limit, expiresAt: state.groups[key].expiresAt };
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
