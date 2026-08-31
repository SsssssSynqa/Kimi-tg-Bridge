import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableTransportError, withTransportRetry } from '../src/telegram-transport-retry.mjs';

// Reported symptom: the agent answered in the terminal but nothing arrived on
// Telegram — generation succeeded, delivery did not.
// Kimi had already written the reply — it was sitting in the TUI — but the
// sendMessage that would have carried it to her timed out once, the whole turn
// was marked failed, and the durable layer's idea of recovery was to REGENERATE
// the entire turn from scratch. She got nothing.
//
// Syner survives the same proxy hiccups with a transport-level retry (4 attempts,
// exponential backoff) and logged zero poll failures today against Skald's 51.
// Absorb transient faults here so they never reach the durable layer.

const transient = [
  'fetch failed',
  'The operation was aborted due to timeout',
  'read ECONNRESET',
  'socket hang up',
  'other side closed',
  'connect ETIMEDOUT 149.154.167.220:443',
];

for (const message of transient) {
  test(`transient transport fault is retryable: ${message}`, () => {
    assert.equal(isRetryableTransportError(new Error(message)), true);
  });
}

test('a Telegram API rejection is NOT retryable', () => {
  const error = new Error('Telegram sendMessage failed: chat not found');
  error.status = 400;
  assert.equal(isRetryableTransportError(error), false);
});

// 429 carries retry_after and has its own rate limiter upstream. Retrying it
// here without honouring that header makes the throttling worse, not better.
test('429 is left to the existing rate limiter', () => {
  const error = new Error('Telegram sendMessage failed: Too Many Requests');
  error.status = 429;
  assert.equal(isRetryableTransportError(error), false);
});

test('5xx from Telegram is retryable', () => {
  const error = new Error('Telegram getUpdates failed: Bad Gateway');
  error.status = 502;
  assert.equal(isRetryableTransportError(error), true);
});

test('a call that succeeds first try is not retried', async () => {
  let calls = 0;
  const result = await withTransportRetry(async () => {
    calls += 1;
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('a transient fault is absorbed and the call succeeds', async () => {
  let calls = 0;
  const waits = [];
  const result = await withTransportRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('fetch failed');
    return 'delivered';
  }, { sleep: async (ms) => waits.push(ms) });
  assert.equal(result, 'delivered');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]); // exponential
});

test('a non-retryable error surfaces immediately', async () => {
  let calls = 0;
  const error = new Error('Telegram sendMessage failed: chat not found');
  error.status = 400;
  await assert.rejects(
    withTransportRetry(async () => {
      calls += 1;
      throw error;
    }, { sleep: async () => {} }),
    /chat not found/,
  );
  assert.equal(calls, 1);
});

test('giving up rethrows the last error after maxAttempts', async () => {
  let calls = 0;
  await assert.rejects(
    withTransportRetry(async () => {
      calls += 1;
      throw new Error('fetch failed');
    }, { maxAttempts: 4, sleep: async () => {} }),
    /fetch failed/,
  );
  assert.equal(calls, 4);
});

test('backoff is capped', async () => {
  const waits = [];
  await assert.rejects(
    withTransportRetry(async () => {
      throw new Error('fetch failed');
    }, { maxAttempts: 8, maxDelayMs: 2000, sleep: async (ms) => waits.push(ms) }),
    /fetch failed/,
  );
  assert.ok(Math.max(...waits) <= 2000, `backoff exceeded cap: ${waits}`);
});

test('onRetry reports each absorbed fault for the log', async () => {
  const seen = [];
  let calls = 0;
  await withTransportRetry(async () => {
    calls += 1;
    if (calls < 2) throw new Error('socket hang up');
    return 'ok';
  }, {
    sleep: async () => {},
    onRetry: (info) => seen.push(info),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attempt, 1);
  assert.match(seen[0].error.message, /socket hang up/);
});
