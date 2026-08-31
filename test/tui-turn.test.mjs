import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KimiCliClient } from '../src/kimi-client.mjs';

// Regression cover for the 2026-08-06 incident: a broken reply extractor made
// every turn look "not registered", the unbounded self-heal re-pasted the same
// prompt every 5s, kimi queued each paste while showing an empty composer, and
// Skald's pane ended up buried under ~900 identical lines.
//
// The three cases West asked for before this bridge is handed back:
//   1. busy/queued TUI      -> never inject, fail fast
//   2. no reply at all      -> retry cap actually truncates
//   3. slow reply           -> not mistaken for a failure

const PANE_IDLE = [
  ' ╭──────────────────────────────────────────╮',
  ' │ >                                        │',
  ' ╰──────────────────────────────────────────╯',
  ' moonshotai/Kimi-K3   context: 40% (50k/128k)',
].join('\n');

const PANE_QUEUED = [
  '   ❯ TG_PRIVATE Follow the Telegram bridge protocol from AGENTS.md. Reply w…',
  '   ❯ TG_PRIVATE Follow the Telegram bridge protocol from AGENTS.md. Reply w…',
  '   ↑ to edit · ctrl-s to steer immediately',
  ' ╭──────────────────────────────────────────╮',
  ' │ >                                        │',
  ' ╰──────────────────────────────────────────╯',
].join('\n');

const PANE_CACHE_HINT = [
  ' This session has been idle for 1h 4m and is ~201k tokens.',
  ' Compact and continue',
  ' Start a new session',
  ' Continue as-is',
  " Don't ask me again",
  ' ↑↓ navigate · Enter select · Esc cancel',
].join('\n');

function makeClient({ pane, timeoutMs = 12000, onCacheHintContinue = null, onTmux = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-wire-'));
  const wire = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wire, '');

  const client = new KimiCliClient({
    workdir: dir,
    threadId: null,
    engine: 'tui',
    timeoutMs,
    onCacheHintContinue,
  });
  client.threadId = 'session_test';

  const injections = [];
  const keys = [];
  client.wirePath = () => wire;
  client.ensureTui = async () => {};
  client.tuiAlive = () => true;
  client.capturePane = () => (typeof pane === 'function' ? pane() : pane);
  client.tmux = (args, input) => {
    if (args[0] === 'load-buffer') injections.push(String(input));
    if (args[0] === 'send-keys') keys.push(args.at(-1));
    if (onTmux) onTmux({ args, input, wire, injections, keys });
    return '';
  };

  return { client, wire, injections, keys };
}

// A turn as kimi actually writes it: the usage record lands BEFORE the
// assistant text, which is why usage.record must not be the finish line.
function writeTurn(wire, promptText, replyText) {
  const lines = [
    { type: 'turn.prompt', input: [{ type: 'text', text: promptText }] },
    { type: 'usage.record', usageScope: 'turn' },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'text', text: replyText } },
    },
    { type: 'turn.ended' },
  ];
  fs.appendFileSync(wire, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

test('a busy TUI with queued input is never injected into', async () => {
  const { client, injections } = makeClient({ pane: PANE_QUEUED, timeoutMs: 30000 });
  const started = Date.now();
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE hello', 'session_test'),
    /queued input/i,
    'a queued TUI must fail closed instead of piling on another paste',
  );
  assert.equal(injections.length, 0, 'nothing may be pasted into a busy TUI');
  assert.ok(Date.now() - started < 40000, 'it must give up, not hang forever');
});

test('queue detection reads the steer hint, not the composer', () => {
  const { client } = makeClient({ pane: PANE_QUEUED });
  assert.equal(client.tuiHasQueuedInput(), true);
  // The composer looks empty even while the queue is full — that false signal
  // is exactly what drove the flood.
  assert.equal(client.composerIsEmpty(), true);

  const { client: idle } = makeClient({ pane: PANE_IDLE });
  assert.equal(idle.tuiHasQueuedInput(), false);
  assert.equal(idle.composerIsEmpty(), true);
});

test('cache-expiry detection requires the real dialog anchors', () => {
  const { client } = makeClient({ pane: PANE_CACHE_HINT });
  assert.equal(client.cacheExpiryHintIsOpen(), true);

  const { client: idle } = makeClient({ pane: PANE_IDLE });
  assert.equal(idle.cacheExpiryHintIsOpen(), false);

  const { client: changedMenu } = makeClient({
    pane: PANE_CACHE_HINT.replace(' Start a new session\n', ''),
  });
  assert.equal(changedMenu.cacheExpiryHintIsOpen(), false, 'do not press Down twice if the menu shape changed');
});

test('a submit-time cache hint chooses Continue as-is without re-pasting', async () => {
  const prompt = 'TG_PRIVATE cache hint after submit';
  let pane = PANE_IDLE;
  let firstSubmit = true;
  let downCount = 0;
  const notices = [];
  const { client, wire, injections, keys } = makeClient({
    pane: () => pane,
    timeoutMs: 15000,
    onCacheHintContinue: (event) => { notices.push(event); },
    onTmux: ({ args }) => {
      if (args[0] !== 'send-keys') return;
      const key = args.at(-1);
      if (key === 'Down') {
        downCount += 1;
        return;
      }
      if (key === 'Enter' && firstSubmit) {
        firstSubmit = false;
        pane = PANE_CACHE_HINT;
        return;
      }
      if (key === 'Enter' && downCount === 2) {
        pane = PANE_IDLE;
        setTimeout(() => writeTurn(wire, prompt, '完整上下文继续'), 50);
      }
    },
  });

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '完整上下文继续');
  assert.equal(injections.length, 1, 'the stashed prompt belongs to Kimi and must not be pasted twice');
  assert.deepEqual(keys.slice(0, 4), ['Enter', 'Down', 'Down', 'Enter']);
  assert.deepEqual(notices, [{ scene: 'submit', threadId: 'session_test' }]);
});

test('a pre-existing cache hint is continued before the prompt is injected', async () => {
  const prompt = 'TG_PRIVATE cache hint before submit';
  let pane = PANE_CACHE_HINT;
  let downCount = 0;
  let dialogHandled = false;
  const notices = [];
  const { client, wire, injections, keys } = makeClient({
    pane: () => pane,
    timeoutMs: 15000,
    onCacheHintContinue: (event) => { notices.push(event); },
    onTmux: ({ args }) => {
      if (args[0] !== 'send-keys') return;
      const key = args.at(-1);
      if (key === 'Down') {
        downCount += 1;
        return;
      }
      if (key === 'Enter' && !dialogHandled && downCount === 2) {
        dialogHandled = true;
        pane = PANE_IDLE;
        return;
      }
      if (key === 'Enter' && dialogHandled) {
        setTimeout(() => writeTurn(wire, prompt, '先关弹窗再提交'), 50);
      }
    },
  });

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '先关弹窗再提交');
  assert.equal(injections.length, 1, 'the prompt is injected only after the dialog is gone');
  assert.deepEqual(keys.slice(0, 4), ['Down', 'Down', 'Enter', 'Enter']);
  assert.deepEqual(notices, [{ scene: 'pre-submit', threadId: 'session_test' }]);
});

test('a turn that never registers is truncated by the retry cap', async () => {
  const { client, injections } = makeClient({ pane: PANE_IDLE, timeoutMs: 60000 });
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE never lands', 'session_test'),
    /after 3 injection retries/,
    'the self-heal must stop instead of re-pasting for the whole timeout',
  );
  // 1 initial injection + at most 3 retries. The pre-fix loop would have
  // pasted ~12 times in the same window (and hundreds over a long timeout).
  assert.ok(
    injections.length <= 4,
    `expected at most 4 pastes, got ${injections.length}`,
  );
});

test('a slow reply is captured, not mistaken for silence', async () => {
  const prompt = 'TG_PRIVATE slow but real';
  const { client, wire } = makeClient({ pane: PANE_IDLE, timeoutMs: 30000 });
  // Reply arrives well after the first self-heal tick would have fired.
  setTimeout(() => writeTurn(wire, prompt, '我在，只是慢了一点。🐦‍⬛'), 7000);
  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '我在，只是慢了一点。🐦‍⬛');
});

test('text emitted after usage.record is still captured', async () => {
  const prompt = 'TG_PRIVATE ordering';
  const { client, wire } = makeClient({ pane: PANE_IDLE, timeoutMs: 20000 });
  setTimeout(() => writeTurn(wire, prompt, 'usage 在前，正文在后'), 500);
  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, 'usage 在前，正文在后', 'usage.record must not end the turn early');
});
