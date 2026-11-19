/**
 * Rate-limit header parsing — environment-agnostic.
 * No logger dependency; callers surface messages as they see fit.
 */

export interface RateLimitHeaders {
  limit?: number;
  remaining?: number;
  reset?: number;
  windowSeconds?: number;
}

/**
 * Anything we might be handed as "the response headers": a plain record, a
 * WHATWG `Headers` instance (what @atproto/lex exposes on both `XrpcResponse`
 * and `XrpcResponseError`), or nothing at all.
 *
 * `Headers` matters: `Object.entries(new Headers())` is empty, so treating it
 * as a record silently drops every rate-limit header the PDS sent.
 */
export type HeadersLike =
  | Record<string, string>
  | { forEach(callback: (value: string, key: string) => void): void }
  | null
  | undefined;

export function normalizeHeaders(headers: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach(cb: (value: string, key: string) => void): void }).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
}

export function parseRateLimitHeaders(headers: HeadersLike): RateLimitHeaders {
  const h = normalizeHeaders(headers);
  const get = (k: string) => h[k] ?? h[`x-${k}`] ?? '';

  const limit = parseInt(get('ratelimit-limit'), 10);
  const remaining = parseInt(get('ratelimit-remaining'), 10);
  const reset = parseInt(get('ratelimit-reset'), 10);
  const policy = get('ratelimit-policy');

  let windowSeconds: number | undefined;
  const m = /;w=(\d+)/.exec(policy);
  if (m) windowSeconds = parseInt(m[1], 10);
  else if (!isNaN(reset)) {
    windowSeconds = Math.max(0, reset - Math.floor(Date.now() / 1000));
  }

  return {
    limit: isNaN(limit) ? undefined : limit,
    remaining: isNaN(remaining) ? undefined : remaining,
    reset: isNaN(reset) ? undefined : reset,
    windowSeconds,
  };
}

export function isRateLimitError(err: unknown): boolean {
  const e = err as any;
  if (e?.status === 429) return true;
  const msg = (e?.message ?? '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('ratelimit');
}
