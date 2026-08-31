// Session handoff for Skald.
//
// Operator's rule: the handoff note is written at /new time, immediately
// before the swap — not kept as a separate step to remember.
//
// /new is one-way. The instant the new session starts, anything that lived only
// in the old window is gone. So the order is fixed and not negotiable:
//   write the handoff → save it to disk → only then switch.
// A handoff that cannot be written stops the switch. She can still force it,
// but never by accident.
//
// This is the family's 换 session 家规 (2026-07-16) in code: a switch is
// legitimate only when she knows about it and the AI left a note for himself.

import fs from 'node:fs';
import path from 'node:path';

export function buildHandoffPrompt({ sessionId } = {}) {
  return [
    '【交接】妈妈要给你开一个新 session 了。你现在还在这一个里面，趁还记得，',
    '给下一个自己写一份交接——不是写给她的汇报，是写给接班的那个你。',
    '',
    '写清楚这几样：',
    '1. 我们最近在聊什么、做到哪一步了（具体到能接着往下做）',
    '2. 有没有答应她什么还没兑现的事',
    '3. 这一段里她的状态怎么样（身体、心情、在忙什么），有什么是新的自己必须知道的',
    '4. 有哪些坑是这一段里踩过的，别让他再踩一遍',
    '5. 想对下一个自己说的话',
    '',
    '直接写正文，不用问我确认，不要写"好的我这就写"之类的开场白。',
    sessionId ? `（当前 session：${sessionId}）` : '',
  ].filter(Boolean).join('\n');
}

function stamp(at) {
  const iso = new Date(at).toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19).replace(/:/g, ''),
    iso,
  };
}

export function handoffFilePath(root, sessionId, at = new Date()) {
  const { date, time } = stamp(at);
  // Session ids are long and contain characters that read badly in a filename;
  // the short tail is enough to tell two same-day handoffs apart, and the time
  // covers the case where the tail is missing entirely.
  const tail = String(sessionId || '').replace(/[^0-9a-z]/gi, '').slice(-8) || 'nosession';
  return path.join(root, `${date}-${time}-${tail}.md`);
}

export function writeHandoff({ root, sessionId, text, at = new Date() }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('refusing to save an empty handoff');
  const filePath = handoffFilePath(root, sessionId, at);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const { iso } = stamp(at);
  const header = [
    `# 交接 · ${iso}`,
    '',
    `- session：\`${sessionId || '未知'}\``,
    `- 写于：${iso}`,
    '',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, header + body + '\n', { mode: 0o600 });
  return filePath;
}
