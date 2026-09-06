import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePrivateJson } from './durable-files.mjs';

const hash = text => crypto.createHash('sha256').update(String(text)).digest('hex');

// A notice has no Telegram inbound update_id and never enters the model. Keep
// its stable delivery identity separate from the inbound/persona history.
export async function deliverDurableNotice({ directory, noticeId, ownerId, text, isCurrent, send }) {
  const file = path.join(directory, `${hash(noticeId)}.json`);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (record && (record.noticeId !== noticeId || record.ownerId !== String(ownerId) || record.text !== text)) {
    throw new Error('catchup notice durable identity changed');
  }
  if (!isCurrent()) return { superseded: true };
  if (record?.acknowledgedAt) return { confirmed: true, receipt: record.chunks };
  if (!record) {
    record = { version: 1, noticeId, ownerId: String(ownerId), text, chunks: {}, preparedAt: new Date().toISOString() };
    writePrivateJson(file, record);
  }
  const delivery = {
    isAcked(index, chunk) {
      const ack = record.chunks[index];
      if (ack && ack.sha256 !== hash(chunk)) throw new Error('catchup notice chunk identity changed');
      return Boolean(ack);
    },
    ack(index, chunk, receipt) {
      record = { ...record, chunks: { ...record.chunks, [index]: { sha256: hash(chunk), receipt } } };
      writePrivateJson(file, record);
    },
  };
  const sent = await send(ownerId, text, { shouldSend: isCurrent, delivery });
  if (sent === false && !isCurrent()) return { superseded: true };
  if (sent !== true || !Object.keys(record.chunks).length) throw new Error('catchup notice has no confirmed chunk delivery');
  record = { ...record, acknowledgedAt: new Date().toISOString() };
  writePrivateJson(file, record);
  return { confirmed: true, receipt: record.chunks };
}
