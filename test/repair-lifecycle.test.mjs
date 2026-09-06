import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { KimiCliClient } from '../src/kimi-client.mjs';
import { DurableUpdateInbox, deliverDurablePrivateReply } from '../src/durable-update-inbox.mjs';
import { GroupConversationBatcher } from '../src/group-batcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/bridge.mjs'), 'utf8');
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skald-repair-'));
const raw = (id, album = null) => ({ update_id: id, message: { message_id: id, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'fixture', ...(album ? { media_group_id: album } : {}) } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const turnWire = (prompt, text = 'answer', ended = true) => [
  { type: 'turn.prompt', input: [{ type: 'text', text: prompt }] },
  { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } } },
  ...(ended ? [{ type: 'turn.ended' }] : []),
].map(e => JSON.stringify(e)).join('\n') + '\n';
function tui(workdir, onPaste = null) {
  const wire = path.join(workdir, 'wire.jsonl'); if (!fs.existsSync(wire)) fs.writeFileSync(wire, '');
  const client = new KimiCliClient({ workdir, engine: 'tui', timeoutMs: 1 }); client.threadId = 'fixture-session';
  client.ensureTui = async () => {}; client.wirePath = () => wire; client.tuiAlive = () => true; client.capturePane = () => '│ > │';
  const prompts = []; let buffer = '';
  client.tmux = (args, input) => {
    if (args[0] === 'load-buffer') buffer = input;
    if (args[0] === 'paste-buffer') { prompts.push(buffer); onPaste?.(wire, buffer); }
    return '';
  };
  return { client, wire, prompts };
}
function hook(workdir) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/group-readonly-hook.mjs')], { cwd: workdir, input: '{"tool_name":"Bash"}', encoding: 'utf8' }).status;
}
function extractFunction(name, next, globals) {
  const text = source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`\n${next}`));
  return new Function(...Object.keys(globals), text + `; return ${name};`)(...Object.values(globals));
}

test('SK01/02: observer timeout keeps exact group guard; restart recovers same marker without submit', async () => {
  const dir = fixture(); const first = tui(dir, (wire, prompt) => fs.appendFileSync(wire, turnWire(prompt, 'late answer', false)));
  await assert.rejects(first.client.ask('group fixture', [], { toolMode: 'read-only', requestId: 'group:stable' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  assert.equal(first.prompts.length, 1); assert.equal(hook(dir), 2);
  const guardPath = path.join(dir, '.state/group-readonly.json');
  const guard = JSON.parse(fs.readFileSync(guardPath)); guard.ownerPid = 999999; guard.expiresAt = 1; fs.writeFileSync(guardPath, JSON.stringify(guard));
  assert.equal(hook(dir), 2, 'PID death and expired observer TTL cannot grant tools');
  const restarted = tui(dir);
  await assert.rejects(restarted.client.ask('new private', [], { toolMode: 'private-tools', requestId: 'private:next' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  assert.equal(restarted.prompts.length, 0);
  fs.appendFileSync(first.wire, JSON.stringify({ type: 'turn.ended' }) + '\n');
  const reply = await restarted.client.ask('different rebuilt prompt', [], { toolMode: 'read-only', requestId: 'group:stable' });
  assert.equal(reply.reply, 'late answer'); assert.equal(reply.threadId, 'fixture-session'); assert.equal(restarted.prompts.length, 0); assert.equal(hook(dir), 0);
  const repeated = await restarted.client.ask('again', [], { requestId: 'group:stable' }); assert.equal(repeated.reply, 'late answer'); assert.equal(restarted.prompts.length, 0);
});

test('SK02: a failure before paste stays prepared and may retry without blocking unrelated history', async () => {
  const f = tui(fixture(), (wire, prompt) => fs.appendFileSync(wire, turnWire(prompt)));
  const tmux = f.client.tmux; let fail = true;
  f.client.tmux = (args, input) => { if (fail && args[0] === 'load-buffer') { fail = false; throw new Error('buffer unavailable'); } return tmux(args, input); };
  await assert.rejects(f.client.ask('fixture', [], { requestId: 'private:1', toolMode: 'read-only' }), /buffer unavailable/);
  assert.equal(f.client.turnLedger.read('private:1').state, 'prepared'); assert.equal(hook(f.client.workdir), 0);
  assert.equal((await f.client.ask('fixture', [], { requestId: 'private:1', toolMode: 'read-only' })).reply, 'answer'); assert.equal(f.prompts.length, 1);
});

test('SK02: post-paste error remains unknown, later observation captures without another paste', async () => {
  const f = tui(fixture(), (wire, prompt) => fs.appendFileSync(wire, turnWire(prompt)));
  const tmux = f.client.tmux; let fail = true;
  f.client.tmux = (args, input) => { const value = tmux(args, input); if (fail && args[0] === 'paste-buffer') { fail = false; throw new Error('paste response lost'); } return value; };
  await assert.rejects(f.client.ask('fixture', [], { requestId: 'private:1', toolMode: 'read-only' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  assert.equal((await f.client.ask('fixture', [], { requestId: 'private:1', toolMode: 'read-only' })).reply, 'answer'); assert.equal(f.prompts.length, 1);
});

test('SK06: torn tail bytes retained, next accepted update survives restart and compaction', () => {
  const dir = fixture(); const journal = path.join(dir, 'journal'); const bad = '{"state":"rece'; fs.writeFileSync(journal, bad);
  const inbox = new DurableUpdateInbox(journal); inbox.recordReceived(raw(1));
  assert(fs.readFileSync(journal, 'utf8').startsWith(bad + '\n')); assert(fs.existsSync(journal + '.recovery.jsonl'));
  let reload = new DurableUpdateInbox(journal); assert.deepEqual(reload.pendingUpdates().map(u => u.update_id), [1]); reload.compactIfNeeded(true);
  reload = new DurableUpdateInbox(journal); assert.deepEqual(reload.pendingUpdates().map(u => u.update_id), [1]);
  const recovery = fs.readFileSync(journal + '.recovery.jsonl', 'utf8').trim().split('\n').map(JSON.parse); assert.equal(Buffer.from(recovery[0].bytesBase64, 'base64').toString(), bad);
});

test('SK06: complete last JSON without newline is kept; unknown middle corruption does not silently pass', () => {
  const file = path.join(fixture(), 'journal'); fs.writeFileSync(file, JSON.stringify({ state: 'received', updateId: 1, update: raw(1) }));
  const inbox = new DurableUpdateInbox(file); inbox.recordReceived(raw(2)); assert.deepEqual(new DurableUpdateInbox(file).pendingUpdates().map(u => u.update_id), [1, 2]);
  const bad = path.join(fixture(), 'journal'); fs.writeFileSync(bad, '{bad}\n'); assert.throws(() => new DurableUpdateInbox(bad), /JSONL corruption/);
});

test('SY02: album members are frozen and one main completion atomically completes them all', async () => {
  const file = path.join(fixture(), 'journal'); let inbox = new DurableUpdateInbox(file); const updates = [raw(1, 'A'), raw(2, 'A')]; updates.forEach(u => inbox.recordReceived(u));
  inbox.markAlbumBatch(updates); assert.deepEqual(inbox.pendingUpdates().map(u => u.update_id), [1]); inbox.compactIfNeeded(true); inbox = new DurableUpdateInbox(file);
  assert.deepEqual(inbox.albumForUpdate(2).updateIds, [1, 2]); assert.equal(inbox.albumForUpdate(2).primaryUpdateId, 1);
  await deliverDurablePrivateReply({ inbox, updateId: 1, chatId: 1, generate: async () => ({ reply: 'both', threadId: 'fixture' }), send: async () => ({ message_id: 5 }) });
  inbox.markDone(1); inbox = new DurableUpdateInbox(file); assert.deepEqual(inbox.pendingUpdates(), []); assert.equal(inbox.updateState(2), 'done');
  assert(fs.readFileSync(file, 'utf8').includes('album_done'));
});

test('SY02: legacy orphan and late members cannot silently acquire a new model identity', () => {
  const dir = fixture(); const inbox = new DurableUpdateInbox(path.join(dir, 'journal'), { rawArchivePath: path.join(dir, 'raw') });
  const a = raw(1, 'A'), b = raw(2, 'A'); inbox.recordReceived(a); inbox.recordReceived(b); inbox.markDone(1);
  assert.throws(() => inbox.markAlbumBatch([b]), e => e.code === 'ALBUM_OUTCOME_UNKNOWN'); assert.equal(inbox.updateState(2), 'received');
});

test('SK04: stop while sending settles active delivery and unmute does not resurrect it', async () => {
  const entered = deferred(), sent = deferred(); let generations = 0;
  const batcher = new GroupConversationBatcher({ timing: { singleMessageMs: 0 }, generateReplies: async () => { generations++; return [{ text: 'reply' }]; }, sendReply: async () => { entered.resolve(); await sent.promise; return true; }, log: () => {} });
  const original = batcher.enqueue({ chatId: 1, senderId: 1, messageId: 1, text: 'hello' }); await entered.promise;
  await batcher.enqueue({ chatId: 1, senderId: 1, messageId: 2, text: 'stop' }).completion; sent.resolve();
  assert.equal((await original.completion).suppressed, true); await batcher.waitForIdle(1); assert.equal(generations, 1);
});

test('SK08: known first chunk ACK survives failure, compaction, restart; only second chunk resumes', async () => {
  const file = path.join(fixture(), 'journal'); let inbox = new DurableUpdateInbox(file); inbox.recordReceived(raw(1)); let fail = true; const sent = [];
  const sendMessage = extractFunction('sendMessage', 'async function reactToMessage', { groupConfigFor: () => null, DICE_EMOJI: [], rateLimiter: { run: (_c, fn) => fn() }, telegram: async (_m, p) => { if (p.text === 'B' && fail) { fail = false; throw new Error('not sent'); } sent.push(p.text); return { message_id: sent.length }; }, splitTelegramText: () => ['A', 'B'], config: { botName: 'fixture' }, appendLiveLog: () => {}, truncateLiveText: t => t });
  const options = () => ({ inbox, updateId: 1, chatId: 1, generate: async () => ({ reply: 'AB', threadId: 'fixture' }), send: reply => sendMessage(1, reply, null, { delivery: { isAcked: (n, t) => Boolean(inbox.privateChunkAck(1, n, t)), ack: (n, t, result) => inbox.markPrivateChunkAck(1, n, t, result) } }) });
  await assert.rejects(deliverDurablePrivateReply(options()), /not sent/); inbox.compactIfNeeded(true); inbox = new DurableUpdateInbox(file); await deliverDurablePrivateReply(options()); assert.deepEqual(sent, ['A', 'B']);
});

test('SK08: group chunk ACK survives restart independently of the whole reply ACK', () => {
  const file = path.join(fixture(), 'journal'); let inbox = new DurableUpdateInbox(file); inbox.recordReceived(raw(1)); inbox.markGroupBatch({ batchId: 'g', chatId: '1', updateIds: [1], preparedMessages: [{ _durableUpdateId: 1 }] }); inbox.markGroupBatchReplies('g', [{ text: 'AB' }], 'fixture'); inbox.markGroupChunkAck('g', 0, 0, 'A', { message_id: 5 }); inbox.compactIfNeeded(true); inbox = new DurableUpdateInbox(file); assert(inbox.groupChunkAck('g', 0, 0, 'A')); assert(!inbox.isGroupReplyAcked('g', 0)); assert.throws(() => inbox.groupChunkAck('g', 0, 0, 'changed'), /identity changed/);
});

test('SK11: revoked group exact replay has no model/send; downtime-held group keeps pending', async () => {
  const file = path.join(fixture(), 'journal'); const inbox = new DurableUpdateInbox(file); inbox.recordReceived(raw(1)); inbox.markGroupBatch({ batchId: 'g', chatId: '1', updateIds: [1], preparedMessages: [{ _durableUpdateId: 1, chatId: 1 }] });
  const [record] = inbox.pendingGroupBatches(); let allowed = false, dispatch = false;
  const replay = extractFunction('replayDurableGroupBatch', 'function recordGroupBatchReplayFailure', { durableInbox: inbox, mayDispatchUpdate: () => dispatch, groupStillAuthorized: () => allowed, log: () => {}, sendMessage: () => { throw new Error('must not send'); }, generateGroupReplies: () => { throw new Error('must not generate'); } });
  assert.equal(await replay(record), false); assert.equal(inbox.updateState(1), 'received'); dispatch = true; assert.equal(await replay(record), true); assert.equal(inbox.updateState(1), 'done');
});

test('Recovery hold does not block later dispatchable private, but classification sees every member', () => {
  const inbox = new DurableUpdateInbox(path.join(fixture(), 'journal')); [1, 2, 3].forEach(id => inbox.recordReceived(raw(id))); inbox.markGroupBatch({ batchId: 'g', chatId: 1, updateIds: [1, 2], preparedMessages: [{ _durableUpdateId: 1 }, { _durableUpdateId: 2 }] });
  const shouldDispatch = update => update.update_id >= 3; assert.deepEqual(inbox.pendingUpdates(Date.now(), { shouldDispatch }).map(u => u.update_id), [3]); assert.deepEqual(inbox.pendingGroupBatches(Date.now(), { shouldDispatch }), []); assert.deepEqual(inbox.pendingDowntimeUpdates().map(u => u.update_id), [1, 2, 3]);
});

test('SK02: reconciling an old completed turn freezes relay contents before a new turn can overwrite them', async () => {
  const dir = fixture(), relayDir = path.join(dir, 'relay'); fs.mkdirSync(relayDir);
  const relay = path.join(relayDir, 'reply'); fs.writeFileSync(relay, 'original relay reply');
  const first = tui(dir, (wire, prompt) => fs.appendFileSync(wire, turnWire(prompt, `[SKALD:FILE]${relay}[/SKALD:FILE]`, false)));
  first.client.relayDir = relayDir;
  await assert.rejects(first.client.ask('old', [], { requestId: 'group:old', toolMode: 'read-only' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  fs.appendFileSync(first.wire, JSON.stringify({ type: 'turn.ended' }) + '\n');
  const next = tui(dir, (wire, prompt) => { fs.writeFileSync(relay, 'overwritten'); fs.appendFileSync(wire, turnWire(prompt, 'new reply')); }); next.client.relayDir = relayDir;
  assert.equal((await next.client.ask('new', [], { requestId: 'private:new' })).reply, 'new reply');
  assert.equal((await next.client.ask('old', [], { requestId: 'group:old' })).reply, 'original relay reply'); assert.equal(next.prompts.length, 1);
});

test('SK04: stop then human unmute during generation cancels only the old generation', async () => {
  const entered = deferred(), release = deferred(); const sent = []; let count = 0;
  const batcher = new GroupConversationBatcher({ timing: { singleMessageMs: 0 }, generateReplies: async (messages) => { if (++count === 1) { entered.resolve(); await release.promise; } return [{ text: messages.map(m => m.text).join(',') }]; }, sendReply: async (_chat, reply) => { sent.push(reply.text); return true; }, log: () => {} });
  const old = batcher.enqueue({ chatId: 1, senderId: 1, messageId: 1, text: 'old' }); await entered.promise;
  batcher.enqueue({ chatId: 1, senderId: 1, messageId: 2, text: 'stop' }); const fresh = batcher.enqueue({ chatId: 1, senderId: 1, messageId: 3, text: 'new' }); release.resolve();
  assert.equal((await old.completion).suppressed, true); await fresh.completion; await batcher.waitForIdle(1); assert.deepEqual(sent, ['new']);
});

test('SY02: dead album survives compaction, and requeue restores original membership and attempt-free observe', () => {
  const file = path.join(fixture(), 'journal'); let inbox = new DurableUpdateInbox(file); const updates = [raw(1, 'A'), raw(2, 'A')]; updates.forEach(u => inbox.recordReceived(u)); inbox.markAlbumBatch(updates);
  inbox.markRetry(1, new Error('observe only'), { countAttempt: false, now: 1, baseDelayMs: 1 }); assert.equal(inbox.records.get(1).attempts, 0);
  inbox.markRetry(1, new Error('failed'), { maxAttempts: 1, now: 1 }); inbox.compactIfNeeded(true); inbox = new DurableUpdateInbox(file); assert.equal(inbox.albumForUpdate(2).state, 'dead'); assert.equal(inbox.updateState(2), 'dead');
  inbox.requeueDead(2); assert.deepEqual(inbox.pendingUpdates().map(u => u.update_id), [1]); assert.deepEqual(inbox.albumForUpdate(1).updateIds, [1, 2]);
});

test('SY02: a group album persists all member IDs and one group completion survives restart atomically', () => {
  const file = path.join(fixture(), 'journal'); let inbox = new DurableUpdateInbox(file); const updates = [raw(1, 'A'), raw(2, 'A')]; updates.forEach(u => inbox.recordReceived(u)); inbox.markAlbumBatch(updates);
  inbox.markGroupBatch({ batchId: 'group:album', chatId: 1, updateIds: [1, 2], preparedMessages: [{ _durableUpdateId: 1 }] }); inbox.markGroupBatchDone('group:album'); inbox = new DurableUpdateInbox(file); assert.equal(inbox.updateState(1), 'done'); assert.equal(inbox.updateState(2), 'done'); assert.deepEqual(inbox.pendingUpdates(), []);
});

test('SK10: real passive group branch archives every image in the album with its own source ID', async () => {
  const updates = [1, 2, 3].map(id => ({ update_id: id + 10, message: { message_id: id, media_group_id: 'A', chat: { id: 9, type: 'supergroup' }, from: { id: 7 }, photo: [{ file_id: `photo:${id}` }], date: id } })); const recorded = [];
  const handle = extractFunction('handleMessage', 'async function prepareTelegramUpdate', {
    getTelegramMessageText: () => '', hasTelegramAttachments: () => true, refreshDynamicGroups: () => {}, allowedGroups: new Map([['9', {}]]), handleFlowCommand: async () => false, handleGateCommand: async () => false, config: {}, ownerUserId: '', dynamicGroupsPath: '', gateCommandPrefix: 'skald', sendMessage: () => { throw new Error('passive must not send'); }, dynamicGroups: {}, allowedUserIds: new Set(), mentionContextOptions: () => ({}), canTriggerInGroup: () => false, rememberGroupMessage: () => {}, passiveHistoryText: () => '', isNonConversationalBotMessage: () => false, token: 'fixture', imageCacheDir: '', fileCacheDir: '', DEFAULT_CONFIG: {}, log: () => {},
    downloadTelegramAttachments: async message => ({ images: [message.photo[0].file_id] }), durableInbox: { albumForUpdate: () => ({ updates }) }, pendingGroupImages: { record: record => { recorded.push(record); return ['token']; } },
  });
  await handle(updates[0].message, 11, updates.slice(1).map(u => u.message)); assert.deepEqual(recorded.map(r => [r.messageId, r.updateId, r.images[0]]), [[1, 11, 'photo:1'], [2, 12, 'photo:2'], [3, 13, 'photo:3']]);
});

test('SK01: a corrupt or missing active turn receipt never releases an existing group guard', async () => {
  const dir = fixture(); const f = tui(dir); await assert.rejects(f.client.ask('group', [], { requestId: 'g', toolMode: 'read-only' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  fs.writeFileSync(f.client.turnLedger.filePath('g'), '{broken'); assert.equal(hook(dir), 2);
  fs.unlinkSync(f.client.turnLedger.filePath('g')); assert.equal(hook(dir), 2);
  fs.writeFileSync(path.join(dir, '.state/group-readonly.json'), '{broken'); assert.equal(hook(dir), 2);
});

test('SK02: restart with an unresolved receipt does not auto-start or replace the TUI', async () => {
  const dir = fixture(); const f = tui(dir); await assert.rejects(f.client.ask('pending', [], { requestId: 'p' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  let starts = 0;
  class Stub extends KimiCliClient { async ensureTui() { starts++; } }
  new Stub({ workdir: dir, threadId: 'fixture-session', engine: 'tui' }); assert.equal(starts, 0);
});

test('SK11: authorization revoked while waiting in modelQueue cannot start the model or advance context', async () => {
  let allowed = true, asks = 0; const batch = [{ chatId: '1', messageId: 1, _durableUpdateId: 1 }];
  const generate = extractFunction('generateGroupReplies', 'async function notifyGroupFailure', {
    durableInbox: { albumForUpdate: () => null, markGroupBatch: () => {} }, pendingGroupImages: { pending: () => ({ tokens: [], images: [] }) }, config: {}, durableGroupBatchId: () => 'g', serializeDurableGroupMessage: m => m, groupStillAuthorized: () => allowed, telegram: async () => {}, groupConfigFor: () => ({}), mentionContextOptions: () => ({}), recentGroupContextDelta: () => [], sessionId: 'fixture-session', modelQueue: { run: async fn => { allowed = false; return fn(); } }, codex: { ask: async () => { asks++; throw new Error('must not ask'); } },
  });
  assert.deepEqual(await generate(batch, {}), []); assert.equal(asks, 0); assert.equal(batch[0]._authorizationRevoked, true); assert.equal(batch[0]._processedThreadId, undefined);
});

test('SK11: the live reaction callback rechecks group authorization before Telegram', async () => {
  const expression = source.match(/onReact: (\(chatId, messageId, emoji\) =>[^\n]+),/)[1]; let reactions = 0;
  const callback = new Function('groupStillAuthorized', 'reactToMessage', `return ${expression};`)(() => false, async () => { reactions++; }); await callback(1, 2, '👀'); assert.equal(reactions, 0);
});

test('SK02: explicit driver ensure and main startup cannot restart an unresolved absent TUI', async () => {
  const f = tui(fixture()); await assert.rejects(f.client.ask('pending', [], { requestId: 'pending' }), e => e.code === 'KIMI_OUTCOME_UNKNOWN');
  f.client.tuiAlive = () => false; let starts = 0; f.client.tmux = () => { starts++; };
  await assert.rejects(KimiCliClient.prototype.ensureTui.call(f.client, 'fixture-session'), e => e.code === 'KIMI_OUTCOME_UNKNOWN'); assert.equal(starts, 0);
  assert.match(source, /sessionId && codex\.turnLedger\.pending\(\)\.length === 0\) \{\s*await codex\.ensureTui/);
});
