/**
 * Scale ledger: one short row per account, full detail for the selected one.
 *
 * Fifty stacked cards cannot be scanned. The row keeps the name, plan, health,
 * up to three used-percent meters, and the next reset in their own columns.
 * Percents sit above the green fill, never on it. Every window, date, and
 * action still renders in the inspector through the existing card.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { maskCredentialName } from '@/utils/quota/maskName';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import {
  glanceQuota,
  ROSTER_FILTERS,
  rosterPlanText as planText,
  rosterWindowTitle as windowTitle,
  shownRosterWindows,
  type RosterFilter,
  type RosterGlance,
  type RosterHealth,
} from '../rosterModel';
import { QuotaCard } from './QuotaCard';
import styles from './QuotaRoster.module.scss';

const HEALTH_CLASS: Record<RosterHealth, string> = {
  exhausted: styles.healthExhausted,
  available: styles.healthAvailable,
  idle: styles.healthIdle,
  loading: styles.healthLoading,
  error: styles.healthError,
  unknown: styles.healthUnknown,
};

function quotaEntryKey(entry: QuotaFileEntry): string {
  return `${entry.type}:${getQuotaCacheKey(entry.file)}`;
}

export type QuotaRosterProps = {
  entries: QuotaFileEntry[];
  filter: RosterFilter;
  counts: Record<RosterFilter, number>;
  onFilterChange: (filter: RosterFilter) => void;
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  canRefresh: (entry: QuotaFileEntry) => boolean;
  resettingKey: string | null;
  maskNames: boolean;
  nowMs: number;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
};

export function QuotaRoster(props: QuotaRosterProps) {
  const {
    entries,
    filter,
    counts,
    onFilterChange,
    quotaFor,
    resolvedTheme,
    canRefresh,
    resettingKey,
    maskNames,
    nowMs,
    onRefresh,
    onReset,
  } = props;
  const { t, i18n } = useTranslation();
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    entries[0] ? quotaEntryKey(entries[0]) : null
  );

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !entries.some((entry) => quotaEntryKey(entry) === selectedKey)) {
      setSelectedKey(quotaEntryKey(entries[0]));
    }
  }, [entries, selectedKey]);

  const selected = entries.find((entry) => quotaEntryKey(entry) === selectedKey) ?? null;

  const moveSelection = (from: QuotaFileEntry, delta: number, focusRow: HTMLElement) => {
    const index = entries.findIndex((entry) => quotaEntryKey(entry) === quotaEntryKey(from));
    const next = entries[index + delta];
    if (!next) return;
    const key = quotaEntryKey(next);
    setSelectedKey(key);
    const row = focusRow
      .closest('tbody')
      ?.querySelector<HTMLElement>(`[data-roster-key="${CSS.escape(key)}"]`);
    row?.focus();
  };

  const detail = selected ? (
    <QuotaCard
      key={quotaEntryKey(selected)}
      entry={selected}
      quota={quotaFor(selected)}
      resolvedTheme={resolvedTheme}
      canRefresh={canRefresh(selected)}
      resetting={resettingKey === getQuotaCacheKey(selected.file)}
      maskNames={maskNames}
      entranceDelayMs={null}
      quiet
      onRefresh={() => onRefresh(selected)}
      onReset={() => onReset(selected)}
    />
  ) : (
    <p className={styles.detailEmpty}>{t('quota_management.roster_detail_empty')}</p>
  );

  return (
    <div className={styles.roster}>
      <div
        className={styles.filters}
        role="group"
        aria-label={t('quota_management.roster_filter_label')}
      >
        {ROSTER_FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            className={filter === id ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            aria-pressed={filter === id}
            onClick={() => onFilterChange(id)}
          >
            <span>{t(`quota_management.roster_filter_${id}`)}</span>
            <span className={styles.chipCount}>{counts[id]}</span>
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={t('quota_management.roster_filter_empty')}
          action={
            <Button variant="secondary" size="sm" onClick={() => onFilterChange('all')}>
              {t('quota_management.roster_clear_filter')}
            </Button>
          }
        />
      ) : (
        <div className={styles.shell}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>
                {t('quota_management.roster_filter_label')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('quota_management.roster_col_account')}</th>
                  <th scope="col">{t('quota_management.roster_col_windows')}</th>
                  <th scope="col">{t('quota_management.roster_col_reset')}</th>
                  <th scope="col">
                    <span className={styles.srOnly}>{t('auth_files.quota_refresh_single')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const key = quotaEntryKey(entry);
                  const quota = quotaFor(entry);
                  const glance = glanceQuota(entry.type, quota, nowMs);
                  const isSelected = key === selectedKey;
                  const displayName = maskNames
                    ? maskCredentialName(getQuotaDisplayName(entry.file))
                    : getQuotaDisplayName(entry.file);
                  const refreshing =
                    quota?.status === 'loading' || resettingKey === getQuotaCacheKey(entry.file);

                  return (
                    <RosterRow
                      key={key}
                      entry={entry}
                      entryKey={key}
                      glance={glance}
                      displayName={displayName}
                      isSelected={isSelected}
                      resolvedTheme={resolvedTheme}
                      canRefresh={canRefresh(entry)}
                      refreshing={refreshing}
                      nowMs={nowMs}
                      locale={i18n.resolvedLanguage}
                      onSelect={() => setSelectedKey(key)}
                      onMove={(delta, row) => moveSelection(entry, delta, row)}
                      onRefresh={() => onRefresh(entry)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          <aside
            className={styles.inspector}
            aria-label={t('quota_management.roster_detail_title')}
          >
            {detail}
          </aside>
        </div>
      )}
    </div>
  );
}

type RosterRowProps = {
  entry: QuotaFileEntry;
  entryKey: string;
  glance: RosterGlance;
  displayName: string;
  isSelected: boolean;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  refreshing: boolean;
  nowMs: number;
  locale: string | undefined;
  onSelect: () => void;
  onMove: (delta: number, row: HTMLElement) => void;
  onRefresh: () => void;
};

function RosterRow(props: RosterRowProps) {
  const {
    entry,
    entryKey,
    glance,
    displayName,
    isSelected,
    resolvedTheme,
    canRefresh,
    refreshing,
    nowMs,
    locale,
    onSelect,
    onMove,
    onRefresh,
  } = props;
  const { t } = useTranslation();
  const { shown, hidden } = shownRosterWindows(glance.windows);
  const plan = planText(t, glance.plan);
  const iconSrc = getAuthFileIcon(entry.type, resolvedTheme);
  const typeLabel = getTypeLabel(t, entry.type);
  const healthKey =
    glance.health === 'loading' ? 'roster_health_loading' : `roster_health_${glance.health}`;
  const resetAbsolute = glance.nextResetMs ? formatInstantShort(glance.nextResetMs) : null;
  const resetRelative = glance.nextResetMs
    ? formatRelativeInstant(glance.nextResetMs, nowMs, locale)
    : null;

  return (
    <tr
      data-roster-key={entryKey}
      className={isSelected ? styles.selected : undefined}
      aria-selected={isSelected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          onMove(1, event.currentTarget);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          onMove(-1, event.currentTarget);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <th scope="row" className={styles.account}>
        <span className={styles.accountInner}>
          <span
            className={styles.iconWrap}
            title={typeLabel}
            style={
              isThemeSurfaceIconProvider(entry.type)
                ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                : undefined
            }
          >
            {iconSrc ? (
              <img src={iconSrc} alt="" className={styles.icon} />
            ) : (
              <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <span className={styles.identity}>
            <span className={styles.name} title={displayName}>
              {displayName}
            </span>
            <span className={styles.sub}>
              {plan && <span className={styles.plan}>{plan}</span>}
              <span className={`${styles.health} ${HEALTH_CLASS[glance.health]}`}>
                {glance.health === 'exhausted' && (
                  <span className={styles.pip} aria-hidden="true" />
                )}
                {t(`quota_management.${healthKey}`)}
              </span>
            </span>
          </span>
        </span>
      </th>
      <td className={styles.windows}>
        {shown.length === 0 ? (
          <span className={styles.placeholder}>{t(`quota_management.${healthKey}`)}</span>
        ) : (
          <div className={styles.meters}>
            {shown.map((limit, index) => {
              const title = windowTitle(t, limit.label);
              return (
                <div key={`${index}:${limit.label}`} className={styles.meter} title={title}>
                  <span className={styles.meterTop}>
                    <span className={styles.meterName}>{limit.shortLabel}</span>
                    <span className={styles.meterPct}>{limit.usedPercent}%</span>
                  </span>
                  <span className={styles.track} aria-hidden="true">
                    <span className={styles.fill} style={{ width: `${limit.usedPercent}%` }} />
                  </span>
                </div>
              );
            })}
            {hidden.length > 0 && (
              <span
                className={styles.more}
                title={hidden.map((limit) => windowTitle(t, limit.label)).join(', ')}
              >
                {t('quota_management.roster_more_windows', { count: hidden.length })}
              </span>
            )}
          </div>
        )}
      </td>
      <td className={styles.reset} title={resetAbsolute ?? undefined}>
        {resetRelative ? (
          <>
            <span className={styles.resetRelative}>{resetRelative}</span>
            {resetAbsolute && <span className={styles.resetAbsolute}>{resetAbsolute}</span>}
          </>
        ) : (
          <span className={styles.placeholder}>—</span>
        )}
      </td>
      <td className={styles.action}>
        <button
          type="button"
          className={styles.refresh}
          title={t('auth_files.quota_refresh_hint')}
          aria-label={t('auth_files.quota_refresh_single')}
          disabled={isQuotaRefreshDisabled(canRefresh, refreshing, false)}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
            onRefresh();
          }}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
        </button>
      </td>
    </tr>
  );
}
