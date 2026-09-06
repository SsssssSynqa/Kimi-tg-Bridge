import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function writePrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filePath);
  syncDirectory(directory);
}

function appendBytes(filePath, bytes) {
  const existed = fs.existsSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`append made no progress: ${filePath}`);
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.chmodSync(filePath, 0o600);
  if (!existed) syncDirectory(path.dirname(filePath));
}

// Never append a new record onto a torn predecessor. The original bytes stay
// append-only; recovery records identify exactly which incomplete line was
// quarantined before a newline is added. Unknown middle corruption is an error.
export function repairJsonlTail(filePath) {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, 'r');
  let tail; let start;
  try {
    const { size } = fs.fstatSync(fd);
    if (!size) return;
    const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 10) return;
    let position = size; const parts = [];
    while (position > 0) {
      const length = Math.min(64 * 1024, position); position -= length;
      const part = Buffer.alloc(length); fs.readSync(fd, part, 0, length, position);
      const newline = part.lastIndexOf(10);
      if (newline !== -1) { parts.unshift(part.subarray(newline + 1)); position += newline + 1; break; }
      parts.unshift(part);
    }
    start = position; tail = Buffer.concat(parts);
  } finally { fs.closeSync(fd); }
  let complete = false;
  try { JSON.parse(tail.toString('utf8')); complete = true; } catch {}
  if (!complete) {
    const recovery = {
      version: 1, kind: 'torn-tail', offset: start, length: tail.length,
      sha256: crypto.createHash('sha256').update(tail).digest('hex'),
      bytesBase64: tail.toString('base64'), recordedAt: new Date().toISOString(),
    };
    // A recovery sidecar may itself have a torn tail; a leading newline keeps
    // its next complete receipt separate without altering any original bytes.
    appendBytes(`${filePath}.recovery.jsonl`, Buffer.from(`\n${JSON.stringify(recovery)}\n`));
  }
  appendBytes(filePath, Buffer.from('\n'));
}

export function appendPrivateJsonLine(filePath, value) {
  repairJsonlTail(filePath);
  appendBytes(filePath, Buffer.from(`${JSON.stringify(value)}\n`));
}

export function readRecoverableJsonLines(filePath) {
  repairJsonlTail(filePath);
  if (!fs.existsSync(filePath)) return [];
  const recovered = new Map();
  if (fs.existsSync(`${filePath}.recovery.jsonl`)) {
    for (const line of fs.readFileSync(`${filePath}.recovery.jsonl`, 'utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r.kind === 'torn-tail') recovered.set(Number(r.offset), r);
      } catch { /* Only complete, exact recovery receipts authorize a skipped line. */ }
    }
  }
  const contents = fs.readFileSync(filePath); const result = []; let start = 0;
  while (start < contents.length) {
    const end = contents.indexOf(10, start);
    if (end < 0) throw new Error(`JSONL append boundary missing: ${filePath}`);
    const bytes = contents.subarray(start, end);
    if (bytes.toString('utf8').trim()) {
      try { result.push(JSON.parse(bytes.toString('utf8'))); }
      catch {
        const r = recovered.get(start);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (!r || r.length !== bytes.length || r.sha256 !== hash) {
          throw new Error(`JSONL corruption at byte ${start}: ${filePath}; original bytes preserved`);
        }
      }
    }
    start = end + 1;
  }
  return result;
}
