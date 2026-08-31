import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  crossedThresholds,
  parsePaneContextLabel,
  parsePaneContextPercent,
  readWireContextTokens,
  formatContextAlert,
} from '../src/context-usage.mjs';

// Product rule: notify at the first threshold, notify once more at 90%,
// never block the conversation.
//
// Nothing here may block a turn or switch a session. The watcher only reads and
// reports; /new stays entirely in her hands. Two sources, because the TUI status
// line is what Kimi itself computes (most accurate) but is not always rendered,
// and wire.jsonl is structured but needs a capacity to divide by.

test('reads the percentage Kimi itself renders in the TUI status line', () => {
  const pane = [
    ' ╭────────────────────────╮',
    ' │ >                      │',
    ' ╰────────────────────────╯',
    ' yolo  K3 thinking: high  …/Desktop/Synergia/Kimi',
    '                                     context: 10% (98.1k/1M)',
  ].join('\n');
  assert.equal(parsePaneContextPercent(pane), 10);
});

test('reads a high percentage', () => {
  assert.equal(parsePaneContextPercent('context: 83% (830.0k/1M)'), 83);
});

test('returns null when the status line is not on screen', () => {
  assert.equal(parsePaneContextPercent('just some reply text\nno status bar here'), null);
  assert.equal(parsePaneContextPercent(''), null);
  assert.equal(parsePaneContextPercent(null), null);
});

test('is not fooled by the word context appearing in a reply', () => {
  assert.equal(parsePaneContextPercent('I lost the context: it was 40% done'), null);
});

// Skald writes long prose and will eventually say something like this. Only the
// status bar at the bottom of the pane counts as a measurement.
test('prose far above the status bar is never read as a measurement', () => {
  const pane = [
    'The agent noted: context: 40% 只是个比喻。',
    ...Array.from({ length: 20 }, (_, i) => `filler line ${i}`),
    ' ╰────────────────────────╯',
    ' yolo  K3 thinking: high',
    '                          context: 83% (830.0k/1M)',
  ].join('\n');
  assert.equal(parsePaneContextPercent(pane), 83);
});

test('prose with no status bar at all still reads as no measurement', () => {
  const pane = [
    'The agent noted: context: 40% 只是个比喻。',
    ...Array.from({ length: 20 }, (_, i) => `filler line ${i}`),
  ].join('\n');
  assert.equal(parsePaneContextPercent(pane), null);
});

test('pulls the human-readable usage label off the status line', () => {
  assert.equal(parsePaneContextLabel('  context: 83% (830.0k/1M)'), '830.0k/1M');
  assert.equal(parsePaneContextLabel('context: 10% (98.1k/1M)'), '98.1k/1M');
});

test('a missing label is empty, never undefined', () => {
  assert.equal(parsePaneContextLabel('context: 83%'), '');
  assert.equal(parsePaneContextLabel(null), '');
});

// --- wire.jsonl fallback -----------------------------------------------------

function writeWire(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-wire-'));
  const file = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('sums the input side of the last usage.record', () => {
  const file = writeWire([
    { type: 'turn.prompt' },
    { type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 10, output: 5, inputCacheRead: 20, inputCacheCreation: 0 } },
    { type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 462, output: 429, inputCacheRead: 99584, inputCacheCreation: 0 } },
  ]);
  // output is not part of what the next turn has to carry
  assert.equal(readWireContextTokens(file), 100046);
});

test('ignores malformed lines rather than throwing', () => {
  const file = writeWire([{ type: 'usage.record', usage: { inputOther: 1, inputCacheRead: 2 } }]);
  fs.appendFileSync(file, 'not json at all\n');
  assert.equal(readWireContextTokens(file), 3);
});

test('returns null for a missing or usage-free wire', () => {
  assert.equal(readWireContextTokens('/nonexistent/wire.jsonl'), null);
  assert.equal(readWireContextTokens(writeWire([{ type: 'turn.prompt' }])), null);
});

// --- threshold edge detection ------------------------------------------------
// Must fire once per crossing, never on every tick, and never re-fire after a
// restart at the same level.

test('fires when a threshold is first crossed', () => {
  assert.deepEqual(crossedThresholds(79, [], [80, 90]), []);
  assert.deepEqual(crossedThresholds(80, [], [80, 90]), [80]);
  assert.deepEqual(crossedThresholds(85, [], [80, 90]), [80]);
});

test('does not repeat a threshold already reported', () => {
  assert.deepEqual(crossedThresholds(85, [80], [80, 90]), []);
  assert.deepEqual(crossedThresholds(89, [80], [80, 90]), []);
});

test('fires the 90 mark separately', () => {
  assert.deepEqual(crossedThresholds(90, [80], [80, 90]), [90]);
  assert.deepEqual(crossedThresholds(97, [80, 90], [80, 90]), []);
});

test('a jump straight past both reports both', () => {
  assert.deepEqual(crossedThresholds(95, [], [80, 90]), [80, 90]);
});

test('ignores a nonsense reading instead of alerting', () => {
  assert.deepEqual(crossedThresholds(null, [], [80, 90]), []);
  assert.deepEqual(crossedThresholds(-1, [], [80, 90]), []);
  assert.deepEqual(crossedThresholds(1000, [], [80, 90]), []);
});

// --- the message she actually receives ---------------------------------------

test('the alert names the level, the session, and who decides', () => {
  const text = formatContextAlert({ percent: 80, threshold: 80, sessionId: 'session_abc123', tokensLabel: '800.0k/1M' });
  assert.match(text, /80%/);
  assert.match(text, /session_abc123/);
  assert.match(text, /\/new/); // she must be told the switch is hers to make
  assert.match(text, /800\.0k\/1M/);
});

test('the 90 alert reads more urgent than the 80 one', () => {
  const first = formatContextAlert({ percent: 80, threshold: 80, sessionId: 's', tokensLabel: '' });
  const second = formatContextAlert({ percent: 91, threshold: 90, sessionId: 's', tokensLabel: '' });
  assert.notEqual(first, second);
  assert.match(second, /90%/);
});
