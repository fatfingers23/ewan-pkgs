/**
 * Unit tests for the polish migration subtool.
 *
 * Tests cover:
 * - Migration plan classification (backfill vs dedupe)
 * - Backfill preserving rkeys and rewriting $type
 * - Legacy cleanup ordering
 * - Failure safety (legacy copies retained)
 * - Dry-run purity (no writes)
 * - Alpha -> production field conversion (mbid: URIs, originUri, musicServiceUri)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Client } from '@atproto/lex';
import { buildPolishPlan, migrateLegacyRecords, convertLegacyPlay } from '../lib/polish.js';
import type { PolishPlan } from '../lib/polish.js';
import { migrateLegacyRecords as coreMigrateLegacyRecords } from '@ewanc26/croft-click-core';
import type { PolishWait } from '@ewanc26/croft-click-core';

function play(rkey: string, track: string, $type = 'fm.teal.alpha.feed.play') {
  return {
    rkey,
    uri: `at://did:plc:test/${$type}/${rkey}`,
    cid: `bafyrei${rkey}`,
    value: {
      $type,
      trackName: track,
      artists: [{ artistName: 'Test Artist' }],
      playedTime: '2025-01-01T00:00:00Z',
      submissionClientAgent: 'malachite/test',
      musicServiceUri: 'https://example.com',
    },
  };
}

/**
 * Stand-in for an @atproto/lex Client.
 *
 * Migration writes go through a single `client.xrpc(applyWrites)` per batch
 * (not `client.call`, which discards the response headers the rate limiter
 * needs), so the mock splits the batch back out into the creates and deletes
 * the assertions care about and returns an XrpcResponse-shaped object.
 */
function makeFakeAgent(
  onCreate?: (write: any) => Promise<unknown>,
  onDelete?: (write: any) => Promise<unknown>,
  /** Headers to return for the Nth (0-based) applyWrites call. */
  headersFor?: (callIndex: number) => Headers,
  /** Throw for the Nth call instead of answering it. */
  errorFor?: (callIndex: number) => unknown
) {
  const created: any[] = [];
  const deleted: any[] = [];
  const callTimes: number[] = [];

  const client = {
    assertDid: 'did:plc:test',
    did: 'did:plc:test',
    xrpc: async (_nsid: unknown, options: any) => {
      const callIndex = callTimes.length;
      callTimes.push(Date.now());
      const err = errorFor?.(callIndex);
      if (err) throw err;

      const results: unknown[] = [];
      for (const write of options?.body?.writes ?? []) {
        const isCreate = write.$type === 'com.atproto.repo.applyWrites#create';
        // Record the write in the legacy per-record shape the assertions use.
        (isCreate ? created : deleted).push({
          collection: write.collection,
          rkey: write.rkey,
          record: write.value,
        });
        const hook = isCreate ? onCreate : onDelete;
        // A throwing hook models the whole applyWrites call failing, which is
        // how the PDS rejects a batch.
        if (hook) await hook(write);
        results.push({ $type: 'com.atproto.repo.applyWrites#createResult' });
      }
      return { headers: headersFor?.(callIndex) ?? new Headers(), body: { results } };
    },
  };

  return { agent: client as unknown as Client, created, deleted, callTimes };
}

function rateLimitHeaders(limit: number, remaining: number, resetAt: number): Headers {
  return new Headers({
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(resetAt),
    'RateLimit-Policy': `${limit};w=3600`,
  });
}

describe('buildPolishPlan', () => {
  it('classifies legacy records by production rkey presence', () => {
    const legacy = [
      play('rkeyA', 'Track A'),
      play('rkeyB', 'Track B'),
      play('rkeyC', 'Track C'),
    ];
    const production = [
      play('rkeyA', 'Track A (prod)', 'fm.teal.feed.play'),
      play('rkeyZ', 'Prod only', 'fm.teal.feed.play'),
    ];

    const plan = buildPolishPlan(legacy, production);

    assert.strictEqual(plan.legacyTotal, 3);
    assert.strictEqual(plan.productionTotal, 2);
    assert.deepStrictEqual(plan.toBackfill.map((r) => r.rkey), ['rkeyB', 'rkeyC']);
    assert.deepStrictEqual(plan.toDedupe.map((r) => r.rkey), ['rkeyA']);
  });

  it('dedupes by rkey even when the production value differs', () => {
    const legacy = [play('rkeyA', 'Track A')];
    const production = [play('rkeyA', 'Track A (different content)', 'fm.teal.feed.play')];

    const plan = buildPolishPlan(legacy, production);

    assert.strictEqual(plan.toDedupe.length, 1);
    assert.strictEqual(plan.toBackfill.length, 0);
  });

  it('returns an empty plan when no legacy records exist', () => {
    const plan = buildPolishPlan([], [play('rkeyA', 'Track A', 'fm.teal.feed.play')]);

    assert.strictEqual(plan.legacyTotal, 0);
    assert.strictEqual(plan.productionTotal, 1);
    assert.strictEqual(plan.toBackfill.length, 0);
    assert.strictEqual(plan.toDedupe.length, 0);
  });
});

describe('convertLegacyPlay', () => {
  const uuid = '6e195e15-e0b1-4093-a98f-ea1b8625f58d';

  it('prefixes bare MusicBrainz UUIDs with mbid:', () => {
    const out = convertLegacyPlay({
      trackName: 'Wall of Eyes',
      recordingMbId: uuid,
      releaseMbId: '70649A43-4ACF-49C8-9318-7E49C116C43E',
      trackMbId: `https://musicbrainz.org/recording/${uuid}`,
    });

    assert.strictEqual(out.recordingMbId, `mbid:${uuid}`);
    assert.strictEqual(out.releaseMbId, 'mbid:70649a43-4acf-49c8-9318-7e49c116c43e');
    assert.strictEqual(out.trackMbId, `mbid:${uuid}`);
  });

  it('leaves MusicBrainz IDs that are already mbid: URIs unchanged', () => {
    const out = convertLegacyPlay({ trackName: 'x', recordingMbId: `mbid:${uuid}` });
    assert.strictEqual(out.recordingMbId, `mbid:${uuid}`);
  });

  it('drops MusicBrainz IDs that contain no UUID', () => {
    const out = convertLegacyPlay({ trackName: 'x', recordingMbId: 'not-an-id', releaseMbId: '' });
    assert.ok(!('recordingMbId' in out));
    assert.ok(!('releaseMbId' in out));
  });

  it('normalises artistMbId inside the artists array', () => {
    const out = convertLegacyPlay({
      trackName: 'x',
      artists: [
        { artistName: 'The Smile', artistMbId: '9055fca5-69bc-4d47-b569-ab2012a19565' },
        { artistName: 'No MBID' },
        { artistName: 'Bad MBID', artistMbId: 'nope' },
      ],
    });

    assert.deepStrictEqual(out.artists, [
      { artistName: 'The Smile', artistMbId: 'mbid:9055fca5-69bc-4d47-b569-ab2012a19565' },
      { artistName: 'No MBID' },
      { artistName: 'Bad MBID' },
    ]);
  });

  it('renames originUrl to originUri', () => {
    const out = convertLegacyPlay({
      trackName: 'x',
      originUrl: 'https://www.last.fm/music/The%20Smile/_/Wall%20of%20Eyes',
    });

    assert.strictEqual(out.originUri, 'https://www.last.fm/music/The%20Smile/_/Wall%20of%20Eyes');
    assert.ok(!('originUrl' in out));
  });

  it('drops originUrl / originUri values that are not URIs', () => {
    const out = convertLegacyPlay({ trackName: 'x', originUrl: 'just some text', originUri: '' });
    assert.ok(!('originUrl' in out));
    assert.ok(!('originUri' in out));
  });

  it('converts musicServiceBaseDomain to an https musicServiceUri', () => {
    const out = convertLegacyPlay({ trackName: 'x', musicServiceBaseDomain: 'last.fm' });
    assert.strictEqual(out.musicServiceUri, 'https://last.fm/');
    assert.ok(!('musicServiceBaseDomain' in out));
  });

  it('keeps an existing musicServiceUri over musicServiceBaseDomain', () => {
    const out = convertLegacyPlay({
      trackName: 'x',
      musicServiceBaseDomain: 'last.fm',
      musicServiceUri: 'https://www.last.fm/',
    });
    assert.strictEqual(out.musicServiceUri, 'https://www.last.fm/');
    assert.ok(!('musicServiceBaseDomain' in out));
  });

  it("drops the alpha 'local' placeholder domain rather than inventing a URI", () => {
    const out = convertLegacyPlay({ trackName: 'x', musicServiceBaseDomain: 'local' });
    assert.ok(!('musicServiceUri' in out));
    assert.ok(!('musicServiceBaseDomain' in out));
  });

  it('drops null-valued properties and stamps the production $type', () => {
    const out = convertLegacyPlay({ $type: 'fm.teal.alpha.feed.play', trackName: 'x', duration: null });
    assert.ok(!('duration' in out));
    assert.strictEqual(out.$type, 'fm.teal.feed.play');
  });

  it('does not mutate its input', () => {
    const input = { trackName: 'x', recordingMbId: uuid, originUrl: 'https://a.b/c', artists: [{ artistName: 'A', artistMbId: uuid }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    convertLegacyPlay(input);
    assert.deepStrictEqual(input, snapshot);
  });
});

describe('migrateLegacyRecords', () => {
  it('backfills into production preserving rkeys, then deletes legacy copies', async () => {
    const legacy = [play('rkeyA', 'Track A'), play('rkeyB', 'Track B')];
    const production = [play('rkeyA', 'Track A (prod)', 'fm.teal.feed.play')];
    const plan = buildPolishPlan(legacy, production);

    const { agent, created, deleted } = makeFakeAgent();
    const result = await migrateLegacyRecords(agent, plan);

    assert.strictEqual(result.backfilled, 1);
    assert.strictEqual(result.deduped, 1);
    assert.strictEqual(result.deleted, 2);
    assert.strictEqual(result.failed, 0);

    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].collection, 'fm.teal.feed.play');
    assert.strictEqual(created[0].rkey, 'rkeyB');
    assert.strictEqual(created[0].record.$type, 'fm.teal.feed.play');
    assert.strictEqual(created[0].record.trackName, 'Track B');

    assert.strictEqual(deleted.length, 2);
    assert.ok(deleted.some((d) => d.rkey === 'rkeyA' && d.collection === 'fm.teal.alpha.feed.play'));
    assert.ok(deleted.some((d) => d.rkey === 'rkeyB' && d.collection === 'fm.teal.alpha.feed.play'));
  });

  it('converts alpha field formats when backfilling into production', async () => {
    const alpha = play('rkeyA', 'Wall of Eyes');
    const { musicServiceUri: _dropped, ...rest } = alpha.value;
    const legacy = [{
      ...alpha,
      value: {
        ...rest,
        artists: [{ artistName: 'The Smile', artistMbId: '9055fca5-69bc-4d47-b569-ab2012a19565' }],
        recordingMbId: '6e195e15-e0b1-4093-a98f-ea1b8625f58d',
        originUrl: 'https://www.last.fm/music/The%20Smile/_/Wall%20of%20Eyes',
        musicServiceBaseDomain: 'last.fm',
      } as Record<string, unknown>,
    }];
    const plan = buildPolishPlan(legacy, []);

    const { agent, created } = makeFakeAgent();
    await migrateLegacyRecords(agent, plan);

    assert.strictEqual(created.length, 1);
    const record = created[0].record;
    assert.strictEqual(record.$type, 'fm.teal.feed.play');
    assert.strictEqual(record.recordingMbId, 'mbid:6e195e15-e0b1-4093-a98f-ea1b8625f58d');
    assert.strictEqual(record.artists[0].artistMbId, 'mbid:9055fca5-69bc-4d47-b569-ab2012a19565');
    assert.strictEqual(record.originUri, 'https://www.last.fm/music/The%20Smile/_/Wall%20of%20Eyes');
    assert.strictEqual(record.musicServiceUri, 'https://last.fm/');
    assert.ok(!('originUrl' in record));
    assert.ok(!('musicServiceBaseDomain' in record));
  });

  it('keeps legacy copies when a backfill fails', async () => {
    const legacy = [play('rkeyA', 'Track A')];
    const plan = buildPolishPlan(legacy, []);
    const { agent, created, deleted } = makeFakeAgent(() => {
      throw new Error('boom');
    });

    const result = await migrateLegacyRecords(agent, plan);

    assert.strictEqual(result.backfilled, 0);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(deleted.length, 0);
  });

  it('performs no writes in dry-run', async () => {
    const legacy = [play('rkeyA', 'Track A')];
    const plan = buildPolishPlan(legacy, []);
    const { agent, created, deleted } = makeFakeAgent();

    const result = await migrateLegacyRecords(agent, plan, true);

    assert.strictEqual(result.backfilled, 1);
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(created.length, 0);
    assert.strictEqual(deleted.length, 0);
  });

  it('learns quota from response headers and waits for reset before the next batch', { timeout: 15000 }, async () => {
    // 201 legacy records -> two backfill batches (200 + 1). The first response
    // reports quota below the 15% headroom with a reset 2s away, so the second
    // batch must not be sent until that reset has passed.
    const legacy = Array.from({ length: 201 }, (_, i) => play(`rkey${String(i).padStart(3, '0')}`, `Track ${i}`));
    const plan = buildPolishPlan(legacy, []);
    const resetAt = Math.floor(Date.now() / 1000) + 2;

    const { agent, callTimes } = makeFakeAgent(undefined, undefined, (callIndex) =>
      callIndex === 0 ? rateLimitHeaders(1000, 100, resetAt) : rateLimitHeaders(1000, 1000, resetAt)
    );

    const result = await migrateLegacyRecords(agent, plan);

    assert.strictEqual(result.backfilled, 201);
    assert.strictEqual(result.failed, 0);
    assert.ok(callTimes.length >= 2, `expected at least two applyWrites calls, got ${callTimes.length}`);
    const gapMs = callTimes[1] - callTimes[0];
    assert.ok(gapMs >= 1500, `second batch was sent after ${gapMs}ms; expected it to wait for the reset`);
  });

  it('honours ratelimit-reset from a 429 instead of sleeping a fixed hour', { timeout: 15000 }, async () => {
    const legacy = [play('rkeyA', 'Track A')];
    const plan = buildPolishPlan(legacy, []);
    const resetAt = Math.floor(Date.now() / 1000) + 2;

    const { agent, callTimes, created } = makeFakeAgent(undefined, undefined, undefined, (callIndex) =>
      callIndex === 0
        ? Object.assign(new Error('Rate Limit Exceeded'), { status: 429, headers: rateLimitHeaders(1000, 0, resetAt) })
        : undefined
    );

    const result = await migrateLegacyRecords(agent, plan);

    assert.strictEqual(result.backfilled, 1);
    assert.strictEqual(result.failed, 0);
    // 429, the retried backfill, then the legacy-delete phase.
    assert.strictEqual(callTimes.length, 3, 'the batch should be retried once after the 429');
    assert.strictEqual(created.length, 1);
    const gapMs = callTimes[1] - callTimes[0];
    assert.ok(gapMs >= 1500 && gapMs < 10000, `retry gap was ${gapMs}ms; expected ~2-3s from the reset header`);
  });

  it('reports a quota wait before blocking on the window reset', { timeout: 15000 }, async () => {
    // Same shape as the test above, but through the core entry point so the
    // wait itself is observable: the CLI needs it to tell the user why the
    // progress bar has stopped moving.
    const legacy = Array.from({ length: 201 }, (_, i) => play(`rkey${String(i).padStart(3, '0')}`, `Track ${i}`));
    const plan = buildPolishPlan(legacy, []);
    const resetAt = Math.floor(Date.now() / 1000) + 2;

    const { agent } = makeFakeAgent(undefined, undefined, (callIndex) =>
      callIndex === 0 ? rateLimitHeaders(1000, 100, resetAt) : rateLimitHeaders(1000, 1000, resetAt)
    );

    const waits: PolishWait[] = [];
    const result = await coreMigrateLegacyRecords(agent, plan, { onWait: (wait) => waits.push(wait) });

    assert.strictEqual(result.backfilled, 201);
    const quotaWaits = waits.filter((wait) => wait.kind === 'quota');
    assert.strictEqual(quotaWaits.length, 1, `expected exactly one quota wait, got ${JSON.stringify(waits)}`);
    const [wait] = quotaWaits;
    assert.strictEqual(wait.phase, 'backfill');
    assert.ok(wait.ms >= 1000 && wait.ms <= 3500, `quota wait was ${wait.ms}ms; expected ~2-3s until the reset`);
    assert.ok(Math.abs(wait.resumeAt - (resetAt + 1) * 1000) < 1500, 'resumeAt should be the window reset');
    assert.strictEqual(wait.remaining, 100);
    assert.strictEqual(wait.limit, 1000);
  });

  it('paces deletes at the delete cost rather than the create cost learned during backfill', { timeout: 15000 }, async () => {
    // 401 records -> three batches per phase (200 + 200 + 1), so each phase
    // observes its own points-per-write from consecutive responses and paces
    // the batches that follow. Creates cost 3 points and deletes 1: at
    // 10,000 points per 10s the pacer spaces 200 creates by ~750ms but 200
    // deletes by only ~250ms. Carrying the create cost into the delete phase
    // would space deletes by 500ms or more.
    const legacy = Array.from({ length: 401 }, (_, i) => play(`rkey${String(i).padStart(3, '0')}`, `Track ${i}`));
    const plan = buildPolishPlan(legacy, []);
    const limit = 10_000;
    const resetAt = Math.floor(Date.now() / 1000) + 10;
    let spent = 0;

    const client = {
      assertDid: 'did:plc:test',
      xrpc: async (_nsid: unknown, options: any) => {
        const results: unknown[] = [];
        for (const write of options?.body?.writes ?? []) {
          spent += write.$type === 'com.atproto.repo.applyWrites#create' ? 3 : 1;
          results.push({ $type: `${write.$type}Result` });
        }
        return {
          headers: new Headers({
            'RateLimit-Limit': String(limit),
            'RateLimit-Remaining': String(limit - spent),
            'RateLimit-Reset': String(resetAt),
            'RateLimit-Policy': `${limit};w=10`,
          }),
          body: { results },
        };
      },
    } as unknown as Client;

    const waits: PolishWait[] = [];
    const result = await coreMigrateLegacyRecords(client, plan, { onWait: (wait) => waits.push(wait) });

    assert.strictEqual(result.backfilled, 401);
    assert.strictEqual(result.deleted, 401);
    assert.strictEqual(spent, 401 * 3 + 401);

    const backfillPacing = waits.filter((wait) => wait.phase === 'backfill' && wait.kind === 'pacing');
    const deletePacing = waits.filter((wait) => wait.phase === 'delete' && wait.kind === 'pacing');
    assert.ok(backfillPacing.length >= 1, 'expected a pacing wait between backfill batches');
    assert.ok(deletePacing.length >= 1, 'expected a pacing wait between delete batches');
    for (const wait of backfillPacing) {
      assert.ok(wait.ms >= 600 && wait.ms <= 900, `backfill pacing was ${wait.ms}ms; expected ~750ms for 200 creates`);
    }
    for (const wait of deletePacing) {
      assert.ok(wait.ms >= 200 && wait.ms <= 300, `delete pacing was ${wait.ms}ms; expected ~250ms for 200 deletes`);
    }
  });

  it('handles an empty plan without touching the repo', async () => {
    const plan: PolishPlan = { productionTotal: 0, legacyTotal: 0, toBackfill: [], toDedupe: [] };
    const { agent, created, deleted } = makeFakeAgent();

    const result = await migrateLegacyRecords(agent, plan);

    assert.strictEqual(result.backfilled, 0);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(created.length, 0);
    assert.strictEqual(deleted.length, 0);
  });
});
