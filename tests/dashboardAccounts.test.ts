import { describe, expect, test } from 'bun:test';
import {
  accountSourcesFromApiKeyUsage,
  accountSourcesFromFiles,
  apiKeysInUsage,
  buildAccountViews,
  countAccountFilters,
  matchesAccountFilter,
  summarizeQuotaHeadroom,
  type AccountSource,
} from '@/features/dashboard/accounts';
import type { ActivityRecord } from '@/features/dashboard/activity';
import {
  buildProviderTraffic,
  buildTrafficWindow,
} from '@/features/dashboard/hooks/useDashboardOverview';
import type { QuotaCardState } from '@/features/quota/providers';
import type { AuthFileItem } from '@/types/authFile';
import type { RecentRequestBucket, RecentRequestUsageEntry } from '@/utils/recentRequests';

const NOW = Date.UTC(2026, 9, 8, 16, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const buckets = (...totals: Array<[number, number]>): RecentRequestBucket[] =>
  totals.map(([success, failed]) => ({ success, failed }));

const claudeFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'claude-a@example.dev.json',
  type: 'claude',
  authIndex: '1',
  auth_index: '1',
  success: 100,
  failed: 2,
  recent_requests: buckets([3, 0], [5, 1]),
  ...overrides,
});

const claudeQuota = (usedPercents: number[]): QuotaCardState =>
  ({
    status: 'success',
    planType: 'plan_max',
    windows: usedPercents.map((usedPercent, index) => ({
      id: index === 0 ? 'five-hour' : 'seven-day',
      label: index === 0 ? '5-hour limit' : '7-day limit',
      usedPercent,
      resetAtMs: NOW + (index + 1) * HOUR,
      periodHours: index === 0 ? 5 : 168,
    })),
  }) as unknown as QuotaCardState;

const live = (key: string): [string, ActivityRecord] => [
  key,
  { total: 1, lastActiveAtMs: NOW - 2 * MINUTE, exact: true, sampledAtMs: NOW },
];
const stale = (key: string, agoMs: number): [string, ActivityRecord] => [
  key,
  { total: 1, lastActiveAtMs: NOW - agoMs, exact: true, sampledAtMs: NOW },
];

const noQuota = () => undefined;

describe('account sources', () => {
  test('a credential file carries window and lifetime counts separately', () => {
    const [source] = accountSourcesFromFiles([claudeFile()], new Set());
    expect(source.kind).toBe('file');
    expect(source.provider).toBe('claude');
    expect(source.quotaType).toBe('claude');
    expect(source.lifetimeTotal).toBe(102);
    expect(source.windowSuccess).toBe(8);
    expect(source.windowFailure).toBe(1);
  });

  test('an api_key credential already in api-key-usage is not counted twice', () => {
    const usage = new Map<string, Map<string, RecentRequestUsageEntry>>([
      [
        'claude',
        new Map([
          ['https://api.example|sk-live-123', { success: 4, failed: 0, recentRequests: [] }],
        ]),
      ],
    ]);
    const covered = claudeFile({
      name: 'plugin.json',
      account_type: 'api_key',
      account: 'sk-live-123',
    });
    const sources = accountSourcesFromFiles([covered, claudeFile()], apiKeysInUsage(usage));
    expect(sources.map((source) => source.label)).toEqual(['claude-a@example.dev.json']);
  });

  test('API key accounts are labelled with the masked key, never the raw one', () => {
    const usage = new Map([
      [
        'codex',
        new Map([
          ['https://api.example|sk-secret-abcdef', { success: 1, failed: 0, recentRequests: [] }],
        ]),
      ],
    ]);
    const [source] = accountSourcesFromApiKeyUsage(usage, () => 'sk********ef');
    expect(source.label).toBe('sk********ef · api.example');
    expect(source.key).not.toContain('sk********ef');
    expect(source.quotaType).toBe(null);
    expect(JSON.stringify({ label: source.label, provider: source.provider })).not.toContain(
      'secret'
    );
  });
});

describe('buildAccountViews', () => {
  const sourcesFor = (files: AuthFileItem[]): AccountSource[] =>
    accountSourcesFromFiles(files, new Set());

  test('live means a request in the last ten minutes', () => {
    const [source] = sourcesFor([claudeFile()]);
    const [liveView] = buildAccountViews([source], new Map([live(source.key)]), noQuota, NOW);
    expect(liveView.live).toBe(true);
    const [idleView] = buildAccountViews(
      [source],
      new Map([stale(source.key, 11 * MINUTE)]),
      noQuota,
      NOW
    );
    expect(idleView.live).toBe(false);
    expect(idleView.lastActiveAtMs).toBe(NOW - 11 * MINUTE);
  });

  test('derives disabled, cooling (with its end), problem, and ready states', () => {
    const files = [
      claudeFile({ name: 'off.json', disabled: true }),
      claudeFile({
        name: 'cooling.json',
        unavailable: true,
        cooldownSnapshot: {
          receivedAtMs: NOW,
          records: [
            {
              scope: 'credential',
              reason: 'quota',
              retryAt: new Date(NOW + 47 * MINUTE).toISOString(),
              remainingSeconds: 47 * 60,
            },
          ],
        },
      }),
      claudeFile({ name: 'problem.json', status: 'error', statusMessage: 'token expired' }),
      claudeFile({ name: 'ok.json' }),
    ];
    const views = buildAccountViews(sourcesFor(files), new Map(), noQuota, NOW);
    const byName = Object.fromEntries(views.map((view) => [view.source.label, view]));
    expect(byName['off.json'].state).toBe('disabled');
    expect(byName['cooling.json'].state).toBe('cooling');
    expect(byName['cooling.json'].retryAtMs).toBe(NOW + 47 * MINUTE);
    expect(byName['problem.json'].state).toBe('problem');
    expect(byName['ok.json'].state).toBe('ready');
  });

  test('flags used-up quota, failed quota reads, and a poor success rate', () => {
    const files = [
      claudeFile({ name: 'full.json' }),
      claudeFile({ name: 'broken.json' }),
      claudeFile({ name: 'flaky.json', recent_requests: buckets([3, 7]) }),
      claudeFile({ name: 'fine.json' }),
    ];
    const quotaFor = (source: AccountSource): QuotaCardState | undefined => {
      if (source.label === 'full.json') return claudeQuota([100, 40]);
      if (source.label === 'broken.json')
        return { status: 'error', error: 'HTTP 401' } as QuotaCardState;
      return claudeQuota([20, 30]);
    };
    const views = buildAccountViews(sourcesFor(files), new Map(), quotaFor, NOW);
    const attention = views.filter((view) => view.attention).map((view) => view.source.label);
    expect(attention.sort()).toEqual(['broken.json', 'flaky.json', 'full.json']);
  });

  test('a low success rate on a handful of requests is not an alarm', () => {
    const [view] = buildAccountViews(
      sourcesFor([claudeFile({ recent_requests: buckets([1, 2]) })]),
      new Map(),
      noQuota,
      NOW
    );
    expect(view.successRate).toBeCloseTo(33.33, 1);
    expect(view.attention).toBe(false);
  });

  test('orders live first, then attention, then idle by recency, disabled last', () => {
    const files = [
      claudeFile({ name: 'disabled.json', disabled: true }),
      claudeFile({ name: 'idle-old.json' }),
      claudeFile({ name: 'cooling.json', unavailable: true }),
      claudeFile({ name: 'idle-recent.json' }),
      claudeFile({ name: 'live.json' }),
    ];
    const sources = sourcesFor(files);
    const keyOf = (name: string) => sources.find((source) => source.label === name)!.key;
    const ledger = new Map([
      live(keyOf('live.json')),
      stale(keyOf('idle-recent.json'), 20 * MINUTE),
      stale(keyOf('idle-old.json'), 3 * HOUR),
    ]);
    const order = buildAccountViews(sources, ledger, noQuota, NOW).map((view) => view.source.label);
    expect(order).toEqual([
      'live.json',
      'cooling.json',
      'idle-recent.json',
      'idle-old.json',
      'disabled.json',
    ]);
  });

  test('filters and their counts agree', () => {
    const files = [
      claudeFile({ name: 'live.json' }),
      claudeFile({ name: 'idle.json' }),
      claudeFile({ name: 'cooling.json', unavailable: true }),
      claudeFile({ name: 'off.json', disabled: true }),
    ];
    const sources = sourcesFor(files);
    const views = buildAccountViews(sources, new Map([live(sources[0].key)]), noQuota, NOW);
    const counts = countAccountFilters(views);
    expect(counts).toEqual({ all: 4, live: 1, idle: 2, attention: 1 });
    for (const filter of ['all', 'live', 'idle', 'attention'] as const) {
      expect(views.filter((view) => matchesAccountFilter(view, filter)).length).toBe(
        counts[filter]
      );
    }
  });
});

describe('summarizeQuotaHeadroom', () => {
  test('counts open, used up, failed, and pending accounts and finds the first recovery', () => {
    const files = ['open', 'full', 'failed', 'pending'].map((name) =>
      claudeFile({ name: `${name}.json` })
    );
    const quotaFor = (source: AccountSource): QuotaCardState | undefined => {
      if (source.label === 'open.json') return claudeQuota([10, 20]);
      if (source.label === 'full.json') return claudeQuota([100, 50]);
      if (source.label === 'failed.json') return { status: 'error' } as QuotaCardState;
      return undefined;
    };
    const views = buildAccountViews(
      accountSourcesFromFiles(files, new Set()),
      new Map(),
      quotaFor,
      NOW
    );
    const headroom = summarizeQuotaHeadroom(views);
    expect(headroom).toMatchObject({ tracked: 4, open: 1, exhausted: 1, failed: 1, pending: 1 });
    expect(headroom.nextRecoveryMs).toBe(NOW + HOUR);
    expect(headroom.nextResetMs).toBe(NOW + HOUR);
  });

  test('accounts without a quota provider are not tracked', () => {
    const usage = new Map([
      ['openai', new Map([['https://x|sk-1', { success: 1, failed: 0, recentRequests: [] }]])],
    ]);
    const views = buildAccountViews(
      accountSourcesFromApiKeyUsage(usage, () => '••'),
      new Map(),
      noQuota,
      NOW
    );
    expect(summarizeQuotaHeadroom(views).tracked).toBe(0);
    expect(views[0].quota).toBe(null);
  });
});

describe('provider fleet', () => {
  test('totals cover the bucket window, with lifetime counters kept separate', () => {
    // Regression: the fleet said "over the same window" but summed lifetime counters.
    const sources = accountSourcesFromFiles(
      [
        claudeFile({ name: 'a.json', success: 4000, failed: 40, recent_requests: buckets([9, 1]) }),
        claudeFile({ name: 'b.json', success: 900, failed: 10, recent_requests: buckets([10, 0]) }),
      ],
      new Set()
    );
    const [claude] = buildProviderTraffic(sources);
    expect(claude.total).toBe(20);
    expect(claude.success).toBe(19);
    expect(claude.successRate).toBe(95);
    expect(claude.lifetimeTotal).toBe(4950);
    expect(claude.credentials).toBe(2);
  });

  test('the fleet and the headline agree on the window total', () => {
    const sources = accountSourcesFromFiles(
      [
        claudeFile({ name: 'a.json', recent_requests: buckets([1, 0], [2, 1]) }),
        {
          name: 'x.json',
          type: 'xai',
          success: 50,
          failed: 5,
          recent_requests: buckets([0, 0], [4, 0]),
        },
      ],
      new Set()
    );
    const headline = buildTrafficWindow(sources.map((source) => source.buckets));
    const fleetTotal = buildProviderTraffic(sources).reduce((sum, row) => sum + row.total, 0);
    expect(fleetTotal).toBe(headline.total);
    expect(headline.total).toBe(8);
  });
});
