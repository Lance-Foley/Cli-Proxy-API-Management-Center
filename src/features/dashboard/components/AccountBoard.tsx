/**
 * Account board: every AI account on one screen.
 *
 * One row per account, scannable at a glance: is it working right now, how
 * much has it carried in the window, how much quota is left, and when does the
 * next window reset. Full quota detail stays on the quota page.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { formatPercent } from '@/utils/format';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { maskCredentialName } from '@/utils/quota/maskName';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import {
  rosterPlanText,
  rosterWindowTitle,
  shownRosterWindows,
  type RosterHealth,
} from '@/features/quota/rosterModel';
import {
  ACCOUNT_FILTERS,
  matchesAccountFilter,
  type AccountFilter,
  type AccountState,
  type AccountView,
} from '../accounts';
import { Sparkline } from './Sparkline';
import styles from './AccountBoard.module.scss';

const DASH = '—';
const JUST_NOW_MS = 60_000;

const STATE_CLASS: Record<AccountState, string> = {
  ready: styles.stateReady,
  cooling: styles.stateCooling,
  problem: styles.stateProblem,
  disabled: styles.stateDisabled,
};

const QUOTA_HEALTH_CLASS: Partial<Record<RosterHealth, string>> = {
  exhausted: styles.quotaExhausted,
  error: styles.quotaError,
};

export interface AccountBoardProps {
  views: AccountView[];
  /** The first credential read is still in flight. */
  loading: boolean;
  filter: AccountFilter;
  counts: Record<AccountFilter, number>;
  onFilterChange: (filter: AccountFilter) => void;
  maskNames: boolean;
  onToggleMask: () => void;
  quotaRefreshing: boolean;
  canRefreshQuota: boolean;
  onRefreshQuota: () => void;
  resolvedTheme: ResolvedTheme;
  nowMs: number;
  windowLabel: string;
}

export function AccountBoard(props: AccountBoardProps) {
  const {
    views,
    loading,
    filter,
    counts,
    onFilterChange,
    maskNames,
    onToggleMask,
    quotaRefreshing,
    canRefreshQuota,
    onRefreshQuota,
    resolvedTheme,
    nowMs,
    windowLabel,
  } = props;
  const { t } = useTranslation();
  const visible = views.filter((view) => matchesAccountFilter(view, filter));

  return (
    <div className={styles.board}>
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label={t('dashboard.board_filter_label')}>
          {ACCOUNT_FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              className={filter === id ? `${styles.chip} ${styles.chipOn}` : styles.chip}
              aria-pressed={filter === id}
              onClick={() => onFilterChange(id)}
            >
              {id === 'live' && <i className={styles.chipLiveDot} aria-hidden="true" />}
              <span>{t(`dashboard.board_filter_${id}`)}</span>
              <span className={styles.chipCount}>{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className={styles.tools}>
          <button type="button" className={styles.tool} onClick={onToggleMask}>
            {maskNames ? t('quota_management.show_emails') : t('quota_management.hide_emails')}
          </button>
          <button
            type="button"
            className={styles.tool}
            onClick={onRefreshQuota}
            disabled={!canRefreshQuota || quotaRefreshing}
          >
            <IconRefreshCw
              size={13}
              className={quotaRefreshing ? styles.spinning : undefined}
              aria-hidden="true"
            />
            {t('quota_management.refresh_all_quota')}
          </button>
        </div>
      </div>

      {views.length === 0 && loading ? (
        <div className={styles.loadingRows} aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={52} rounded={10} />
          ))}
        </div>
      ) : views.length === 0 ? (
        <EmptyState
          title={t('dashboard.board_empty_title')}
          description={t('dashboard.board_empty_desc')}
          action={
            <Link to="/oauth" className={styles.emptyLink}>
              {t('nav.oauth')}
            </Link>
          }
        />
      ) : visible.length === 0 ? (
        <p className={styles.filterEmpty}>
          {t('dashboard.board_filter_empty')}{' '}
          <button
            type="button"
            className={styles.inlineButton}
            onClick={() => onFilterChange('all')}
          >
            {t('quota_management.roster_clear_filter')}
          </button>
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>{t('dashboard.board_title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.board_col_account')}</th>
                <th scope="col">{t('dashboard.board_col_activity')}</th>
                <th scope="col">
                  {t('dashboard.board_col_traffic')}{' '}
                  <span className={styles.thNote}>{windowLabel}</span>
                </th>
                <th scope="col">{t('dashboard.board_col_quota')}</th>
                <th scope="col">{t('dashboard.board_col_reset')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((view) => (
                <AccountRow
                  key={view.source.key}
                  view={view}
                  maskNames={maskNames}
                  resolvedTheme={resolvedTheme}
                  nowMs={nowMs}
                  windowLabel={windowLabel}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.footnote}>{t('dashboard.board_footnote')}</p>
    </div>
  );
}

interface AccountRowProps {
  view: AccountView;
  maskNames: boolean;
  resolvedTheme: ResolvedTheme;
  nowMs: number;
  windowLabel: string;
}

function AccountRow({ view, maskNames, resolvedTheme, nowMs, windowLabel }: AccountRowProps) {
  const { t, i18n } = useTranslation();
  const { source, quota } = view;
  const locale = i18n.resolvedLanguage;
  const typeLabel = getTypeLabel(t, source.provider);
  const iconSrc = getAuthFileIcon(source.provider, resolvedTheme);
  const name =
    source.kind === 'apiKey'
      ? `${t('dashboard.board_api_key')} ${source.label}`
      : maskNames
        ? maskCredentialName(source.label)
        : source.label;
  const plan = quota ? rosterPlanText(t, quota.plan) : null;

  const lastActive = (() => {
    if (view.lastActiveAtMs === null) return t('dashboard.board_never', { window: windowLabel });
    const at = Math.min(view.lastActiveAtMs, nowMs);
    if (nowMs - at < JUST_NOW_MS) return t('dashboard.board_just_now');
    const relative = formatRelativeInstant(at, nowMs, locale);
    return view.lastActiveExact
      ? relative
      : t('dashboard.board_last_active_estimate', { relative });
  })();

  const stateLabel =
    view.state === 'cooling' && view.retryAtMs !== null
      ? t('dashboard.board_state_cooling_until', {
          relative: formatRelativeInstant(view.retryAtMs, nowMs, locale),
        })
      : t(`dashboard.board_state_${view.state}`);

  const { shown, hidden } = quota ? shownRosterWindows(quota.windows) : { shown: [], hidden: [] };
  const quotaPlaceholder = !quota
    ? t('dashboard.board_quota_none')
    : quota.health === 'loading'
      ? t('quota_management.roster_health_loading')
      : quota.health === 'error'
        ? t('quota_management.roster_health_error')
        : quota.health === 'idle'
          ? t('quota_management.roster_health_idle')
          : t('quota_management.roster_health_unknown');

  const resetMs = quota?.nextResetMs ?? null;

  return (
    <tr className={view.live ? styles.rowLive : undefined}>
      <th scope="row" className={styles.account}>
        <span className={styles.accountInner}>
          <span
            className={styles.iconWrap}
            title={typeLabel}
            style={
              isThemeSurfaceIconProvider(source.provider)
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
            <span className={styles.name} title={name}>
              {name}
            </span>
            <span className={styles.sub}>
              <span className={styles.provider}>{typeLabel}</span>
              {plan && <span className={styles.plan}>{plan}</span>}
              <span className={`${styles.state} ${STATE_CLASS[view.state]}`}>{stateLabel}</span>
              {quota?.health === 'exhausted' && (
                <span className={styles.quotaExhausted}>
                  {t('quota_management.roster_health_exhausted')}
                </span>
              )}
            </span>
          </span>
        </span>
      </th>

      <td className={styles.activity}>
        {view.live ? (
          <span className={styles.livePill}>
            <i className={styles.liveDot} aria-hidden="true" />
            {t('dashboard.board_live')}
          </span>
        ) : (
          <span className={styles.idlePill}>{t('dashboard.board_idle')}</span>
        )}
        <span className={styles.lastActive}>{lastActive}</span>
      </td>

      <td className={styles.traffic}>
        <Sparkline
          points={source.buckets.map((bucket) => bucket.success + bucket.failed)}
          color={view.live ? 'var(--viz-success)' : undefined}
          ariaLabel={t('dashboard.fleet_spark_label', { provider: name })}
          className={styles.spark}
        />
        <span className={styles.trafficNumbers}>
          <b>{view.windowTotal.toLocaleString()}</b>
          <span>{view.successRate === null ? DASH : formatPercent(view.successRate)}</span>
        </span>
      </td>

      <td className={styles.quota}>
        {shown.length === 0 ? (
          <span
            className={`${styles.placeholder} ${quota ? (QUOTA_HEALTH_CLASS[quota.health] ?? '') : ''}`}
          >
            {quotaPlaceholder}
          </span>
        ) : (
          <div className={styles.meters}>
            {shown.map((limit, index) => (
              <div
                key={`${index}:${limit.label}`}
                className={styles.meter}
                title={rosterWindowTitle(t, limit.label)}
              >
                <span className={styles.meterTop}>
                  <span className={styles.meterName}>{limit.shortLabel}</span>
                  <span className={styles.meterPct}>{limit.usedPercent}%</span>
                </span>
                <span className={styles.track} aria-hidden="true">
                  <span className={styles.fill} style={{ width: `${limit.usedPercent}%` }} />
                </span>
              </div>
            ))}
            {hidden.length > 0 && (
              <span
                className={styles.more}
                title={hidden.map((limit) => rosterWindowTitle(t, limit.label)).join(', ')}
              >
                {t('quota_management.roster_more_windows', { count: hidden.length })}
              </span>
            )}
          </div>
        )}
      </td>

      <td className={styles.reset} title={resetMs ? formatInstantShort(resetMs) : undefined}>
        {resetMs ? (
          <>
            <span className={styles.resetRelative}>
              {formatRelativeInstant(resetMs, nowMs, locale)}
            </span>
            <span className={styles.resetAbsolute}>{formatInstantShort(resetMs)}</span>
          </>
        ) : (
          <span className={styles.placeholder}>{DASH}</span>
        )}
      </td>
    </tr>
  );
}
