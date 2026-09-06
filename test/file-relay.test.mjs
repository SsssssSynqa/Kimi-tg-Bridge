import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveFileRelay } from '../src/kimi-client.mjs';

const RELAY_DIR = path.join(os.tmpdir(), 'skald-relay');

function unique(name) {
  return path.join(RELAY_DIR, `${name}-${process.pid}-${crypto.randomUUID()}`);
}

test('a regular relay file is substituted and consumed', () => {
  fs.mkdirSync(RELAY_DIR, { recursive: true, mode: 0o700 });
  const relay = unique('regular');
  fs.writeFileSync(relay, 'relay body', { mode: 0o600 });
  try {
    assert.equal(resolveFileRelay(`[SKALD:FILE]${relay}[/SKALD:FILE]`, undefined, { relayDir: RELAY_DIR }), 'relay body');
    assert.equal(fs.existsSync(relay), false);
  } finally {
    try { fs.unlinkSync(relay); } catch {}
  }
});

test('a symlink inside the relay directory cannot escape to another file', () => {
  fs.mkdirSync(RELAY_DIR, { recursive: true, mode: 0o700 });
  const outside = path.join(os.tmpdir(), `skald-relay-outside-${process.pid}-${crypto.randomUUID()}`);
  const relay = unique('escape');
  fs.writeFileSync(outside, 'must stay private', { mode: 0o600 });
  fs.symlinkSync(outside, relay);
  const marker = `[SKALD:FILE]${relay}[/SKALD:FILE]`;
  try {
    assert.equal(resolveFileRelay(marker, undefined, { relayDir: RELAY_DIR }), marker);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must stay private');
    assert.equal(fs.lstatSync(relay).isSymbolicLink(), true);
  } finally {
    try { fs.unlinkSync(relay); } catch {}
    try { fs.unlinkSync(outside); } catch {}
  }
});
