/**
 * Which accounts are working right now.
 *
 * The management API does not expose session IDs, so activity is tracked per
 * account: an account is active when it finished a request within the last
 * ten minutes. Two backend signals feed that, and neither alone is enough:
 *
 * - `recent_requests`: ten-minute buckets aligned to the Unix clock, the last
 *   one still filling. A non-empty bucket only bounds when a request finished.
 * - lifetime `success` + `failed`: when the sum grows between two samples, a
 *   request finished between those samples.
 *
 * Buckets seed the first reading with the middle of the newest busy bucket.
 * Counter growth between two close samples pins the reading to the later one;
 * growth across a long gap (a hidden tab, failed polls, another route) only
 * narrows the estimate to where that gap overlaps the newest busy bucket. An
 * unchanged counter never moves the reading forward — nothing new happened.
 *
 * Pure: no React, no clock of its own.
 */

import type { RecentRequestBucket } from '@/utils/recentRequests';

export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const ACTIVITY_BUCKET_MS = 10 * 60_000;
/** Samples closer than this (2.5 polls) pin new activity to the later one. */
export const EXACT_SAMPLE_GAP_MS = 75_000;

export interface ActivitySample {
  key: string;
  /** Lifetime success + failed. */
  total: number;
  /** Oldest first; the last bucket holds the snapshot instant. */
  buckets: RecentRequestBucket[];
}

export interface ActivityRecord {
  total: number;
  /** Local clock. Null when no request is visible in the bucket window. */
  lastActiveAtMs: number | null;
  /** True when pinned by close samples; false while it is an estimate. */
  exact: boolean;
  /** Local clock of the sample this record last absorbed. */
  sampledAtMs: number;
}

export type ActivityLedger = ReadonlyMap<string, ActivityRecord>;

export interface ActivityClock {
  /** Local time the data was fetched. */
  receivedAtMs: number;
  /** Server time of the snapshot. Missing means the local receipt time. */
  observedAtMs?: number | null;
}

interface Span {
  startMs: number;
  endMs: number;
}

const bucketTotal = (bucket: RecentRequestBucket): number => bucket.success + bucket.failed;
const midpoint = ({ startMs, endMs }: Span): number => startMs + (endMs - startMs) / 2;

/**
 * The newest non-empty bucket, on the local clock.
 *
 * The current bucket ends at the snapshot instant, not ten minutes after it
 * started. Server time is only used for bucket alignment; the span is shifted
 * onto the local clock through the receipt time so a skewed server clock
 * cannot age or rejuvenate it.
 */
export function newestBusyBucket(
  buckets: readonly RecentRequestBucket[],
  clock: ActivityClock
): Span | null {
  const observedAtMs = clock.observedAtMs ?? clock.receivedAtMs;
  const currentStartMs = Math.floor(observedAtMs / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS;
  const toLocal = (serverMs: number) => clock.receivedAtMs - (observedAtMs - serverMs);

  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (bucketTotal(buckets[index]) <= 0) continue;
    const bucketsAgo = buckets.length - 1 - index;
    const startMs = currentStartMs - bucketsAgo * ACTIVITY_BUCKET_MS;
    const endMs = Math.min(startMs + ACTIVITY_BUCKET_MS, observedAtMs);
    return { startMs: toLocal(startMs), endMs: toLocal(endMs) };
  }
  return null;
}

/** Midpoint of the newest busy bucket, or null for a quiet window. */
export function estimateLastActivityMs(
  buckets: readonly RecentRequestBucket[],
  clock: ActivityClock
): number | null {
  const bucket = newestBusyBucket(buckets, clock);
  return bucket ? midpoint(bucket) : null;
}

/** Where a request that finished after `sinceMs` most likely finished. */
function locateGrowth(
  sample: ActivitySample,
  sinceMs: number,
  clock: ActivityClock
): Pick<ActivityRecord, 'lastActiveAtMs' | 'exact'> {
  const bucket = newestBusyBucket(sample.buckets, clock);
  const endMs = Math.min(clock.receivedAtMs, bucket?.endMs ?? clock.receivedAtMs);

  if (clock.receivedAtMs - sinceMs <= EXACT_SAMPLE_GAP_MS) {
    return { lastActiveAtMs: endMs, exact: true };
  }
  // A long gap: the request finished somewhere in it, inside the newest busy bucket.
  const startMs = Math.min(endMs, Math.max(sinceMs, bucket?.startMs ?? sinceMs));
  return { lastActiveAtMs: midpoint({ startMs, endMs }), exact: false };
}

/**
 * Fold one sample set into the ledger. Accounts missing from `samples` are
 * dropped: a deleted credential must not keep counting as active.
 */
export function advanceActivity(
  previous: ActivityLedger,
  samples: readonly ActivitySample[],
  clock: ActivityClock
): Map<string, ActivityRecord> {
  const next = new Map<string, ActivityRecord>();
  const sampledAtMs = clock.receivedAtMs;

  samples.forEach((sample) => {
    const prior = previous.get(sample.key);
    if (prior && sample.total > prior.total) {
      next.set(sample.key, {
        total: sample.total,
        ...locateGrowth(sample, prior.sampledAtMs, clock),
        sampledAtMs,
      });
      return;
    }
    // An unchanged counter keeps its reading — unless that reading is "never seen",
    // which visible bucket activity contradicts (a restart that landed on the same total).
    if (prior && sample.total === prior.total && prior.lastActiveAtMs !== null) {
      next.set(sample.key, { ...prior, sampledAtMs });
      return;
    }
    // First sighting, or the counters went backwards because the proxy restarted.
    next.set(sample.key, {
      total: sample.total,
      lastActiveAtMs: estimateLastActivityMs(sample.buckets, clock),
      exact: false,
      sampledAtMs,
    });
  });

  return next;
}

export function isActiveAt(record: ActivityRecord | undefined, nowMs: number): boolean {
  if (!record || record.lastActiveAtMs === null) return false;
  return nowMs - record.lastActiveAtMs <= ACTIVE_WINDOW_MS;
}

export function countActive(ledger: ActivityLedger, nowMs: number): number {
  let active = 0;
  ledger.forEach((record) => {
    if (isActiveAt(record, nowMs)) active += 1;
  });
  return active;
}

/** Parse the auth-files `observed_at` stamp; anything unusable means "use receipt time". */
export function parseObservedAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
