import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import { buildProviderSummaries } from '@/features/quota/quotaSummary';

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const HOUR = 3_600_000;

const entry = (name: string, type: QuotaFileEntry['type']): QuotaFileEntry => ({
  file: { name } as AuthFileItem,
  type,
});

const claudeQuota = (usedPercent: number, resetInHours: number): QuotaCardState =>
  ({
    status: 'success',
    windows: [
      {
        id: 'seven-day',
        label: '7-day limit',
        usedPercent,
        resetAtMs: NOW + resetInHours * HOUR,
        periodHours: 168,
      },
    ],
  }) as unknown as QuotaCardState;

describe('buildProviderSummaries', () => {
  test('pools remaining percent against 100 per credential and finds the soonest reset', () => {
    const a = entry('claude-a.json', 'claude');
    const b = entry('claude-b.json', 'claude');
    const quotas = new Map<QuotaFileEntry, QuotaCardState>([
      [a, claudeQuota(40, 30)],
      [b, claudeQuota(0, 10)],
    ]);

    const [summary] = buildProviderSummaries([a, b], (e) => quotas.get(e), NOW);

    expect(summary.provider).toBe('claude');
    expect(summary.credentialCount).toBe(2);
    expect(summary.loadedCount).toBe(2);
    expect(summary.segments).toEqual([60, 100]);
    expect(summary.remainingTotal).toBe(160);
    expect(summary.capacityTotal).toBe(200);
    expect(summary.label).toBe('7-day limit');
    expect(summary.nextResetMs).toBe(NOW + 10 * HOUR);
  });

  test('unloaded credentials count toward capacity but not remaining', () => {
    const a = entry('claude-a.json', 'claude');
    const b = entry('claude-b.json', 'claude');
    const quotas = new Map<QuotaFileEntry, QuotaCardState>([[a, claudeQuota(83, 5)]]);

    const [summary] = buildProviderSummaries([a, b], (e) => quotas.get(e), NOW);

    expect(summary.segments).toEqual([17, null]);
    expect(summary.remainingTotal).toBe(17);
    expect(summary.capacityTotal).toBe(200);
    expect(summary.loadedCount).toBe(1);
  });

  test('reports no remaining total when nothing has loaded, and ignores past resets', () => {
    const a = entry('xai-a.json', 'xai');
    const [idle] = buildProviderSummaries([a], () => undefined, NOW);
    expect(idle.remainingTotal).toBeNull();
    expect(idle.label).toBeNull();
    expect(idle.nextResetMs).toBeNull();

    const c = entry('claude-c.json', 'claude');
    const [stale] = buildProviderSummaries([c], () => claudeQuota(10, -2), NOW);
    expect(stale.nextResetMs).toBeNull();
  });

  test('omits providers without credentials and keeps tab order', () => {
    const summaries = buildProviderSummaries(
      [entry('kimi.json', 'kimi'), entry('claude.json', 'claude')],
      () => undefined,
      NOW
    );
    expect(summaries.map((s) => s.provider)).toEqual(['claude', 'kimi']);
  });
});

describe('buildProviderSummaries headline', () => {
  test('pools the account-wide 7-day limit, not a model-scoped window that resets sooner', () => {
    // Regression: the strip read "7-day Fable 5 · 15% of 300%" while the 7-day
    // limits were 93%, 15%, and 74% — Fable's reset is milliseconds earlier.
    const withFable = (weeklyUsed: number, resetInHours: number): QuotaCardState =>
      ({
        status: 'success',
        windows: [
          {
            id: 'seven-day',
            label: '7-day limit',
            usedPercent: weeklyUsed,
            resetAtMs: NOW + resetInHours * HOUR + 400,
            periodHours: 168,
          },
          {
            id: 'seven-day-fable',
            label: '7-day Fable 5',
            usedPercent: 0,
            resetAtMs: NOW + resetInHours * HOUR + 100,
            periodHours: 168,
          },
        ],
      }) as unknown as QuotaCardState;

    const entries = ['a', 'b', 'c'].map((name) => entry(`claude-${name}.json`, 'claude'));
    const quotas = new Map<QuotaFileEntry, QuotaCardState>([
      [entries[0], withFable(93, 54)],
      [entries[1], withFable(15, 160)],
      [entries[2], withFable(74, 46)],
    ]);

    const [summary] = buildProviderSummaries(entries, (e) => quotas.get(e), NOW);

    expect(summary.label).toBe('7-day limit');
    expect(summary.segments).toEqual([7, 85, 26]);
    expect(summary.remainingTotal).toBe(118); // 182% used of 300%
  });
});

describe('buildProviderSummaries names the counted window', () => {
  test('xAI reads as its weekly total, not the first product', () => {
    // Regression: the strip read "GrokBuild · 38%" — 38% is the weekly total;
    // GrokBuild itself was 36%.
    const xai = entry('xai-a.json', 'xai');
    const quota = {
      status: 'success',
      billing: {
        periodType: 'weekly',
        usagePercent: 38,
        resetAtMs: NOW + 100 * HOUR,
        periodHours: 168,
        productUsage: [
          { product: 'GrokBuild', usagePercent: 36 },
          { product: 'GrokAppBuilder', usagePercent: 2 },
        ],
      },
    } as unknown as QuotaCardState;

    const [summary] = buildProviderSummaries([xai], () => quota, NOW);

    expect(summary.label).toBe('xai_quota.weekly_limit');
    expect(summary.remainingTotal).toBe(62);
  });

  test('Claude names the 7-day limit even when the 5-hour shares its percent', () => {
    const claude = entry('claude-a.json', 'claude');
    const quota = {
      status: 'success',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 36,
          resetAtMs: NOW + HOUR,
          periodHours: 5,
        },
        {
          id: 'seven-day',
          label: '7-day limit',
          usedPercent: 36,
          resetAtMs: NOW + 50 * HOUR,
          periodHours: 168,
        },
      ],
    } as unknown as QuotaCardState;

    const [summary] = buildProviderSummaries([claude], () => quota, NOW);

    expect(summary.label).toBe('7-day limit');
  });
});
