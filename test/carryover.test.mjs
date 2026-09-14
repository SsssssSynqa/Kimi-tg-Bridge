// 2026-08-16 精炼续窗（carryover.mjs + ../换窗/kimi_refine.py）
//
// 最要紧的两条：
//   ① 剥壳必须认出真人的话 —— 不剥壳，精炼出来的全是 TG_PRIVATE 协议噪音，
//      跟大猫猫那边 isMeta 的坑是同一类（那次差点让换窗后的他听不见她说话）
//   ② think 是思考链，绝不能带进下一窗

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCarryover,
  buildWakePrompt,
  carryoverFilePath,
  carryoverMessage,
  writeCarryoverFile,
} from '../src/carryover.mjs';

const SESSION = 'session_00001111-2222-3333-4444-555566667777';

function line(object) {
  return `${JSON.stringify(object)}\n`;
}

function userLine(text) {
  return line({
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } },
    time: 1,
  });
}

function assistantLines(parts, step = `step-${Math.random().toString(16).slice(2)}`) {
  let out = line({ type: 'context.append_loop_event', event: { type: 'step.begin', stepUuid: step }, time: 2 });
  for (const part of parts) {
    out += line({
      type: 'context.append_loop_event',
      event: { type: 'content.part', stepUuid: step, part },
      time: 3,
    });
  }
  out += line({ type: 'context.append_loop_event', event: { type: 'step.end', stepUuid: step }, time: 4 });
  return out;
}

function tgPrivate(text) {
  return [
    'TG_PRIVATE',
    'Follow the Telegram bridge protocol from AGENTS.md. Reply with the Telegram message body only.',
    JSON.stringify({ mode: 'TG_PRIVATE', botName: 'Skald', sender: '鹅鹅', username: 'Good_Goose_Max', text }),
  ].join('\n');
}

function tgGroup(messages) {
  return [
    'TG_GROUP_BATCH',
    'Follow the Telegram bridge protocol from AGENTS.md.',
    JSON.stringify({ mode: 'TG_GROUP_BATCH', chatId: '-100', messages }),
  ].join('\n');
}

function makeWire(dir, extra = '') {
  let body = line({ type: 'metadata', protocol_version: '1.5', created_at: 1 });
  for (let i = 0; i < 40; i += 1) {
    body += userLine(tgPrivate(`记住这件事：我们说好第 ${i} 条约定，我喜欢你这样，答应我别忘了这个承诺。`));
    body += assistantLines([
      { type: 'think', text: `THINKING-${i} 这段思考链绝对不能带走` },
      { type: 'text', text: `记住了，第 ${i} 条我不会忘。` },
    ]);
  }
  const wire = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wire, body + extra);
  return wire;
}

test('剥掉 TG_PRIVATE 协议壳，认出说话人和正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const payload = await buildCarryover(makeWire(dir));
    assert.ok(payload.selected > 0);
    assert.ok(payload.body.includes('鹅鹅：') || payload.body.includes('鹅鹅:'),
      `摘录里应出现「鹅鹅」，实得开头：${payload.body.slice(0, 200)}`);
    assert.ok(!payload.body.includes('TG_PRIVATE'), '协议壳不能漏进摘录');
    assert.ok(!payload.body.includes('"mode"'), 'JSON 载荷不能漏进摘录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('think 是思考链，绝不带进下一窗', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const payload = await buildCarryover(makeWire(dir));
    assert.ok(!payload.body.includes('THINKING-'), '思考链漏进摘录了');
    assert.ok(payload.body.includes('我不会忘'), '他真正说出口的话应该留下');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('system-reminder 之类的注入块要丢掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const extra = userLine('<system-reminder>\nThe TodoList tool has not been updated recently.\n</system-reminder>')
      + userLine(tgPrivate('这句是真的要留下的话，记住我今天很累'))
      + assistantLines([{ type: 'text', text: '记住了，你今天很累。' }]);
    const payload = await buildCarryover(makeWire(dir, extra));
    assert.ok(!payload.body.includes('TodoList'), '注入块漏进摘录了');
    assert.ok(payload.body.includes('我今天很累'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TG_GROUP_BATCH 一批消息逐条摊平，各自带说话人', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const extra = userLine(tgGroup([
      { messageId: 1, sender: 'Syner✨', text: '本王说了一句要记住的话，这是承诺' },
      { messageId: 2, sender: '鹅鹅', text: '我也说了一句要记住的话，答应我' },
    ])) + assistantLines([{ type: 'text', text: '两句都记下了。' }]);
    const payload = await buildCarryover(makeWire(dir, extra));
    assert.ok(payload.body.includes('Syner✨'), '群里其他人的名字要留住');
    assert.ok(payload.body.includes('鹅鹅'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一 step 的多个 text 片段合并成一条完整发言', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const extra = userLine(tgPrivate('说一句长的，我要记住这个承诺'))
      + assistantLines([
        { type: 'text', text: '前半句' },
        { type: 'text', text: '后半句连着的。' },
      ]);
    const payload = await buildCarryover(makeWire(dir, extra));
    assert.ok(payload.body.includes('前半句后半句连着的。'), '流式片段应拼回完整句子');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('空 wire 明确拒绝，不产出空摘录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const wire = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(wire, line({ type: 'metadata', protocol_version: '1.5' }));
    await assert.rejects(buildCarryover(wire), /拒绝续窗/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wire 不存在时报清楚的错，不是崩在 spawn 里', async () => {
  await assert.rejects(buildCarryover('/nope/does/not/exist.jsonl'), /找不到 wire\.jsonl/);
});

test('落盘带上出处头，正文原样保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    const report = { source_events: 100, selected: 20, gold: 12, estimated_tokens: 1234, speakers: [['鹅鹅', 9]] };
    const filePath = writeCarryoverFile({ root: dir, sessionId: SESSION, body: '鹅鹅：测试正文', report });
    const written = fs.readFileSync(filePath, 'utf8');
    assert.match(written, /# 精炼历史/);
    assert.match(written, /源对话 100 条里留下 20 条/);
    assert.match(written, /鹅鹅×9/);
    assert.ok(written.includes('鹅鹅：测试正文'));
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, '交接内容是私密的');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('拒绝写空摘录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-carryover-'));
  try {
    assert.throws(() => writeCarryoverFile({ root: dir, sessionId: SESSION, body: '   ' }), /empty carryover/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件名带日期、时间和 session 尾号，同日多次不互相覆盖', () => {
  const a = carryoverFilePath('/tmp', SESSION, new Date('2026-08-16T01:02:03Z'));
  const b = carryoverFilePath('/tmp', SESSION, new Date('2026-08-16T04:05:06Z'));
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^2026-08-16-010203-.*精炼历史\.md$/);
});

test('引导语把两份文件都指出来，并要他自己读', () => {
  const prompt = buildWakePrompt({
    handoffPath: '/x/交接.md',
    carryoverPath: '/x/精炼历史.md',
    previousSessionId: SESSION,
  });
  assert.match(prompt, /\/x\/交接\.md/);
  assert.match(prompt, /\/x\/精炼历史\.md/);
  assert.match(prompt, /先把它们读了再说话/);
  assert.match(prompt, /打个招呼/);
  assert.match(prompt, /Synqa/);
  assert.doesNotMatch(prompt, /\u5988\u5988/u);
});

test('只有交接没有精炼时，引导语不留空编号', () => {
  const prompt = buildWakePrompt({ handoffPath: '/x/交接.md' });
  assert.match(prompt, /1\. 交接笔记/);
  assert.ok(!prompt.includes('2.'), '缺一份时不该留下悬空的编号');
});

test('汇报里过滤掉合成的占位说话人', () => {
  const text = carryoverMessage('/x/y.md', {
    source_events: 10, selected: 5, gold: 3, tail: 2, dropped_for_budget: 0, estimated_tokens: 100,
    speakers: [['鹅鹅', 3], ['[refined-carryover', 1]],
  });
  assert.match(text, /鹅鹅×3/);
  assert.ok(!text.includes('refined-carryover'));
});
