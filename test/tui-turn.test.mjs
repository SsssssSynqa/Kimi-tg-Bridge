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

function makeClient({ pane, timeoutMs = 12000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-wire-'));
  const wire = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wire, '');

  const client = new KimiCliClient({
    workdir: dir,
    threadId: 'session_test',
    engine: 'tui',
    timeoutMs,
  });

  const injections = [];
  const keys = [];
  client.wirePath = () => wire;
  client.ensureTui = async () => {};
  client.tuiAlive = () => true;
  client.capturePane = () => (typeof pane === 'function' ? pane() : pane);
  client.tmux = (args, input) => {
    if (args[0] === 'load-buffer') injections.push(String(input));
    if (args[0] === 'send-keys') keys.push(args.at(-1));
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
