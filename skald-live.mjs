#!/usr/bin/env node
// skald-live — 在终端实时观看 Skald 的 TG 对话流（只看，不说）。
// 数据源：桥的 .state/telegram-live.jsonl（liveLogEnabled: true 时由桥写入）。
// 启动时回放最近 N 条，然后 500ms 轮询增量跟随（tail -f 语义，跨进程安全）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '.state', 'telegram-live.jsonl');
const REPLAY_LINES = 30;
const MAX_SHOW_CHARS = 600;

const C = {
  dim: '\x1b[2m', reset: '\x1b[0m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', magenta: '\x1b[35m', gray: '\x1b[90m',
};

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

function fmtEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  const time = `${C.gray}${fmtTime(event.recordedAt)}${C.reset}`;
  const text = String(event.text || '').slice(0, MAX_SHOW_CHARS)
    + (String(event.text || '').length > MAX_SHOW_CHARS ? `${C.dim}…${C.reset}` : '');
  if (event.direction === 'in') {
    const where = event.chatType === 'group' ? `${C.dim}·${event.chatTitle || '群'}${C.reset}` : '';
    const name = `${C.cyan}${event.senderName || event.senderUsername || event.senderId}${C.reset}`;
    return `${time} ${name}${where}: ${text}`;
  }
  if (event.direction === 'out') {
    const cont = event.chunkIndex > 0 ? `${C.dim}(续)${C.reset} ` : '';
    return `${time} ${C.yellow}Skald ↩${C.reset} ${cont}${text}`;
  }
  return null;
}

let offset = 0;
let carry = '';

function consume(chunk, print) {
  carry += chunk;
  const lines = carry.split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const formatted = fmtEvent(line);
    if (formatted) print(formatted);
  }
}

function replay() {
  if (!fs.existsSync(LIVE_PATH)) {
    console.log(`${C.dim}（还没有对话流——桥收到第一条 TG 消息后这里会活过来）${C.reset}`);
    return;
  }
  const content = fs.readFileSync(LIVE_PATH, 'utf8');
  offset = Buffer.byteLength(content);
  const lines = content.split('\n').filter((line) => line.trim());
  const tail = lines.slice(-REPLAY_LINES);
  if (lines.length > tail.length) console.log(`${C.dim}（…省略更早的 ${lines.length - tail.length} 条）${C.reset}`);
  for (const line of tail) {
    const formatted = fmtEvent(line);
    if (formatted) console.log(formatted);
  }
}

function follow() {
  setInterval(() => {
    let stat;
    try { stat = fs.statSync(LIVE_PATH); } catch { return; }
    if (stat.size < offset) { offset = 0; carry = ''; } // 文件被轮转/清空则从头
    if (stat.size === offset) return;
    const fd = fs.openSync(LIVE_PATH, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = stat.size;
      consume(buf.toString('utf8'), (line) => console.log(line));
    } finally {
      fs.closeSync(fd);
    }
  }, 500);
}

console.log(`${C.magenta}── Skald · TG 实时流（只看不说，下方窗口才是对话）──${C.reset}`);
replay();
follow();
