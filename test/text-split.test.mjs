import assert from 'node:assert/strict';
import test from 'node:test';

import { splitTelegramText } from '../src/telegram-text-split.mjs';

test('a chunk boundary never splits a surrogate pair', () => {
  const source = `${'x'.repeat(3999)}😀tail`;
  const chunks = splitTelegramText(source);
  assert.equal(chunks.join(''), source);
  assert.equal(chunks[0].endsWith('\ud83d'), false);
  assert.equal(chunks[1].startsWith('\ude00'), false);
});

test('newline preference and empty fallback are preserved', () => {
  const source = `${'x'.repeat(3000)}\n${'y'.repeat(1500)}`;
  assert.deepEqual(splitTelegramText(source).map((chunk) => chunk.length), [3000, 1500]);
  assert.deepEqual(splitTelegramText('', 4000, '(empty)'), ['(empty)']);
});
