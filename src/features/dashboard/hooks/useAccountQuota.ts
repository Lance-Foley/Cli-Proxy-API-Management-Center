/**
 * Quota for the command center's account board.
 *
 * Reads the shared quota cache and keeps it warm: whenever the credential list
 * changes (every live poll), accounts whose quota never settled or settled five
 * or more minutes ago are fetched. The quota page uses the same freshness
 * record, so moving between the two pages does not fetch twice.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types/authFile';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { classifyQuotaFiles, staleQuotaEntries } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import type { AccountSource } from '../accounts';

/**
 * @param enabled the connection is up; manual refresh works.
 * @param autoLoad also keep the cache warm (connected and the tab visible).
 */
export function useAccountQuota(files: AuthFileItem[] | null, enabled: boolean, autoLoad: boolean) {
  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const entries = useMemo(() => classifyQuotaFiles(files ?? []), [files]);

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const quotaFor = useCallback(
    (source: AccountSource): QuotaCardState | undefined =>
      source.file && source.quotaType
        ? quotaByType[source.quotaType][getQuotaCacheKey(source.file)]
        : undefined,
    [quotaByType]
  );

  useEffect(() => {
    if (!enabled || !autoLoad || batchLoading) return;
    const due = staleQuotaEntries(entries, useQuotaStore.getState().fetchedAtByKey, Date.now());
    if (due.length > 0) void loadQuota(due);
  }, [autoLoad, batchLoading, enabled, entries, loadQuota]);

  const refreshAll = useCallback(() => {
    if (!enabled || entries.length === 0) return;
    void loadQuota(entries);
  }, [enabled, entries, loadQuota]);

  return { quotaFor, quotaAccountCount: entries.length, batchLoading, refreshAll };
}
