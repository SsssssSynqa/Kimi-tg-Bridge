import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KimiCliClient } from '../src/kimi-client.mjs';

// Synqa's call (2026-08-06): "权限全都转发到tg" — every approval dialog must
// reach her phone, because the TUI menu is invisible from Telegram. Before this,
// a turn that needed approval hung forever: she waited for a reply, he waited
// for a keypress.

const PANE_IDLE = [
  ' ╭──────────────────────────────────────────╮',
  ' │ >                                        │',
  ' ╰──────────────────────────────────────────╯',
].join('\n');

function makeClient({ requestUserApproval, timeoutMs = 20000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-approval-'));
  const wire = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wire, '');

  const client = new KimiCliClient({
    workdir: dir,
    threadId: 'session_test',
    engine: 'tui',
    timeoutMs,
    requestUserApproval,
  });

  const keys = [];
  const injections = [];
  client.wirePath = () => wire;
  client.ensureTui = async () => {};
  client.tuiAlive = () => true;
  client.capturePane = () => PANE_IDLE;
  client.tmux = (args, input) => {
    if (args[0] === 'send-keys') keys.push(args.at(-1));
    if (args[0] === 'load-buffer') injections.push(String(input));
    return '';
  };
  return { client, wire, keys, injections };
}

const prompt = 'TG_PRIVATE approval flow';

// 桥在 prompt 首行贴 [turn:xxx] 标记认领本轮，TUI 收到的是带标记那一份。
// 这里必须回放**实际注入的**文本，否则模拟出的 wire 与真实情况不符。
function writePrompt(wire, injections) {
  fs.appendFileSync(wire, `${JSON.stringify({
    type: 'turn.prompt',
    input: [{ type: 'text', text: injections?.[0] ?? prompt }],
  })}\n`);
}

function writeApproval(wire, request) {
  fs.appendFileSync(wire, `${JSON.stringify({
    type: 'interaction.request',
    id: request.toolCallId,
    kind: 'approval',
    toolCallId: request.toolCallId,
    request,
  })}\n`);
}

function writeReply(wire, text) {
  const lines = [
    { type: 'usage.record', usageScope: 'turn' },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } } },
    { type: 'turn.ended' },
  ];
  fs.appendFileSync(wire, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

test('a Bash approval is forwarded as a command card and an accept types 1', async () => {
  const seen = [];
  const { client, wire, keys, injections } = makeClient({
    requestUserApproval: async (info) => { seen.push(info); return 'accept'; },
  });

  setTimeout(() => {
    writePrompt(wire, injections);
    writeApproval(wire, {
      toolCallId: 'Bash:1',
      toolName: 'Bash',
      action: 'Running: ls',
      display: { kind: 'command', command: 'ls -la /tmp', cwd: '/work', language: 'bash' },
    });
  }, 300);
  setTimeout(() => writeReply(wire, '批完了，我继续。'), 2500);

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '批完了，我继续。');
  assert.equal(seen.length, 1, 'the approval must reach Telegram exactly once');
  assert.equal(seen[0].method, 'item/command/requestApproval');
  assert.equal(seen[0].summary.command, 'ls -la /tmp');
  assert.equal(seen[0].summary.cwd, '/work');
  assert.ok(keys.includes('1'), 'accept must type "1" (approve once) into the menu');
  assert.ok(!keys.includes('2'), 'never "approve for this session" — she asked for every request');
});

test('a Write approval is forwarded as a file card and a decline types 3', async () => {
  const seen = [];
  const { client, wire, keys, injections } = makeClient({
    requestUserApproval: async (info) => { seen.push(info); return 'decline'; },
  });

  setTimeout(() => {
    writePrompt(wire, injections);
    writeApproval(wire, {
      toolCallId: 'Write:1',
      toolName: 'Write',
      action: 'Writing /work/Saga/today.md',
      display: { kind: 'file_io', operation: 'write', path: '/work/Saga/today.md', content: '...' },
    });
  }, 300);
  setTimeout(() => writeReply(wire, '好，我不写了。'), 2500);

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '好，我不写了。');
  assert.equal(seen[0].method, 'item/fileChange/requestApproval');
  assert.deepEqual(seen[0].summary.filePaths, ['/work/Saga/today.md']);
  assert.ok(keys.includes('3'), 'decline must type "3" (reject)');
});

test('with no approval channel wired the request fails closed, it does not hang', async () => {
  const { client, wire, keys, injections } = makeClient({ requestUserApproval: null, timeoutMs: 15000 });
  setTimeout(() => {
    writePrompt(wire, injections);
    writeApproval(wire, {
      toolCallId: 'Bash:2',
      toolName: 'Bash',
      action: 'Running: rm -rf /',
      display: { kind: 'command', command: 'rm -rf /', cwd: '/', language: 'bash' },
    });
  }, 300);
  setTimeout(() => writeReply(wire, '被拒了。'), 2500);

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '被拒了。');
  assert.ok(keys.includes('3'), 'no channel must mean reject, never silent approval');
  assert.ok(!keys.includes('1'), 'nothing may be approved without her');
});

test('a forwarding failure declines instead of letting the tool through', async () => {
  const { client, wire, keys, injections } = makeClient({
    requestUserApproval: async () => { throw new Error('telegram down'); },
  });
  setTimeout(() => {
    writePrompt(wire, injections);
    writeApproval(wire, {
      toolCallId: 'Edit:1',
      toolName: 'Edit',
      action: 'Editing /work/x.md',
      display: { kind: 'file_io', operation: 'edit', path: '/work/x.md' },
    });
  }, 300);
  setTimeout(() => writeReply(wire, '发不出去就别做。'), 2500);

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '发不出去就别做。');
  assert.ok(keys.includes('3'), 'a broken approval channel must fail closed');
});

test('time spent waiting for her does not count against the turn timeout', async () => {
  // Turn budget is 6s; she takes 5s to answer. Without crediting the wait back,
  // the turn would die before the reply lands.
  const { client, wire, injections } = makeClient({
    requestUserApproval: async () => new Promise((r) => { setTimeout(() => r('accept'), 5000); }),
    timeoutMs: 6000,
  });
  setTimeout(() => {
    writePrompt(wire, injections);
    writeApproval(wire, {
      toolCallId: 'Bash:3',
      toolName: 'Bash',
      action: 'Running: sleep',
      display: { kind: 'command', command: 'sleep 1', cwd: '/work' },
    });
  }, 300);
  setTimeout(() => writeReply(wire, '等你等得值。'), 7000);

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '等你等得值。');
});
