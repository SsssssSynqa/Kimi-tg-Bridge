import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function insideDirectory(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function writeAtomicPrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  const fd = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function imageToken(messageId, image) {
  return `${Number(messageId)}:${String(image.sha256 || path.basename(image.path || 'image'))}`;
}

/**
 * Durable metadata queue for images seen in an allowed Telegram group while a
 * mention/quiet gate deliberately suppresses the immediate model turn.
 *
 * It stores only cache-local file references. Callers attach them to the next
 * ordinary group turn and acknowledge tokens only after that turn is delivered.
 */
export class PendingGroupImages {
  constructor({ filePath, imageRoot, maxEntriesPerChat = 50, log = () => {} }) {
    this.filePath = path.resolve(filePath);
    this.imageRoot = path.resolve(imageRoot);
    this.maxEntriesPerChat = Math.max(1, Number(maxEntriesPerChat) || 50);
    this.log = log;
    this.chats = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || typeof parsed.chats !== 'object') return;
      for (const [chatId, entries] of Object.entries(parsed.chats || {})) {
        if (!Array.isArray(entries)) continue;
        this.chats.set(String(chatId), entries.filter((entry) => (
          Number.isSafeInteger(Number(entry?.messageId)) && Array.isArray(entry?.images)
        )));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`pending group image state ignored: ${error.message}`);
    }
  }

  save() {
    writeAtomicPrivateJson(this.filePath, {
      schemaVersion: 1,
      chats: Object.fromEntries(this.chats.entries()),
    });
  }

  sanitizeImage(image) {
    const candidate = path.resolve(String(image?.path || ''));
    if (!image?.path || !insideDirectory(candidate, this.imageRoot) || !fs.existsSync(candidate)) return null;
    return {
      path: candidate,
      fileName: image.fileName || path.basename(candidate),
      mimeType: image.mimeType || 'application/octet-stream',
      fileSize: Number(image.fileSize || image.bytes || 0) || null,
      width: Number(image.width || 0) || null,
      height: Number(image.height || 0) || null,
      sha256: image.sha256 || null,
      source: image.source || 'telegram',
    };
  }

  record({ chatId, messageId, updateId = null, sentAt = null, images = [] }) {
    const normalizedImages = images.map((image) => this.sanitizeImage(image)).filter(Boolean);
    if (!normalizedImages.length) return [];
    const key = String(chatId);
    const id = Number(messageId);
    if (!key || !Number.isSafeInteger(id)) return [];
    const current = this.chats.get(key) || [];
    const existingTokens = new Set(current.flatMap((entry) => (
      entry.images.map((image) => imageToken(entry.messageId, image))
    )));
    const novel = normalizedImages.filter((image) => !existingTokens.has(imageToken(id, image)));
    if (!novel.length) return [];
    current.push({
      messageId: id,
      updateId: Number.isSafeInteger(Number(updateId)) ? Number(updateId) : null,
      sentAt,
      images: novel,
    });
    current.sort((left, right) => left.messageId - right.messageId);
    if (current.length > this.maxEntriesPerChat) {
      current.splice(0, current.length - this.maxEntriesPerChat);
    }
    this.chats.set(key, current);
    this.save();
    return novel.map((image) => imageToken(id, image));
  }

  pending(chatId, {
    throughMessageId = Number.POSITIVE_INFINITY,
    limit = Number.POSITIVE_INFINITY,
  } = {}) {
    if (Number(limit) <= 0) return { images: [], tokens: [] };
    const entries = (this.chats.get(String(chatId)) || [])
      .filter((entry) => Number(entry.messageId) <= Number(throughMessageId));
    const images = [];
    const tokens = [];
    const seen = new Set();
    for (const entry of entries) {
      for (const stored of entry.images || []) {
        const image = this.sanitizeImage(stored);
        if (!image) continue;
        const token = imageToken(entry.messageId, image);
        if (seen.has(token)) continue;
        seen.add(token);
        tokens.push(token);
        images.push(image);
        if (images.length >= Number(limit)) return { images, tokens };
      }
    }
    return { images, tokens };
  }

  consume(chatId, tokens = []) {
    const consumed = new Set(tokens.map(String));
    if (!consumed.size) return 0;
    const key = String(chatId);
    const current = this.chats.get(key) || [];
    let removed = 0;
    const next = [];
    for (const entry of current) {
      const images = (entry.images || []).filter((image) => {
        const drop = consumed.has(imageToken(entry.messageId, image));
        if (drop) removed += 1;
        return !drop;
      });
      if (images.length) next.push({ ...entry, images });
    }
    if (next.length) this.chats.set(key, next);
    else this.chats.delete(key);
    if (removed) this.save();
    return removed;
  }

  stats() {
    let images = 0;
    for (const entries of this.chats.values()) {
      for (const entry of entries) images += entry.images?.length || 0;
    }
    return { chats: this.chats.size, images };
  }
}
