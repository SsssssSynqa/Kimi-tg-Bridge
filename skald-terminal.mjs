#!/usr/bin/env node
// skald-terminal — a plain terminal chat window for the agent.
// 一个普通的对话界面：你打字他回答；TG 侧的消息和他的回复实时流进同一个画面，
// 混在一条时间线里。不分屏，没有 tmux。
//
// 你在这里说的话直接进入共用会话（kimi 落盘），TG 桥下一轮自然记得；
// TG 内容来自桥的 live 日志（.state/telegram-live.jsonl），500ms 轮询。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.resolve(BRIDGE_DIR, '..');
const LIVE_PATH = path.join(BRIDGE_DIR, '.state', 'telegram-live.jsonl');
const SESSION_FILE = path.join(BRIDGE_DIR, '.state', 'session.txt');
// 2026-08-30 开源脱敏：原来硬编码了本机用户名。从 HOME 派生，本机行为完全不变，
// 别人 clone 下来也能直接跑；要装在别处就设 KIMI_PATH。
const KIMI = process.env.KIMI_PATH
  || `${process.env.HOME || ''}/.kimi-code/bin/kimi`;
const REPLAY = 10;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', magenta: '\x1b[35m', gray: '\x1b[90m', green: '\x1b[32m',
};

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  catch { return '--:--'; }
}

function fmtLiveEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  const time = `${C.gray}${fmtTime(event.recordedAt)}${C.reset}`;
  const text = String(event.text || '');
  if (event.direction === 'in') {
    const where = event.chatType === 'group' ? `${C.dim}·${event.chatTitle || '群'}${C.reset}` : `${C.dim}·私聊${C.reset}`;
    return `${time} ${C.cyan}${event.senderName || event.senderUsername || event.senderId}${C.reset}${where}: ${text}`;
  }
  if (event.direction === 'out') {
    const cont = event.chunkIndex > 0 ? `${C.dim}(续)${C.reset} ` : '';
    return `${time} ${C.yellow}Skald↩TG${C.reset} ${cont}${text}`;
  }
  return null;
}

const sessionId = (() => {
  try { return fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch { return ''; }
})();
if (!sessionId) {
  console.error('桥还没有会话记录（.state/session.txt 为空）。先让桥收一条 TG 消息，或直接用 kimi 开会话。');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.green}你${C.reset} > ` });
let turnRunning = false;

// 打印一行到滚动流：先清掉输入行，打印，再重绘输入提示和已敲的字。
function printAbovePrompt(line) {
  process.stdout.write('\r\x1b[K');
  console.log(line);
  if (!turnRunning) rl.prompt(true);
}

// --- TG live 流：回放 + 跟随 -------------------------------------------------
let offset = 0;
let carry = '';

function consumeLive(chunk) {
  carry += chunk;
  const lines = carry.split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const formatted = fmtLiveEvent(line);
    if (formatted) printAbovePrompt(formatted);
  }
}

function replayLive() {
  if (!fs.existsSync(LIVE_PATH)) return;
  const content = fs.readFileSync(LIVE_PATH, 'utf8');
  offset = Buffer.byteLength(content);
  const lines = content.split('\n').filter((line) => line.trim());
  for (const line of lines.slice(-REPLAY)) {
    const formatted = fmtLiveEvent(line);
    if (formatted) console.log(formatted);
  }
}

setInterval(() => {
  let stat;
  try { stat = fs.statSync(LIVE_PATH); } catch { return; }
  if (stat.size < offset) { offset = 0; carry = ''; }
  if (stat.size === offset) return;
  const fd = fs.openSync(LIVE_PATH, 'r');
  try {
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    offset = stat.size;
    consumeLive(buf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}, 500);

// --- 你的轮次：spawn kimi -p，流式打印 ---------------------------------------
function runTurn(text) {
  return new Promise((resolve) => {
    const child = spawn(KIMI, ['--session', sessionId, '-p', text, '--output-format', 'stream-json'], {
      cwd: WORKDIR, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let printedHeader = false;
    let stderrTail = '';
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.role === 'assistant' && msg.content) {
          if (!printedHeader) { process.stdout.write(`${C.yellow}Skald${C.reset} > `); printedHeader = true; }
          process.stdout.write(msg.content.endsWith('\n') ? msg.content : `${msg.content}\n`);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-400); });
    child.on('close', (code) => {
      if (code !== 0) console.log(`${C.dim}（这一轮失败 exit=${code}：${stderrTail.trim().split('\n').pop() || '未知错误'}）${C.reset}`);
      else if (!printedHeader) console.log(`${C.dim}（这一轮他没有说话——可能内容都在工具动作里）${C.reset}`);
      resolve();
    });
  });
}

console.log(`${C.magenta}── Skald · 终端窗口（与 TG 同一段记忆；TG 动静会流进这里）──${C.reset}`);
console.log(`${C.dim}会话 ${sessionId.slice(0, 20)}…  退出：exit 或 Ctrl+C${C.reset}`);
replayLive();
rl.prompt();

rl.on('line', async (input) => {
  const text = input.trim();
  if (!text) { rl.prompt(); return; }
  if (text === 'exit' || text === 'quit') { rl.close(); return; }
  turnRunning = true;
  await runTurn(text);
  turnRunning = false;
  rl.prompt();
});

rl.on('close', () => {
  console.log(`\n${C.dim}（窗口合上了，记忆还在。TG 里他继续当班。）${C.reset}`);
  process.exit(0);
});
