// Telegram 相册聚合（2026-08-30）
//
// 病象：她在 Telegram 里一次选中三张图发出来，机器回了三条——一张图一条。
// 这不是模型的问题，是 Telegram 的投递方式：一个"相册"在 Bot API 里**不是**
// 一条消息，而是 N 条各带一张图的独立 update，彼此只靠同一个 `media_group_id`
// 关联。桥如果收到一条就投喂一轮，自然就是一图一答。
//
// 官方没有"这个相册总共几张"的字段，也没有结束标志。业界通行做法只有一条：
// 按 media_group_id 攒一个很短的静默窗口，窗口内不再有同组新消息就当收齐。
//
// 这里刻意**不阻塞轮询、也不推迟落盘**：
//   - 每条 update 仍然照旧独立 fsync 进 durable inbox（崩溃安全不受影响）；
//   - 合并只发生在 dispatch 阶段——窗口没到就跳过本轮，挂一个定时器到点再来，
//     而不是 sleep 在收消息的那条路上。
// 崩溃重启后 firstSeen 是空的，重放的那批会重新等一个窗口再合并，最多多等 1 秒。

export const DEFAULT_ALBUM_WINDOW_MS = 1200;

function albumIdOf(update) {
  const message = update?.message;
  if (!message) return null;
  const id = message.media_group_id;
  return id === undefined || id === null || id === '' ? null : String(id);
}

function albumKeyOf(update, albumId) {
  const message = update?.message;
  if (!message) return null;
  return JSON.stringify([
    String(message.chat?.id ?? ''),
    String(message.message_thread_id ?? ''),
    String(albumId),
  ]);
}

/** 同一相册必须同群、同话题；跨聊天的相同 id 不该被并到一起。 */
function sameConversation(a, b) {
  const ma = a?.message; const mb = b?.message;
  if (!ma || !mb) return false;
  if (String(ma.chat?.id) !== String(mb.chat?.id)) return false;
  return String(ma.message_thread_id ?? '') === String(mb.message_thread_id ?? '');
}

export function createAlbumBatcher({
  windowMs = DEFAULT_ALBUM_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  // (chat, thread, media_group_id) -> 最后一次发现新成员的时刻与成员集合。
  const albumStates = new Map();

  return {
    /**
     * 决定这条 update 现在该怎么处理。
     *   { action: 'single' }                    不是相册，照常单条处理
     *   { action: 'wait', waitMs, albumId }     是相册但窗口没到，本轮先跳过
     *   { action: 'merge', updates, albumId }   收齐了，这些 update 合成一个 turn
     * updates 按 update_id 升序，第一条是主 update（承载文本/回复关系）。
     */
    plan(update, pendingUpdates = []) {
      const albumId = albumIdOf(update);
      if (!albumId) return { action: 'single' };

      const at = now();
      const batchKey = albumKeyOf(update, albumId);
      const group = pendingUpdates
        .filter((candidate) => albumIdOf(candidate) === albumId && sameConversation(candidate, update))
        .sort((a, b) => Number(a.update_id) - Number(b.update_id));
      const updates = group.length ? group : [update];
      const memberIds = new Set(updates.map((candidate) => String(candidate.update_id)));
      let state = albumStates.get(batchKey);
      if (!state) {
        state = { lastSeen: at, memberIds };
        albumStates.set(batchKey, state);
      } else {
        const hasNewMember = [...memberIds].some((id) => !state.memberIds.has(id));
        if (hasNewMember) state.lastSeen = at;
        for (const id of memberIds) state.memberIds.add(id);
      }
      const elapsed = at - state.lastSeen;
      if (elapsed < windowMs) {
        return { action: 'wait', waitMs: windowMs - elapsed, albumId, batchKey };
      }

      return { action: 'merge', updates, albumId, batchKey };
    },

    /** 一个相册处理完就忘掉它，避免内存状态无限增长。 */
    forget(batchKey) {
      if (batchKey) albumStates.delete(batchKey);
    },

    /** 仅供测试与排障。 */
    size() {
      return albumStates.size;
    },
  };
}
