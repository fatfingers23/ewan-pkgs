/**
 * Alpha -> production play conversion — environment-agnostic.
 *
 * `fm.teal.alpha.feed.play` stored MusicBrainz IDs as bare UUID strings and
 * used `originUrl` / `musicServiceBaseDomain`. The production
 * `fm.teal.feed.play` lexicon declares `trackMbId`, `recordingMbId`,
 * `releaseMbId` and `artists[].artistMbId` as `format: uri` (`mbid:<uuid>`),
 * and replaces the two location fields with `originUri` / `musicServiceUri`,
 * both `format: uri`. Copying an alpha value verbatim therefore produces a
 * record the production lexicon rejects, so polish runs every backfilled
 * value through here first.
 */

import { RECORD_TYPE } from './config.js';
import { normalizeMusicBrainzId } from './mbid.js';

/** Top-level MusicBrainz fields the production lexicon declares as `mbid:` URIs. */
const MBID_FIELDS = ['trackMbId', 'recordingMbId', 'releaseMbId'] as const;

/**
 * Lexicon `uri` format: a scheme, optional `//`, then a non-empty body with no
 * whitespace. Mirrors @atproto/lexicon's check.
 */
const URI_RE = /^\w+:(?:\/\/)?[^\s/][^\s]*$/;
const MAX_URI_LENGTH = 8 * 1024;

function isLexiconUri(value: unknown): boolean {
  return typeof value === 'string' && value.length <= MAX_URI_LENGTH && URI_RE.test(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Turn an alpha `musicServiceBaseDomain` (e.g. `last.fm`, `music.apple.com`)
 * into the `https://<domain>/` URI production wants. The alpha default of
 * `local` and anything that isn't a hostname yield undefined so the field is
 * omitted rather than fabricated.
 */
function serviceDomainToUri(domain: unknown): string | undefined {
  const trimmed = asString(domain)?.trim();
  if (!trimmed) return undefined;
  if (isLexiconUri(trimmed)) return trimmed;
  const host = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return undefined;
  return `https://${host.toLowerCase()}/`;
}

function normalizeMbidField(target: Record<string, unknown>, key: string): void {
  if (!(key in target)) return;
  const normalized = normalizeMusicBrainzId(asString(target[key]));
  if (normalized) target[key] = normalized;
  else delete target[key];
}

/**
 * Convert an `fm.teal.alpha.feed.play` value into a valid
 * `fm.teal.feed.play` value. Pure: returns a new object and never mutates
 * the input. Fields that cannot be expressed in the production shape are
 * dropped rather than written in a form the lexicon will reject.
 */
export function convertLegacyPlay(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    // Alpha writers emitted `duration: null`; null is not a valid integer.
    if (field === null || field === undefined) continue;
    out[key] = field;
  }

  for (const key of MBID_FIELDS) normalizeMbidField(out, key);

  if (Array.isArray(out.artists)) {
    out.artists = out.artists.map((artist) => {
      if (!artist || typeof artist !== 'object') return artist;
      const copy = { ...(artist as Record<string, unknown>) };
      normalizeMbidField(copy, 'artistMbId');
      return copy;
    });
  }

  if ('originUrl' in out) {
    const legacyUrl = out.originUrl;
    delete out.originUrl;
    if (!('originUri' in out)) out.originUri = legacyUrl;
  }
  if ('originUri' in out && !isLexiconUri(out.originUri)) delete out.originUri;

  if ('musicServiceBaseDomain' in out) {
    const domain = out.musicServiceBaseDomain;
    delete out.musicServiceBaseDomain;
    if (!('musicServiceUri' in out)) {
      const uri = serviceDomainToUri(domain);
      if (uri) out.musicServiceUri = uri;
    }
  }
  if ('musicServiceUri' in out && !isLexiconUri(out.musicServiceUri)) delete out.musicServiceUri;

  out.$type = RECORD_TYPE;
  return out;
}
