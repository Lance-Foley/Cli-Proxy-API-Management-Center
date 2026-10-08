/**
 * Account board model: one row per AI account the proxy routes through.
 *
 * Two sources, the same split the traffic totals use: credential files
 * (`/credentials`) and config API keys (`api-key-usage`). An `api_key`
 * credential already reported by `api-key-usage` is skipped, so nothing is
 * counted twice.
 *
 * Pure: the store, the clock, and the activity ledger are all passed in.
 */

import { isProblemAuthFile } from '@/features/authFiles/constants';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import { resolveQuotaProviderType } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { glanceQuota, type RosterGlance } from '@/features/quota/rosterModel';
import type { AuthFileItem } from '@/types/authFile';
import { isDisabledAuthFile } from '@/utils/quota/validators';
import {
  normalizeRecentRequestUsageEntry,
  sumRecentRequests,
  type RecentRequestBucket,
  type RecentRequestUsageEntry,
} from '@/utils/recentRequests';
import { isActiveAt, type ActivityLedger, type ActivitySample } from './activity';

export type AccountKind = 'file' | 'apiKey';

export interface AccountSource {
  key: string;
  kind: AccountKind;
  /** Provider id, used for the icon and label. */
  provider: string;
  /** Credential filename, or an already-masked API key. Never a raw key. */
  label: string;
  file: AuthFileItem | null;
  quotaType: QuotaProviderType | null;
  lifetimeTotal: number;
  buckets: RecentRequestBucket[];
  windowSuccess: number;
  windowFailure: number;
}

export type AccountState = 'ready' | 'cooling' | 'problem' | 'disabled';

export interface AccountView {
  source: AccountSource;
  state: AccountState;
  /** Local clock. Null when the account is not cooling or the end is unknown. */
  retryAtMs: number | null;
  live: boolean;
  lastActiveAtMs: number | null;
  /** False while the last-active instant is still a bucket estimate. */
  lastActiveExact: boolean;
  windowTotal: number;
  successRate: number | null;
  /** Null for accounts without a quota provider. */
  quota: RosterGlance | null;
  attention: boolean;
}

export const ACCOUNT_FILTERS = ['all', 'live', 'idle', 'attention'] as const;

export type AccountFilter = (typeof ACCOUNT_FILTERS)[number];

/** Below this many requests a success rate is noise, not a signal. */
const ATTENTION_MIN_REQUESTS = 5;
const ATTENTION_SUCCESS_RATE = 80;

/** `api-key-usage` keys look like `<baseUrl>|<apiKey>`. */
export const apiKeyFromCompositeKey = (compositeKey: string): string => {
  const separatorIndex = compositeKey.indexOf('|');
  return separatorIndex < 0 ? '' : compositeKey.slice(separatorIndex + 1).trim();
};

export const providerIdOfAuthFile = (file: AuthFileItem): string => {
  const candidate = String(file.type ?? file.provider ?? '')
    .trim()
    .toLowerCase();
  return candidate && candidate !== 'empty' ? candidate : 'unknown';
};

export type ApiKeyUsageByProvider = ReadonlyMap<
  string,
  ReadonlyMap<string, RecentRequestUsageEntry>
>;

export function apiKeysInUsage(usage: ApiKeyUsageByProvider): Set<string> {
  const keys = new Set<string>();
  usage.forEach((entries) =>
    entries.forEach((_, compositeKey) => {
      const apiKey = apiKeyFromCompositeKey(compositeKey);
      if (apiKey) keys.add(apiKey);
    })
  );
  return keys;
}

/** True when `api-key-usage` already reports this credential. */
export function isCoveredByApiKeyUsage(
  file: AuthFileItem,
  usageKeys: ReadonlySet<string>
): boolean {
  const accountType = String(file.account_type ?? '')
    .trim()
    .toLowerCase();
  const account = String(file.account ?? '').trim();
  return accountType === 'api_key' && account !== '' && usageKeys.has(account);
}

const windowCounts = (buckets: RecentRequestBucket[]) => {
  const { success, failure } = sumRecentRequests(buckets);
  return { windowSuccess: success, windowFailure: failure };
};

export function accountSourcesFromFiles(
  files: readonly AuthFileItem[],
  usageKeys: ReadonlySet<string>
): AccountSource[] {
  return files
    .filter((file) => !isCoveredByApiKeyUsage(file, usageKeys))
    .map((file) => {
      const entry = normalizeRecentRequestUsageEntry(file);
      return {
        key: `file:${file.name}\0${String(file.authIndex ?? '')}`,
        kind: 'file' as const,
        provider: providerIdOfAuthFile(file),
        label: file.name,
        file,
        quotaType: resolveQuotaProviderType(file),
        lifetimeTotal: entry.success + entry.failed,
        buckets: entry.recentRequests,
        ...windowCounts(entry.recentRequests),
      };
    });
}

export function accountSourcesFromApiKeyUsage(
  usage: ApiKeyUsageByProvider,
  maskKey: (apiKey: string) => string
): AccountSource[] {
  const sources: AccountSource[] = [];
  usage.forEach((entries, provider) => {
    entries.forEach((entry, compositeKey) => {
      sources.push({
        key: `api:${provider}\0${compositeKey}`,
        kind: 'apiKey',
        provider,
        label: maskKey(apiKeyFromCompositeKey(compositeKey)),
        file: null,
        quotaType: null,
        lifetimeTotal: entry.success + entry.failed,
        buckets: entry.recentRequests,
        ...windowCounts(entry.recentRequests),
      });
    });
  });
  return sources;
}

export const activitySamples = (sources: readonly AccountSource[]): ActivitySample[] =>
  sources.map((source) => ({
    key: source.key,
    total: source.lifetimeTotal,
    buckets: source.buckets,
  }));

function accountState(
  file: AuthFileItem | null,
  nowMs: number
): Pick<AccountView, 'state' | 'retryAtMs'> {
  if (!file) return { state: 'ready', retryAtMs: null };
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  if (isDisabledAuthFile(file) || status === 'disabled') {
    return { state: 'disabled', retryAtMs: null };
  }

  const snapshot = file.cooldownSnapshot;
  if (snapshot?.records) {
    const credentialWide = summarizeCooldowns(snapshot, nowMs).rows.filter(
      (row) => row.record.scope === 'credential' && row.remainingSeconds > 0
    );
    if (credentialWide.length > 0) {
      const seconds = Math.min(...credentialWide.map((row) => row.remainingSeconds));
      return { state: 'cooling', retryAtMs: nowMs + seconds * 1000 };
    }
  }
  if (file.unavailable === true) return { state: 'cooling', retryAtMs: null };
  if (isProblemAuthFile(file)) return { state: 'problem', retryAtMs: null };
  return { state: 'ready', retryAtMs: null };
}

function needsAttention(view: Omit<AccountView, 'attention'>): boolean {
  if (view.state === 'cooling' || view.state === 'problem') return true;
  if (view.quota?.health === 'exhausted' || view.quota?.health === 'error') return true;
  return (
    view.successRate !== null &&
    view.windowTotal >= ATTENTION_MIN_REQUESTS &&
    view.successRate < ATTENTION_SUCCESS_RATE
  );
}

/** Live first, then accounts needing attention, then the rest; disabled sinks. */
const rankOf = (view: AccountView): number => {
  if (view.live) return 0;
  if (view.attention) return 1;
  if (view.state === 'disabled') return 3;
  return 2;
};

export function compareAccountViews(a: AccountView, b: AccountView): number {
  const rank = rankOf(a) - rankOf(b);
  if (rank !== 0) return rank;
  const aSeen = a.lastActiveAtMs ?? -Infinity;
  const bSeen = b.lastActiveAtMs ?? -Infinity;
  if (aSeen !== bSeen) return bSeen > aSeen ? 1 : -1;
  return b.windowTotal - a.windowTotal || a.source.label.localeCompare(b.source.label);
}

export function buildAccountViews(
  sources: readonly AccountSource[],
  ledger: ActivityLedger,
  quotaFor: (source: AccountSource) => QuotaCardState | undefined,
  nowMs: number
): AccountView[] {
  return sources
    .map((source) => {
      const record = ledger.get(source.key);
      const windowTotal = source.windowSuccess + source.windowFailure;
      const base = {
        source,
        ...accountState(source.file, nowMs),
        live: isActiveAt(record, nowMs),
        lastActiveAtMs: record?.lastActiveAtMs ?? null,
        lastActiveExact: record?.exact ?? false,
        windowTotal,
        successRate: windowTotal > 0 ? (source.windowSuccess / windowTotal) * 100 : null,
        quota: source.quotaType ? glanceQuota(source.quotaType, quotaFor(source), nowMs) : null,
      };
      return { ...base, attention: needsAttention(base) };
    })
    .sort(compareAccountViews);
}

export function matchesAccountFilter(view: AccountView, filter: AccountFilter): boolean {
  if (filter === 'live') return view.live;
  if (filter === 'idle') return !view.live && view.state !== 'disabled';
  if (filter === 'attention') return view.attention;
  return true;
}

export function countAccountFilters(views: readonly AccountView[]): Record<AccountFilter, number> {
  const counts: Record<AccountFilter, number> = {
    all: views.length,
    live: 0,
    idle: 0,
    attention: 0,
  };
  views.forEach((view) => {
    if (matchesAccountFilter(view, 'live')) counts.live += 1;
    if (matchesAccountFilter(view, 'idle')) counts.idle += 1;
    if (matchesAccountFilter(view, 'attention')) counts.attention += 1;
  });
  return counts;
}

export interface QuotaHeadroom {
  /** Accounts with a quota provider. */
  tracked: number;
  open: number;
  exhausted: number;
  failed: number;
  /** Not loaded yet, loading, or loaded without windows. */
  pending: number;
  /** Soonest reset across every tracked account. */
  nextResetMs: number | null;
  /** Soonest reset among used-up accounts: when capacity comes back. */
  nextRecoveryMs: number | null;
}

const soonest = (current: number | null, candidate: number | null): number | null =>
  candidate === null ? current : current === null ? candidate : Math.min(current, candidate);

export function summarizeQuotaHeadroom(views: readonly AccountView[]): QuotaHeadroom {
  const headroom: QuotaHeadroom = {
    tracked: 0,
    open: 0,
    exhausted: 0,
    failed: 0,
    pending: 0,
    nextResetMs: null,
    nextRecoveryMs: null,
  };
  views.forEach(({ quota }) => {
    if (!quota) return;
    headroom.tracked += 1;
    if (quota.health === 'available') headroom.open += 1;
    else if (quota.health === 'exhausted') headroom.exhausted += 1;
    else if (quota.health === 'error') headroom.failed += 1;
    else headroom.pending += 1;
    headroom.nextResetMs = soonest(headroom.nextResetMs, quota.nextResetMs);
    if (quota.health === 'exhausted') {
      headroom.nextRecoveryMs = soonest(headroom.nextRecoveryMs, quota.nextResetMs);
    }
  });
  return headroom;
}
