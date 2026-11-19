/**
 * Teal migration polish — environment-agnostic.
 *
 * Moves legacy `fm.teal.alpha.feed.play` scrobbles into the production
 * `fm.teal.feed.play` collection, then cleans up the legacy copies.
 * No CLI UI or caching; those are added by the CLI wrapper (src/lib/polish.ts
 * in malachite) and by malachite-web.
 */

import type { Client } from '@atproto/lex';
import { RECORD_TYPE, LEGACY_RECORD_TYPE } from './config.js';
import { fetchRepoViaCARWithClient } from './car-fetch.js';
import { retryWithBackoff } from './retry-helper.js';
import { RateLimiter } from './rate-limiter.js';
import { ProactiveRatePacer } from './proactive-rate-pacer.js';
import { isRateLimitError, type HeadersLike } from './rate-limit-headers.js';
import { com } from '@bsky/sdk/lexicons'
import { convertLegacyPlay } from './legacy-play.js';

export interface PolishRecord {
  rkey: string;
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

export interface PolishPlan {
  productionTotal: number;
  legacyTotal: number;
  /** Alpha records with no production counterpart — need to be backfilled. */
  toBackfill: PolishRecord[];
  /** Alpha records whose rkey already exists in production — drop the alpha copy. */
  toDedupe: PolishRecord[];
}

export interface PolishResult {
  backfilled: number;
  deduped: number;
  deleted: number;
  failed: number;
}

export type PolishPhase = 'backfill' | 'delete';

/**
 * A deliberate pause in a write phase. `pacing` is the proactive spacing
 * between batches that keeps the sustained rate under the PDS's write budget;
 * `quota` means the local ledger has dropped below the safety headroom and
 * nothing will be sent until the rate-limit window resets.
 */
export interface PolishWait {
  phase: PolishPhase;
  kind: 'pacing' | 'quota';
  /** Length of the pause in milliseconds. */
  ms: number;
  /** Unix milliseconds at which writes resume. */
  resumeAt: number;
  /** Points remaining in the reported bucket when the pause began. */
  remaining: number;
  /** Capacity of the reported bucket. */
  limit: number;
  /** Human-readable explanation. */
  reason: string;
}

export interface PolishMigrateOptions {
  dryRun?: boolean;
  /** Called after each record is processed: (phase, done, total). */
  onProgress?: (phase: PolishPhase, done: number, total: number) => void;
  /** Called before every pacing sleep or quota wait, so the UI can explain the pause. */
  onWait?: (wait: PolishWait) => void;
  signal?: AbortSignal;
}

/** PDS repo write costs: 3 points per create, 1 per delete. */
const CREATE_POINTS = 3;
const DELETE_POINTS = 1;
/** applyWrites hard limit per call. */
const MAX_WRITES_PER_BATCH = 200;

/** Extract DID from a Client. */
function getDid(client: Client): string {
  return client.assertDid
}

function collectionFromUri(uri: string): string {
  return uri.split('/').slice(3, -1).join('/');
}

function asPolishRecord(rec: { rkey: string; uri: string; cid: string; value: unknown }): PolishRecord {
  return {
    rkey: rec.rkey,
    uri: rec.uri,
    cid: rec.cid,
    value: (rec.value ?? {}) as Record<string, unknown>,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build a migration plan from raw CAR record lists. Pure and unit-testable.
 * Deduplication is rkey-based, prioritizing the production namespace.
 */
export function buildPolishPlan(
  legacy: { rkey: string; uri: string; cid: string; value: unknown }[],
  production: { rkey: string; uri: string; cid: string; value: unknown }[]
): PolishPlan {
  const productionRkeys = new Set(production.map((rec) => rec.rkey));

  const toBackfill: PolishRecord[] = [];
  const toDedupe: PolishRecord[] = [];

  for (const rec of legacy) {
    const record = asPolishRecord(rec);
    if (productionRkeys.has(record.rkey)) {
      toDedupe.push(record);
    } else {
      toBackfill.push(record);
    }
  }

  return {
    productionTotal: production.length,
    legacyTotal: legacy.length,
    toBackfill,
    toDedupe,
  };
}

/**
 * Fetch both collections via CAR and build a migration plan.
 * Read-only — performs no writes.
 */
export async function analyzeLegacyRecords(client: Client, signal?: AbortSignal): Promise<PolishPlan> {
  const did = getDid(client);
  if (!did) throw new Error('No authenticated session');

  signal?.throwIfAborted();

  const [legacy, production] = await Promise.all([
    fetchRepoViaCARWithClient(client, LEGACY_RECORD_TYPE, did, signal),
    fetchRepoViaCARWithClient(client, RECORD_TYPE, did, signal),
  ]);

  return buildPolishPlan(legacy, production);
}

/**
 * Send one applyWrites batch.
 *
 * Goes through `client.xrpc`, not `client.call`: `call` returns only the
 * response body and discards the `ratelimit-*` headers the limiter needs to
 * learn the PDS's capacity. Retries transient transport failures; a 429 is
 * deliberately not in the retryable list so it reaches the caller intact.
 */
async function sendApplyWrites(
  client: Client,
  did: string,
  writes: ApplyWrite[],
  signal?: AbortSignal,
): Promise<{ headers: HeadersLike; results: unknown[] }> {
  const response = (await retryWithBackoff(
    () =>
      client.xrpc(com.atproto.repo.applyWrites.main as any, {
        body: { repo: did, writes },
        signal,
      } as any),
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      retryableErrors: [
        'fetch failed',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNREFUSED',
        'network',
        'socket hang up',
        'timeout',
        '503',
        '502',
        '504',
      ],
    },
  )) as unknown as { headers?: HeadersLike; body?: { results?: unknown[] } };

  return { headers: response?.headers, results: response?.body?.results ?? [] };
}

type ApplyWrite =
  | { $type: 'com.atproto.repo.applyWrites#create'; collection: string; rkey: string; value: Record<string, unknown> }
  | { $type: 'com.atproto.repo.applyWrites#delete'; collection: string; rkey: string };

interface PhaseContext {
  client: Client;
  did: string;
  rl: RateLimiter;
  pacer: ProactiveRatePacer;
  signal?: AbortSignal;
  onProgress?: PolishMigrateOptions['onProgress'];
  onWait?: PolishMigrateOptions['onWait'];
}

/**
 * Run one write phase (backfill creates or legacy deletes) in paced,
 * rate-limited batches of up to MAX_WRITES_PER_BATCH.
 *
 * Every response's headers feed the limiter, so batch spacing tracks the
 * quota the PDS actually reports. A 429 drains the local quota (using the
 * response's `ratelimit-reset` when present), and the same batch is retried
 * once `waitForPermit` lets it through. applyWrites is atomic, so a batch
 * either lands whole or not at all; a non-429 failure marks the whole batch
 * failed and refunds its reservation, since the server never charged for it.
 */
async function runWritePhase(
  phase: PolishPhase,
  records: PolishRecord[],
  toWrite: (record: PolishRecord) => ApplyWrite,
  pointsPerWrite: number,
  ctx: PhaseContext,
): Promise<{ succeeded: number; failed: number; succeededRkeys: Set<string> }> {
  const { client, did, rl, pacer, signal, onProgress, onWait } = ctx;
  const isCancelled = () => signal?.aborted ?? false;

  const reportWait = (kind: PolishWait['kind'], ms: number, resumeAt: number, reason: string) => {
    if (!onWait) return;
    const cap = rl.getServerCapacity();
    onWait({
      phase,
      kind,
      ms,
      resumeAt,
      remaining: rl.getActualRemaining(),
      limit: cap?.limit ?? 0,
      reason,
    });
  };

  // Each phase sends writes of a different cost (creates 3 points, deletes
  // 1), so an estimate learned from the previous phase would over-pace this
  // one. The quota ledger itself is shared: both phases draw on one bucket.
  rl.resetPointsPerRecordEstimate();

  let succeeded = 0;
  let failed = 0;
  const succeededRkeys = new Set<string>();

  let i = 0;
  while (i < records.length) {
    signal?.throwIfAborted();
    const batch = records.slice(i, i + MAX_WRITES_PER_BATCH);
    const batchPoints = batch.length * pointsPerWrite;

    await rl.waitForPermit(batchPoints, isCancelled, (ms, resumeAt) =>
      reportWait('quota', ms, resumeAt, `quota below safety headroom; waiting for the rate-limit window to reset`),
    );
    signal?.throwIfAborted();

    try {
      const { headers, results } = await sendApplyWrites(client, did, batch.map(toWrite), signal);
      rl.updateFromHeaders(headers, batch.length);

      for (let j = 0; j < batch.length; j++) {
        const result = results[j] as { error?: unknown } | undefined;
        if (result && !('error' in result)) {
          succeeded++;
          succeededRkeys.add(batch[j].rkey);
        } else {
          failed++;
        }
        onProgress?.(phase, succeeded + failed, records.length);
      }
    } catch (err: unknown) {
      if (signal?.aborted) throw err;

      if (isRateLimitError(err)) {
        // The reservation was never spent; give it back before draining so
        // the limiter's ledger matches what the server actually charged.
        rl.refund(batchPoints);
        rl.handleRateLimitHit((err as { headers?: HeadersLike })?.headers);
        // Same batch again: the next waitForPermit blocks until the window
        // the 429 headers described has reset.
        continue;
      }

      rl.refund(batchPoints);
      failed += batch.length;
      onProgress?.(phase, succeeded + failed, records.length);
    }

    i += batch.length;

    if (i < records.length) {
      const cap = rl.getServerCapacity();
      if (cap && rl.hasObservedPointsPerRecord()) {
        const pacing = pacer.calculateDelay(
          batch.length,
          cap.limit,
          cap.windowSeconds,
          rl.getActualRemaining(),
          rl.getPointsPerRecord(pointsPerWrite),
        );
        reportWait('pacing', pacing.delayMs, Date.now() + pacing.delayMs, pacing.reason);
        await sleep(pacing.delayMs, signal);
      }
    }
  }

  return { succeeded, failed, succeededRkeys };
}

/**
 * Execute a migration plan: backfill missing legacy records into the
 * production collection (preserving rkeys), then delete the legacy copies.
 * Each backfilled value passes through `convertLegacyPlay` so alpha-era
 * field formats become valid under the production lexicon.
 *
 * Uses proactive rate limiting to avoid 429s: batches are paced based on
 * server capacity learned from response headers, and 429 responses trigger
 * a quota drain + wait via the RateLimiter.
 *
 * Backfill failures are reported and their legacy copies are retained so no
 * data is ever lost — re-running polish will finish the job.
 */
export async function migrateLegacyRecords(
  client: Client,
  plan: PolishPlan,
  opts: PolishMigrateOptions = {}
): Promise<PolishResult> {
  const did = getDid(client);
  if (!did) throw new Error('No authenticated session');

  const { dryRun = false, onProgress, onWait, signal } = opts;
  signal?.throwIfAborted();

  if (dryRun) {
    return {
      backfilled: plan.toBackfill.length,
      deduped: plan.toDedupe.length,
      deleted: plan.legacyTotal,
      failed: 0,
    };
  }

  const ctx: PhaseContext = {
    client,
    did,
    rl: new RateLimiter({ headroom: 0.15 }),
    pacer: new ProactiveRatePacer(),
    signal,
    onProgress,
    onWait,
  };

  const backfill = await runWritePhase(
    'backfill',
    plan.toBackfill,
    (record) => ({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: RECORD_TYPE,
      rkey: record.rkey,
      value: convertLegacyPlay(record.value),
    }),
    CREATE_POINTS,
    ctx,
  );

  const toDelete = [
    ...plan.toDedupe,
    ...plan.toBackfill.filter((record) => backfill.succeededRkeys.has(record.rkey)),
  ];

  const deletion = await runWritePhase(
    'delete',
    toDelete,
    (record) => ({
      $type: 'com.atproto.repo.applyWrites#delete',
      collection: collectionFromUri(record.uri),
      rkey: record.rkey,
    }),
    DELETE_POINTS,
    ctx,
  );

  return {
    backfilled: backfill.succeeded,
    deduped: plan.toDedupe.length,
    deleted: deletion.succeeded,
    failed: backfill.failed,
  };
}
