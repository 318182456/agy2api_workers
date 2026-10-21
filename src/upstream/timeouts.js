import { googleFetch } from '../core/common.js';

export const retryableStatus = (status) => [429, 500, 502, 503, 504, 524].includes(status);
export const clientAborted = (signal) => signal?.aborted && signal.reason?.name !== 'TimeoutError';
export function boundedSeconds(value, fallback, min, max) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= min && seconds <= max
    ? Math.floor(seconds)
    : fallback;
}
// Limit waiting for headers only. Clear the timer before handing off a live response body.
export async function fetchGeneration(fetcher, url, options, seconds) {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException('Upstream headers timed out', 'TimeoutError')),
    seconds * 1000,
  );
  try {
    return await googleFetch(
      fetcher,
      url,
      {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
      },
      'generation_fetch',
    );
  } finally {
    clearTimeout(timer);
  }
}
