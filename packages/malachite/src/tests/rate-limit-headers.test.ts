/**
 * Rate-limit header handling must accept a WHATWG `Headers` instance, because
 * that is what @atproto/lex hands back on both XrpcResponse and
 * XrpcResponseError. `Object.entries(new Headers())` is empty, so a
 * record-only implementation silently learns nothing from the server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizeHeaders as coreNormalizeHeaders,
  parseRateLimitHeaders as coreParseRateLimitHeaders,
  RateLimiter as CoreRateLimiter,
} from '@ewanc26/croft-click-core';
import { normalizeHeaders as cliNormalizeHeaders } from '../utils/rate-limit-headers.js';

function headers(limit: number, remaining: number, resetAt: number): Headers {
  return new Headers({
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(resetAt),
    'RateLimit-Policy': `${limit};w=3600`,
  });
}

describe('normalizeHeaders', () => {
  it('flattens a Headers instance into a lowercase record (core)', () => {
    const out = coreNormalizeHeaders(headers(5000, 4200, 1));
    assert.strictEqual(out['ratelimit-limit'], '5000');
    assert.strictEqual(out['ratelimit-remaining'], '4200');
    assert.strictEqual(out['ratelimit-policy'], '5000;w=3600');
  });

  it('flattens a Headers instance into a lowercase record (cli)', () => {
    const out = cliNormalizeHeaders(headers(5000, 4200, 1));
    assert.strictEqual(out['ratelimit-limit'], '5000');
    assert.strictEqual(out['ratelimit-remaining'], '4200');
  });

  it('still accepts a plain record with mixed-case keys', () => {
    const out = coreNormalizeHeaders({ 'RateLimit-Limit': '10', 'x-RateLimit-Remaining': '3' });
    assert.strictEqual(out['ratelimit-limit'], '10');
    assert.strictEqual(out['x-ratelimit-remaining'], '3');
  });

  it('returns an empty record for undefined input', () => {
    assert.deepStrictEqual(coreNormalizeHeaders(undefined), {});
  });
});

describe('parseRateLimitHeaders', () => {
  it('parses limit/remaining/window from a Headers instance', () => {
    const now = Math.floor(Date.now() / 1000);
    const parsed = coreParseRateLimitHeaders(headers(5000, 4200, now + 3600));
    assert.strictEqual(parsed.limit, 5000);
    assert.strictEqual(parsed.remaining, 4200);
    assert.strictEqual(parsed.windowSeconds, 3600);
    assert.strictEqual(parsed.reset, now + 3600);
  });
});

describe('core RateLimiter with Headers instances', () => {
  it('learns server capacity from a Headers instance', () => {
    const rl = new CoreRateLimiter({ headroom: 0.15 });
    const now = Math.floor(Date.now() / 1000);
    rl.updateFromHeaders(headers(5000, 4200, now + 3600));
    assert.deepStrictEqual(rl.getServerCapacity(), { limit: 5000, windowSeconds: 3600 });
    assert.strictEqual(rl.getActualRemaining(), 4200);
  });

  it('uses ratelimit-reset from the 429 headers rather than the one-hour stub', () => {
    const rl = new CoreRateLimiter({ headroom: 0.15 });
    const now = Math.floor(Date.now() / 1000);
    rl.handleRateLimitHit(headers(5000, 0, now + 120));
    const cap = rl.getServerCapacity();
    assert.ok(cap, 'capacity should be learned from the 429 headers');
    assert.strictEqual(cap.limit, 5000);
    assert.strictEqual(rl.getActualRemaining(), 0);
    assert.strictEqual(rl.getResetAt(), now + 120);
  });
});

describe('core RateLimiter points-per-record estimate', () => {
  function bucket(limit: number, remaining: number, resetAt: number, windowSeconds: number): Headers {
    return new Headers({
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(remaining),
      'RateLimit-Reset': String(resetAt),
      'RateLimit-Policy': `${limit};w=${windowSeconds}`,
    });
  }

  it('drops the estimate when the server starts reporting a differently shaped bucket', () => {
    // The PDS reports whichever bucket is tightest under the same header
    // names. A per-IP request bucket (1 point per call) and the repo-write
    // bucket (3 points per create) have nothing in common, so an estimate
    // learned from one must not be carried into pacing math for the other.
    const rl = new CoreRateLimiter({ headroom: 0.15 });
    const now = Math.floor(Date.now() / 1000);
    rl.updateFromHeaders(bucket(3000, 2999, now + 300, 300), 200);
    rl.updateFromHeaders(bucket(3000, 2998, now + 300, 300), 200);
    assert.ok(rl.hasObservedPointsPerRecord(), 'two same-bucket readings should yield an estimate');
    assert.ok(rl.getPointsPerRecord(3) < 0.01);

    rl.updateFromHeaders(bucket(5000, 2600, now + 3300, 3600), 200);
    assert.strictEqual(rl.hasObservedPointsPerRecord(), false, 'a new bucket shape must reset the estimate');
    assert.strictEqual(rl.getPointsPerRecord(3), 3);
    assert.deepStrictEqual(rl.getServerCapacity(), { limit: 5000, windowSeconds: 3600 });
  });

  it('resetPointsPerRecordEstimate clears the estimate but keeps the quota ledger', () => {
    const rl = new CoreRateLimiter({ headroom: 0.15 });
    const now = Math.floor(Date.now() / 1000);
    rl.updateFromHeaders(bucket(5000, 4400, now + 3600, 3600), 200);
    rl.updateFromHeaders(bucket(5000, 3800, now + 3600, 3600), 200);
    assert.strictEqual(rl.getPointsPerRecord(1), 3);

    rl.resetPointsPerRecordEstimate();
    assert.strictEqual(rl.hasObservedPointsPerRecord(), false);
    assert.strictEqual(rl.getPointsPerRecord(1), 1);
    assert.strictEqual(rl.getActualRemaining(), 3800, 'the ledger must survive the reset');

    // The next same-window reading re-learns against the new cost.
    rl.updateFromHeaders(bucket(5000, 3600, now + 3600, 3600), 200);
    assert.strictEqual(rl.getPointsPerRecord(3), 1);
  });
});
