import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendPrivateJsonLine, readRecoverableJsonLines } from './durable-files.mjs';

function updateIdOf(update) {
  const id = Number(update?.update_id);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid Telegram update_id');
  return id;
}

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on directories.
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function appendJsonLine(filePath, event) {
  appendPrivateJsonLine(filePath, event);
}

function albumKeyOf(update) {
  const m = update?.message;
  if (!m?.media_group_id) return null;
  return JSON.stringify([String(m.chat?.id ?? ''), String(m.message_thread_id ?? ''), String(m.media_group_id)]);
}

function chunkHash(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }

function writeAtomicPrivateFile(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(value), { encoding: 'utf8', mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(directory);
}

export class DurableUpdateInbox {
  constructor(filePath, {
    compactBytes = 8 * 1024 * 1024,
    keepDone = 512,
    rawArchivePath = null,
  } = {}) {
    this.filePath = filePath;
    this.compactBytes = compactBytes;
    this.keepDone = keepDone;
    this.rawArchivePath = rawArchivePath;
    this.rawArchiveOffsetPath = rawArchivePath ? `${rawArchivePath}.offset` : null;
    this.lastArchivedUpdateId = -1;
    if (this.rawArchiveOffsetPath) {
      try {
        const id = Number(fs.readFileSync(this.rawArchiveOffsetPath, 'utf8').trim());
        if (Number.isSafeInteger(id)) this.lastArchivedUpdateId = id;
      } catch {}
    }
    this.records = new Map();
    this.doneOrder = [];
    this.groupBatches = new Map();
    this.updateToGroupBatch = new Map();
    this.downtimeRecoveryRecords = new Map();
    this.downtimeTerminals = new Map();
    this.groupModelLifecycle = () => ({ state: 'unknown' });
    this.albumBatches = new Map();
    this.updateToAlbum = new Map();
    this.load();
  }

  applyGroupBatchEvent(event) {
    const batchId = String(event.batchId || '');
    if (!batchId) return;

    if (['group_downtime_done', 'group_downtime_dissolved'].includes(event.state)) {
      this.applyDowntimeRecovery(event);
      return;
    }

    if (event.state === 'group_batch') {
      const updateIds = [...new Set(
        (event.updateIds || []).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0),
      )];
      if (!updateIds.length || !Array.isArray(event.preparedMessages)) return;
      for (const updateId of updateIds) {
        const previousBatchId = this.updateToGroupBatch.get(updateId);
        if (previousBatchId && previousBatchId !== batchId) {
          const previous = this.groupBatches.get(previousBatchId);
          if (previous) previous.state = 'superseded';
        }
      }
      const record = {
        state: 'active',
        modelLifecycleVersion: event.modelLifecycleVersion ?? null,
        batchId,
        chatId: String(event.chatId || ''),
        updateIds,
        preparedMessages: event.preparedMessages,
        replies: null,
        threadId: null,
        ackedReplyIndexes: new Set(),
        chunkAcks: {},
        attempts: Number(event.attempts || 0),
        nextAttemptAt: Number(event.nextAttemptAt || 0),
        lastError: event.lastError || null,
      };
      this.groupBatches.set(batchId, record);
      for (const updateId of updateIds) this.updateToGroupBatch.set(updateId, batchId);
      return;
    }

    const record = this.groupBatches.get(batchId);
    if (!record) return;
    if (event.state === 'group_replies') {
      record.replies = Array.isArray(event.replies) ? event.replies : [];
      record.threadId = event.threadId ? String(event.threadId) : null;
    } else if (event.state === 'group_reply_ack') {
      const index = Number(event.replyIndex);
      if (Number.isInteger(index) && index >= 0) record.ackedReplyIndexes.add(index);
    } else if (event.state === 'group_chunk_ack') {
      record.chunkAcks[`${event.replyIndex}:${event.chunkIndex}`] = { hash: event.hash, result: event.result };
    } else if (event.state === 'group_retry') {
      record.attempts = Number(event.attempts || record.attempts || 0);
      record.nextAttemptAt = Number(event.nextAttemptAt || 0);
      record.lastError = event.lastError || null;
      for (const updateId of record.updateIds) {
        const current = this.records.get(updateId);
        if (current?.state === 'received') {
          this.records.set(updateId, {
            ...current,
            attempts: record.attempts,
            nextAttemptAt: record.nextAttemptAt,
            lastError: record.lastError,
          });
        }
      }
    } else if (event.state === 'group_dead') {
      record.state = 'dead';
      record.attempts = Number(event.attempts || record.attempts || 0);
      record.nextAttemptAt = 0;
      record.lastError = event.lastError || null;
      for (const updateId of record.updateIds) {
        const current = this.records.get(updateId);
        if (current?.update) {
          this.records.set(updateId, {
            ...current,
            state: 'dead',
            attempts: record.attempts,
            nextAttemptAt: 0,
            lastError: record.lastError,
          });
        }
      }
    } else if (event.state === 'group_requeue') {
      record.state = 'active';
      record.attempts = 0;
      record.nextAttemptAt = 0;
      record.lastError = null;
      for (const updateId of record.updateIds) {
        const current = this.records.get(updateId);
        if (current?.update) {
          this.records.set(updateId, {
            ...current,
            state: 'received',
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
          });
          this.updateToGroupBatch.set(updateId, batchId);
        }
      }
    } else if (event.state === 'group_superseded' || event.state === 'group_done') {
      record.state = event.state === 'group_done' ? 'done' : 'superseded';
      for (const updateId of record.updateIds) {
        if (this.updateToGroupBatch.get(updateId) === batchId) this.updateToGroupBatch.delete(updateId);
      }
      if (event.state === 'group_done') {
        for (const updateId of record.updateIds) this.markDoneInMemory(updateId);
      }
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    for (const event of readRecoverableJsonLines(this.filePath)) {
      if (String(event.state || '').startsWith('album_')) {
        this.applyAlbumEvent(event);
        continue;
      }
      if (String(event.state || '').startsWith('group_')) {
        this.applyGroupBatchEvent(event);
        continue;
      }
      const id = Number(event.updateId);
      if (!Number.isSafeInteger(id)) continue;
      const current = this.records.get(id);
      if (event.state === 'received' && event.update) {
        this.records.set(id, {
          state: 'received',
          update: event.update,
          attempts: Number(event.attempts || 0),
          nextAttemptAt: Number(event.nextAttemptAt || 0),
          lastError: event.lastError || null,
          privateDelivery: current?.privateDelivery || null,
          operation: current?.operation || null,
        });
      } else if (event.state === 'private_generated') {
        const current = this.records.get(id);
        if (current?.update) {
          this.records.set(id, {
            ...current,
            privateDelivery: {
              reply: String(event.reply || ''),
              threadId: event.threadId ? String(event.threadId) : null,
              chatId: String(event.chatId || ''),
              sent: false,
              sendResult: null,
              chunkAcks: {},
            },
          });
        }
      } else if (event.state === 'private_chunk_ack') {
        if (current?.privateDelivery) current.privateDelivery.chunkAcks[event.chunkIndex] = { hash: event.hash, result: event.result };
      } else if (event.state === 'private_send_ack') {
        const current = this.records.get(id);
        if (current?.privateDelivery) {
          current.privateDelivery.sent = true;
          current.privateDelivery.sendResult = event.sendResult || null;
        }
      } else if (event.state === 'operation_intent') {
        const current = this.records.get(id);
        if (current?.update) {
          current.operation = {
            name: String(event.name || ''),
            payload: event.payload || {},
            status: 'intent',
            result: null,
          };
        }
      } else if (event.state === 'operation_result') {
        const current = this.records.get(id);
        if (current?.operation) {
          current.operation.status = 'result';
          current.operation.result = event.result || {};
        }
      } else if (event.state === 'retry') {
        const current = this.records.get(id);
        if (current?.update) {
          this.records.set(id, {
            ...current,
            state: 'received',
            attempts: Number(event.attempts || current.attempts || 0),
            nextAttemptAt: Number(event.nextAttemptAt || 0),
            lastError: event.lastError || null,
          });
        }
      } else if (event.state === 'dead') {
        this.records.set(id, {
          ...current,
          state: 'dead',
          update: event.update || current?.update || null,
          attempts: Number(event.attempts || current?.attempts || 0),
          lastError: event.lastError || current?.lastError || null,
        });
      } else if (event.state === 'done') {
        if (event.terminalReason) this.downtimeTerminals.set(id, event);
        this.markDoneInMemory(id);
      }
    }
    this.trimDoneIndex();
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }

  markDoneInMemory(updateId) {
    const id = Number(updateId);
    if (this.records.get(id)?.state === 'done') return;
    this.records.set(id, { state: 'done', update: null });
    this.doneOrder.push(id);
    const album = this.albumForUpdate(id);
    if (album && album.updateIds.every((member) => this.records.get(member)?.state === 'done')) album.state = 'done';
  }

  append(event) {
    appendJsonLine(this.filePath, event);
  }

  archiveRaw(update, updateId) {
    if (!this.rawArchivePath || updateId <= this.lastArchivedUpdateId) return;
    // The archive is append-only and never compacted. The offset is written
    // second, so a crash can at worst duplicate one line, never lose it.
    appendJsonLine(this.rawArchivePath, {
      archivedAt: new Date().toISOString(),
      updateId,
      update,
    });
    writeAtomicPrivateFile(this.rawArchiveOffsetPath, updateId);
    this.lastArchivedUpdateId = updateId;
  }

  recordReceived(update) {
    const updateId = updateIdOf(update);
    this.archiveRaw(update, updateId);
    const existing = this.records.get(updateId);
    if (existing) return existing.state === 'received';
    this.append({ state: 'received', updateId, recordedAt: new Date().toISOString(), attempts: 0, update });
    this.records.set(updateId, {
      state: 'received',
      update,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      privateDelivery: null,
      operation: null,
    });
    return true;
  }

  markPrivateGenerated(updateId, { reply, threadId, chatId }) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.update || current.state !== 'received') throw new Error(`update ${id} is not in a deliverable state`);
    if (current.privateDelivery) return current.privateDelivery;
    const event = {
      state: 'private_generated',
      updateId: id,
      recordedAt: new Date().toISOString(),
      reply: String(reply || ''),
      threadId: threadId ? String(threadId) : null,
      chatId: String(chatId || ''),
    };
    this.append(event);
    current.privateDelivery = {
      reply: event.reply,
      threadId: event.threadId,
      chatId: event.chatId,
      sent: false,
      sendResult: null,
      chunkAcks: {},
    };
    return current.privateDelivery;
  }

  privateDelivery(updateId) {
    const delivery = this.records.get(Number(updateId))?.privateDelivery;
    return delivery ? structuredClone(delivery) : null;
  }

  privateChunkAck(updateId, chunkIndex, text) {
    const ack = this.records.get(Number(updateId))?.privateDelivery?.chunkAcks?.[chunkIndex];
    if (ack && ack.hash !== chunkHash(text)) throw new Error(`private chunk identity changed update=${updateId}`);
    return ack || null;
  }

  markPrivateChunkAck(updateId, chunkIndex, text, result) {
    const current = this.records.get(Number(updateId));
    if (!current?.privateDelivery || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error('invalid private chunk ack');
    if (this.privateChunkAck(updateId, chunkIndex, text)) return;
    const event = { state: 'private_chunk_ack', updateId: Number(updateId), chunkIndex, hash: chunkHash(text), result, recordedAt: new Date().toISOString() };
    this.append(event);
    current.privateDelivery.chunkAcks ||= {};
    current.privateDelivery.chunkAcks[chunkIndex] = { hash: event.hash, result };
  }

  markPrivateSendAck(updateId, sendResult = null) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.privateDelivery) throw new Error(`update ${id} has no generated private reply`);
    if (current.privateDelivery.sent) return;
    this.append({
      state: 'private_send_ack',
      updateId: id,
      recordedAt: new Date().toISOString(),
      sendResult,
    });
    current.privateDelivery.sent = true;
    current.privateDelivery.sendResult = sendResult;
  }

  beginOperation(updateId, name, payload = {}) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.update || current.state !== 'received') throw new Error(`update ${id} is not in an executable state`);
    if (current.operation) {
      if (current.operation.name !== String(name)) throw new Error(`update ${id} operation name conflict`);
      return structuredClone(current.operation);
    }
    const event = {
      state: 'operation_intent',
      updateId: id,
      recordedAt: new Date().toISOString(),
      name: String(name),
      payload,
    };
    this.append(event);
    current.operation = { name: event.name, payload, status: 'intent', result: null };
    return structuredClone(current.operation);
  }

  completeOperation(updateId, result = {}) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.operation) throw new Error(`update ${id} has no operation intent`);
    if (current.operation.status === 'result') return structuredClone(current.operation);
    const event = {
      state: 'operation_result',
      updateId: id,
      recordedAt: new Date().toISOString(),
      result,
    };
    this.append(event);
    current.operation.status = 'result';
    current.operation.result = result;
    return structuredClone(current.operation);
  }

  operation(updateId) {
    const operation = this.records.get(Number(updateId))?.operation;
    return operation ? structuredClone(operation) : null;
  }

  updateState(updateId) {
    return this.records.get(Number(updateId))?.state || null;
  }

  // 停机协议（Plan v3.2）：把一条停机期间攒下的记录标成终态，并写明它为什么终结。
  // journal 里 done 事件多带的字段在 replay 时被忽略（load 只取 updateId），纯属审计信息，
  // 不改变既有状态机；terminalReason 让「人格处理过」与「按规则弃读/进 digest」不再混为一谈。
  markDowntimeDone(updateId, terminalReason, context = {}) {
    const id = Number(updateId);
    const record = this.records.get(id);
    if (record?.state === 'done') {
      const previous = this.downtimeTerminals.get(id);
      return Boolean(previous && previous.terminalReason === terminalReason
        && previous.digestId === (context.digestId ? String(context.digestId) : null)
        && (previous.duplicateOfSourceKey ?? null) === (context.duplicateOfSourceKey ?? null));
    }
    if (!record) return false;
    if (this.groupBatchForUpdate(id)?.state === 'active') return false;
    if (!terminalReason) throw new Error('markDowntimeDone 必须给出 terminalReason');
    const event = {
      state: 'done', updateId: id, recordedAt: new Date().toISOString(),
      terminalReason: String(terminalReason),
      downtimeRecordId: context.recordId ? String(context.recordId) : null,
      digestId: context.digestId ? String(context.digestId) : null,
      ...(context.duplicateOfSourceKey ? { duplicateOfSourceKey: String(context.duplicateOfSourceKey) } : {}),
      ...(context.duplicateOfDigestId ? { duplicateOfDigestId: String(context.duplicateOfDigestId) } : {}),
    };
    this.append(event); this.downtimeTerminals.set(id, event);
    this.markDoneInMemory(id);
    this.trimDoneIndex();
    this.compactIfNeeded();
    return true;
  }

  prepareDowntimeRecovery(decisions) {
    const byId = new Map(decisions.map(({ update, decision }) => [Number(update.update_id), decision]));
    for (const batch of this.groupBatches.values()) {
      if (batch.state !== 'active') continue;
      const members = batch.updateIds.map(updateId => ({ updateId, decision: byId.get(updateId) }));
      if (members.some(member => !member.decision || member.decision.action === 'hold')) continue;
      const terminal = members.filter(member => member.decision.action === 'terminal');
      if (!terminal.length) continue;
      // Only new batches declare this guarantee. Never upgrade a legacy batch
      // just because its submit receipt happens to be absent after restart.
      if (batch.modelLifecycleVersion !== 1) continue;
      const lifecycle = this.groupModelLifecycle(batch);
      if (!['unsubmitted', 'prepared', 'completed'].includes(lifecycle?.state)) continue;
      const replayIds = members.filter(member => member.decision.action === 'replay').map(member => member.updateId);
      if (replayIds.length && lifecycle.state === 'completed') continue;
      const splitAlbum = replayIds.some(id => {
        const album = this.albumForUpdate(id);
        return album && album.updateIds.some(member => terminal.some(t => t.updateId === member));
      });
      const reboundBatch = splitAlbum ? this.rebindUnsubmittedAlbumBatch(batch, replayIds, terminal) : null;
      const event = {
        state: replayIds.length ? 'group_downtime_dissolved' : 'group_downtime_done',
        batchId: batch.batchId, recordedAt: new Date().toISOString(),
        lifecycle, modelDisposition: lifecycle.state === 'completed' ? 'completed-not-replayed' : 'not-submitted',
        batch: { ...structuredClone(batch), ackedReplyIndexes: [...batch.ackedReplyIndexes] },
        members: terminal.map(({ updateId, decision }) => ({ updateId, terminalReason: decision.reason,
          downtimeRecordId: decision.recordId ?? null, digestId: decision.digestId ?? null,
          ...(decision.duplicateOfSourceKey ? { duplicateOfSourceKey: decision.duplicateOfSourceKey } : {}),
          ...(decision.duplicateOfDigestId ? { duplicateOfDigestId: decision.duplicateOfDigestId } : {}),
        })), replayIds, reboundBatch,
      };
      this.append(event); this.applyDowntimeRecovery(event); this.trimDoneIndex(); this.compactIfNeeded();
    }
  }

  rebindUnsubmittedAlbumBatch(batch, replayIds, terminal) {
    const replay = new Set(replayIds), terminalIds = new Set(terminal.map(member => member.updateId));
    const preparedMessages = [];
    for (const original of batch.preparedMessages) {
      const album = this.albumForUpdate(original._durableUpdateId);
      const sourceIds = album?.updateIds || [Number(original._durableUpdateId)];
      const targets = sourceIds.filter(id => replay.has(id));
      const albumSources = sourceIds.map(updateId => ({ updateId,
        messageId: (album?.updates.find(update => update.update_id === updateId) || this.records.get(updateId)?.update)?.message?.message_id,
        contextOnly: terminalIds.has(updateId),
      }));
      if (replay.has(Number(original._durableUpdateId))) {
        preparedMessages.push({ ...structuredClone(original), albumSources,
          replyTargetIds: targets.map(id => this.records.get(id).update.message.message_id) });
      } else {
        // Retain the exact original caption, media paths and source identity as
        // context. Only the outside-window member is a new reply trigger.
        preparedMessages.push({ ...structuredClone(original), downtimeContextOnly: true,
          contextOnly: true, replyTargetIds: [], albumSources });
        for (const id of targets) {
          const message = this.records.get(id).update.message;
          preparedMessages.push({ ...structuredClone(original), _durableUpdateId: id,
            messageId: message.message_id, sentAt: Number(message.date) * 1000,
            text: message.text || message.caption || '（相册的新图片；完整相册与原说明见同批上下文）',
            images: [], files: [], replyTo: null, contextOnly: false,
            replyTargetIds: [message.message_id], albumSources,
          });
        }
      }
    }
    const identity = crypto.createHash('sha256').update(JSON.stringify({ batchId: batch.batchId,
      replayIds, terminal: terminal.map(member => [member.updateId, member.decision.reason, member.decision.digestId]) })).digest('hex').slice(0, 24);
    return { batchId: `${batch.batchId}:downtime:${identity}`, chatId: batch.chatId,
      updateIds: replayIds, preparedMessages, modelLifecycleVersion: 1,
      originalBatchId: batch.batchId, originalSourceUpdateIds: [...batch.updateIds],
      attempts: 0, nextAttemptAt: 0, recordedAt: new Date().toISOString() };
  }

  applyDowntimeRecovery(event) {
    this.downtimeRecoveryRecords.set(event.batchId, structuredClone(event));
    const previous = this.groupBatches.get(event.batchId);
    const batch = previous || { ...event.batch, ackedReplyIndexes: new Set(event.batch.ackedReplyIndexes || []) };
    batch.state = event.state === 'group_downtime_done' ? 'done' : 'dissolved';
    this.groupBatches.set(event.batchId, batch);
    for (const id of event.batch.updateIds) {
      if (this.updateToGroupBatch.get(id) === event.batchId) this.updateToGroupBatch.delete(id);
    }
    for (const member of event.members) {
      this.downtimeTerminals.set(member.updateId, { state: 'done', ...member, recordedAt: event.recordedAt });
      this.markDoneInMemory(member.updateId);
    }
    const rebound = event.reboundBatch;
    if (rebound && !this.groupBatches.has(rebound.batchId)
      && rebound.updateIds.every(id => this.records.get(id)?.state === 'received' && !this.updateToGroupBatch.has(id))) {
      this.applyGroupBatchEvent({ ...rebound, state: 'group_batch' });
    }
  }

  applyAlbumEvent(event) {
    if (event.state === 'album_batch') {
      const record = { ...event, state: 'active' };
      this.albumBatches.set(event.albumKey, record);
      for (const id of record.updateIds) this.updateToAlbum.set(id, event.albumKey);
      return;
    }
    const album = this.albumBatches.get(event.albumKey);
    if (!album) throw new Error(`album event has no membership: ${event.albumKey}`);
    if (event.state === 'album_done') {
      album.state = 'done';
      for (const id of album.updateIds) this.markDoneInMemory(id);
      return;
    }
    if (['album_retry', 'album_dead', 'album_requeue'].includes(event.state)) {
      album.state = event.state === 'album_dead' ? 'dead' : 'active';
      for (const id of album.updateIds) {
        const current = this.records.get(id);
        if (!current?.update) throw new Error(`album member missing: ${id}`);
        this.records.set(id, { ...current, state: album.state === 'dead' ? 'dead' : 'received',
          attempts: event.attempts || 0, nextAttemptAt: event.nextAttemptAt || 0, lastError: event.lastError || null });
      }
    }
  }

  albumForUpdate(updateId) {
    return this.albumBatches.get(this.updateToAlbum.get(Number(updateId))) || null;
  }

  markAlbumBatch(updates) {
    const ordered = [...updates].sort((a, b) => updateIdOf(a) - updateIdOf(b));
    const albumKey = albumKeyOf(ordered[0]);
    if (!albumKey || ordered.some((u) => albumKeyOf(u) !== albumKey)) throw new Error('invalid album membership');
    const prior = this.albumBatches.get(albumKey);
    if (prior) {
      if (prior.state === 'done' || ordered.some((u) => !prior.updateIds.includes(updateIdOf(u)))) {
        const error = new Error('Album has completed or frozen members outside this delivery; retained without generating a new turn');
        error.code = 'ALBUM_OUTCOME_UNKNOWN'; error.retryWithoutAttempt = true; throw error;
      }
      return prior;
    }
    const ids = ordered.map(updateIdOf);
    // Pre-upgrade journals had no album event. A previously completed member
    // means the surviving child must not invent a new causal identity.
    if (this.rawArchivePath && fs.existsSync(this.rawArchivePath)) {
      for (const raw of readRecoverableJsonLines(this.rawArchivePath)) {
        const candidate = raw.update;
        if (albumKeyOf(candidate) === albumKey && !ids.includes(updateIdOf(candidate))) {
          const error = new Error('Legacy/late album has a prior member outside the pending set; outcome unknown, no new model turn');
          error.code = 'ALBUM_OUTCOME_UNKNOWN'; error.retryWithoutAttempt = true; throw error;
        }
      }
    }
    const event = { state: 'album_batch', albumKey, primaryUpdateId: ids[0], updateIds: ids,
      updates: structuredClone(ordered), recordedAt: new Date().toISOString() };
    this.append(event); this.applyAlbumEvent(event);
    return this.albumBatches.get(albumKey);
  }

  markAlbumDone(album) {
    if (!album || album.state === 'done') return;
    const event = { state: 'album_done', albumKey: album.albumKey, recordedAt: new Date().toISOString() };
    this.append(event); this.applyAlbumEvent(event); this.trimDoneIndex(); this.compactIfNeeded();
  }

  markDone(updateId) {
    const id = Number(updateId);
    if (this.records.get(id)?.state === 'done') return;
    const groupBatch = this.groupBatchForUpdate(id);
    // GroupConversationBatcher settles every message in an active batch
    // together. Commit the whole membership in one fsync event so a crash
    // cannot leave a half-done batch that can neither replay nor progress.
    if (groupBatch?.state === 'active') {
      this.markGroupBatchDone(groupBatch.batchId);
      return;
    }
    const album = this.albumForUpdate(id);
    if (album) { this.markAlbumDone(album); return; }
    this.append({ state: 'done', updateId: id, recordedAt: new Date().toISOString() });
    this.markDoneInMemory(id);
    this.trimDoneIndex();
    this.compactIfNeeded();
  }

  markGroupBatch({ batchId, chatId, updateIds, preparedMessages, modelLifecycleVersion = null }) {
    const id = String(batchId || '');
    const ids = [...new Set(
      (updateIds || []).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0),
    )];
    if (!id || !ids.length || !Array.isArray(preparedMessages) || preparedMessages.length > ids.length || preparedMessages.some((m) => !ids.includes(Number(m._durableUpdateId)))) {
      throw new Error('invalid durable group batch arguments');
    }

    const existing = this.groupBatches.get(id);
    if (existing?.state === 'active') return id;

    const supersededBatchIds = new Set();
    for (const updateId of ids) {
      const previousBatchId = this.updateToGroupBatch.get(updateId);
      if (previousBatchId && previousBatchId !== id) supersededBatchIds.add(previousBatchId);
    }
    for (const previousBatchId of supersededBatchIds) {
      this.append({
        state: 'group_superseded',
        batchId: previousBatchId,
        supersededBy: id,
        recordedAt: new Date().toISOString(),
      });
      this.applyGroupBatchEvent({ state: 'group_superseded', batchId: previousBatchId });
    }

    const event = {
      state: 'group_batch',
      modelLifecycleVersion,
      batchId: id,
      chatId: String(chatId || ''),
      updateIds: ids,
      preparedMessages,
      recordedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
    return id;
  }

  markGroupBatchReplies(batchId, replies, threadId) {
    const id = String(batchId || '');
    const record = this.groupBatches.get(id);
    if (!record || record.state !== 'active') throw new Error(`group batch ${id} is not active`);
    const event = {
      state: 'group_replies',
      batchId: id,
      recordedAt: new Date().toISOString(),
      replies: Array.isArray(replies) ? replies : [],
      threadId: threadId ? String(threadId) : null,
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
  }

  markGroupReplyAck(batchId, replyIndex) {
    const id = String(batchId || '');
    const index = Number(replyIndex);
    const record = this.groupBatches.get(id);
    if (!record || record.state !== 'active' || !Number.isInteger(index) || index < 0) {
      throw new Error(`group batch ${id} reply ack is invalid`);
    }
    if (record.ackedReplyIndexes.has(index)) return;
    const event = {
      state: 'group_reply_ack',
      batchId: id,
      replyIndex: index,
      recordedAt: new Date().toISOString(),
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
  }

  groupChunkAck(batchId, replyIndex, chunkIndex, text) {
    const ack = this.groupBatches.get(String(batchId))?.chunkAcks?.[`${replyIndex}:${chunkIndex}`];
    if (ack && ack.hash !== chunkHash(text)) throw new Error(`group chunk identity changed batch=${batchId}`);
    return ack || null;
  }

  markGroupChunkAck(batchId, replyIndex, chunkIndex, text, result) {
    const record = this.groupBatches.get(String(batchId));
    if (!record || record.state !== 'active' || !Number.isSafeInteger(replyIndex) || !Number.isSafeInteger(chunkIndex) || replyIndex < 0 || chunkIndex < 0) throw new Error('invalid group chunk ack');
    if (this.groupChunkAck(batchId, replyIndex, chunkIndex, text)) return;
    const event = { state: 'group_chunk_ack', batchId, replyIndex, chunkIndex, hash: chunkHash(text), result, recordedAt: new Date().toISOString() };
    this.append(event); this.applyGroupBatchEvent(event);
  }

  isGroupReplyAcked(batchId, replyIndex) {
    return this.groupBatches.get(String(batchId || ''))?.ackedReplyIndexes.has(Number(replyIndex)) === true;
  }

  groupBatchForUpdate(updateId) {
    const batchId = this.updateToGroupBatch.get(Number(updateId));
    if (!batchId) return null;
    const record = this.groupBatches.get(batchId);
    return record && (record.state === 'active' || record.state === 'dead') ? record : null;
  }

  rawUpdate(updateId) { return structuredClone(this.records.get(Number(updateId))?.update || null); }

  pendingDowntimeUpdates() {
    return [...this.records.entries()].filter(([, r]) => r.state === 'received' && r.update)
      .sort(([a], [b]) => a - b).map(([, r]) => structuredClone(r.update));
  }

  dispatchable(updateId, shouldDispatch) {
    const batch = this.groupBatchForUpdate(updateId) || this.albumForUpdate(updateId);
    const ids = batch?.updateIds || [Number(updateId)];
    return ids.every((id) => {
      const update = this.records.get(id)?.update;
      return !update || shouldDispatch(update);
    });
  }

  pendingGroupBatches(now = Date.now(), { shouldDispatch = () => true } = {}) {
    const pending = [...this.groupBatches.values()]
      .filter((record) => record.state === 'active')
      .filter((record) => this.dispatchable(record.updateIds[0], shouldDispatch))
      .filter((record) => record.updateIds.every((updateId) => this.records.get(updateId)?.state === 'received'))
      .sort((left, right) => Math.min(...left.updateIds) - Math.min(...right.updateIds));
    const record = pending[0];
    if (!record || Number(record.nextAttemptAt || 0) > now) return [];
    const earliestReceivedUpdateId = Math.min(
      ...[...this.records.entries()]
        .filter(([id, entry]) => entry.state === 'received' && entry.update && this.dispatchable(id, shouldDispatch))
        .map(([updateId]) => updateId),
    );
    if (Math.min(...record.updateIds) !== earliestReceivedUpdateId) return [];
    return [{
      ...record,
      updateIds: [...record.updateIds],
      preparedMessages: structuredClone(record.preparedMessages),
      replies: record.replies == null ? null : structuredClone(record.replies),
      ackedReplyIndexes: new Set(record.ackedReplyIndexes),
    }];
  }

  markGroupBatchRetry(batchId, error, {
    maxAttempts = 12,
    baseDelayMs = 3000,
    maxDelayMs = 5 * 60 * 1000,
    countAttempt = true,
  } = {}) {
    const id = String(batchId || '');
    const record = this.groupBatches.get(id);
    if (!record || record.state !== 'active') throw new Error(`group batch ${id} is not in a retryable state`);
    if (Number(record.nextAttemptAt || 0) > Date.now()) {
      return {
        dead: false,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        alreadyScheduled: true,
      };
    }

    const attempts = Number(record.attempts || 0) + (countAttempt ? 1 : 0);
    const lastError = String(error || 'unknown').slice(0, 500);
    if (attempts >= maxAttempts) {
      const event = {
        state: 'group_dead',
        batchId: id,
        recordedAt: new Date().toISOString(),
        attempts,
        lastError,
      };
      this.append(event);
      this.applyGroupBatchEvent(event);
      this.compactIfNeeded();
      return { dead: true, attempts, nextAttemptAt: null, alreadyScheduled: false };
    }

    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
    const nextAttemptAt = Date.now() + delayMs;
    const event = {
      state: 'group_retry',
      batchId: id,
      recordedAt: new Date().toISOString(),
      attempts,
      nextAttemptAt,
      lastError,
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
    for (const updateId of record.updateIds) {
      const current = this.records.get(updateId);
      if (current?.state === 'received') {
        this.records.set(updateId, { ...current, attempts, nextAttemptAt, lastError });
      }
    }
    this.compactIfNeeded();
    return { dead: false, attempts, nextAttemptAt, alreadyScheduled: false };
  }

  markGroupBatchDone(batchId, terminalReason = null) {
    const id = String(batchId || '');
    const record = this.groupBatches.get(id);
    if (!record || record.state === 'done') return;
    if (record.state !== 'active') throw new Error(`group batch ${id} is not active`);
    const event = { state: 'group_done', batchId: id, recordedAt: new Date().toISOString(), ...(terminalReason ? { terminalReason } : {}) };
    this.append(event);
    this.applyGroupBatchEvent(event);
    this.trimDoneIndex();
    this.compactIfNeeded();
  }

  markRetry(updateId, error, {
    maxAttempts = 12,
    baseDelayMs = 3000,
    maxDelayMs = 5 * 60 * 1000,
    countAttempt = true,
  } = {}) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.update || current.state !== 'received') {
      throw new Error(`update ${id} is not in a retryable state`);
    }
    const attempts = Number(current.attempts || 0) + (countAttempt ? 1 : 0);
    const lastError = String(error || 'unknown').slice(0, 500);
    const album = this.albumForUpdate(id);
    if (album) {
      const dead = attempts >= maxAttempts;
      const nextAttemptAt = dead ? 0 : Date.now() + Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
      const event = { state: dead ? 'album_dead' : 'album_retry', albumKey: album.albumKey, attempts, nextAttemptAt, lastError, recordedAt: new Date().toISOString() };
      this.append(event); this.applyAlbumEvent(event); this.compactIfNeeded();
      return { dead, attempts, nextAttemptAt: dead ? null : nextAttemptAt };
    }
    if (attempts >= maxAttempts) {
      const event = {
        state: 'dead',
        updateId: id,
        recordedAt: new Date().toISOString(),
        attempts,
        lastError,
        update: current.update,
      };
      this.append(event);
      this.records.set(id, { ...current, state: 'dead', attempts, lastError });
      this.compactIfNeeded();
      return { dead: true, attempts, nextAttemptAt: null };
    }
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
    const nextAttemptAt = Date.now() + delayMs;
    this.append({
      state: 'retry',
      updateId: id,
      recordedAt: new Date().toISOString(),
      attempts,
      nextAttemptAt,
      lastError,
    });
    this.records.set(id, { ...current, state: 'received', attempts, nextAttemptAt, lastError });
    this.compactIfNeeded();
    return { dead: false, attempts, nextAttemptAt };
  }

  pendingUpdates(now = Date.now(), { shouldDispatch = () => true } = {}) {
    const pending = [...this.records.entries()]
      .filter(([id, record]) => record.state === 'received' && record.update && this.dispatchable(id, shouldDispatch))
      .sort(([left], [right]) => left - right);
    const due = [];
    for (const [updateId, record] of pending) {
      const album = this.albumForUpdate(updateId);
      if (album && album.primaryUpdateId !== updateId) continue;
      // An active exact group batch owns this update. Stop rather than skipping
      // it so a later Telegram update cannot leap over a delayed batch replay.
      if (this.updateToGroupBatch.has(updateId)) break;
      // Preserve Telegram update order across retry backoff. A later update must
      // not leap over an earlier one that has not reached its retry deadline.
      if (Number(record.nextAttemptAt || 0) > now) break;
      due.push(record.update);
    }
    return due;
  }

  deadUpdates() {
    return [...this.records.entries()]
      .filter(([, record]) => record.state === 'dead')
      .sort(([left], [right]) => left - right)
      .map(([updateId, record]) => ({ updateId, attempts: record.attempts, lastError: record.lastError }));
  }

  requeueDead(updateId) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (current?.state !== 'dead' || !current.update) return false;
    const deadGroupBatch = [...this.groupBatches.values()].find(
      (record) => record.state === 'dead' && record.updateIds.includes(id),
    );
    if (deadGroupBatch) {
      const event = {
        state: 'group_requeue',
        batchId: deadGroupBatch.batchId,
        recordedAt: new Date().toISOString(),
      };
      this.append(event);
      this.applyGroupBatchEvent(event);
      return true;
    }
    const album = this.albumForUpdate(id);
    if (album) {
      const event = { state: 'album_requeue', albumKey: album.albumKey, recordedAt: new Date().toISOString() };
      this.append(event); this.applyAlbumEvent(event); return true;
    }
    const event = {
      state: 'received',
      updateId: id,
      recordedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      update: current.update,
    };
    this.append(event);
    this.records.set(id, {
      ...current,
      state: 'received',
      update: current.update,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
    return true;
  }

  stats(now = Date.now()) {
    let pending = 0;
    let delayed = 0;
    let dead = 0;
    for (const record of this.records.values()) {
      if (record.state === 'received') {
        pending += 1;
        if (Number(record.nextAttemptAt || 0) > now) delayed += 1;
      } else if (record.state === 'dead') {
        dead += 1;
      }
    }
    return { pending, delayed, dead };
  }

  trimDoneIndex() {
    while (this.doneOrder.length > this.keepDone) {
      const id = this.doneOrder.shift();
      if (this.records.get(id)?.state === 'done') this.records.delete(id);
    }
  }

  compactIfNeeded(force = false) {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch { return; }
    if (!force && size < this.compactBytes) return;
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const lines = [];
    for (const [updateId, record] of [...this.records.entries()].sort(([a], [b]) => a - b)) {
      let event;
      if (record.state === 'received') {
        event = {
          state: 'received',
          updateId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          nextAttemptAt: record.nextAttemptAt || 0,
          lastError: record.lastError || null,
          update: record.update,
        };
      } else if (record.state === 'dead') {
        event = {
          state: 'dead',
          updateId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          lastError: record.lastError || null,
          update: record.update,
        };
      } else {
        event = this.downtimeTerminals.get(updateId) || { state: 'done', updateId, recordedAt: new Date().toISOString() };
      }
      lines.push(JSON.stringify(event));
      if (record.privateDelivery && record.state !== 'done') {
        lines.push(JSON.stringify({
          state: 'private_generated',
          updateId,
          recordedAt: new Date().toISOString(),
          reply: record.privateDelivery.reply,
          threadId: record.privateDelivery.threadId || null,
          chatId: record.privateDelivery.chatId,
        }));
        for (const [chunkIndex, ack] of Object.entries(record.privateDelivery.chunkAcks || {})) {
          lines.push(JSON.stringify({ state: 'private_chunk_ack', updateId, chunkIndex: Number(chunkIndex), ...ack }));
        }
        if (record.privateDelivery.sent) {
          lines.push(JSON.stringify({
            state: 'private_send_ack',
            updateId,
            recordedAt: new Date().toISOString(),
            sendResult: record.privateDelivery.sendResult || null,
          }));
        }
      }
      if (record.operation && record.state !== 'done') {
        lines.push(JSON.stringify({
          state: 'operation_intent',
          updateId,
          recordedAt: new Date().toISOString(),
          name: record.operation.name,
          payload: record.operation.payload || {},
        }));
        if (record.operation.status === 'result') {
          lines.push(JSON.stringify({
            state: 'operation_result',
            updateId,
            recordedAt: new Date().toISOString(),
            result: record.operation.result || {},
          }));
        }
      }
    }
    for (const album of this.albumBatches.values()) {
      if (album.state === 'done') continue;
      lines.push(JSON.stringify({ ...album, state: 'album_batch' }));
      if (album.state === 'dead') {
        const member = this.records.get(album.primaryUpdateId);
        lines.push(JSON.stringify({ state: 'album_dead', albumKey: album.albumKey, attempts: member?.attempts || 0, nextAttemptAt: member?.nextAttemptAt || 0, lastError: member?.lastError || null }));
      }
    }
    for (const record of [...this.groupBatches.values()]
      .filter((entry) => entry.state === 'active' || entry.state === 'dead')
      .sort((left, right) => Math.min(...left.updateIds) - Math.min(...right.updateIds))) {
      lines.push(JSON.stringify({
        state: 'group_batch',
        modelLifecycleVersion: record.modelLifecycleVersion ?? null,
        batchId: record.batchId,
        chatId: record.chatId,
        updateIds: record.updateIds,
        preparedMessages: record.preparedMessages,
        recordedAt: new Date().toISOString(),
        attempts: record.attempts || 0,
        nextAttemptAt: record.nextAttemptAt || 0,
        lastError: record.lastError || null,
      }));
      if (record.replies != null) {
        lines.push(JSON.stringify({
          state: 'group_replies',
          batchId: record.batchId,
          recordedAt: new Date().toISOString(),
          replies: record.replies,
          threadId: record.threadId || null,
        }));
      }
      for (const [key, ack] of Object.entries(record.chunkAcks || {})) {
        const [replyIndex, chunkIndex] = key.split(':').map(Number);
        lines.push(JSON.stringify({ state: 'group_chunk_ack', batchId: record.batchId, replyIndex, chunkIndex, ...ack }));
      }
      for (const replyIndex of [...record.ackedReplyIndexes].sort((a, b) => a - b)) {
        lines.push(JSON.stringify({
          state: 'group_reply_ack',
          batchId: record.batchId,
          replyIndex,
          recordedAt: new Date().toISOString(),
        }));
      }
      if (record.state === 'dead') {
        lines.push(JSON.stringify({
          state: 'group_dead',
          batchId: record.batchId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          lastError: record.lastError || null,
        }));
      } else if (record.attempts || record.nextAttemptAt || record.lastError) {
        lines.push(JSON.stringify({
          state: 'group_retry',
          batchId: record.batchId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          nextAttemptAt: record.nextAttemptAt || 0,
          lastError: record.lastError || null,
        }));
      }
    }
    for (const event of this.downtimeRecoveryRecords.values()) lines.push(JSON.stringify(event));
    fs.writeFileSync(tmp, `${lines.join('\n')}${lines.length ? '\n' : ''}`, { encoding: 'utf8', mode: 0o600 });
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    fsyncDirectory(path.dirname(this.filePath));
  }
}

export async function deliverDurablePrivateReply({
  inbox,
  updateId,
  chatId,
  generate,
  send,
  onReplay = () => {},
}) {
  let delivery = inbox.privateDelivery(updateId);
  let generatedNow = false;
  if (!delivery) {
    const generated = await generate();
    delivery = inbox.markPrivateGenerated(updateId, {
      reply: generated.reply,
      threadId: generated.threadId,
      chatId,
    });
    generatedNow = true;
  } else {
    onReplay(delivery);
  }

  if (delivery.sent) {
    return { delivery, generatedNow, sentNow: false };
  }
  const sendResult = await send(delivery.reply, { updateId, delivery });
  inbox.markPrivateSendAck(updateId, sendResult || null);
  return {
    delivery: inbox.privateDelivery(updateId),
    generatedNow,
    sentNow: true,
  };
}
