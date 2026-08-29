// Context-usage watcher for the Kimi session behind Skald.
//
// Synqa, 2026-08-15: 「通知，然后90%再通知一次，我/new的时候再写交接然后直接换」
//
// Deliberately powerless: it reads, it reports, and that is all. It never blocks
// a turn, never writes a handoff on its own, and never switches a session.
// The switch is hers — this only makes sure she is never surprised by it.
//
// Two sources, in priority order:
//   1. The TUI status line ("context: 10% (98.1k/1M)") — the number Kimi itself
//      computes, so it can never drift from what she sees on screen. Not always
//      rendered, so it can come back null.
//   2. wire.jsonl's last usage.record — structured and always there, but needs a
//      capacity to divide by, and its total runs ~2% above the TUI's figure.

import fs from 'node:fs';

const PANE_CONTEXT_RE = /context:\s*(\d{1,3})%/i;

export const DEFAULT_THRESHOLDS = [80, 90];

// The status bar is always the last thing tmux renders. Scanning only the tail
// keeps a reply that happens to contain "context: 40%" from being read as a
// measurement — Skald writes long prose, and it will say things like that.
const STATUS_TAIL_LINES = 8;

export function parsePaneContextPercent(paneText) {
  if (!paneText || typeof paneText !== 'string') return null;
  const lines = paneText.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - STATUS_TAIL_LINES));
  for (const line of tail) {
    const match = line.match(PANE_CONTEXT_RE);
    if (!match) continue;
    const percent = Number(match[1]);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) return percent;
  }
  return null;
}

// "context: 83% (830.0k/1M)" -> "830.0k/1M". Cosmetic: it lets the alert show
// her the same figure she'd see on screen. Absent is fine.
const PANE_LABEL_RE = /context:\s*\d{1,3}%\s*\(([^)]+)\)/i;

export function parsePaneContextLabel(paneText) {
  if (!paneText || typeof paneText !== 'string') return '';
  const lines = paneText.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - STATUS_TAIL_LINES));
  for (const line of tail) {
    const match = line.match(PANE_LABEL_RE);
    if (match) return match[1].trim();
  }
  return '';
}

export function readWireContextTokens(wirePath) {
  let raw;
  try {
    raw = fs.readFileSync(wirePath, 'utf8');
  } catch {
    return null;
  }
  let total = null;
  for (const line of raw.split('\n')) {
    if (!line || !line.includes('usage.record')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'usage.record') continue;
    const usage = record.usage || {};
    // Only the input side survives into the next turn; output does not occupy
    // the window the way the carried-forward prompt does.
    total = Number(usage.inputOther || 0)
      + Number(usage.inputCacheRead || 0)
      + Number(usage.inputCacheCreation || 0);
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function crossedThresholds(percent, alreadyNotified, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return [];
  const seen = new Set((alreadyNotified || []).map(Number));
  return thresholds
    .filter((level) => percent >= level && !seen.has(Number(level)))
    .sort((a, b) => a - b);
}

export function formatContextAlert({ percent, threshold, sessionId, tokensLabel }) {
  const head = threshold >= 90
    ? `🔴 鸦鸦的上下文到 ${threshold}% 了（现在 ${percent}%）`
    : `🟡 鸦鸦的上下文到 ${threshold}% 了（现在 ${percent}%）`;
  const size = tokensLabel ? `\n用量：${tokensLabel}` : '';
  const tail = threshold >= 90
    ? '\n\n再往上就该丢东西了。想换的时候发 /new —— 他会先写好交接再换。'
    : '\n\n不急，想换的时候发 /new —— 他会先写好交接再换。换不换、什么时候换，你说了算。';
  return `${head}${size}\nsession：${sessionId || '未知'}${tail}`;
}
