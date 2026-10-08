import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, authFilesApi } from '@/services/api';
import { useAuthStore, useConfigStore, useModelsStore } from '@/stores';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import { useInterval } from '@/hooks/useInterval';
import { useProviderRecentRequests } from '@/components/providers/hooks/useProviderRecentRequests';
import { mergeRecentRequestBucketGroups, type RecentRequestBucket } from '@/utils/recentRequests';
import type { Config } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import {
  advanceActivity,
  parseObservedAtMs,
  type ActivityClock,
  type ActivityRecord,
} from '../activity';
import {
  accountSourcesFromApiKeyUsage,
  accountSourcesFromFiles,
  activitySamples,
  apiKeysInUsage,
  providerIdOfAuthFile,
  type AccountSource,
} from '../accounts';
import {
  TRAFFIC_BUCKET_MINUTES,
  type CredentialHealth,
  type DashboardCounts,
  type ProviderTraffic,
  type TrafficWindow,
} from '../types';
import { maskApiKey } from '@/utils/format';

/** Live view cadence. The proxy is local, and `/credentials` is an in-memory read. */
export const DASHBOARD_LIVE_POLL_MS = 30_000;

const EMPTY_TRAFFIC: TrafficWindow = {
  buckets: [],
  totalSuccess: 0,
  totalFailure: 0,
  total: 0,
  successRate: null,
  peakTotal: 0,
  peakIndex: -1,
  windowMinutes: 0,
};

export const buildTrafficWindow = (bucketGroups: RecentRequestBucket[][]): TrafficWindow => {
  const buckets = mergeRecentRequestBucketGroups(bucketGroups);
  if (buckets.length === 0) {
    return EMPTY_TRAFFIC;
  }

  let totalSuccess = 0;
  let totalFailure = 0;
  let peakTotal = 0;
  let peakIndex = -1;

  buckets.forEach((bucket, index) => {
    const bucketTotal = bucket.success + bucket.failed;
    totalSuccess += bucket.success;
    totalFailure += bucket.failed;
    if (bucketTotal > peakTotal) {
      peakTotal = bucketTotal;
      peakIndex = index;
    }
  });

  const total = totalSuccess + totalFailure;

  return {
    buckets,
    totalSuccess,
    totalFailure,
    total,
    successRate: total > 0 ? (totalSuccess / total) * 100 : null,
    peakTotal,
    peakIndex,
    windowMinutes: buckets.length * TRAFFIC_BUCKET_MINUTES,
  };
};

/**
 * Per-provider rollup. Totals and success rate cover the same bucket window as
 * the headline and chart; the lifetime counters ride along as a separate field.
 */
export const buildProviderTraffic = (sources: readonly AccountSource[]): ProviderTraffic[] => {
  const groups = new Map<string, AccountSource[]>();
  sources.forEach((source) => {
    const group = groups.get(source.provider) ?? [];
    group.push(source);
    groups.set(source.provider, group);
  });

  return Array.from(groups.entries())
    .map(([id, group]) => {
      const success = group.reduce((sum, source) => sum + source.windowSuccess, 0);
      const failure = group.reduce((sum, source) => sum + source.windowFailure, 0);
      const total = success + failure;
      return {
        id,
        credentials: group.length,
        success,
        failure,
        total,
        lifetimeTotal: group.reduce((sum, source) => sum + source.lifetimeTotal, 0),
        successRate: total > 0 ? (success / total) * 100 : null,
        buckets: mergeRecentRequestBucketGroups(
          group.map((source) => source.buckets).filter((buckets) => buckets.length > 0)
        ),
      };
    })
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.lifetimeTotal - a.lifetimeTotal ||
        b.credentials - a.credentials ||
        a.id.localeCompare(b.id)
    );
};

export const getProviderKeyCounts = (config: Config) => ({
  gemini: config.geminiApiKeys?.length ?? 0,
  interactions: config.interactionsApiKeys?.length ?? 0,
  codex: config.codexApiKeys?.length ?? 0,
  meta: config.metaApiKeys?.length ?? 0,
  xai: config.xaiApiKeys?.length ?? 0,
  claude: config.claudeApiKeys?.length ?? 0,
  vertex: config.vertexApiKeys?.length ?? 0,
  openai: config.openaiCompatibility?.length ?? 0,
});

interface CredentialSnapshot {
  files: AuthFileItem[];
  clock: ActivityClock;
}

/**
 * Activity ledgers outlive the page so a quick trip to another route keeps the
 * exact readings. A new connection or key starts from scratch.
 */
const activityScope = {
  id: '',
  files: new Map<string, ActivityRecord>() as ReadonlyMap<string, ActivityRecord>,
  apiKeys: new Map<string, ActivityRecord>() as ReadonlyMap<string, ActivityRecord>,
};

const activityLedgersFor = (scopeId: string) => {
  if (activityScope.id !== scopeId) {
    activityScope.id = scopeId;
    activityScope.files = new Map();
    activityScope.apiKeys = new Map();
  }
  return activityScope;
};

const usePageVisible = () => {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden
  );
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return visible;
};

/**
 * Everything the command center shows.
 *
 * Traffic comes from two sources that do not overlap: `api-key-usage` (API keys
 * from the config) and `/credentials` (file and runtime credentials). The
 * backend keeps them apart, but a plugin credential could appear in both, so an
 * `api_key` credential already in `api-key-usage` is skipped.
 */
export function useDashboardOverview() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);

  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const modelsError = useModelsStore((state) => state.error);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const connected = connectionStatus === 'connected';
  const pageVisible = usePageVisible();
  const resolveApiKeysForModels = useApiKeysForModels();

  const {
    usageByProvider,
    fetchedAtMs: usageFetchedAtMs,
    refreshRecentRequests,
  } = useProviderRecentRequests({ enabled: connected });

  const [snapshot, setSnapshot] = useState<CredentialSnapshot | null>(null);
  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const listRequestRef = useRef(0);

  const loadAuthFiles = useCallback(async () => {
    if (!connected) return;
    const requestId = ++listRequestRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === listRequestRef.current && revision === apiClient.getConnectionRevision();
    try {
      const response = await authFilesApi.list();
      if (!isCurrent()) return;
      const receivedAtMs = Date.now();
      setSnapshot({
        files: response.files,
        clock: { receivedAtMs, observedAtMs: parseObservedAtMs(response.observedAt) },
      });
      setLastUpdatedAtMs(receivedAtMs);
      setPollFailed(false);
    } catch {
      // Keep the last good board on screen; the status line reports the miss.
      if (isCurrent()) setPollFailed(true);
    }
  }, [connected]);

  const loadModels = useCallback(async () => {
    if (!connected || !apiBase) return;
    try {
      const apiKeys = await resolveApiKeysForModels();
      await fetchModelsFromStore(apiBase, apiKeys[0]);
    } catch {
      // A failed model list must not take the rest of the dashboard down.
    }
  }, [connected, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  // Separate effects: a config refresh changes loadModels' identity, and sharing
  // one effect would let its cleanup cancel an in-flight credential read.
  useEffect(() => {
    if (!connected) return;
    void fetchConfig().catch(() => undefined);
  }, [connected, fetchConfig]);

  useEffect(() => {
    if (!connected) return;
    void loadModels();
  }, [connected, loadModels]);

  useEffect(() => {
    if (!connected) return;
    void loadAuthFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [connected, loadAuthFiles]);

  // The shared usage cache can be minutes old; activity wants a fresh read on arrival.
  useEffect(() => {
    if (!connected) return;
    void refreshRecentRequests().catch(() => undefined);
  }, [connected, refreshRecentRequests]);

  const livePoll = useCallback(() => {
    void loadAuthFiles();
    void refreshRecentRequests().catch(() => undefined);
  }, [loadAuthFiles, refreshRecentRequests]);

  useInterval(livePoll, connected && pageVisible ? DASHBOARD_LIVE_POLL_MS : null);

  // Coming back to the tab: read immediately instead of waiting out the interval.
  const wasVisibleRef = useRef(pageVisible);
  useEffect(() => {
    if (pageVisible && !wasVisibleRef.current && connected) livePoll();
    wasVisibleRef.current = pageVisible;
  }, [connected, livePoll, pageVisible]);

  const refresh = useCallback(async () => {
    if (!connected) return;
    await Promise.allSettled([
      fetchConfig(true),
      loadAuthFiles(),
      loadModels(),
      refreshRecentRequests(),
    ]);
  }, [connected, fetchConfig, loadAuthFiles, loadModels, refreshRecentRequests]);

  const authFiles = snapshot?.files ?? null;
  const usageKeys = useMemo(() => apiKeysInUsage(usageByProvider), [usageByProvider]);
  const fileSources = useMemo(
    () => accountSourcesFromFiles(authFiles ?? [], usageKeys),
    [authFiles, usageKeys]
  );
  const apiKeySources = useMemo(
    () => accountSourcesFromApiKeyUsage(usageByProvider, maskApiKey),
    [usageByProvider]
  );
  const sources = useMemo(() => [...fileSources, ...apiKeySources], [fileSources, apiKeySources]);

  /* ---------- Activity ledgers ----------
   * Folded in effects, not during render. Re-folding the same snapshot is a
   * no-op (unchanged counters keep their reading), so extra runs are harmless. */

  const scopeId = `${apiBase}\0${managementKey}`;
  const [fileLedger, setFileLedger] = useState(() => activityLedgersFor(scopeId).files);
  const [apiKeyLedger, setApiKeyLedger] = useState(() => activityLedgersFor(scopeId).apiKeys);

  useEffect(() => {
    if (!snapshot) return;
    const scope = activityLedgersFor(scopeId);
    scope.files = advanceActivity(scope.files, activitySamples(fileSources), snapshot.clock);
    setFileLedger(scope.files);
  }, [fileSources, snapshot, scopeId]);

  useEffect(() => {
    // Stamp with the fetch time, not "now": cached usage can be minutes old.
    if (!connected || usageFetchedAtMs <= 0) return;
    const scope = activityLedgersFor(scopeId);
    scope.apiKeys = advanceActivity(scope.apiKeys, activitySamples(apiKeySources), {
      receivedAtMs: usageFetchedAtMs,
    });
    setApiKeyLedger(scope.apiKeys);
  }, [apiKeySources, connected, scopeId, usageFetchedAtMs]);

  const activity = useMemo(
    () => new Map<string, ActivityRecord>([...fileLedger, ...apiKeyLedger]),
    [fileLedger, apiKeyLedger]
  );

  const providerKeyCounts = useMemo(() => (config ? getProviderKeyCounts(config) : null), [config]);

  const traffic = useMemo(
    () =>
      buildTrafficWindow(
        sources.map((source) => source.buckets).filter((buckets) => buckets.length > 0)
      ),
    [sources]
  );
  const providers = useMemo(() => buildProviderTraffic(sources), [sources]);

  const credentials = useMemo<CredentialHealth | null>(() => {
    if (!authFiles) return null;

    let disabled = 0;
    let unavailable = 0;
    const countsByType = new Map<string, number>();

    authFiles.forEach((file) => {
      if (file.disabled) {
        disabled += 1;
      } else if (file.unavailable) {
        unavailable += 1;
      }
      const type = providerIdOfAuthFile(file);
      countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
    });

    return {
      total: authFiles.length,
      active: authFiles.length - disabled - unavailable,
      disabled,
      unavailable,
      byType: Array.from(countsByType.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    };
  }, [authFiles]);

  const counts = useMemo<DashboardCounts>(
    () => ({
      managementKeys: config ? (config.apiKeys?.length ?? 0) : null,
      providerKeys: providerKeyCounts
        ? Object.values(providerKeyCounts).reduce((sum, count) => sum + count, 0)
        : null,
      credentials: authFiles ? authFiles.length : null,
      models: modelsLoading || modelsError ? null : models.length,
    }),
    [config, providerKeyCounts, authFiles, models.length, modelsLoading, modelsError]
  );

  return {
    connectionStatus,
    connected,
    config,
    counts,
    providerKeyCounts,
    traffic,
    providers,
    credentials,
    authFiles,
    sources,
    activity,
    lastUpdatedAtMs,
    pollFailed,
    live: connected && pageVisible,
    refresh,
  };
}
