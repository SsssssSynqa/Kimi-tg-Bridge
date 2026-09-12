import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { writePrivateJson } from './durable-files.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { KimiTurnLedger, pendingTurnError } from './kimi-turn-ledger.mjs';
import { loadVisionConfig, transcribeImages } from './vision-transcribe.mjs';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// File relay: Skald writes sensitive content to a file via the Write tool
// (which bypasses Kimi's Safety text-stream filter), then outputs a marker
// like [SKALD:FILE]/tmp/skald-relay/reply.md[/SKALD:FILE] in his text.
// The bridge replaces the marker with the file's content before sending to TG.
const RELAY_DIR = '/tmp/skald-relay';
const FILE_RELAY_RE = /\[SKALD:FILE\](.+?)\[\/SKALD:FILE\]/g;

// The directory must exist before Skald's Write tool targets it, and /tmp is
// cleared on reboot — ensure it before running the model and when resolving
// a marker. Importing this module must not mutate the real runtime directory.
function ensureRelayDir(log = () => {}, directory = RELAY_DIR) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    log(`file relay: cannot create ${directory}: ${error.message}`);
  }
}


function relayPathIsSafe(resolved, log, directory = RELAY_DIR) {
  const relative = path.relative(directory, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    log(`file relay rejected: ${resolved} is outside ${directory}`);
    return false;
  }
  // A lexical prefix check is not enough: a model-created symlink below the
  // relay directory can still point at an arbitrary readable file. Reject a
  // symlink at every path component before opening the final regular file.
  let cursor = directory;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      log(`file relay rejected: symlink component ${cursor}`);
      return false;
    }
  }
  return true;
}

function substituteMarkers(text, log, options = {}) {
  return text.replace(FILE_RELAY_RE, (match, rawPath) => {
    const filePath = rawPath.trim();
    const resolved = path.resolve(filePath);
    try {
      if (!relayPathIsSafe(resolved, log, options.relayDir)) return match;
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(resolved, flags);
      let content;
      try {
        if (!fs.fstatSync(fd).isFile()) {
          log(`file relay rejected: ${resolved} is not a regular file`);
          return match;
        }
        content = fs.readFileSync(fd, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      log(`file relay: read ${content.length} chars from ${resolved}`);
      if (options.consume !== false) { try { fs.unlinkSync(resolved); } catch {} }
      options.onRead?.(resolved);
      return content;
    } catch (error) {
      log(`file relay: failed to read ${resolved}: ${error.message}`);
      return match;
    }
  });
}

// Group turns answer with a JSON envelope ({"replies":[{"text":...}]}), private
// turns answer with plain text. Substituting file content straight into the raw
// string breaks the group case: the file's newlines and quotes land inside a
// JSON string literal and burst the structure, so parseBatchReplies() silently
// returns [] — the reply never reaches Telegram, and the relay file is already
// deleted by then. So decode the envelope first and substitute into the parsed
// values, where any byte is safe.
function substituteInJsonValues(value, log, options) {
  if (typeof value === 'string') return substituteMarkers(value, log, options);
  if (Array.isArray(value)) return value.map((item) => substituteInJsonValues(item, log, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteInJsonValues(item, log, options)]),
    );
  }
  return value;
}

// Mirrors parseBatchReplies()'s unwrapping so a fenced or prose-wrapped envelope
// is still recognised as JSON rather than falling through to raw substitution.
function parseJsonEnvelope(text) {
  const unwrapped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const parsed = JSON.parse(unwrapped.slice(firstBrace, lastBrace + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function resolveFileRelay(text, log = () => {}, options = {}) {
  if (!text || !text.includes('[SKALD:FILE]')) return text;
  ensureRelayDir(log, options.relayDir);

  const envelope = parseJsonEnvelope(text);
  if (envelope) {
    return JSON.stringify(substituteInJsonValues(envelope, log, options));
  }

  return substituteMarkers(text, log, options);
}

// Only retry Enter for the exact marker still visible in the composer.
// Never re-paste a request whose acceptance is unknown.
const MAX_ENTER_RETRIES = 3;

// KimiCliClient drives the Kimi Code CLI in headless prompt mode. Unlike the
// Codex app-server there is no persistent child process: every turn spawns
// `kimi [--session <id>] -p <prompt> --output-format stream-json` and reads
// two kinds of JSONL lines from stdout:
//   {"role":"assistant","content":"..."}                       -> reply text
//   {"role":"meta","type":"session.resume_hint","session_id"}  -> session anchor
// Verified on kimi 0.32.0 (2026-08-05): the session id is stable across
// resumed turns, and resuming a missing session exits 1 with
// `Session "<id>" not found.` on stderr — that exact contract is what the
// fail-closed detection below keys on.
export class KimiCliClient {
  constructor({
    kimiPath = 'kimi',
    workdir,
    threadId = null,
    model = '',
    timeoutMs = 600000,
    vision = null,
    nativeVision = false,
    engine = 'spawn',
    tmuxSession = 'skald-tg',
    tmuxBin = '/usr/local/bin/tmux',
    turnStateDir = null,
    relayDir = RELAY_DIR,
    onReady,
    onThreadChange,
    onSecurityEvent,
    // Forwards a tool-approval request to Synqa and resolves 'accept'/'decline'.
    // Without it a TUI turn that needs approval hangs on a dialog only visible
    // in the terminal — she waits for a reply, he waits for a keypress.
    requestUserApproval = null,
    // Kimi's cache-expiry dialog is also invisible from Telegram. Synqa chose
    // to preserve the full context automatically; this callback makes that
    // choice visible without coupling the TUI driver to Telegram transport.
    onCacheHintContinue = null,
    log = () => {},
  } = {}) {
    this.kimiPath = kimiPath;
    this.relayDir = relayDir;
    this.workdir = workdir;
    this.threadId = threadId || null;
    this.model = String(model || '').trim();
    this.timeoutMs = timeoutMs;
    // engine 'tui': turns are injected into a persistent interactive kimi TUI
    // living in a tmux session (the visible-body architecture of the sylux
    // bridge). Synqa attaches to that tmux and sees Skald's real interface —
    // thinking, tool calls, everything. Replies are captured from the
    // session's wire.jsonl. engine 'spawn': headless one-process-per-turn.
    this.engine = engine === 'tui' ? 'tui' : 'spawn';
    this.tmuxSession = tmuxSession;
    this.tmuxBin = tmuxBin;
    this.wirePathCache = { threadId: null, path: null };
    // nativeVision: the backend model accepts images itself, so the archived
    // original is handed over as a path for its own media-reading tool. Without
    // it a vision model transcribes the image into text (Syrah bridge recipe),
    // and with neither there are no eyes at all — degrade honestly, never guess.
    this.nativeVision = nativeVision === true;
    this.vision = this.nativeVision ? null : loadVisionConfig(vision);
    if (vision && !this.nativeVision && !this.vision) log('vision config present but unusable (missing model/baseUrl/apiKey) — images will be archived without transcription');
    this.onReady = onReady;
    this.onThreadChange = onThreadChange;
    this.onSecurityEvent = onSecurityEvent;
    this.requestUserApproval = typeof requestUserApproval === 'function' ? requestUserApproval : null;
    this.onCacheHintContinue = typeof onCacheHintContinue === 'function' ? onCacheHintContinue : null;
    this.log = log;
    this.closing = false;
    this.activeChild = null;
    // Serialises turns even though the bridge's modelQueue already does:
    // two concurrent resumes of the same kimi session are undefined behaviour.
    this.turnChain = Promise.resolve();
    // Set when the locked session failed to resume. Only /new or /resume
    // clears it — never a silent replacement session.
    this.resumeBlocked = null;
    this.readOnlyGuardPath = path.join(this.workdir, '.state', 'group-readonly.json');
    this.turnLedger = new KimiTurnLedger(turnStateDir || path.join(this.workdir, '.state', 'kimi-turns'));
    this.lastTurnRecord = null;
    const pendingTurns = this.turnLedger.pending();
    for (const pending of pendingTurns) {
      if (pending.toolMode === 'read-only') this.writeReadOnlyGuard(pending);
    }

    if (this.threadId) {
      // Kimi has no cheap "validate session" call; the persisted id is
      // adopted as locked and the first real turn is the true validation.
      this.log(`Kimi client locked to persisted session ${this.threadId} (validated on first turn)`);
      if (this.onReady) this.onReady(this.threadId);
      if (this.engine === 'tui' && pendingTurns.length === 0) {
        // No auto-start while a prior submit is unresolved. Bring the visible TUI up right away so attaching works before the
        // first TG message arrives. Failures surface on the first turn.
        this.ensureTui(this.threadId).catch((error) => this.log(`TUI pre-start failed: ${error.message}`));
      }
    } else {
      this.log('Kimi client ready; a session will be created on the first turn');
    }
  }

  buildArgs(prompt, sessionId) {
    const args = [];
    if (sessionId) args.push('--session', sessionId);
    if (this.model) args.push('-m', this.model);
    args.push('-p', prompt, '--output-format', 'stream-json');
    return args;
  }

  runKimi(prompt, sessionId) {
    ensureRelayDir(this.log, this.relayDir);
    return new Promise((resolve, reject) => {
      const child = spawn(this.kimiPath, this.buildArgs(prompt, sessionId), {
        cwd: this.workdir,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeChild = child;

      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = null;
        fn(value);
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        settle(reject, new Error(`Kimi response timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => settle(reject, error));
      child.on('close', (code) => settle(resolve, { code, stdout, stderr }));
    });
  }

  parseStream(stdout) {
    let text = '';
    let sessionId = null;
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue; // progress noise is not part of the contract
      }
      if (message.role === 'assistant' && message.content) {
        text += (text ? '\n' : '') + String(message.content);
      }
      if (message.role === 'meta' && message.type === 'session.resume_hint' && message.session_id) {
        sessionId = String(message.session_id);
      }
    }
    return { text: text.trim(), sessionId };
  }

  isSessionNotFound(stderr) {
    return /Session "[^"]+" not found/.test(String(stderr || ''));
  }

  failClosed(previousThreadId, error) {
    this.resumeBlocked = error;
    this.log(`Kimi session could not be resumed; failing closed on ${previousThreadId}`);
    if (this.onSecurityEvent) {
      try {
        this.onSecurityEvent({
          kind: 'thread-resume-blocked',
          decision: 'fail-closed',
          params: { threadId: previousThreadId, error: error.message },
        });
      } catch {}
    }
    if (this.onThreadChange) {
      try {
        this.onThreadChange({
          previousThreadId,
          reason: 'resume-failed',
          blocked: true,
          error: error.message,
        });
      } catch {}
    }
  }

  // Matches CodexAppClient.ask(): resolves to { reply, threadId } or throws.
  // `images` arrive as bridge attachment records ({ path, mimeType, ... });
  // kimi -p cannot attach media, so their on-disk paths are appended to the
  // prompt for the agent to open with its own tools.
  async ask(text, images = [], options = {}) {
    const run = this.turnChain.then(() => this.askNow(text, images, options));
    // Keep the chain alive after failures.
    this.turnChain = run.catch(() => {});
    return run;
  }

  // `allowEmpty`: the caller treats an empty turn as a legitimate outcome
  // rather than a failure. Group turns set it — staying silent is the
  // mention-only contract, not a broken generation.
  async askNow(text, images = [], options = {}) {
    if (this.closing) throw new Error('Kimi client is closing');
    if (this.resumeBlocked) {
      throw new Error(
        `Kimi session ${this.threadId} could not be resumed; the bridge failed closed. `
        + 'Use /new or /resume <session-id> to decide explicitly.',
      );
    }

    let prompt = String(text || '');
    const attachmentPaths = (images || []).map((image) => image?.path).filter(Boolean);
    if (attachmentPaths.length) {
      let visionNote;
      if (this.nativeVision) {
        // No transcriber in the way: the model has image input, so it opens the
        // file itself. This holds in groups too, where a text-only summary used
        // to be the only thing that ever reached him.
        visionNote = `（收到 ${attachmentPaths.length} 张图。你的模型支持图像输入：用 ReadMediaFile 工具打开下面的原图路径亲眼看，再回应。工具失败就如实说看不见，不要编造画面内容）`;
      } else if (this.vision) {
        try {
          const description = await transcribeImages(images, this.vision, { log: this.log });
          visionNote = `【图片视觉转写·${this.vision.model}】\n${description}`;
        } catch (error) {
          // Honest degradation (Skald's own clause): report the failure, never
          // fabricate a description, never drop the turn because of it.
          this.log(`vision transcribe failed: ${error.message}`);
          visionNote = `（收到 ${attachmentPaths.length} 张图，视觉转写失败：${String(error.message).slice(0, 120)}；请如实说明看不见，不要编造画面内容）`;
        }
      } else {
        visionNote = `（收到 ${attachmentPaths.length} 张图，桥未配置视觉转写；请如实说明看不见，不要编造画面内容）`;
      }
      prompt += `\n${visionNote}\n原图已存档：\n${attachmentPaths.join('\n')}`;
    }

    const lockedSession = this.threadId;

    // TUI engine: with a locked session the turn goes through the visible
    // interactive TUI. A brand-new session (no id yet) still bootstraps via
    // one headless spawn — the TUI needs an id to resume.
    if (this.engine === 'tui' && lockedSession) {
      const rawReply = await this.runTuiTurn(prompt, lockedSession, options);
      const record = this.lastTurnRecord;
      const readPaths = [];
      const reply = record?.reply ?? resolveFileRelay(rawReply, this.log, {
        relayDir: this.relayDir, consume: false, onRead: (filePath) => readPaths.push(filePath),
      });
      // Resolve relay contents durably before cleanup. A restart between file
      // read and inbox completion must not lose the only sendable reply.
      if (record && record.reply === undefined) this.lastTurnRecord = this.turnLedger.save(record, { reply });
      for (const filePath of readPaths) { try { fs.unlinkSync(filePath); } catch {} }
      if (!reply && !options.allowEmpty) throw new Error('Kimi produced no sendable text');
      return { reply, threadId: record?.sessionId || this.threadId };
    }

    const { code, stdout, stderr } = await this.withToolMode(
      options.toolMode,
      () => this.runKimi(prompt, lockedSession),
    );

    if (code !== 0) {
      if (lockedSession && this.isSessionNotFound(stderr)) {
        const error = new Error(
          `Kimi session ${lockedSession} was not found; the bridge failed closed and did not `
          + 'create a replacement session. Use /new or /resume <session-id> to recover.',
        );
        this.failClosed(lockedSession, error);
        throw error;
      }
      throw new Error(`Kimi exited with code ${code}: ${String(stderr || '').trim().slice(-300)}`);
    }

    const { text: rawReply, sessionId } = this.parseStream(stdout);
    if (!sessionId) throw new Error('Kimi stream-json output had no session.resume_hint');
    if (sessionId !== this.threadId) {
      this.threadId = sessionId;
      if (this.onReady) this.onReady(sessionId);
    }
    const reply = resolveFileRelay(rawReply, this.log, { relayDir: this.relayDir });
    if (!reply && !options.allowEmpty) throw new Error('Kimi produced no sendable text');
    if (this.engine === 'tui') {
      try { await this.ensureTui(this.threadId); } catch (error) { this.log(`TUI start deferred: ${error.message}`); }
    }
    return { reply, threadId: this.threadId };
  }

  // ------------------------------------------------------------------
  // TUI engine internals
  // ------------------------------------------------------------------

  writeReadOnlyGuard(turnRecord = null) {
    const nonce = turnRecord?.marker || crypto.randomUUID();
    const guard = {
      version: 1,
      mode: 'group-read-only',
      nonce,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + this.timeoutMs + 60_000,
      ...(turnRecord ? {
        version: 2, turnKey: turnRecord.requestId,
        receiptPath: this.turnLedger.filePath(turnRecord.requestId),
      } : {}),
    };
    writePrivateJson(this.readOnlyGuardPath, guard);
    return nonce;
  }

  clearReadOnlyGuard(nonce) {
    try {
      const current = JSON.parse(fs.readFileSync(this.readOnlyGuardPath, 'utf8'));
      if (current?.nonce === nonce) fs.unlinkSync(this.readOnlyGuardPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`read-only guard cleanup failed: ${error.message}`);
    }
  }

  async withToolMode(toolMode, operation, { turnRecord = null } = {}) {
    if (toolMode !== 'read-only') return operation();
    const nonce = this.writeReadOnlyGuard(turnRecord);
    try {
      return await operation();
    } finally {
      const current = turnRecord ? this.turnLedger.read(turnRecord.requestId) : null;
      if (!turnRecord || ['prepared', 'completed'].includes(current?.state)) this.clearReadOnlyGuard(nonce);
      // A persistent TUI can outlive this observer. Its active guard deliberately
      // survives timeout/crash until the same recorded turn.ended is observed.
    }
  }

  tmux(args, input = null) {
    return execFileSync(this.tmuxBin, args, {
      encoding: 'utf8',
      ...(input !== null ? { input } : {}),
    });
  }

  tuiAlive() {
    try {
      this.tmux(['has-session', '-t', this.tmuxSession]);
      return true;
    } catch {
      return false;
    }
  }

  sessionDirOnDisk(sessionId) {
    const sessionsRoot = path.join(os.homedir(), '.kimi-code', 'sessions');
    try {
      for (const entry of fs.readdirSync(sessionsRoot)) {
        const candidate = path.join(sessionsRoot, entry, sessionId);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
    return null;
  }

  wirePath(sessionId) {
    if (this.wirePathCache.threadId === sessionId && this.wirePathCache.path) return this.wirePathCache.path;
    // session_index.jsonl is what kimi itself resolves a --session id through,
    // so it is the authority on WHICH copy of a session is live (a directory
    // sweep can land on a stale duplicate and watch the wrong wire forever).
    let dir = null;
    try {
      const index = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'session_index.jsonl'), 'utf8');
      for (const line of index.split('\n')) {
        if (!line.includes(sessionId)) continue;
        try {
          const record = JSON.parse(line);
          if (record.sessionId === sessionId && record.sessionDir) dir = record.sessionDir;
        } catch {}
      }
    } catch {}
    if (!dir || !fs.existsSync(dir)) dir = this.sessionDirOnDisk(sessionId);
    if (!dir) return null;
    const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
    this.wirePathCache = { threadId: sessionId, path: wire };
    return wire;
  }

  capturePane() {
    try {
      return this.tmux(['capture-pane', '-t', this.tmuxSession, '-p']);
    } catch {
      return '';
    }
  }

  // The composer row renders as `│ > typed text   │`; empty means idle input.
  composerIsEmpty(pane = this.capturePane()) {
    const lines = pane.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = lines[i].match(/│\s*>\s?(.*)│\s*$/);
      if (match) return match[1].trim() === '';
    }
    // No composer found (alt screen redraw edge) — do not block the turn.
    return true;
  }

  // Kimi 0.38 replaces the editor with this dialog after a long-idle, 200k+
  // session receives its next submit. Looking only for an empty composer is
  // unsafe: the replacement has no composer, which used to make the bridge
  // re-paste and press Enter on the default `Compact and continue` option.
  cacheExpiryHintIsOpen(pane = this.capturePane()) {
    const normalized = String(pane || '').replace(/\s+/g, ' ');
    const anchors = [
      'This session has been idle for ',
      'Compact and continue',
      'Start a new session',
      'Continue as-is',
      "Don't ask me again",
    ];
    let cursor = -1;
    return anchors.every((anchor) => {
      cursor = normalized.indexOf(anchor, cursor + 1);
      return cursor >= 0;
    });
  }

  notifyCacheHintContinue(scene) {
    if (!this.onCacheHintContinue) return;
    try {
      Promise.resolve(this.onCacheHintContinue({
        scene,
        threadId: this.threadId,
      })).catch((error) => this.log(`cache-expiry notice failed: ${error.message}`));
    } catch (error) {
      this.log(`cache-expiry notice failed: ${error.message}`);
    }
  }

  // `Continue as-is` is the third item and Kimi initialises every fresh cache
  // hint at item zero. Select it explicitly, then wait until the dialog has
  // actually disappeared before allowing any paste or retry key through.
  async continueCacheExpiryHintIfPresent(scene) {
    if (!this.cacheExpiryHintIsOpen()) return false;
    this.log(`Kimi cache-expiry hint detected (${scene}); selecting Continue as-is`);
    this.tmux(['send-keys', '-t', this.tmuxSession, 'Down']);
    this.tmux(['send-keys', '-t', this.tmuxSession, 'Down']);
    await sleep(100);
    this.tmux(['send-keys', '-t', this.tmuxSession, 'Enter']);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!this.cacheExpiryHintIsOpen()) {
        this.notifyCacheHintContinue(scene);
        return true;
      }
    }
    throw new Error('Kimi cache-expiry hint stayed open after selecting Continue as-is');
  }

  // Translate a kimi approval request into the shape the bridge's Telegram
  // approval card already speaks (built for Codex), ask Synqa, then type her
  // answer into the TUI menu: 1 = approve once, 3 = reject. There is
  // deliberately no "approve for this session" — she asked for every request to
  // reach her, so every request costs one tap.
  async resolveApproval(record) {
    const request = record?.request || {};
    const display = request.display || {};
    const info = display.kind === 'file_io'
      ? {
          method: 'item/fileChange/requestApproval',
          reason: 'manual-confirmation-required',
          summary: { filePaths: [display.path].filter(Boolean) },
        }
      : {
          method: 'item/command/requestApproval',
          reason: 'manual-confirmation-required',
          summary: {
            command: display.command || request.action || '',
            cwd: display.cwd || this.workdir || '',
          },
        };

    let decision = 'decline';
    if (!this.requestUserApproval) {
      // Fail closed: with no way to ask her, refuse rather than let a tool call
      // through unreviewed — and say so, instead of hanging on the dialog.
      this.log(`approval requested (${request.toolName || '?'}) but no approval channel is wired; declining`);
    } else {
      try {
        decision = await this.requestUserApproval(info);
      } catch (error) {
        this.log(`approval forwarding failed (${error.message}); declining`);
        decision = 'decline';
      }
    }

    const key = decision === 'accept' ? '1' : '3';
    this.log(`approval ${request.toolName || '?'} -> ${decision} (typing ${key})`);
    this.tmux(['send-keys', '-t', this.tmuxSession, key]);
    await sleep(200);
    this.tmux(['send-keys', '-t', this.tmuxSession, 'Enter']);
    return decision;
  }

  // An empty composer does NOT mean the TUI is ready for input. While a turn is
  // running, kimi accepts pastes and parks them in a send queue, leaving the
  // composer visually empty. Re-injecting on that signal appends one more
  // queued item per retry — that is how a downstream fault buried Skald's pane
  // under 900 identical lines. The queue advertises itself with a steer hint.
  // 队列会用 steer 提示自报家门。但 pane 截图是启发式：提示可能滚出可视区，
  // 或被 cache 提示框盖住。turn 标记是每轮唯一的，若它已出现在 pane（含
  // 历史回滚区），那份 paste 就一定没丢——只是还没轮到。这是第二道保险。
  turnMarkerInPane(needle) {
    try {
      return this.tmux(['capture-pane', '-t', this.tmuxSession, '-p', '-S', '-']).includes(needle);
    } catch {
      return false;
    }
  }

  tuiHasQueuedInput(pane = this.capturePane()) {
    return /ctrl-s to steer/i.test(pane);
  }

  async ensureTui(sessionId) {
    if (this.tuiAlive()) { ensureRelayDir(this.log, this.relayDir); return; }
    const [pending] = this.turnLedger.pending();
    if (pending) throw pendingTurnError(pending, 'TUI is absent while a prior submit is unresolved; no auto-start');
    ensureRelayDir(this.log, this.relayDir);
    // Disk check first so a vanished session fails closed instead of leaving
    // a dead tmux and a confusing generic error.
    if (!this.sessionDirOnDisk(sessionId)) {
      const error = new Error(
        `Kimi session ${sessionId} is missing on disk; the bridge failed closed and did not `
        + 'create a replacement session. Use /new or /resume <session-id> to recover.',
      );
      this.failClosed(sessionId, error);
      throw error;
    }
    this.log(`starting kimi TUI in tmux session ${this.tmuxSession} (session ${sessionId})`);
    this.tmux([
      'new-session', '-d', '-s', this.tmuxSession, '-c', this.workdir,
      // -y/--yolo: auto-approve regular tool calls. The TUI defaults to an
      // interactive approval prompt per tool call, same as spawn mode without
      // it — but nobody is at this unattended tmux pane to press the key, so
      // any turn that touches a tool (which is most of them) hangs forever.
      // Confirmed live 2026-08-06: a Bash approval sat unresolved 5+ hours
      // and silently ate every queued Telegram message behind it.
      `${this.kimiPath} --session ${sessionId} --yolo`,
    ]);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (!this.tuiAlive()) {
        const error = new Error(`Kimi TUI exited right after start; session ${sessionId} may be unresumable`);
        this.failClosed(sessionId, error);
        throw error;
      }
      if (await this.continueCacheExpiryHintIfPresent('resume')) continue;
      if (/│\s*>/.test(this.capturePane())) {
        // The composer border renders before the TUI actually accepts input;
        // pasting immediately gets silently dropped. Give it a beat.
        await sleep(2000);
        return;
      }
      await sleep(500);
    }
    throw new Error('Kimi TUI did not become ready within 30s');
  }

  killTui() {
    try { this.tmux(['kill-session', '-t', this.tmuxSession]); } catch {}
  }

  parseWireLines(chunk, state) {
    state.carry += chunk;
    const lines = state.carry.split('\n');
    state.carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try { record = JSON.parse(trimmed); } catch { continue; }
      if (record.type === 'turn.prompt' && !state.matched) {
        const promptText = (record.input || [])
          .map((part) => (part?.type === 'text' ? part.text : ''))
          .join('');
        // 认标记本身，不要求它在开头：标记全局唯一，出现即是这一轮，
        // 而 startsWith 会被 TUI 对首行空白的任何规范化打破。
        if (promptText.includes(state.needle)) state.matched = true;
        continue;
      }
      // Only a matching turn.prompt establishes causal ownership. Text from an
      // unmatched turn may be a late reply to the previous Telegram update or
      // a terminal-authored turn; forwarding it as this update's reply is a
      // worse failure than a bounded retry because it attributes words to the
      // wrong message.
      if (!state.matched) continue;
      // A tool-approval dialog: the turn is now blocked on a keypress that only
      // exists inside tmux. Hand it to the caller loop, which forwards it to
      // Telegram and types the answer back in.
      if (record.type === 'interaction.request' && record.kind === 'approval' && !state.pendingApproval) {
        state.pendingApproval = record;
      }
      const event = record.type === 'context.append_loop_event' ? record.event : null;
      if (event?.type === 'content.part' && event.part?.type === 'text' && event.part.text) {
        state.text += event.part.text;
      }
      // `turn.ended` is the only true end-of-turn marker. `usage.record` is
      // emitted per LLM call — it lands BEFORE the assistant text of that same
      // call (and several times in a tool-using turn), so treating it as the
      // finish line returned an empty reply while the real text was one line
      // away. That is what surfaced as "produced no sendable text".
      if (record.type === 'turn.ended') {
        state.done = true;
        return;
      }
    }
  }

  recordedWireState(record) {
    const state = { carry: '', needle: record.marker, matched: false, text: '', done: false, pendingApproval: null };
    if (!record.wirePath || !fs.existsSync(record.wirePath)) return state;
    const fd = fs.openSync(record.wirePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size < record.wireOffset) throw pendingTurnError(record, 'wire shrank; acceptance cannot be disproved');
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.alloc(64 * 1024); let offset = record.wireOffset;
      while (offset < size && !state.done) {
        const length = Math.min(buffer.length, size - offset);
        const read = fs.readSync(fd, buffer, 0, length, offset);
        if (read <= 0) break;
        offset += read;
        this.parseWireLines(decoder.write(buffer.subarray(0, read)), state);
      }
    } finally { fs.closeSync(fd); }
    return state;
  }

  captureCompletedTurn(record, rawReply) {
    const completed = this.turnLedger.read(record.requestId);
    if (completed?.state === 'completed') return completed;
    const readPaths = [];
    const reply = resolveFileRelay(rawReply, this.log, {
      relayDir: this.relayDir, consume: false, onRead: (filePath) => readPaths.push(filePath),
    });
    // Include resolved relay text in the same durable terminal receipt before
    // freeing the queue. A later model turn may reuse the same relay filename.
    const saved = this.turnLedger.save(record, {
      state: 'completed', rawReply, reply, completedAt: new Date().toISOString(),
    });
    for (const filePath of readPaths) { try { fs.unlinkSync(filePath); } catch {} }
    return saved;
  }

  reconcilePendingTurns(exceptRequestId = null) {
    for (const record of this.turnLedger.pending()) {
      if (record.toolMode === 'read-only') this.writeReadOnlyGuard(record);
      if (record.requestId === exceptRequestId) continue;
      const state = this.recordedWireState(record);
      if (!state.done) throw pendingTurnError(record, 'a prior accepted/submitted turn is still unresolved');
      this.captureCompletedTurn(record, state.text.trim());
      this.clearReadOnlyGuard(record.marker);
    }
  }

  async runTuiTurn(promptBody, sessionId, options = {}) {
    const requestId = String(options.requestId || `terminal-operation:${crypto.randomUUID()}`);
    this.reconcilePendingTurns(requestId);
    let record = this.turnLedger.read(requestId);
    if (record?.state === 'completed') {
      this.lastTurnRecord = record;
      this.clearReadOnlyGuard(record.marker);
      return record.rawReply || '';
    }
    if (!record) {
      // Failures before a submit intent are safe to retry: no text was injected.
      await this.ensureTui(sessionId);
      const wire = this.wirePath(sessionId);
      if (!wire || !fs.existsSync(wire)) throw new Error('Kimi session wire.jsonl not found; cannot capture the reply');
      record = this.turnLedger.prepare({ requestId, sessionId, prompt: promptBody,
        toolMode: options.toolMode, wirePath: wire, wireOffset: fs.statSync(wire).size });
    }
    const prompt = `${record.marker}\n${promptBody}`;
    return this.withToolMode(record.toolMode, async () => {
      if (record.state === 'prepared') {
        if (record.sessionId !== sessionId) throw new Error('A prepared Kimi request belongs to a different session; not submitted');
        await this.ensureTui(sessionId);
        const composerDeadline = Date.now() + 20000;
        while (Date.now() < composerDeadline) {
          if (await this.continueCacheExpiryHintIfPresent('pre-submit')) continue;
          const pane = this.capturePane();
          if (this.composerIsEmpty(pane) && !this.tuiHasQueuedInput(pane)) break;
          await sleep(500);
        }
        const pane = this.capturePane();
        if (this.tuiHasQueuedInput(pane)) throw new Error('Kimi TUI still has queued input after 20s; no submit was attempted');
        if (!this.composerIsEmpty(pane)) throw new Error('Kimi TUI composer still contains terminal input after 20s; no submit was attempted');
        // Persist the irreversible boundary BEFORE either paste or Enter.
        // If we crash after this fsync, only observation of this marker is safe.
        this.tmux(['load-buffer', '-b', 'skald-bridge-turn', '-'], prompt);
        record = this.turnLedger.save(record, { state: 'submitted', submittedAt: new Date().toISOString() });
        try {
          this.tmux(['paste-buffer', '-b', 'skald-bridge-turn', '-t', this.tmuxSession, '-p', '-d']);
          await sleep(800);
          // 2026-09-13：Kimi 0.42.0 在一次多行粘贴后会弹一个小提示层，裸 Enter 被它吃掉、
          // 提示原样留在输入框（09-12 07:27 Mac、09-13 01:07 LA 各卡一次，都是人工 Escape+Enter 才提交）。
          // 此刻没有流式输出（前面已等到 composer 为空），Escape 只会关弹层，不会打断任何回合。
          this.tmux(['send-keys', '-t', this.tmuxSession, 'Escape']);
          await sleep(150);
          this.tmux(['send-keys', '-t', this.tmuxSession, 'Enter']);
        } catch (error) {
          record = this.turnLedger.save(record, { state: 'outcome-unknown', lastError: String(error.message || error).slice(0, 500) });
          throw pendingTurnError(record, 'submit transport failed after durable intent');
        }
      }

      const state = { carry: '', needle: record.marker, matched: false, text: '', done: false, pendingApproval: null };
      const decoder = new StringDecoder('utf8');
      let offset = record.wireOffset;
      let deadline = Date.now() + this.timeoutMs;
      let lastRetry = Date.now(); let retries = 0;
      try {
        while (Date.now() < deadline) {
          await sleep(500);
          let stat;
          try { stat = fs.statSync(record.wirePath); } catch { continue; }
          if (stat.size < offset) throw pendingTurnError(record, 'wire shrank');
          if (stat.size > offset) {
            const fd = fs.openSync(record.wirePath, 'r');
            try {
              const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
              while (offset < stat.size && !state.done) {
                const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
                if (read <= 0) break;
                offset += read;
                this.parseWireLines(decoder.write(buffer.subarray(0, read)), state);
              }
            } finally { fs.closeSync(fd); }
          }
          if (state.done) {
            record = this.captureCompletedTurn(record, state.text.trim());
            this.lastTurnRecord = record;
            return record.rawReply;
          }
          if (state.matched && record.state !== 'accepted') record = this.turnLedger.save(record, { state: 'accepted' });
          if (!state.matched && await this.continueCacheExpiryHintIfPresent('submit')) { lastRetry = Date.now(); continue; }
          if (state.pendingApproval) {
            const request = state.pendingApproval; state.pendingApproval = null;
            const waitedFrom = Date.now(); await this.resolveApproval(request);
            deadline += Date.now() - waitedFrom; lastRetry = Date.now(); continue;
          }
          // Retry Enter only when this exact marker is waiting in the composer. An absent
          // wire event is never proof a paste was dropped. 2026-09-13：长批次会把 marker
          // 卷出输入框可见区（显示「↑ N more」），原来的可见性判据永远不满足、补 Enter 永远
          // 不触发——marker 在可见区 **或** 输入框正折叠着更多行，都算「这一轮还在等提交」。
          // 只有本桥往这个 TUI 里打字，输入框非空又不是本轮的情况不存在于正常路径。
          if (!state.matched && Date.now() - lastRetry > 5000 && retries < MAX_ENTER_RETRIES) {
            lastRetry = Date.now(); retries += 1;
            const currentPane = this.capturePane();
            const composerHoldsThisTurn = currentPane.includes(record.marker) || /↑\s*\d+\s*more/.test(currentPane);
            if (!this.composerIsEmpty(currentPane) && composerHoldsThisTurn) {
              this.tmux(['send-keys', '-t', this.tmuxSession, 'Escape']);
              await sleep(150);
              this.tmux(['send-keys', '-t', this.tmuxSession, 'Enter']);
            }
          }
          if (!this.tuiAlive()) throw pendingTurnError(record, 'TUI died before a matching turn.ended');
        }
        throw pendingTurnError(record, `observer timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      } catch (error) {
        if (record.state !== 'completed') {
          record = this.turnLedger.save(record, { state: 'outcome-unknown', lastError: String(error.message || error).slice(0, 500) });
        }
        if (error.code === 'KIMI_OUTCOME_UNKNOWN') throw error;
        throw pendingTurnError(record, error.message || 'observer failure');
      }
    }, { turnRecord: record });
  }

  // /new: kimi only materialises a session by running a turn, so a fresh
  // session starts with one explicit bootstrap line. The turn is visible in
  // the session history on purpose — the agent should know how it began.
  async newThread() {
    const run = this.turnChain.then(async () => {
      this.reconcilePendingTurns();
      const { code, stdout, stderr } = await this.runKimi(
        '（Telegram 桥 /new：新会话从这里开始。）',
        null,
      );
      if (code !== 0) {
        throw new Error(`Kimi could not start a new session (exit ${code}): ${String(stderr || '').trim().slice(-300)}`);
      }
      const { sessionId } = this.parseStream(stdout);
      if (!sessionId) throw new Error('Kimi did not report a session id for the new session');
      this.threadId = sessionId;
      this.resumeBlocked = null;
      if (this.onReady) this.onReady(sessionId);
      if (this.engine === 'tui') {
        this.killTui();
        try { await this.ensureTui(sessionId); } catch (error) { this.log(`TUI restart after /new failed: ${error.message}`); }
      }
      return sessionId;
    });
    this.turnChain = run.catch(() => {});
    return run;
  }

  // /resume <id>: adopt an existing session. Kimi cannot validate a session
  // without spending a turn, so this checks the session store on disk
  // (read-only — the files themselves are never touched) and lets the next
  // real turn be the full validation; a broken id still fails closed there.
  async resumeThread(threadId) {
    const target = String(threadId || '').trim();
    if (!target) throw new Error('resumeThread needs a session id');
    this.reconcilePendingTurns();
    const sessionsRoot = path.join(os.homedir(), '.kimi-code', 'sessions');
    let found = false;
    try {
      for (const workdirEntry of fs.readdirSync(sessionsRoot)) {
        if (fs.existsSync(path.join(sessionsRoot, workdirEntry, target))) {
          found = true;
          break;
        }
      }
    } catch (error) {
      throw new Error(`Kimi session store is unreadable: ${error.message}`);
    }
    if (!found) throw new Error(`Kimi session not found on disk: ${target}`);
    this.threadId = target;
    this.resumeBlocked = null;
    this.wirePathCache = { threadId: null, path: null };
    if (this.onReady) this.onReady(target);
    if (this.engine === 'tui') {
      this.killTui();
      try { await this.ensureTui(target); } catch (error) { this.log(`TUI restart after /resume failed: ${error.message}`); }
    }
    return target;
  }

  close() {
    this.closing = true;
    try {
      this.activeChild?.kill('SIGTERM');
    } catch {
      // Process may already be gone.
    }
  }
}
