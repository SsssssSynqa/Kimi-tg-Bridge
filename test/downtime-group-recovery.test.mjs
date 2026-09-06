import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableUpdateInbox } from '../src/durable-update-inbox.mjs';
import { createDowntimeHooks } from '../src/downtime-hooks.mjs';
import { buildDigest, writeDigestFiles, loadScope } from '../../../shared/downtime-digest.mjs';
import { parseBatchReplies } from '../src/group-batcher.mjs';
import { fileURLToPath } from 'node:url';
import { RESUME_FILE } from '../../../shared/downtime-gate.mjs';

const chat = -1004499561917;
const raw = (id, date = '2026-09-06T23:00+08:00') => ({ update_id: id, message: { message_id: id, date: Date.parse(date) / 1000, text: `line ${id}`, from: { id: 8668822281 }, chat: { id: chat, type: 'supergroup' } } });
function fixture(updates, { legacy = false, lifecycle = { state: 'unsubmitted' }, preparedMessages = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-group-recovery-')); const stateDir = path.join(root, '.state'); fs.mkdirSync(path.join(root, 'shared')); fs.writeFileSync(path.join(root, 'shared/downtime-catchup-scope.json'), JSON.stringify(loadScope()));
  const inbox = new DurableUpdateInbox(path.join(stateDir, 'journal'), { rawArchivePath: path.join(stateDir, 'raw') }); updates.forEach(update => inbox.recordReceived(update));
  if (updates[0]?.message?.media_group_id) inbox.markAlbumBatch(updates);
  inbox.markGroupBatch({ batchId: 'g', chatId: chat, updateIds: updates.map(u => u.update_id), preparedMessages: preparedMessages || updates.map(u => ({ _durableUpdateId: u.update_id, chatId: chat, messageId: u.message.message_id })), ...(legacy ? {} : { modelLifecycleVersion: 1 }) });
  inbox.groupModelLifecycle = () => lifecycle;
  const window = { start: '2026-09-06T22:00+08:00', end: '2026-09-07T05:00+08:00' };
  const digest = buildDigest({ updates, window, scope: loadScope(), bridge: 'skald', persona: 'skald' }); writeDigestFiles(digest, path.join(root, 'downtime-digests'));
  fs.mkdirSync(path.join(stateDir, 'control')); fs.writeFileSync(path.join(stateDir, 'control', RESUME_FILE), JSON.stringify({ recordId: 'dt-fixture', mode: 'digest', digestId: digest.digestId, window }));
  const hooks = createDowntimeHooks({ durableInbox: inbox, stateDir, root, log: () => {} }); return { root, stateDir, inbox, hooks, digest };
}

test('real active groupBatch entirely covered by digest terminates atomically without a model turn', () => {
  const f = fixture([raw(1), raw(2)]); const stats = f.hooks.consumeResume(); assert.equal(stats.complete, true); assert.equal(f.inbox.updateState(1), 'done'); assert.equal(f.inbox.updateState(2), 'done');
  let reload = new DurableUpdateInbox(path.join(f.stateDir, 'journal')); assert.deepEqual(reload.pendingGroupBatches(), []); assert.equal(reload.downtimeRecoveryRecords.get('g').modelDisposition, 'not-submitted');
  reload.compactIfNeeded(true); reload = new DurableUpdateInbox(path.join(f.stateDir, 'journal')); assert.equal(reload.downtimeTerminals.get(1).digestId, f.digest.digestId); assert.equal(fs.readFileSync(path.join(f.stateDir, 'raw'), 'utf8').trim().split('\n').length, 2);
});

test('proven unsubmitted mixed batch dissolves scheduling only and releases outside-window input', () => {
  const f = fixture([raw(1), raw(2, '2026-09-07T06:00+08:00')], { lifecycle: { state: 'prepared', marker: 'original' } }); f.hooks.consumeResume();
  assert.equal(f.inbox.updateState(1), 'done'); assert.equal(f.inbox.updateState(2), 'received'); assert.equal(f.inbox.groupBatchForUpdate(2), null); assert.deepEqual(f.inbox.pendingUpdates(Date.now(), { shouldDispatch: f.hooks.shouldDispatch }).map(u => u.update_id), [2]);
  f.inbox.compactIfNeeded(true); const reload = new DurableUpdateInbox(path.join(f.stateDir, 'journal')); assert.deepEqual(reload.pendingUpdates().map(u => u.update_id), [2]); assert.equal(reload.downtimeRecoveryRecords.get('g').state, 'group_downtime_dissolved');
});

test('unknown accepted and legacy batches remain on original ownership, never falsely unsubmitted', () => {
  for (const options of [{ lifecycle: { state: 'outcome-unknown', marker: 'original' } }, { legacy: true }]) {
    const f = fixture([raw(1), raw(2)], options); const stats = f.hooks.consumeResume(); assert.equal(stats.complete, false); assert.equal(f.inbox.updateState(1), 'received'); assert.equal(f.inbox.groupBatchForUpdate(1).batchId, 'g'); assert.deepEqual(f.inbox.pendingGroupBatches(Date.now(), { shouldDispatch: f.hooks.shouldDispatch }), []); assert.equal(f.inbox.downtimeRecoveryRecords.size, 0);
  }
});

test('completed-not-replayed retains reply, attempt and chunk ACK evidence through compaction', () => {
  const f = fixture([raw(1)], { lifecycle: { state: 'completed', rawReply: 'complete raw', reply: 'complete resolved', marker: 'original', sessionId: 'same' } });
  f.inbox.markGroupBatchReplies('g', [{ text: 'original reply' }], 'same'); f.inbox.markGroupChunkAck('g', 0, 0, 'original reply', { message_id: 55 }); f.inbox.groupBatches.get('g').attempts = 2;
  f.hooks.consumeResume(); f.inbox.compactIfNeeded(true); const reload = new DurableUpdateInbox(path.join(f.stateDir, 'journal')); const audit = reload.downtimeRecoveryRecords.get('g'); assert.equal(audit.modelDisposition, 'completed-not-replayed'); assert.equal(audit.lifecycle.reply, 'complete resolved'); assert.equal(audit.batch.attempts, 2); assert.equal(audit.batch.replies[0].text, 'original reply'); assert.equal(audit.batch.chunkAcks['0:0'].result.message_id, 55);
});

test('duplicate source disposition retains its actual source key and digest rather than claiming inclusion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-duplicate-')); const file = path.join(root, 'journal'); let inbox = new DurableUpdateInbox(file); inbox.recordReceived(raw(1));
  const context = { digestId: 'main', recordId: 'dt', duplicateOfSourceKey: '0:-1:1', duplicateOfDigestId: 'original-digest' };
  assert.equal(inbox.markDowntimeDone(1, 'downtime_duplicate_of_included', context), true); inbox.compactIfNeeded(true); inbox = new DurableUpdateInbox(file); assert.equal(inbox.downtimeTerminals.get(1).duplicateOfDigestId, 'original-digest'); assert.equal(inbox.markDowntimeDone(1, 'downtime_duplicate_of_included', context), true); assert.equal(inbox.markDowntimeDone(1, 'downtime_digest_included', context), false);
});

test('unsubmitted group album across window keeps original caption/media as context and only outside member triggers one model/send', async () => {
  const updates = [raw(1, '2026-09-07T04:59:59+08:00'), raw(2, '2026-09-07T05:00:00+08:00')]; updates.forEach(u => { u.message.media_group_id = 'album'; u.message.photo = [{ file_id: `p${u.update_id}` }]; delete u.message.text; }); updates[0].message.caption = 'the exact original caption';
  const images = [{ path: '/fixture/one.png' }, { path: '/fixture/two.png' }];
  const original = { chatId: String(chat), messageId: 1, _durableUpdateId: 1, text: updates[0].message.caption, images, files: [], senderName: 'owner', senderIsBot: false, sentAt: updates[0].message.date * 1000, receivedAt: 1 };
  const f = fixture(updates, { preparedMessages: [original] }); f.hooks.consumeResume(); assert.equal(f.inbox.updateState(1), 'done'); assert.equal(f.inbox.albumForUpdate(2).primaryUpdateId, 1);
  f.inbox.compactIfNeeded(true); const inbox = new DurableUpdateInbox(path.join(f.stateDir, 'journal')); const [rebound] = inbox.pendingGroupBatches(Date.now(), { shouldDispatch: f.hooks.shouldDispatch }); assert.deepEqual(rebound.updateIds, [2]); assert.equal(rebound.preparedMessages[0].text, original.text); assert.deepEqual(rebound.preparedMessages[0].images, images);
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bridge.mjs'), 'utf8');
  const extract = (name, next, globals, async = true) => new Function(...Object.keys(globals), source.slice(source.indexOf(`${async ? 'async ' : ''}function ${name}(`), source.indexOf(`\n${next}`)) + `; return ${name};`)(...Object.values(globals));
  const replyTargets = extract('replyTargetIdsForBatch', 'function buildGroupBatchPrompt', {}, false);
  const config = { botName: 'fixture' }; const groupConfigFor = () => ({});
  const buildPrompt = extract('buildGroupBatchPrompt', 'async function askCodex', { config, groupConfigFor, replyTargetIdsForBatch: replyTargets }, false);
  let models = 0, input; const sent = [];
  const generate = extract('generateGroupReplies', 'async function notifyGroupFailure', {
    durableInbox: inbox, pendingGroupImages: { pending: () => ({ images: [], tokens: [] }) }, config, groupStillAuthorized: () => true, telegram: async () => {}, groupConfigFor, mentionContextOptions: () => ({}), recentGroupContextDelta: () => [], sessionId: 'same-session', modelQueue: { run: fn => fn() },
    codex: { threadId: 'same-session', ask: async (prompt, actualImages) => { models++; input = { prompt: JSON.parse(prompt.split('\n').at(-1)), images: actualImages }; return { reply: '{"replies":[{"text":"new outside answer","replyToMessageId":1}]}', threadId: 'same-session' }; } },
    buildGroupBatchPrompt: buildPrompt, telegramToolMode: () => 'read-only', privateToolsEnabled: true, GROUP_REPLY_SCHEMA: {}, syncThreadToDesktop: () => {}, parseBatchReplies, replyTargetIdsForBatch: replyTargets,
  });
  const replay = extract('replayDurableGroupBatch', 'function recordGroupBatchReplayFailure', { durableInbox: inbox, mayDispatchUpdate: f.hooks.shouldDispatch, groupStillAuthorized: () => true, generateGroupReplies: generate, log: () => {}, replyTargetIdsForBatch: replyTargets, groupChunkDelivery: () => null, sendMessage: async (_chat, text, target) => { sent.push({ text, target }); return true; }, advanceGroupContextCursor: () => {}, pendingGroupImages: { consume: () => {} } });
  await replay(rebound); assert.equal(models, 1); assert.deepEqual(input.images, images); assert.deepEqual(input.prompt.replyTargetIds, [2]); assert.equal(input.prompt.messages[0].contextOnly, true); assert.equal(input.prompt.messages[0].text, original.text); assert.deepEqual(input.prompt.messages[0].albumSources.map(s => [s.messageId, s.contextOnly]), [[1, true], [2, false]]); assert.deepEqual(sent, [{ text: 'new outside answer', target: 2 }]); assert.equal(inbox.updateState(2), 'done'); inbox.compactIfNeeded(true); assert.deepEqual(new DurableUpdateInbox(path.join(f.stateDir, 'journal')).pendingGroupBatches(), []);
});

test('completed mixed output targeting only the old window is retained for explicit review, never rebound or resubmitted', () => {
  const f = fixture([raw(1), raw(2, '2026-09-07T06:00+08:00')], { lifecycle: { state: 'completed', reply: 'only old answer' } }); f.inbox.markGroupBatchReplies('g', [{ text: 'only old answer', replyToMessageId: 1 }], 'same');
  const result = f.hooks.consumeResume(); assert.equal(result.complete, false); assert.equal(f.inbox.groupBatchForUpdate(2).batchId, 'g'); assert.equal(f.inbox.groupBatchForUpdate(2).replies[0].replyToMessageId, 1); assert.deepEqual(f.inbox.pendingGroupBatches(Date.now(), { shouldDispatch: f.hooks.shouldDispatch }), []); assert.equal(f.inbox.downtimeRecoveryRecords.size, 0);
});
