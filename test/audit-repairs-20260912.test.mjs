import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const bridgeRoot = path.resolve(process.env.SKALD_REPAIR_ROOT || path.join(import.meta.dirname, '..'));
const kimiRoot = path.resolve(bridgeRoot, '..');
const cutoverPath = path.join(bridgeRoot, 'tasks/skald-vps-cutover-20260912/cutover.sh');
const rollbackPath = path.join(bridgeRoot, 'tasks/skald-vps-cutover-20260912/rollback-a.sh');
const refinePath = path.join(kimiRoot, '换窗/kimi_refine.py');

function source(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Linux Kimi TUI defaults to /usr/bin/tmux', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.equal(descriptor?.configurable, true);
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try {
    const moduleUrl = `${pathToFileURL(path.join(bridgeRoot, 'src/kimi-client.mjs')).href}?audit=${Date.now()}`;
    const { KimiCliClient } = await import(moduleUrl);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-tmux-'));
    const client = new KimiCliClient({ workdir });
    assert.equal(client.tmuxBin, '/usr/bin/tmux');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('bridge forwards configured tmuxBin into the Kimi client', () => {
  const bridge = source(path.join(bridgeRoot, 'src/bridge.mjs'));
  assert.match(bridge, /tmuxBin:\s*config\.tmuxBin\s*\|\|\s*undefined/);
});

test('carryover unwraps only a transport marker directly before a TG envelope', () => {
  const program = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('candidate_refine', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
private = '[turn:abc]\nTG_PRIVATE\n' + json.dumps({'sender': 'Synqa', 'text': 'hello'}, ensure_ascii=False)
ordinary = '[turn:abc]\nthis is terminal prose'
print(json.dumps([module.unwrap_user_text(private), module.unwrap_user_text(ordinary)], ensure_ascii=False))
`;
  const result = spawnSync('python3', ['-c', program, refinePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['Synqa: hello', '[turn:abc]\nthis is terminal prose']);
});

test('cutover uses canonical manifests and does not assume git-status line counts', () => {
  const script = source(cutoverPath);
  assert.match(script, /bytes=\$\(wc -c <"\$file" \| tr -d '\[:space:\]'\)/);
  assert.match(script, /printf '%s %s %s\\n' "\$label" "\$bytes" "\$hash"/);
  assert.doesNotMatch(script, /sed\s+['"]1,2d['"]/);
});

test('cutover makes both remote preflight and start failures fatal', () => {
  const script = source(cutoverPath);
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /ssh syner-vps 'bash -se' <<'REMOTE_PREFLIGHT'/);
  assert.match(script, /ActiveState --value/);
  assert.match(script, /MainPID --value/);
  assert.match(script, /ssh syner-vps 'bash -se' <<'REMOTE_START'/);
  assert.match(script, /systemctl is-active --quiet skald-bridge/);
});

test('rollback fetch failure cannot truncate the current OAuth credential', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-rollback-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const credentials = path.join(home, '.kimi-code/credentials');
  fs.mkdirSync(credentials, { recursive: true });
  fs.mkdirSync(fakeBin);
  const credentialPath = path.join(credentials, 'kimi-code.json');
  const original = '{"access_token":"old-access","refresh_token":"old-refresh","expires_at":4102444800}\n';
  fs.writeFileSync(credentialPath, original, { mode: 0o600 });
  const ssh = path.join(fakeBin, 'ssh');
  fs.writeFileSync(ssh, String.raw`#!/bin/sh
count=0
test -f "$SSH_COUNT_FILE" && count=$(cat "$SSH_COUNT_FILE")
count=$((count + 1)); printf '%s' "$count" > "$SSH_COUNT_FILE"
cat >/dev/null
test "$count" -eq 1 && exit 0
exit 23
`);
  fs.chmodSync(ssh, 0o755);
  const result = spawnSync('/bin/bash', [rollbackPath], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      SSH_COUNT_FILE: path.join(root, 'ssh-count'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(credentialPath, 'utf8'), original);
});

test('rollback validates fetched OAuth before atomic replacement', () => {
  const script = source(rollbackPath);
  assert.match(script, /TMP_CRED=\$\(mktemp/);
  assert.match(script, /for k in \("access_token", "refresh_token"\)/);
  assert.match(script, /math\.isfinite\(expiry\)/);
  assert.match(script, /mv -f "\$TMP_CRED" "\$CRED"/);
  execFileSync('/bin/bash', ['-n', rollbackPath]);
  execFileSync('/bin/bash', ['-n', cutoverPath]);
});

test('rollback rejects a loaded-but-not-running Mac bridge after bootstrap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skald-start-check-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const credentials = path.join(home, '.kimi-code/credentials');
  fs.mkdirSync(credentials, { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(credentials, 'kimi-code.json'), '{"access_token":"old","refresh_token":"old","expires_at":1}\n');
  const writeExecutable = (name, body) => {
    const filePath = path.join(fakeBin, name);
    fs.writeFileSync(filePath, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(filePath, 0o755);
  };
  writeExecutable('ssh', String.raw`
count=0; test -f "$SSH_COUNT_FILE" && count=$(cat "$SSH_COUNT_FILE")
count=$((count + 1)); printf '%s' "$count" > "$SSH_COUNT_FILE"
cat >/dev/null
test "$count" -eq 1 && exit 0
printf '%s\n' '{"access_token":"new","refresh_token":"new","expires_at":4102444800}'
`);
  writeExecutable('launchctl', String.raw`
case "$1" in
  print) printf '%s\n' 'state = exited' 'pid = 0';;
  list) printf '%s\n' '- 0 com.synergia.skald-bridge';;
esac
exit 0
`);
  writeExecutable('sleep', ':');
  writeExecutable('tail', ':');
  const result = spawnSync('/bin/bash', [rollbackPath], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      SSH_COUNT_FILE: path.join(root, 'ssh-count'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /state = exited|没有有效 PID/);
});
