import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildHandoffPrompt, handoffFilePath, writeHandoff } from '../src/handoff.mjs';

// Synqa, 2026-08-15: 「我/new的时候再写交接然后直接换」
//
// /new is destructive and one-way: the moment the new session starts, whatever
// was only in the old window is gone. So the handoff is written FIRST, saved to
// disk FIRST, and only then does the switch happen. If the handoff cannot be
// written, the switch does not happen at all — she can still force it, but not
// by accident.

test('the prompt asks Skald to write for his own next self, not for a log', () => {
  const prompt = buildHandoffPrompt({ sessionId: 'session_abc' });
  assert.match(prompt, /交接/);
  // It has to be addressed to the successor, or he writes a status report.
  assert.match(prompt, /下一个|接班|新的自己|继任/);
});

test('the prompt does not tell him the session is already gone', () => {
  // He is still in it while writing. Past tense here has produced goodbye
  // letters instead of handoffs before.
  const prompt = buildHandoffPrompt({ sessionId: 'session_abc' });
  assert.doesNotMatch(prompt, /已经结束|已经切换|已被关闭/);
});

test('the file is named by date and session so two in one day never collide', () => {
  const at = new Date('2026-08-15T22:45:00Z');
  const a = handoffFilePath('/root', 'session_00006b0b-4818-4faf-869d-ac85fd84b498', at);
  const b = handoffFilePath('/root', 'session_ffffffff-0000-0000-0000-000000000000', at);
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^2026-08-15/);
  assert.ok(a.endsWith('.md'));
  assert.equal(path.dirname(a), '/root');
});

test('a session id with no shape still yields a usable filename', () => {
  const at = new Date('2026-08-15T22:45:00Z');
  const p = handoffFilePath('/root', '', at);
  assert.match(path.basename(p), /^2026-08-15/);
  assert.ok(p.endsWith('.md'));
  assert.doesNotMatch(path.basename(p), /[/\\]/);
});

test('writeHandoff creates the directory and returns the path', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skald-handoff-')), '交接');
  const written = writeHandoff({
    root,
    sessionId: 'session_abc',
    text: '## 我在做什么\n体检六条桥。',
    at: new Date('2026-08-15T22:45:00Z'),
  });
  assert.ok(fs.existsSync(written));
  const body = fs.readFileSync(written, 'utf8');
  assert.match(body, /体检六条桥/);
  // The successor must be able to tell which session this came from.
  assert.match(body, /session_abc/);
  assert.match(body, /2026-08-15/);
});

test('writing twice in the same second does not clobber the first', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skald-handoff-')), '交接');
  const at = new Date('2026-08-15T22:45:00Z');
  const first = writeHandoff({ root, sessionId: 'session_a', text: 'first', at });
  const second = writeHandoff({ root, sessionId: 'session_b', text: 'second', at });
  assert.notEqual(first, second);
  assert.match(fs.readFileSync(first, 'utf8'), /first/);
  assert.match(fs.readFileSync(second, 'utf8'), /second/);
});

test('an empty handoff is refused rather than silently saved', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skald-handoff-')), '交接');
  assert.throws(
    () => writeHandoff({ root, sessionId: 's', text: '   ', at: new Date() }),
    /empty|空/i,
  );
});
