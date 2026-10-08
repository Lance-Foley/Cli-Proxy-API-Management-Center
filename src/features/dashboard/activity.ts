/**
 * Which accounts are working right now.
 *
 * The management API does not expose session IDs, so activity is tracked per
 * account: an account is active when it finished a request within the last
 * ten minutes. Two backend signals feed that, and neither alone is enough:
 *
 * - `recent_requests`: ten-minute buckets aligned to the Unix clock, the last
 *   one still filling. A non-empty bucket only bounds when a request finished.
 * - lifetime `success` + `failed`: when the sum grows between two polls, a
 *   request finished between those polls.
 *
 * Buckets seed the first reading with the middle of the newest busy bucket;
 * counter growth replaces it with the poll time from then on. An unchanged
 * counter never moves the reading forward — nothing new happened.
 *
 * Pure: no React, no clock of its own.
 */

import type { RecentRequestBucket } from '@/utils/recentRequests';

export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const ACTIVITY_BUCKET_MS = 10 * 60_000;

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
  /** True once counter growth was seen; false while it is a bucket estimate. */
  exact: boolean;
}

export type ActivityLedger = ReadonlyMap<string, ActivityRecord>;

export interface ActivityClock {
  /** Local time the response arrived. */
  receivedAtMs: number;
  /** Server time of the snapshot. Missing means the local receipt time. */
  observedAtMs?: number | null;
}

const bucketTotal = (bucket: RecentRequestBucket): number => bucket.success + bucket.failed;

/**
 * Midpoint of the newest non-empty bucket, on the local clock.
 *
 * The current bucket ends at the snapshot instant, not ten minutes after it
 * started, so its midpoint never lands in the future. Server time is only used
 * for bucket alignment; the result is shifted onto the local clock through the
 * receipt time so a skewed server clock cannot age or rejuvenate it.
 */
export function estimateLastActivityMs(
  buckets: readonly RecentRequestBucket[],
  clock: ActivityClock
): number | null {
  const observedAtMs = clock.observedAtMs ?? clock.receivedAtMs;
  const currentStartMs = Math.floor(observedAtMs / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS;

  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (bucketTotal(buckets[index]) <= 0) continue;
    const bucketsAgo = buckets.length - 1 - index;
    const startMs = currentStartMs - bucketsAgo * ACTIVITY_BUCKET_MS;
    const endMs = Math.min(startMs + ACTIVITY_BUCKET_MS, observedAtMs);
    const midpointMs = startMs + (endMs - startMs) / 2;
    return clock.receivedAtMs - (observedAtMs - midpointMs);
  }
  return null;
}

/**
 * Fold one poll into the ledger. Accounts missing from `samples` are dropped:
 * a deleted credential must not keep counting as active.
 */
export function advanceActivity(
  previous: ActivityLedger,
  samples: readonly ActivitySample[],
  clock: ActivityClock
): Map<string, ActivityRecord> {
  const next = new Map<string, ActivityRecord>();

  samples.forEach((sample) => {
    const prior = previous.get(sample.key);
    if (prior && sample.total > prior.total) {
      next.set(sample.key, {
        total: sample.total,
        lastActiveAtMs: clock.receivedAtMs,
        exact: true,
      });
      return;
    }
    // An unchanged counter keeps its reading — unless that reading is "never seen",
    // which visible bucket activity contradicts (a restart that landed on the same total).
    if (prior && sample.total === prior.total && prior.lastActiveAtMs !== null) {
      next.set(sample.key, { ...prior });
      return;
    }
    // First sighting, or the counters went backwards because the proxy restarted.
    next.set(sample.key, {
      total: sample.total,
      lastActiveAtMs: estimateLastActivityMs(sample.buckets, clock),
      exact: false,
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
