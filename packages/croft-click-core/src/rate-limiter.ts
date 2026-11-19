/**
 * In-memory rate limiter — environment-agnostic.
 * Tracks quota from response headers and gates requests to stay within limits.
 */

import { normalizeHeaders, type HeadersLike } from './rate-limit-headers.js';

interface State {
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds
  windowSeconds: number;
}

export class RateLimiter {
  private state: State | null = null;
  private readonly headroom: number;

  /**
   * Empirically observed points consumed per record, derived from successive
   * quota readings rather than assumed. The server reports whichever bucket
   * is currently tightest (e.g. a broad per-IP request cap vs. a write-specific
   * points budget) under the same generic header names, with no way to tell
   * which one it is from the headers alone. A hardcoded "points per record"
   * constant is only correct when the reported bucket happens to be the
   * write-specific one; against a request-counted bucket it wildly
   * overestimates cost per record. Tracking the observed delta instead
   * self-corrects regardless of which bucket is being reported.
   */
  private observedPointsPerRecord: number | null = null;
  private lastRemaining: number | null = null;
  private lastResetAt: number | null = null;

  constructor(opts?: { headroom?: number }) {
    this.headroom = opts?.headroom ?? 0.15;
  }

  /**
   * @param batchSize Number of records the just-completed request covered.
   *   Pass this to let the limiter learn the real points-per-record cost of
   *   whichever bucket the server is reporting; omit for reads/other calls
   *   that shouldn't feed the estimate.
   */
  updateFromHeaders(headers: HeadersLike, batchSize?: number): void {
    const h = normalizeHeaders(headers);
    const get = (k: string) => h[k] ?? h[`x-${k}`] ?? '';

    const limit = parseInt(get('ratelimit-limit'), 10);
    const remaining = parseInt(get('ratelimit-remaining'), 10);
    const reset = parseInt(get('ratelimit-reset'), 10);
    const policy = get('ratelimit-policy');

    if (!limit || isNaN(limit) || isNaN(remaining)) return;

    let windowSeconds = 3600;
    const m = /;w=(\d+)/.exec(policy);
    if (m) windowSeconds = parseInt(m[1], 10);

    const now = Math.floor(Date.now() / 1000);
    const resetAt = isNaN(reset) ? now + windowSeconds : reset;

    // A differently-shaped bucket (different limit/window) has different
    // per-request cost semantics — e.g. the per-IP request bucket charges 1
    // per call while the repo-write bucket charges 3 per create. An estimate
    // learned from the old bucket says nothing about the new one, so drop it
    // rather than blending it into the next sample.
    const sameBucket =
      this.state !== null && this.state.limit === limit && this.state.windowSeconds === windowSeconds;
    if (this.state && !sameBucket) {
      this.observedPointsPerRecord = null;
    }

    // Only learn from this reading if it's a same-window continuation of the
    // previous one — a window reset (or first-ever reading) makes the delta
    // meaningless.
    if (
      batchSize &&
      batchSize > 0 &&
      sameBucket &&
      this.lastRemaining !== null &&
      this.lastResetAt === resetAt
    ) {
      const consumed = this.lastRemaining - remaining;
      if (consumed > 0) {
        const observed = consumed / batchSize;
        this.observedPointsPerRecord =
          this.observedPointsPerRecord === null
            ? observed
            : this.observedPointsPerRecord * 0.5 + observed * 0.5;
      }
    }

    this.lastRemaining = remaining;
    this.lastResetAt = resetAt;
    this.state = { limit, remaining, resetAt, windowSeconds };
  }

  /**
   * Points-per-record cost to use for pacing math: the empirically observed
   * value once we have one, otherwise the caller's assumed default.
   */
  getPointsPerRecord(fallback: number): number {
    return this.observedPointsPerRecord ?? fallback;
  }

  /**
   * Whether an empirical points-per-record estimate exists yet. Before the
   * first same-window reading pair, any capacity/window the server reports
   * could belong to a bucket with completely different per-request cost
   * semantics than the caller's assumed default — proactively pacing against
   * it is as likely to be needlessly conservative as it is accurate. Callers
   * should skip proactive delay until this is true and rely on the reactive
   * 429 path (`handleRateLimitHit` + `waitForPermit`) in the meantime, which
   * is safe regardless of which bucket is actually being reported.
   */
  hasObservedPointsPerRecord(): boolean {
    return this.observedPointsPerRecord !== null;
  }

  /**
   * Forget the empirical points-per-record estimate while keeping the quota
   * ledger. Call this when the cost of what is being sent changes — e.g.
   * switching from creates (3 points) to deletes (1 point) — so the next
   * same-window reading pair re-learns against the new cost instead of
   * blending it into the old average and over-pacing the cheaper writes.
   */
  resetPointsPerRecordEstimate(): void {
    this.observedPointsPerRecord = null;
  }

  getActualRemaining(): number {
    if (!this.state) return 0;
    if (Math.floor(Date.now() / 1000) >= this.state.resetAt) return this.state.limit;
    return this.state.remaining;
  }

  getServerCapacity(): { limit: number; windowSeconds: number } | null {
    if (!this.state || this.state.limit === 0) return null;
    return { limit: this.state.limit, windowSeconds: this.state.windowSeconds };
  }

  hasServerInfo(): boolean {
    return this.state !== null && this.state.limit > 0;
  }

  /** Unix seconds at which the current window resets, or null before any reading. */
  getResetAt(): number | null {
    return this.state?.resetAt ?? null;
  }

  /**
   * Called when the server returns a 429. Zeroes remaining so the next
   * `waitForPermit` actually blocks until the window resets. When the 429
   * carried rate-limit headers, `resetAt` comes from them; the one-hour
   * stub below is only the fallback for a headerless response.
   */
  handleRateLimitHit(errHeaders?: HeadersLike): void {
    const normalized = normalizeHeaders(errHeaders);
    if (Object.keys(normalized).length > 0) {
      this.updateFromHeaders(normalized);
    }
    const now = Math.floor(Date.now() / 1000);
    if (this.state) {
      this.state.remaining = 0;
    } else {
      this.state = { limit: 5000, remaining: 0, resetAt: now + 3600, windowSeconds: 3600 };
    }
  }

  /**
   * Wait until there is sufficient quota to send `pointsNeeded` points.
   * Polls `isCancelled` every 50 ms so callers can abort mid-wait.
   *
   * @param onWait Invoked once, before blocking, with how long the wait will
   *   be and the unix-ms time it ends — so callers can tell the user why
   *   nothing is being sent instead of appearing to hang.
   */
  async waitForPermit(
    pointsNeeded: number,
    isCancelled?: () => boolean,
    onWait?: (waitMs: number, resumeAt: number) => void,
  ): Promise<void> {
    if (!this.state) return; // no info yet — let first request probe

    const now = Math.floor(Date.now() / 1000);
    if (now >= this.state.resetAt) {
      this.state.remaining = this.state.limit;
      this.state.resetAt = now + this.state.windowSeconds;
    }

    const headroomPts = Math.floor(this.state.limit * this.headroom);
    const effective = this.state.remaining - headroomPts;

    if (effective < pointsNeeded) {
      const resetMs = Math.max(0, (this.state.resetAt - Math.floor(Date.now() / 1000)) + 1) * 1000;
      const end = Date.now() + resetMs;
      onWait?.(resetMs, end);
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (isCancelled?.() || Date.now() >= end) { resolve(); return; }
          setTimeout(tick, Math.min(50, end - Date.now()));
        };
        tick();
      });
      if (this.state && !isCancelled?.()) {
        this.state.remaining = this.state.limit;
        this.state.resetAt = Math.floor(Date.now() / 1000) + this.state.windowSeconds;
      }
    }

    if (this.state) this.state.remaining = Math.max(0, this.state.remaining - pointsNeeded);
  }

  /**
   * Returns a reservation made by `waitForPermit` that was never actually
   * spent — e.g. the request it was reserved for failed for a reason
   * unrelated to rate limiting (validation error, network failure) rather
   * than being sent and accepted or rejected by the server. Without this,
   * failed batches permanently drain the local quota ledger even though the
   * server's real quota was untouched, eventually causing `waitForPermit` to
   * block on phantom rate limiting.
   */
  refund(points: number): void {
    if (!this.state) return;
    this.state.remaining = Math.min(this.state.limit, this.state.remaining + points);
  }
}
