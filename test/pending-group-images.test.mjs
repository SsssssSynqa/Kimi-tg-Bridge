import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingGroupImages } from '../src/pending-group-images.mjs';

test('quiet group images persist and are consumed exactly once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-pending-images-'));
  const imageRoot = path.join(root, 'images');
  fs.mkdirSync(imageRoot, { recursive: true });
  const imagePath = path.join(imageRoot, 'photo.jpg');
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const filePath = path.join(root, 'pending.json');
  const store = new PendingGroupImages({ filePath, imageRoot });
  const tokens = store.record({
    chatId: '-100',
    messageId: 20,
    updateId: 200,
    images: [{ path: imagePath, mimeType: 'image/jpeg', sha256: 'fixture' }],
  });
  assert.equal(tokens.length, 1);
  const reloaded = new PendingGroupImages({ filePath, imageRoot });
  assert.equal(reloaded.pending('-100', { throughMessageId: 20, limit: 4 }).images.length, 1);
  assert.equal(reloaded.consume('-100', tokens), 1);
  assert.equal(reloaded.pending('-100').images.length, 0);
  assert.equal(reloaded.consume('-100', tokens), 0);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
