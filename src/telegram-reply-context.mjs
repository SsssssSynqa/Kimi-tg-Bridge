const REPLY_TEXT_MAX_CHARS = 4096;

function clipText(value) {
  const characters = Array.from(String(value || ''));
  if (characters.length <= REPLY_TEXT_MAX_CHARS) return characters.join('');
  return `${characters.slice(0, REPLY_TEXT_MAX_CHARS - 1).join('')}…`;
}

function senderName(reply) {
  if (reply?.sender_chat) {
    return reply.sender_chat.username
      ? `@${reply.sender_chat.username}`
      : reply.sender_chat.title || String(reply.sender_chat.id ?? 'unknown');
  }
  const from = reply?.from;
  if (!from) return 'unknown';
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return from.username ? `@${from.username}` : fullName || String(from.id ?? 'unknown');
}

function contentKind(reply) {
  for (const kind of ['photo', 'video', 'document', 'animation', 'audio', 'voice', 'sticker', 'dice', 'poll', 'location', 'contact']) {
    if (reply?.[kind] != null) return kind;
  }
  if (typeof reply?.text === 'string') return 'text';
  if (typeof reply?.caption === 'string') return 'caption';
  return 'unknown';
}

export function buildTelegramReplyContext(message, botUsername = '') {
  const reply = message?.reply_to_message;
  if (!reply || reply.message_id == null) return null;
  const kind = contentKind(reply);
  const username = String(reply.from?.username || '');
  const selfUsername = String(botUsername || '').replace(/^@/, '');
  const senderKind = reply.sender_chat
    ? 'chat'
    : reply.from?.is_bot
      ? username.toLowerCase() === selfUsername.toLowerCase() ? 'self_bot' : 'other_bot'
      : reply.from ? 'human' : 'unknown';
  const quoted = typeof reply.text === 'string'
    ? reply.text
    : typeof reply.caption === 'string' ? reply.caption : `[${kind}]`;
  return {
    messageId: Number(reply.message_id),
    sender: senderName(reply),
    senderKind,
    contentKind: kind,
    text: clipText(quoted),
  };
}
