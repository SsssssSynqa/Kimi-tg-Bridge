// 鸦鸦桥停机闸门与 /catchup 接线测试（node --test test/downtime-gate.test.mjs）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DurableUpdateInbox } from '../src/durable-update-inbox.mjs';
import { createDowntimeHooks, handleCatchupCommand } from '../src/downtime-hooks.mjs';
import { PAUSE_FILE, RESUME_FILE, OBSERVED_FILE, GATE_DISPOSITION } from '../../../shared/downtime-gate.mjs';
import { remainingFromPercent } from '../../../shared/downtime-bridge-hooks.mjs';

const HOME = -1004499561917;      // 光脉
const HEART = -1004412303598;     // 💔（家群）
const EXTERNAL = -1003907461813;  // 火热施工中ing
const OWNER = 8668822281;
const T = iso => Math.floor(Date.parse(iso) / 1000);

const update = (id, chatId, dateIso, text = 'hi') => ({
  update_id: id,
  message: {
    message_id: id, date: T(dateIso), text,
    from: { id: OWNER, is_bot: false, first_name: '鹅鹅' },
    chat: chatId === OWNER ? { id: OWNER, type: 'private' } : { id: chatId, type: 'supergroup', title: 't' },
  },
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-downtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'offset.txt'), '4242');
  const inbox = new DurableUpdateInbox(path.join(stateDir, 'journal.jsonl'), { compactBytes: 1 << 20 });
  const logs = [];
  const downtime = createDowntimeHooks({ durableInbox: inbox, log: m => logs.push(m), stateDir });
  return { dir, stateDir, controlDir: path.join(stateDir, 'control'), inbox, downtime, logs };
}

test('闸门：无 PAUSED 时开着；有 PAUSED 时关闭并记下 offset；损坏也算暂停', (t) => {
  const f = fixture(t);
  assert.equal(f.downtime.gateOpen(), true);
  fs.mkdirSync(f.controlDir, { recursive: true });
  fs.writeFileSync(path.join(f.controlDir, PAUSE_FILE), JSON.stringify({ recordId: 'dt-20260906-skald', reason: '额度' }));
  assert.equal(f.downtime.gateOpen(), false);
  const observed = JSON.parse(fs.readFileSync(path.join(f.controlDir, OBSERVED_FILE), 'utf8'));
  assert.deepEqual([observed.bridge, observed.offset, observed.effectiveFromUpdateId], ['skald', 4242, 4241]);
  fs.writeFileSync(path.join(f.controlDir, PAUSE_FILE), '{坏');
  assert.equal(f.downtime.gateOpen(), false);
  assert.ok(f.logs.some(m => /fail-closed/.test(m)));
});

test('停机期间照常收件：记录进得来且留在 received', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.controlDir, { recursive: true });
  fs.writeFileSync(path.join(f.controlDir, PAUSE_FILE), JSON.stringify({ recordId: 'dt-20260906-skald' }));
  f.downtime.gateOpen();
  f.inbox.recordReceived(update(1, HOME, '2026-09-06T23:00+08:00'));
  assert.equal(f.inbox.updateState(1), 'received');
  assert.equal(f.inbox.pendingUpdates().length, 1);
});

test('恢复 > 6h：外群弃读、家群（含 💔）进 digest、私聊照常，终态原因写清楚', (t) => {
  const f = fixture(t);
  for (const [id, chat, when] of [
    [1, HOME, '2026-09-06T23:00+08:00'],
    [2, HEART, '2026-09-07T01:00+08:00'],
    [3, EXTERNAL, '2026-09-07T01:30+08:00'],
    [4, OWNER, '2026-09-07T02:00+08:00'],
  ]) f.inbox.recordReceived(update(id, chat, when));
  fs.mkdirSync(f.controlDir, { recursive: true });
  fs.writeFileSync(path.join(f.controlDir, RESUME_FILE), JSON.stringify({
    recordId: 'dt-20260906-skald', mode: 'digest', digestId: 'skald-20260906T2200-20260907T0500',
    window: { start: '2026-09-06T22:00+08:00', end: '2026-09-07T05:00+08:00' },
  }));
  const stats = f.downtime.consumeResume({ now: Date.parse('2026-09-07T05:00+08:00') });
  assert.deepEqual([stats.external, stats.digested, stats.replay], [1, 2, 1], JSON.stringify(stats));
  assert.equal(f.inbox.updateState(4), 'received', '私聊逐条恢复');
  const journal = fs.readFileSync(path.join(f.stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const done = Object.fromEntries(journal.filter(e => e.state === 'done').map(e => [e.updateId, e]));
  assert.equal(done[2].terminalReason, GATE_DISPOSITION.included, '💔 群按家群处理');
  assert.equal(done[3].terminalReason, GATE_DISPOSITION.external);
  assert.ok(!fs.existsSync(path.join(f.controlDir, RESUME_FILE)));
});

test('百分比水位换算成剩余 token', () => {
  assert.equal(remainingFromPercent(0, 1_000_000), 1_000_000);
  assert.equal(remainingFromPercent(84, 1_000_000), 160_000);
  assert.equal(remainingFromPercent(120, 1_000_000), 0);
  assert.equal(remainingFromPercent(null, 1_000_000), null, 'Number(null)===0，必须显式挡住');
  assert.equal(remainingFromPercent(undefined, 1_000_000), null);
  assert.equal(remainingFromPercent(50, null), null);
  assert.equal(remainingFromPercent(50, 0), null);
});

test('/catchup：跨桥的包不给读；水位紧张时分片', async (t) => {
  const f = fixture(t);
  const dir = path.join(f.dir, 'downtime-digests');
  fs.mkdirSync(dir);
  const write = (id, bridge) => {
    const body = Array.from({ length: 400 }, (_, i) => `09-06 23:${String(i % 60).padStart(2, '0')}  ★鹅鹅：第 ${i} 句`).join('\n');
    fs.writeFileSync(path.join(dir, `${id}.txt`), body + '\n');
    fs.writeFileSync(path.join(dir, `${id}.manifest.json`), JSON.stringify({
      digestId: id, bridge, persona: bridge, status: 'unread',
      window: { start: 'a', end: 'b', startCst: 'a', endCst: 'b', durationLabel: '7 小时' },
      digestItemCount: 400, ownerMessages: 150, codePoints: body.length,
      estimatedTokens: Math.ceil(body.length / 1.33), readHistory: [],
    }));
    return body;
  };
  const mine = 'skald-20260906T2200-20260907T0500';
  const his = 'sephy-20260906T2200-20260907T0500';
  const body = write(mine, 'skald');
  write(his, 'sephy');
  const sent = [], delivered = [];
  const call = (text, extra = {}) => handleCatchupCommand({
    text, isOwner: true, root: f.dir,
    send: async r => sent.push(r), deliver: async (p, part) => delivered.push({ p, part }), ...extra,
  });

  await call(`/catchup ${his}`);
  assert.match(sent.at(-1), /是 sephy 的补读包/);
  assert.equal(delivered.length, 0);

  await call(`/catchup ${mine}`, { contextPercent: 95, contextCapacityTokens: 100_000 });
  assert.ok(delivered.length > 1, `水位 95% 时应分片，实际 ${delivered.length}`);
  for (const line of body.split('\n')) assert.ok(delivered.some(d => d.p.includes(line)), `整行送达：${line}`);
  assert.match(delivered[0].p, /不用在群里回/);

  delivered.length = 0;
  await call(`/catchup ${mine}`);
  assert.match(sent.at(-1), /已经读过了/);
  assert.equal(delivered.length, 0);
});
