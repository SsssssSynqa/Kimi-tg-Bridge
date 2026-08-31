import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTelegramReplyContext } from '../src/telegram-reply-context.mjs';

test('reply provenance keeps the quoted sender and text', () => {
  const context = buildTelegramReplyContext({
    reply_to_message: {
      message_id: 42,
      from: { id: 7, username: 'other_bot', is_bot: true },
      text: '上一条消息',
    },
  }, 'Skald_Kimi_bot');
  assert.deepEqual(context, {
    messageId: 42,
    sender: '@other_bot',
    senderKind: 'other_bot',
    contentKind: 'text',
    text: '上一条消息',
  });
});

test('a media-only reply records its content kind', () => {
  const context = buildTelegramReplyContext({
    reply_to_message: {
      message_id: 9,
      from: { id: 1, first_name: 'Synqa' },
      photo: [{ file_id: 'x' }],
    },
  });
  assert.equal(context.sender, 'Synqa');
  assert.equal(context.senderKind, 'human');
  assert.equal(context.text, '[photo]');
});
