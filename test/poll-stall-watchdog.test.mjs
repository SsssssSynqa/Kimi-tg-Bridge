import assert from 'node:assert/strict';
import test from 'node:test';

import { createPollStallWatchdog } from '../src/poll-stall-watchdog.mjs';

// Synqa's call (2026-08-15): 全家 TG 桥体检。Skald 在 14:26 报了一次
// "poll failed; retrying in 3s: The operation was aborted due to timeout"，
// 之后 30+ 分钟零日志、零网络流量、getUpdates 探测无反应 —— 进程活着但聋了。
// undici 的 keep-alive 连接池在 abort 之后会留下坏 socket，下一个 fetch
// 既不返回也不超时。launchd 的 KeepAlive 只认进程退出，对"活着但聋了"无效。
//
// 看门狗只盯 getUpdates 那一段。生成回复（askKimi 可以跑满 timeoutMs=10min）
// 走的是同一个 for 循环，轮询本来就停着 —— 那段绝不能被误杀。

// 手动时钟 + 手动 tick，避免测试依赖真实时间。
function makeHarness({ stallMs = 90000, checkMs = 15000 } = {}) {
  let now = 1000;
  const ticks = [];
  const stalls = [];
  const watchdog = createPollStallWatchdog({
    stallMs,
    checkMs,
    now: () => now,
    onStall: (stuckMs) => stalls.push(stuckMs),
    setIntervalFn: (fn, ms) => {
      ticks.push({ fn, ms });
      return { ms };
    },
    clearIntervalFn: () => {
      ticks.length = 0;
    },
  });
  return {
    watchdog,
    stalls,
    advance: (ms) => {
      now += ms;
    },
    tick: () => ticks.forEach((t) => t.fn()),
    intervalMs: () => ticks[0]?.ms,
  };
}

test('a getUpdates call that hangs past the threshold fires onStall', () => {
  const h = makeHarness();
  h.watchdog.start();
  h.watchdog.beginPoll();
  h.advance(95000);
  h.tick();
  assert.equal(h.stalls.length, 1);
  assert.ok(h.stalls[0] >= 95000);
});

test('a getUpdates call that returns in time never fires', () => {
  const h = makeHarness();
  h.watchdog.start();
  h.watchdog.beginPoll();
  h.advance(30000);
  h.watchdog.endPoll();
  h.advance(120000);
  h.tick();
  assert.deepEqual(h.stalls, []);
});

// 这条是防误杀的核心：妈妈一句话可能让 Kimi 生成 10 分钟。
// 那段时间 endPoll() 已经调过了，看门狗必须完全闭嘴。
test('a long reply generation between polls is never killed', () => {
  const h = makeHarness();
  h.watchdog.start();
  h.watchdog.beginPoll();
  h.advance(5000);
  h.watchdog.endPoll();
  h.advance(10 * 60 * 1000);
  h.tick();
  assert.deepEqual(h.stalls, []);
});

test('firing once does not fire repeatedly for the same hang', () => {
  const h = makeHarness();
  h.watchdog.start();
  h.watchdog.beginPoll();
  h.advance(95000);
  h.tick();
  h.advance(95000);
  h.tick();
  assert.equal(h.stalls.length, 1);
});

test('the next poll after a recovery is watched again', () => {
  const h = makeHarness();
  h.watchdog.start();
  h.watchdog.beginPoll();
  h.advance(95000);
  h.tick();
  h.watchdog.endPoll();
  h.watchdog.beginPoll();
  h.advance(95000);
  h.tick();
  assert.equal(h.stalls.length, 2);
});

test('check interval never exceeds the stall threshold', () => {
  const h = makeHarness({ stallMs: 5000, checkMs: 15000 });
  h.watchdog.start();
  assert.ok(h.intervalMs() <= 5000);
});

test('stop() halts watching', () => {
  const h = makeHarness();
  h.watchdog.start();
  h.watchdog.beginPoll();
  h.watchdog.stop();
  h.advance(95000);
  h.tick();
  assert.deepEqual(h.stalls, []);
});
