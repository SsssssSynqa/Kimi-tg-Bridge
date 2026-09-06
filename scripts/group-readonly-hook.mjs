#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const guardPath = path.resolve(process.cwd(), '.state', 'group-readonly.json');
const readOnlyTools = new Set([
  'Read',
  'ReadFile',
  'ReadMediaFile',
  'Grep',
  'Glob',
  'FetchURL',
  'WebFetch',
  'WebSearch',
  'SearchWeb',
  'Skill',
]);

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeGuard() {
  try {
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    if (guard?.mode !== 'group-read-only') return false;
    if (guard.version === 2) {
      // The bridge observer may have timed out or restarted while its TUI is
      // still executing. Only the exact durable completion releases this guard.
      try {
        const receipt = JSON.parse(fs.readFileSync(guard.receiptPath, 'utf8'));
        return !(receipt.requestId === guard.turnKey && receipt.marker === guard.nonce && receipt.state === 'completed');
      } catch { return true; }
    }
    return Number(guard.expiresAt) > Date.now()
      && processAlive(Number(guard.ownerPid));
  } catch (error) {
    // An existing but unreadable/corrupt guard is not evidence of completion.
    return error.code !== 'ENOENT';
  }
}

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // A malformed hook payload must not make ordinary/private turns unusable.
}

const toolName = String(input.tool_name || input.toolName || '');
if (activeGuard() && !readOnlyTools.has(toolName)) {
  process.stderr.write(
    `Blocked ${toolName || 'unknown tool'}: Telegram group turns are mechanically read-only.\n`,
  );
  process.exit(2);
}
