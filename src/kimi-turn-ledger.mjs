import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePrivateJson } from './durable-files.mjs';

export function pendingTurnError(record, reason) {
  const error = new Error(
    `Kimi turn ${record.marker} is outcome-unknown (${reason}); request ${record.requestId} `
    + 'was not submitted again. Recovery observes the same session/wire marker.',
  );
  error.code = 'KIMI_OUTCOME_UNKNOWN';
  error.retryWithoutAttempt = true;
  return error;
}

// One stable transport request -> one persisted prompt marker. These are
// delivery receipts, never a replacement or a cropped view of persona history.
export class KimiTurnLedger {
  constructor(directory) { this.directory = directory; }
  filePath(requestId) {
    const key = crypto.createHash('sha256').update(String(requestId)).digest('hex');
    return path.join(this.directory, `${key}.json`);
  }
  read(requestId) {
    try {
      const record = JSON.parse(fs.readFileSync(this.filePath(requestId), 'utf8'));
      if (record.version !== 1 || record.requestId !== requestId || !record.marker) {
        throw new Error(`invalid Kimi turn receipt for ${requestId}`);
      }
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  activeRequests() {
    try {
      const index = JSON.parse(fs.readFileSync(path.join(this.directory, 'active.json'), 'utf8'));
      if (index.version !== 1 || !Array.isArray(index.requestIds) || index.requestIds.some((id) => typeof id !== 'string')) throw new Error('invalid Kimi active turn index');
      return index.requestIds;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(record, patch = {}) {
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    const pending = ['submitted', 'accepted', 'outcome-unknown'].includes(next.state);
    const active = this.activeRequests();
    // Index first, submit receipt second, paste last. A crash cannot hide an
    // accepted request merely because updating a second file was interrupted.
    if (pending && !active.includes(record.requestId)) {
      writePrivateJson(path.join(this.directory, 'active.json'), { version: 1, requestIds: [...active, record.requestId] });
    }
    writePrivateJson(this.filePath(record.requestId), next);
    if (next.state === 'completed' && active.includes(record.requestId)) {
      writePrivateJson(path.join(this.directory, 'active.json'), { version: 1, requestIds: active.filter((id) => id !== record.requestId) });
    }
    return next;
  }

  prepare({ requestId, sessionId, prompt, toolMode, wirePath, wireOffset }) {
    const prior = this.read(requestId);
    if (prior) {
      // A changed *current* session is not a reason to re-submit an old request:
      // its result always belongs to the recorded original session.
      return prior;
    }
    return this.save({
      version: 1, requestId, sessionId,
      marker: `[turn:t${crypto.randomUUID().replaceAll('-', '')}]`,
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
      toolMode: toolMode || 'read-only', wirePath, wireOffset,
      state: 'prepared', createdAt: new Date().toISOString(),
    });
  }
  pending() {
    return this.activeRequests().map((requestId) => {
      const record = this.read(requestId);
      if (!record) throw new Error(`Kimi active turn receipt missing: ${requestId}`);
      return record;
    }).filter((record) => ['submitted', 'accepted', 'outcome-unknown'].includes(record.state))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
}
