import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deliverDurableNotice } from '../src/durable-notice-outbox.mjs';

test('notice ACK is actual send completion; known chunks and complete receipts survive retries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-notice-')); const calls = []; let fail = true;
  const request = { directory, noticeId: 'notice:stable', ownerId: '123', text: 'AB', isCurrent: () => true,
    send: async (_chat, _text, { delivery }) => {
      for (const [n, text] of ['A', 'B'].entries()) {
        if (delivery.isAcked(n, text)) continue;
        if (n === 1 && fail) { fail = false; throw new Error('no second ACK'); }
        calls.push(text); delivery.ack(n, text, { message_id: n + 1 });
      }
      return true;
    },
  };
  await assert.rejects(deliverDurableNotice(request), /no second ACK/);
  const record = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(n => n.endsWith('.json'))))); assert.equal(record.acknowledgedAt, undefined);
  assert.equal((await deliverDurableNotice(request)).confirmed, true); assert.equal((await deliverDurableNotice(request)).confirmed, true); assert.deepEqual(calls, ['A', 'B']);
});

test('an outdated notice is not sent, including a revision change during queue wait', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-notice-')); let current = false, sends = 0;
  const request = { directory, noticeId: 'old', ownerId: '123', text: 'notice', isCurrent: () => current,
    send: async (_chat, _body, { shouldSend }) => { current = false; if (!shouldSend()) return false; sends++; return true; },
  };
  assert.deepEqual(await deliverDurableNotice(request), { superseded: true }); current = true;
  assert.deepEqual(await deliverDurableNotice(request), { superseded: true }); assert.equal(sends, 0);
});

test('queue acceptance without a delivery result cannot manufacture a notice ACK', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-notice-')); let release; const queued = new Promise(r => { release = r; }); let resolved = false;
  const operation = deliverDurableNotice({ directory, noticeId: 'slow', ownerId: '123', text: 'one', isCurrent: () => true, send: async (_c, _t, { delivery }) => { await queued; delivery.ack(0, 'one', { message_id: 9 }); return true; } }).then(result => { resolved = true; return result; });
  await Promise.resolve(); assert.equal(resolved, false); release(); assert.equal((await operation).confirmed, true);
});

test('a queue-only or bare success result is not an actual chunk receipt', async () => {
  for (const result of [{ queued: true }, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-notice-'));
    await assert.rejects(deliverDurableNotice({ directory, noticeId: 'queue-only', ownerId: '123', text: 'one', isCurrent: () => true, send: async () => result }), /no confirmed chunk delivery/);
  }
});

test('unknown current-revision I/O failure is retriable, not falsely superseded', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-notice-')); let sends = 0;
  await assert.rejects(deliverDurableNotice({ directory, noticeId: 'io', ownerId: '123', text: 'one', isCurrent: () => { throw new Error('disk unavailable'); }, send: async () => { sends++; return true; } }), /disk unavailable/); assert.equal(sends, 0);
});
