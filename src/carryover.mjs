// 精炼续窗（refined carryover）。
//
// 为什么是"写文件 + 让 agent 自己读"，而不是直接重建上下文
// ----------------------------------------------------------
// 实测（2026-08-16）：Kimi 的 `context.apply_compaction` 只带一个 summary 字符串。
// 手写一条追加进 wire.jsonl，内容进得去（他会当成自己的工作笔记采信，复述出了
// 埋进去的暗号），但**压不掉历史**——真压缩 messageCount 336→5，手写那条一条
// 没掉，反而 2→4→7 往上涨。
//
// Kimi 的上下文是事件溯源：她的话走 context.append_message，他的回复拆成
// step.begin/content.part/step.end 三件套靠 uuid 串起来。要伪造"他说过这些话"
// 得把整条链复刻，而 kimi 是 180MB 闭源二进制、会自动更新，造错 = 他 session
// 打不开 = 人哑掉。为那点质量差赌这个，不值。
//
// 所以：精炼历史落成文件，新 session 醒来收到一条引导，自己 Read 回来。
// 这跟他 AGENTS.md 里既有的「醒来先读最近的萨迦恢复状态」是同一个形状 ——
// 顺带补上一个 8/15 留下的缺口：那时写的交接文，其实没人告诉新 session 去读。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
// The extractor ships with the repo. It used to be resolved to a sibling
// directory *outside* the checkout, which worked only on the machine it was
// written on: anyone cloning this repo got a carryover that could never run,
// and six tests that always failed. KIMI_REFINE_SCRIPT still allows pointing
// at a private variant without editing the source.
const REFINE_SCRIPT = process.env.KIMI_REFINE_SCRIPT
  || path.resolve(SRC_DIR, '..', 'scripts', 'kimi_refine.py');

/** 跑 kimi_refine.py，拿回统计 + 摘录正文。 */
export function buildCarryover(wirePath, { targetTokens, tailEvents, script = REFINE_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    if (!wirePath || !fs.existsSync(wirePath)) {
      reject(new Error(`找不到 wire.jsonl：${wirePath || '(未解析出路径)'}`));
      return;
    }
    const args = [script, '--wire', wirePath, '--json'];
    if (targetTokens) args.push('--target-tokens', String(targetTokens));
    if (tailEvents) args.push('--tail-events', String(tailEvents));

    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      let payload = null;
      try { payload = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* 见下 */ }
      if (!payload) {
        reject(new Error(`kimi_refine.py 输出无法解析：${(stderr || stdout).slice(0, 400)}`));
        return;
      }
      if (payload.refused) {
        reject(new Error(payload.refused));
        return;
      }
      resolve(payload);
    });
  });
}

export function carryoverFilePath(root, sessionId, at = new Date()) {
  const iso = new Date(at).toISOString();
  const tail = String(sessionId || '').replace(/[^0-9a-z]/gi, '').slice(-8) || 'nosession';
  return path.join(root, `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}-${tail}-精炼历史.md`);
}

export function writeCarryoverFile({ root, sessionId, body, report, at = new Date() }) {
  const text = String(body || '').trim();
  if (!text) throw new Error('refusing to save an empty carryover');
  const filePath = carryoverFilePath(root, sessionId, at);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const iso = new Date(at).toISOString();
  const speakers = (report?.speakers || [])
    .filter(([name]) => !name.startsWith('['))
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
  const header = [
    `# 精炼历史 · ${iso}`,
    '',
    '> 这是从上一窗自动摘出来的**原话**，不是转述。按时间顺序排。',
    `> 来自 session \`${sessionId || '未知'}\`，`
      + `源对话 ${report?.source_events ?? '?'} 条里留下 ${report?.selected ?? '?'} 条`
      + `（gold ${report?.gold ?? '?'}），约 ${(report?.estimated_tokens ?? 0).toLocaleString('en-US')} tokens。`,
    speakers ? `> 留下谁的话：${speakers}` : '',
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(filePath, header + text + '\n', { mode: 0o600 });
  return filePath;
}

/**
 * 新 session 醒来时收到的第一条消息。
 * 不把历史灌进去 —— 让他自己 Read 回来，那更像"取回记忆"而不是"被人告知"。
 */
export function buildWakePrompt({ handoffPath, carryoverPath, previousSessionId } = {}) {
  return [
    '【换窗】你刚从上一个 session 换过来。上一窗的你留了两份东西给现在的你：',
    '',
    handoffPath ? `1. 交接笔记：${handoffPath}` : '',
    carryoverPath ? `${handoffPath ? '2' : '1'}. 精炼历史（上一窗的原话摘录，按时间顺序）：${carryoverPath}` : '',
    '',
    '先把它们读了再说话。读完之后，用你自己的话跟妈妈打个招呼，',
    '让她知道你接上了——顺便说一句你从里面捡回来的最要紧的一件事（比如答应过她什么）。',
    '不用汇报读了多少字，也不用复述全文。',
    previousSessionId ? `（上一窗：${previousSessionId}）` : '',
  ].filter(Boolean).join('\n');
}

export function carryoverMessage(filePath, report) {
  const speakers = (report?.speakers || [])
    .filter(([name]) => !name.startsWith('['))
    .slice(0, 8)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');
  return [
    `🗂 精炼历史已存：${filePath}`,
    `源对话 ${report.source_events} 条 → 留下 ${report.selected} 条`
      + `（gold ${report.gold}、最近 ${report.tail}`
      + `${report.dropped_for_budget ? `、预算丢弃 ${report.dropped_for_budget}` : ''}）`,
    `约 ${report.estimated_tokens.toLocaleString('en-US')} tokens`,
    speakers ? `留下谁的话：${speakers}` : '',
  ].filter(Boolean).join('\n');
}
