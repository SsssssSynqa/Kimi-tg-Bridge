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
// 桥会在 prompt 首行贴 [turn:xxx] 标记，TUI 收到的是带标记那一份。
// 测试要模拟真实的 wire，就必须用**实际注入的**文本，而不是原始 prompt。
function writeInjectedTurn(wire, injections, replyText) {
  writeTurn(wire, injections[0] ?? '', replyText);
}

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
        setTimeout(() => writeInjectedTurn(wire, injections, '完整上下文继续'), 50);
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
        setTimeout(() => writeInjectedTurn(wire, injections, '先关弹窗再提交'), 50);
      }
    },
  });

  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '先关弹窗再提交');
  assert.equal(injections.length, 1, 'the prompt is injected only after the dialog is gone');
  assert.deepEqual(keys.slice(0, 4), ['Down', 'Down', 'Enter', 'Enter']);
  assert.deepEqual(notices, [{ scene: 'pre-submit', threadId: 'session_test' }]);
});

test('a turn that never registers stays unknown without re-paste', async () => {
  const { client, injections } = makeClient({ pane: PANE_IDLE, timeoutMs: 6000 });
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE never lands', 'session_test'),
    /outcome-unknown/,
    'the self-heal must stop instead of re-pasting for the whole timeout',
  );
  // 1 initial injection + at most 3 retries. The pre-fix loop would have
  // pasted ~12 times in the same window (and hundreds over a long timeout).
  assert.ok(
    injections.length === 1,
    `expected exactly one paste, got ${injections.length}`,
  );
});

test('a slow reply is captured, not mistaken for silence', async () => {
  const prompt = 'TG_PRIVATE slow but real';
  const { client, wire, injections } = makeClient({ pane: PANE_IDLE, timeoutMs: 30000 });
  // Reply arrives well after the first self-heal tick would have fired.
  setTimeout(() => writeInjectedTurn(wire, injections, '我在，只是慢了一点。🐦‍⬛'), 7000);
  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, '我在，只是慢了一点。🐦‍⬛');
});

test('text emitted after usage.record is still captured', async () => {
  const prompt = 'TG_PRIVATE ordering';
  const { client, wire, injections } = makeClient({ pane: PANE_IDLE, timeoutMs: 20000 });
  setTimeout(() => writeInjectedTurn(wire, injections, 'usage 在前，正文在后'), 500);
  const reply = await client.runTuiTurn(prompt, 'session_test');
  assert.equal(reply, 'usage 在前，正文在后', 'usage.record must not end the turn early');
});

// Unmatched text is not owned by the just-injected Telegram update. It may be
// the previous turn finishing late, so forwarding it would misattribute B's
// words as A's reply. The bridge must fail closed and let the durable policy
// retry A rather than invent causal ownership from arrival time alone.
function writeTurnWithoutPrompt(wire, replyText) {
  const lines = [
    { type: 'usage.record', usageScope: 'turn' },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'text', text: replyText } },
    },
  ];
  fs.appendFileSync(wire, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

test('a late reply without the matching turn.prompt is never misattributed', async () => {
  let wrote = false;
  const { client } = makeClient({
    pane: PANE_IDLE,
    timeoutMs: 30000,
    onTmux: ({ args, wire }) => {
      // This is the previous turn B arriving after A was injected.
      if (args[0] === 'send-keys' && !wrote) {
        wrote = true;
        writeTurnWithoutPrompt(wire, '这是前一轮 B 的迟到输出，不属于当前 A');
      }
    },
  });
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE 当前 A', 'session_test'),
    /never registered the turn|timed out/i,
    'arrival after injection is not proof that the text belongs to A',
  );
});

test('注入之后 wire 里什么都没有时，仍然照旧失败', async () => {
  const { client } = makeClient({ pane: PANE_IDLE, timeoutMs: 12000 });
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE 无人应答', 'session_test'),
    /never registered the turn|timed out/i,
    '真的没有产出时不能凭空造一个回复出来',
  );
});

// —— 2026-09-01 turn 标记 ——
//
// 8/31 那天桥重启 11 次、TUI 注册失败 68 次；而 08-26～08-30 桥没重启，零失败。
// 根因：matched 用 prompt 前 80 字当指纹，而私聊 prompt 前 80 字全是协议头
// （"TG_PRIVATE\nFollow the Telegram bridge protocol from AGENTS.md. Reply with the Te"），
// 任意两条消息完全相同。而桥重启时并不重开 TUI（ensureTui 首行 tuiAlive() 就 return），
// 于是新桥面对一个还留着上一轮残留的 TUI，拿一个认不出彼此的指纹去猜：
// 猜不中就重投（她收到"重复投递"），猜错就把上一轮的回复当成这一轮的（把话安错消息）。
//
// 现在每轮贴一个唯一标记。这两个测试锁的是两个方向 —— 认得出自己，也认不出别人。
function writeTurnWithPrompt(wire, promptText, replyText) {
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

test('注入的 prompt 首行带唯一 turn 标记', async () => {
  const { client, injections } = makeClient({
    pane: PANE_IDLE,
    timeoutMs: 20000,
    onTmux: ({ args, wire, injections: seen }) => {
      if (args[0] !== 'send-keys' || !seen.length) return;
      const mark = /^\[turn:[a-z0-9]+\]/.exec(seen[0]);
      if (mark) writeTurnWithPrompt(wire, seen[0], 'ok');
    },
  });
  const reply = await client.runTuiTurn('TG_PRIVATE 你好', 'session_test');
  assert.equal(reply, 'ok');
  assert.match(injections[0], /^\[turn:[a-z0-9]+\]\nTG_PRIVATE 你好$/,
    '标记必须在首行，原文完整跟在后面');
});

test('别的轮次写进 wire 也不会被认领（这正是错配的来源）', async () => {
  const { client } = makeClient({
    pane: PANE_IDLE,
    timeoutMs: 9000,
    onTmux: ({ args, wire }) => {
      if (args[0] !== 'send-keys') return;
      // 一个协议头完全相同、但 turn 标记不同的轮次 —— 旧实现会把它当成自己的。
      writeTurnWithPrompt(
        wire,
        '[turn:someoneelse]\nTG_PRIVATE Follow the Telegram bridge protocol from AGENTS.md.',
        '这是上一条消息的回复，不该被当成本轮的',
      );
    },
  });
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE 我的消息', 'session_test'),
    /never registered the turn|timed out/i,
    '认不出就该老实失败，不能把别人的回复据为己有',
  );
});

// —— 2026-09-01 粘贴幂等 ——
//
// 当晚三次重试风暴的最后一环：turn 一直没注册（排在正在运行的上一轮后面），
// 桥按「composer 空 = paste 丢了」反复重贴，同一份批次在 Skald 的上下文里被
// 复印几十份，wire 一路灌到 6MB。turn 标记落地后，pane（含历史）里能看到本轮
// 标记就是「paste 没丢，只是没轮到」的确定性证据 —— 只补 Enter，绝不重贴。
function makePaneHistoryClient({ onTmux = null, timeoutMs = 12000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-wire-'));
  const wire = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wire, '');

  const client = new KimiCliClient({ workdir: dir, threadId: null, engine: 'tui', timeoutMs });
  client.threadId = 'session_test';

  const injections = [];
  const keys = [];
  let queuedMarker = '';
  client.wirePath = () => wire;
  client.ensureTui = async () => {};
  client.tuiAlive = () => true;
  client.capturePane = () => PANE_IDLE;
  client.tmux = (args, input) => {
    if (args[0] === 'load-buffer') {
      injections.push(String(input));
      // kimi 收下了这份 paste 并排进队列：pane 历史里随即能查到本轮标记，
      // 但 wire 里还没开 turn（它排在正在运行的上一轮后面）。
      queuedMarker = /^\[turn:[a-z0-9]+\]/.exec(String(input))?.[0] || '';
    }
    if (args[0] === 'send-keys') keys.push(args.at(-1));
    if (args[0] === 'capture-pane' && args.includes('-S')) return queuedMarker;
    if (onTmux) onTmux({ args, input, wire, injections, keys });
    return '';
  };
  return { client, injections, keys };
}

test('paste 已进队列（标记在 pane 历史里）时，只补 Enter，绝不重贴第二份', async () => {
  const { client, injections, keys } = makePaneHistoryClient({ timeoutMs: 12000 });
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE 排在别人后面', 'session_test'),
    /never registered|timed out/i,
  );
  assert.equal(injections.length, 1, '标记已在 pane 里就是没丢——再贴一份就是复印');
  assert.equal(keys.length, 1, '历史不是 composer，不额外提交 Enter');
});

test('pane 里查不到本轮标记不证明 paste 丢失，保持 unknown', async () => {
  const { client, injections } = makePaneHistoryClient({
    timeoutMs: 12000,
    onTmux: ({ args }) => {
      // 这一份 paste 从未被 kimi 收下：pane 历史里永远没有标记。
      if (args[0] === 'load-buffer') return;
    },
  });
  // 让历史查询永远落空：paste 没有被 kimi 收下。
  client.tmux = ((original) => (args, input) => {
    if (args[0] === 'capture-pane' && args.includes('-S')) return '';
    return original(args, input);
  })(client.tmux);
  await assert.rejects(
    () => client.runTuiTurn('TG_PRIVATE 真的丢了', 'session_test'),
    /never registered|timed out/i,
  );
  assert.equal(injections.length, 1, '观察不到不等于没接收，禁止重贴');
});
