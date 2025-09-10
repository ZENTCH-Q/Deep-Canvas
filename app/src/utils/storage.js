// utils/storage.js
// Safe localStorage operations with retries, minimal queuing, and telemetry

import { telemetry } from './telemetry.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isQuotaExceeded(err) {
  if (!err) return false;
  const name = err.name || '';
  const code = err.code;
  const msg = String(err.message || err);
  return (
    name === 'QuotaExceededError' ||
    code === 22 || code === 1014 ||
    /quota|exceeded/i.test(msg)
  );
}

const DEFAULT_BACKOFF = [0, 50, 150, 450, 800];

export async function setItemWithRetries(key, value, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoff = Array.isArray(opts.backoff) ? opts.backoff : DEFAULT_BACKOFF;
  const onQuota = opts.onQuota;
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      localStorage.setItem(key, value);
      const dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      telemetry.record('storage.set.success', { key, attempt: i + 1, ms: dt });
      return true;
    } catch (e) {
      lastErr = e;
      const quota = isQuotaExceeded(e);
      telemetry.record('storage.set.fail', { key, attempt: i + 1, quota, message: String(e?.message || e) });
      if (quota && typeof onQuota === 'function') {
        try {
          const recovered = await onQuota(e);
          // If onQuota handled cleanup, retry immediately without extra backoff
          if (recovered) continue;
        } catch {}
      }
      const wait = backoff[Math.min(i, backoff.length - 1)] || 0;
      if (wait > 0) await sleep(wait);
    }
  }
  telemetry.record('storage.set.giveup', { key, message: String(lastErr?.message || lastErr) });
  return false;
}

export function setItemWithRetriesSync(key, value, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const onQuota = opts.onQuota;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      localStorage.setItem(key, value);
      telemetry.record('storage.set.success.sync', { key, attempt: i + 1 });
      return true;
    } catch (e) {
      lastErr = e;
      const quota = isQuotaExceeded(e);
      telemetry.record('storage.set.fail.sync', { key, attempt: i + 1, quota, message: String(e?.message || e) });
      if (quota && typeof onQuota === 'function') {
        try {
          const recovered = onQuota(e);
          if (recovered) continue;
        } catch {}
      }
    }
  }
  telemetry.record('storage.set.giveup.sync', { key, message: String(lastErr?.message || lastErr) });
  return false;
}

export function safeGetItem(key) {
  try {
    const v = localStorage.getItem(key);
    telemetry.record('storage.get', { key, ok: v != null });
    return v;
  } catch (e) {
    telemetry.record('storage.get.fail', { key, message: String(e?.message || e) });
    return null;
  }
}

export async function safeRemoveItem(key) {
  try { localStorage.removeItem(key); telemetry.record('storage.remove', { key }); return true; }
  catch (e) { telemetry.record('storage.remove.fail', { key, message: String(e?.message || e) }); return false; }
}

// Minimal per-key queue to coalesce multiple writes
const queues = new Map();

export function queueSetItem(key, value, opts = {}) {
  let q = queues.get(key);
  if (!q) { q = { inFlight: false, next: null, promise: Promise.resolve() }; queues.set(key, q); }
  q.next = { value, opts };
  if (q.inFlight) return q.promise;
  q.inFlight = true;
  q.promise = (async function run() {
    try {
      while (q.next) {
        const { value: v, opts: o } = q.next; q.next = null;
        // eslint-disable-next-line no-await-in-loop
        await setItemWithRetries(key, v, o);
      }
    } finally {
      q.inFlight = false;
    }
  })();
  return q.promise;
}

export { isQuotaExceeded };

