/**
 * 额度页纯逻辑：文件归类、tab 过滤、计数、分页。
 * React-free —— 由 tests/quotaPageLogic.test.ts 直接消费。
 */

import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ANTIGRAVITY_CONFIG } from './providers/antigravity/data';
import { CLAUDE_CONFIG } from './providers/claude/data';
import { CODEX_CONFIG } from './providers/codex/data';
import { DEVIN_CONFIG } from './providers/devin/data';
import { KIMI_CONFIG } from './providers/kimi/data';
import { META_CONFIG } from './providers/meta/data';
import { XAI_CONFIG } from './providers/xai/data';
import type { QuotaProviderType } from './providers/types';
import {
  QUOTA_AUTO_REFRESH_MS,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';

const QUOTA_FILTER_MAP: Record<QuotaProviderType, (file: AuthFileItem) => boolean> = {
  antigravity: ANTIGRAVITY_CONFIG.filterFn,
  claude: CLAUDE_CONFIG.filterFn,
  codex: CODEX_CONFIG.filterFn,
  devin: DEVIN_CONFIG.filterFn,
  kimi: KIMI_CONFIG.filterFn,
  meta: META_CONFIG.filterFn,
  xai: XAI_CONFIG.filterFn,
};

export interface QuotaFileEntry {
  file: AuthFileItem;
  type: QuotaProviderType;
}

/** Every classified quota account. The current page, tab, and search do not narrow this list. */
export function refreshAllQuotaTargets<T>(entries: readonly T[]): T[] {
  return [...entries];
}

export function shouldStartQuotaRefresh(input: {
  controlsDisabled: boolean;
  listLoading: boolean;
  batchLoading: boolean;
  alreadyRunning: boolean;
}): boolean {
  return (
    !input.controlsDisabled && !input.listLoading && !input.batchLoading && !input.alreadyRunning
  );
}

/** Null pauses useInterval. The timer runs only on a visible, connected quota page. */
export function quotaAutoRefreshDelay(
  pageVisible: boolean,
  controlsDisabled: boolean
): number | null {
  if (!pageVisible || controlsDisabled) return null;
  return QUOTA_AUTO_REFRESH_MS;
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Accounts whose quota was never fetched, or fetched `maxAgeMs` or longer ago.
 * Both the quota page and the dashboard load these on arrival, so a visit
 * shows numbers without a click and a quick return does not refetch.
 */
export function staleQuotaEntries<T extends { file: AuthFileItem }>(
  entries: readonly T[],
  fetchedAtByKey: Readonly<Record<string, number>>,
  nowMs: number,
  maxAgeMs: number = QUOTA_AUTO_REFRESH_MS
): T[] {
  return entries.filter((entry) => {
    const loadedAtMs = fetchedAtByKey[getQuotaCacheKey(entry.file)];
    return loadedAtMs === undefined || nowMs - loadedAtMs >= maxAgeMs;
  });
}

/** The first visit shows skeletons. A later refresh keeps the ledger on screen. */
export function showQuotaInitialSkeleton(loading: boolean, fileCount: number): boolean {
  return loading && fileCount === 0;
}

/** A refresh-all intent belongs to the session that requested a successful list read. */
export function canRefreshQuotaAfterList(
  requestedSession: number,
  currentSession: number,
  filesSession: number | null,
  hasError: boolean,
  disabled: boolean
): boolean {
  return (
    !disabled && !hasError && requestedSession === currentSession && filesSession === currentSession
  );
}

export const resolveQuotaProviderType = (file: AuthFileItem): QuotaProviderType | null =>
  QUOTA_TAB_ORDER.find((type) => QUOTA_FILTER_MAP[type](file)) ?? null;

/**
 * 把文件列表归类为额度条目：不支持额度或已停用的文件被过滤，
 * 结果按 QUOTA_TAB_ORDER 分组排列（'全部' tab 的卡片顺序即由此决定）。
 */
export function classifyQuotaFiles(files: AuthFileItem[]): QuotaFileEntry[] {
  const groups = new Map<QuotaProviderType, QuotaFileEntry[]>(
    QUOTA_TAB_ORDER.map((type) => [type, []])
  );
  for (const file of files) {
    const type = resolveQuotaProviderType(file);
    if (!type) continue;
    groups.get(type)?.push({ file, type });
  }
  return QUOTA_TAB_ORDER.flatMap((type) => groups.get(type) ?? []);
}

export function filterEntriesByTab(entries: QuotaFileEntry[], tab: QuotaTabId): QuotaFileEntry[] {
  if (tab === 'all') return entries;
  return entries.filter((entry) => entry.type === tab);
}

/** Search public account identifiers only; account may contain an API key. */
export function filterEntriesBySearch(entries: QuotaFileEntry[], search: string): QuotaFileEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter(({ file }) =>
    [file.name, file.email].some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(query)
    )
  );
}

/**
 * Order the grid by whichever credential recovers first.
 *
 * The instant is injected rather than read here: quota lives in the store and
 * arrives asynchronously, and keeping this function store-free is what makes
 * the ordering rules directly testable.
 *
 * Credentials with no instant — not loaded yet, failed, or reporting no
 * upcoming reset — sink to the bottom rather than sorting as "now". They keep
 * their incoming provider-grouped order, so the unloaded tail still reads like
 * the default view instead of an arbitrary shuffle. Because loading is
 * click-to-fetch, that tail is most of the list until the user asks for data.
 *
 * The original index is the final tiebreak, making stability an asserted
 * property rather than an assumption about the engine's sort.
 */
export function sortQuotaEntries(
  entries: QuotaFileEntry[],
  mode: QuotaSortMode,
  resolveNextRecoveryMs: (entry: QuotaFileEntry) => number | null
): QuotaFileEntry[] {
  if (mode !== 'soonest') return [...entries];

  // Decorate once — resolving pokes at provider-shaped state per entry.
  return entries
    .map((entry, index) => ({ entry, index, atMs: resolveNextRecoveryMs(entry) }))
    .sort((a, b) => {
      if (a.atMs === null && b.atMs === null) return a.index - b.index;
      if (a.atMs === null) return 1;
      if (b.atMs === null) return -1;
      return a.atMs - b.atMs || a.index - b.index;
    })
    .map((decorated) => decorated.entry);
}

export function buildTabCounts(entries: QuotaFileEntry[]): Record<string, number> {
  const counts: Record<string, number> = { all: entries.length };
  for (const type of QUOTA_TAB_ORDER) {
    counts[type] = 0;
  }
  for (const entry of entries) {
    counts[entry.type] += 1;
  }
  return counts;
}

export const isQuotaRefreshDisabled = (
  canRefresh: boolean,
  loading: boolean,
  resetting: boolean
): boolean => !canRefresh || loading || resetting;

export interface QuotaPagination<T> {
  pageItems: T[];
  currentPage: number;
  totalPages: number;
}

/** 页码越界时收敛到有效区间（列表缩短后停留在最后一页而不是空页）。 */
export function paginate<T>(items: T[], page: number, pageSize: number): QuotaPagination<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    pageItems: items.slice(start, start + pageSize),
    currentPage,
    totalPages,
  };
}
