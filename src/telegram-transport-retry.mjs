// Transport-level retry for Telegram calls.
//
// Synqa, 2026-08-15 21:57: "Skald刚才回在终端了，没回在tg，是桥断了？"
// Kimi had already written the reply. One sendMessage timed out on the way to
// Telegram, the turn was marked failed, and the durable layer's recovery was to
// regenerate the whole turn — so she sat there with nothing while the text was
// visible in the terminal the entire time.
//
// The network under these bridges hiccups in bursts (51 poll failures for Skald
// on 2026-08-15 alone, clustered at 12/14/15/21 UTC). Syner rides out the exact
// same bursts with zero visible failures because it retries at the transport
// layer. This is that layer, extracted so it can be tested.
//
// Scope: only faults that mean "the message never made it over the wire".
// A Telegram-level rejection (chat not found, bad request) is a real answer and
// must surface immediately. 429 carries retry_after and belongs to the rate
// limiter upstream — retrying it blindly makes throttling worse.

const RETRYABLE_TRANSPORT = new RegExp([
  'fetch failed',
  'aborted',
  'timeout',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'socket hang up',
  'other side closed',
  'terminated',
].join('|'), 'i');

export function isRetryableTransportError(error) {
  if (!error) return false;
  const status = Number(error.status) || 0;
  if (status === 429) return false;      // rate limiter's job, needs retry_after
  if (status >= 500) return true;        // Telegram itself wobbling
  if (status >= 400) return false;       // a real answer: don't paper over it
  return RETRYABLE_TRANSPORT.test(String(error.message || ''));
}

export async function withTransportRetry(call, {
  maxAttempts = 4,
  baseDelayMs = 500,
  maxDelayMs = 5000,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  onRetry = null,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableTransportError(error) || attempt === maxAttempts) throw error;
      const delayMs = Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
      if (typeof onRetry === 'function') onRetry({ attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
