import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_WINDOW_MS,
  ACTIVITY_BUCKET_MS,
  advanceActivity,
  countActive,
  estimateLastActivityMs,
  isActiveAt,
  parseObservedAtMs,
  type ActivityRecord,
} from '../src/features/dashboard/activity';
import type { RecentRequestBucket } from '../src/utils/recentRequests';

const MINUTE = 60_000;
// 10:13:00 UTC on a bucket-aligned day: the current bucket started at 10:10.
const BUCKET_START = Date.UTC(2026, 9, 8, 10, 10, 0);
const NOW = BUCKET_START + 3 * MINUTE;

const empty = (): RecentRequestBucket => ({ success: 0, failed: 0 });
const busy = (success = 1, failed = 0): RecentRequestBucket => ({ success, failed });

/** Twenty buckets, oldest first; `busyAgo` lists buckets counted back from the current one. */
const window = (busyAgo: number[]): RecentRequestBucket[] =>
  Array.from({ length: 20 }, (_, index) => (busyAgo.includes(19 - index) ? busy() : empty()));

describe('estimateLastActivityMs', () => {
  test('a busy current bucket lands halfway between its start and the snapshot', () => {
    const at = estimateLastActivityMs(window([0]), { receivedAtMs: NOW, observedAtMs: NOW });
    expect(at).toBe(BUCKET_START + 1.5 * MINUTE);
  });

  test('an older bucket lands on its own midpoint', () => {
    const at = estimateLastActivityMs(window([1]), { receivedAtMs: NOW, observedAtMs: NOW });
    expect(at).toBe(BUCKET_START - ACTIVITY_BUCKET_MS / 2);
  });

  test('the newest busy bucket wins', () => {
    const at = estimateLastActivityMs(window([7, 2]), { receivedAtMs: NOW, observedAtMs: NOW });
    expect(at).toBe(BUCKET_START - 2 * ACTIVITY_BUCKET_MS + ACTIVITY_BUCKET_MS / 2);
  });

  test('failures count as activity', () => {
    const buckets = [...window([]).slice(0, 19), busy(0, 2)];
    expect(estimateLastActivityMs(buckets, { receivedAtMs: NOW, observedAtMs: NOW })).not.toBe(
      null
    );
  });

  test('a quiet window has no estimate', () => {
    expect(estimateLastActivityMs(window([]), { receivedAtMs: NOW })).toBe(null);
    expect(estimateLastActivityMs([], { receivedAtMs: NOW })).toBe(null);
  });

  test('server clock skew shifts alignment, not the local reading', () => {
    // Server runs 2 minutes ahead; the snapshot is still 3 minutes into its bucket.
    const serverNow = NOW + 2 * MINUTE;
    const serverBucketStart = Math.floor(serverNow / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS;
    const at = estimateLastActivityMs(window([0]), {
      receivedAtMs: NOW,
      observedAtMs: serverNow,
    });
    const ageAtSnapshot = serverNow - (serverBucketStart + (serverNow - serverBucketStart) / 2);
    expect(at).toBe(NOW - ageAtSnapshot);
  });
});

describe('advanceActivity', () => {
  const clock = { receivedAtMs: NOW, observedAtMs: NOW };
  const at = (ms: number) => ({ receivedAtMs: ms, observedAtMs: ms });
  const record = (overrides: Partial<ActivityRecord>): ActivityRecord => ({
    total: 1,
    lastActiveAtMs: null,
    exact: false,
    sampledAtMs: NOW,
    ...overrides,
  });

  test('first sighting seeds an estimate from buckets', () => {
    const ledger = advanceActivity(
      new Map(),
      [{ key: 'a', total: 10, buckets: window([0]) }],
      clock
    );
    expect(ledger.get('a')).toEqual({
      total: 10,
      lastActiveAtMs: BUCKET_START + 1.5 * MINUTE,
      exact: false,
      sampledAtMs: NOW,
    });
  });

  test('growth between two close polls pins activity to the later one', () => {
    const first = advanceActivity(
      new Map(),
      [{ key: 'a', total: 10, buckets: window([4]) }],
      clock
    );
    const later = NOW + 30_000;
    const second = advanceActivity(
      first,
      [{ key: 'a', total: 12, buckets: window([0, 4]) }],
      at(later)
    );
    expect(second.get('a')).toEqual({
      total: 12,
      lastActiveAtMs: later,
      exact: true,
      sampledAtMs: later,
    });
  });

  test('close polls straddling a bucket boundary pin activity to the boundary', () => {
    // Sampled at 10:19:50; at 10:20:10 the growth sits in the bucket that closed at 10:20.
    const before = BUCKET_START + 9 * MINUTE + 50_000;
    const after = BUCKET_START + 10 * MINUTE + 10_000;
    const prior = new Map([['a', record({ total: 4, lastActiveAtMs: NOW, sampledAtMs: before })]]);
    const next = advanceActivity(prior, [{ key: 'a', total: 5, buckets: window([1]) }], at(after));
    expect(next.get('a')).toMatchObject({
      lastActiveAtMs: BUCKET_START + ACTIVITY_BUCKET_MS,
      exact: true,
    });
  });

  test('growth across a long gap is not "just now"', () => {
    // Regression: hidden for two hours, the last request ~110 minutes ago, and the
    // account read "Live · just now" because growth was stamped with this poll.
    const hiddenAt = NOW - 120 * MINUTE;
    const prior = new Map([
      [
        'a',
        record({
          total: 40,
          lastActiveAtMs: hiddenAt - MINUTE,
          exact: true,
          sampledAtMs: hiddenAt,
        }),
      ],
    ]);
    // Busy bucket 11 back from the current one: [BUCKET_START - 110m, BUCKET_START - 100m).
    const next = advanceActivity(prior, [{ key: 'a', total: 46, buckets: window([11]) }], clock);
    const reading = next.get('a')!;
    expect(reading.exact).toBe(false);
    expect(reading.lastActiveAtMs).toBe(BUCKET_START - 105 * MINUTE);
    expect(isActiveAt(reading, NOW)).toBe(false);
  });

  test('a long gap never places activity before the previous sample', () => {
    // Sampled 2 minutes into the busy bucket [-20m, -10m), then away for 18 minutes.
    const sampledAtMs = BUCKET_START - 18 * MINUTE;
    const prior = new Map([['a', record({ total: 2, lastActiveAtMs: null, sampledAtMs })]]);
    const next = advanceActivity(prior, [{ key: 'a', total: 3, buckets: window([2]) }], clock);
    const bucketEnd = BUCKET_START - ACTIVITY_BUCKET_MS;
    expect(next.get('a')).toMatchObject({
      lastActiveAtMs: sampledAtMs + (bucketEnd - sampledAtMs) / 2,
      exact: false,
    });
  });

  test('an unchanged counter never moves the reading forward but records the sample', () => {
    const seen = NOW - 2 * MINUTE;
    const prior = new Map([['a', record({ total: 12, lastActiveAtMs: seen, exact: true })]]);
    // Six minutes later the current bucket midpoint would be newer than `seen`.
    const later = NOW + 6 * MINUTE;
    const next = advanceActivity(prior, [{ key: 'a', total: 12, buckets: window([0]) }], at(later));
    expect(next.get('a')).toEqual({
      total: 12,
      lastActiveAtMs: seen,
      exact: true,
      sampledAtMs: later,
    });
  });

  test('a counter reset re-seeds from buckets', () => {
    const prior = new Map([
      ['a', record({ total: 900, lastActiveAtMs: NOW - MINUTE, exact: true })],
    ]);
    const next = advanceActivity(prior, [{ key: 'a', total: 3, buckets: window([1]) }], clock);
    expect(next.get('a')).toEqual({
      total: 3,
      lastActiveAtMs: BUCKET_START - ACTIVITY_BUCKET_MS / 2,
      exact: false,
      sampledAtMs: NOW,
    });
  });

  test('a "never seen" reading yields to visible activity even if the total matches', () => {
    // A restart that happens to land on the old total must not hide real traffic.
    const prior = new Map([['a', record({ total: 527 })]]);
    const next = advanceActivity(prior, [{ key: 'a', total: 527, buckets: window([2]) }], clock);
    expect(next.get('a')?.lastActiveAtMs).toBe(
      BUCKET_START - 2 * ACTIVITY_BUCKET_MS + ACTIVITY_BUCKET_MS / 2
    );
  });

  test('a quiet account stays "never seen" across polls', () => {
    const prior = new Map([['a', record({ total: 5, sampledAtMs: NOW - MINUTE })]]);
    const next = advanceActivity(prior, [{ key: 'a', total: 5, buckets: window([]) }], clock);
    expect(next.get('a')).toEqual(record({ total: 5 }));
  });

  test('removed accounts leave the ledger', () => {
    const prior = new Map([['gone', record({ lastActiveAtMs: NOW, exact: true })]]);
    const next = advanceActivity(prior, [{ key: 'kept', total: 0, buckets: [] }], clock);
    expect([...next.keys()]).toEqual(['kept']);
  });

  test('does not mutate the previous ledger', () => {
    const original = record({
      lastActiveAtMs: NOW - MINUTE,
      exact: true,
      sampledAtMs: NOW - MINUTE,
    });
    const prior = new Map([['a', original]]);
    advanceActivity(prior, [{ key: 'a', total: 5, buckets: [] }], clock);
    expect(prior.get('a')).toBe(original);
    expect(original.total).toBe(1);
  });
});

describe('isActiveAt / countActive', () => {
  const record = (lastActiveAtMs: number | null): ActivityRecord => ({
    total: 1,
    lastActiveAtMs,
    exact: true,
    sampledAtMs: NOW,
  });

  test('active means a request finished within the last ten minutes', () => {
    expect(isActiveAt(record(NOW), NOW)).toBe(true);
    expect(isActiveAt(record(NOW), NOW + ACTIVE_WINDOW_MS)).toBe(true);
    expect(isActiveAt(record(NOW), NOW + ACTIVE_WINDOW_MS + 1)).toBe(false);
  });

  test('accounts with no visible request are never active', () => {
    expect(isActiveAt(record(null), NOW)).toBe(false);
    expect(isActiveAt(undefined, NOW)).toBe(false);
  });

  test('counts only the active records', () => {
    const ledger = new Map([
      ['live', record(NOW - MINUTE)],
      ['stale', record(NOW - 11 * MINUTE)],
      ['never', record(null)],
    ]);
    expect(countActive(ledger, NOW)).toBe(1);
  });
});

describe('parseObservedAtMs', () => {
  test('reads ISO stamps and rejects anything else', () => {
    expect(parseObservedAtMs('2026-10-08T10:13:00Z')).toBe(NOW);
    expect(parseObservedAtMs('')).toBe(null);
    expect(parseObservedAtMs('soon')).toBe(null);
    expect(parseObservedAtMs(12)).toBe(null);
  });
});
