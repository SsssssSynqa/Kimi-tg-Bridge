import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KimiCliClient } from '../src/kimi-client.mjs';

const hookPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../scripts/group-readonly-hook.mjs',
);

function runHook(cwd, toolName) {
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName }),
    encoding: 'utf8',
  });
}

test('group guard blocks write/command/unknown tools but permits reads', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-readonly-'));
  const client = new KimiCliClient({ workdir, timeoutMs: 5000 });
  await client.withToolMode('read-only', async () => {
    assert.equal(runHook(workdir, 'Read').status, 0);
    assert.equal(runHook(workdir, 'ReadMediaFile').status, 0);
    for (const tool of ['Write', 'Edit', 'Bash', 'Agent', 'mcp__example__mutate']) {
      const result = runHook(workdir, tool);
      assert.equal(result.status, 2, `${tool} must be denied`);
      assert.match(result.stderr, /mechanically read-only/);
    }
  });
  assert.equal(fs.existsSync(path.join(workdir, '.state', 'group-readonly.json')), false);
});

test('private mode has no guard and a failed group turn still clears it', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-readonly-'));
  const client = new KimiCliClient({ workdir, timeoutMs: 5000 });
  await client.withToolMode('private-tools', async () => {
    assert.equal(runHook(workdir, 'Write').status, 0);
  });
  await assert.rejects(
    client.withToolMode('read-only', async () => { throw new Error('turn failed'); }),
    /turn failed/,
  );
  assert.equal(runHook(workdir, 'Bash').status, 0, 'stale guard must not leak into later turns');
});

test('orphaned or expired guards fail open for non-group terminal work', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-readonly-'));
  const state = path.join(workdir, '.state');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(state, 'group-readonly.json'), JSON.stringify({
    mode: 'group-read-only', ownerPid: 999999, expiresAt: Date.now() + 60_000,
  }), { mode: 0o600 });
  assert.equal(runHook(workdir, 'Bash').status, 0);
});
