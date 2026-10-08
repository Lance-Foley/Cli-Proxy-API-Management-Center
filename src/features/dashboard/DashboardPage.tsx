import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconBot,
  IconFileText,
  IconSidebarConfig,
  IconSidebarLogs,
  IconSidebarQuota,
  IconSidebarSystem,
} from '@/components/ui/icons';
import { useAuthStore, useThemeStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { formatCompactNumber, formatDateValue, formatPercent } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota';
import { readQuotaUiState, writeQuotaUiState } from '@/features/quota/uiState';
import { useDashboardOverview, DASHBOARD_LIVE_POLL_MS } from './hooks/useDashboardOverview';
import { useAccountQuota } from './hooks/useAccountQuota';
import { AccountBoard } from './components/AccountBoard';
import { LiveWire } from './components/LiveWire';
import { Meter } from './components/Meter';
import { Sparkline } from './components/Sparkline';
import { ThroughputChart } from './components/ThroughputChart';
import { useCountUp, useRevealGroup, useRevealOnScroll } from '@/hooks/motion';
import {
  buildAccountViews,
  countAccountFilters,
  summarizeQuotaHeadroom,
  type AccountFilter,
} from './accounts';
import { providerLabel, splitWindowMinutes, toneForSuccessRate, type MeterTone } from './utils';
import styles from './dashboard.module.scss';

const DASH = '—';

/** KPI 卡左上角色签：有语义色调的卡用状态色，其余保持中性 */
const TILE_ACCENTS: Record<MeterTone, string> = {
  good: 'var(--viz-success)',
  warning: 'var(--amber-color)',
  critical: 'var(--viz-failure)',
  idle: 'var(--text-quaternary)',
};

/** 大数字：六位以内用千分位，再往上压缩，避免撑破排版 */
const formatHeadline = (value: number): string =>
  value < 100_000 ? value.toLocaleString() : formatCompactNumber(value);

const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const {
    connectionStatus,
    connected,
    config,
    counts,
    traffic,
    providers,
    credentials,
    authFiles,
    sources,
    activity,
    lastUpdatedAtMs,
    pollFailed,
    live,
    refresh,
  } = useDashboardOverview();

  useHeaderRefresh(refresh, connected);

  const {
    quotaFor,
    batchLoading: quotaLoading,
    refreshAll: refreshQuota,
  } = useAccountQuota(authFiles, connected, live);

  /* Hero 与静态网格走分组级联；异步内容区（图表/供应商）保持整块 reveal */
  const heroRef = useRevealGroup<HTMLElement>();
  const statsRef = useRevealGroup<HTMLElement>(0.12);
  const boardRef = useRevealOnScroll<HTMLElement>();
  const trafficRef = useRevealOnScroll<HTMLElement>();
  const fleetRef = useRevealOnScroll<HTMLElement>();
  const detailRef = useRevealGroup<HTMLElement>();
  const ctaRef = useRevealGroup<HTMLElement>();

  const animatedTotal = useCountUp(traffic.total, connected);

  // The minute clock drives relative labels; a fresh poll moves "now" forward
  // immediately so a just-seen request never reads as being in the future.
  const minuteNow = useNow();
  const nowMs = Math.max(minuteNow, lastUpdatedAtMs ?? 0);

  const views = useMemo(
    () => buildAccountViews(sources, activity, quotaFor, nowMs),
    [sources, activity, quotaFor, nowMs]
  );
  const filterCounts = useMemo(() => countAccountFilters(views), [views]);
  const headroom = useMemo(() => summarizeQuotaHeadroom(views), [views]);

  const [boardFilter, setBoardFilter] = useState<AccountFilter>('all');
  // Shared with the quota page: one switch decides whether emails are on screen.
  const [showEmails, setShowEmails] = useState<boolean>(
    () => readQuotaUiState()?.showEmails ?? false
  );
  const toggleEmails = useCallback(() => {
    setShowEmails((previous) => {
      writeQuotaUiState({ showEmails: !previous });
      return !previous;
    });
  }, []);

  const windowLabel = useMemo(() => {
    if (traffic.windowMinutes <= 0) return DASH;
    const { hours, minutes } = splitWindowMinutes(traffic.windowMinutes);
    if (hours === 0) return t('dashboard.window_m', { minutes });
    if (minutes === 0) return t('dashboard.window_h', { hours });
    return t('dashboard.window_hm', { hours, minutes });
  }, [traffic.windowMinutes, t]);

  const heroSparkPoints = useMemo(
    () => traffic.buckets.map((bucket) => bucket.success + bucket.failed),
    [traffic.buckets]
  );

  const routingStrategy = useMemo(() => {
    const raw = config?.routingStrategy?.trim() ?? '';
    if (!raw) return DASH;
    if (raw === 'round-robin') return t('basic_settings.routing_strategy_round_robin');
    if (raw === 'weighted-round-robin') {
      return t('basic_settings.routing_strategy_weighted_round_robin');
    }
    if (raw === 'fill-first') return t('basic_settings.routing_strategy_fill_first');
    return raw;
  }, [config?.routingStrategy, t]);

  const unknownProviderLabel = t('dashboard.provider_unknown');
  const successRateTone = toneForSuccessRate(traffic.successRate);

  /** 标题是算出来的判词，不是写死的口号；句尾句号充当状态灯 */
  const verdict = useMemo(() => {
    if (!connected) {
      return connectionStatus === 'connecting'
        ? { key: 'hero_verdict_connecting', accent: 'var(--amber-color)' }
        : { key: 'hero_verdict_offline', accent: 'var(--text-quaternary)' };
    }
    if (traffic.total === 0 || traffic.successRate === null) {
      return { key: 'hero_verdict_idle', accent: 'var(--text-quaternary)' };
    }
    const keyByTone: Record<MeterTone, string> = {
      good: 'hero_verdict_good',
      warning: 'hero_verdict_warning',
      critical: 'hero_verdict_critical',
      idle: 'hero_verdict_idle',
    };
    return { key: keyByTone[successRateTone], accent: TILE_ACCENTS[successRateTone] };
  }, [connected, connectionStatus, traffic.total, traffic.successRate, successRateTone]);

  /* 句号状态灯只在「有活着的流量」时呼吸；离线/静默时保持安静 */
  const heroAlive = connected && traffic.total > 0;

  const connectionLabel = t(
    connectionStatus === 'connected'
      ? 'common.connected'
      : connectionStatus === 'connecting'
        ? 'common.connecting'
        : 'common.disconnected'
  );
  const versionLabel = serverVersion ? `v${serverVersion.trim().replace(/^[vV]+/, '')}` : null;
  const heroMetaLine = [versionLabel, connectionLabel].filter(Boolean).join(' · ');

  const pollSeconds = Math.round(DASHBOARD_LIVE_POLL_MS / 1000);
  const liveStatus = !connected
    ? null
    : pollFailed
      ? {
          tone: 'warning' as const,
          text:
            lastUpdatedAtMs === null
              ? t('dashboard.status_poll_failed_initial', { seconds: pollSeconds })
              : t('dashboard.status_poll_failed', { time: formatClock(lastUpdatedAtMs) }),
        }
      : live
        ? {
            tone: 'live' as const,
            text:
              lastUpdatedAtMs === null
                ? t('dashboard.status_live', { seconds: pollSeconds })
                : t('dashboard.status_live_updated', {
                    seconds: pollSeconds,
                    time: formatClock(lastUpdatedAtMs),
                  }),
          }
        : { tone: 'paused' as const, text: t('dashboard.status_paused') };

  // Until the first credential read lands, "0 of 0" would be a claim, not a fact.
  const accountsLoaded = connected && authFiles !== null;
  const activeTotal = views.length;
  const activeCount = filterCounts.live;
  const activeTone: MeterTone =
    !accountsLoaded || activeTotal === 0 ? 'idle' : activeCount > 0 ? 'good' : 'idle';

  const quotaTone: MeterTone =
    headroom.tracked === 0 || headroom.open + headroom.exhausted === 0
      ? 'idle'
      : headroom.open === 0
        ? 'critical'
        : headroom.exhausted > 0
          ? 'warning'
          : 'good';
  const quotaHint = (() => {
    if (headroom.tracked === 0) return t('dashboard.vital_quota_none');
    if (headroom.exhausted > 0 && headroom.nextRecoveryMs !== null) {
      return t('dashboard.vital_quota_recovery', {
        count: headroom.exhausted,
        relative: formatRelativeInstant(headroom.nextRecoveryMs, nowMs, i18n.resolvedLanguage),
      });
    }
    if (headroom.nextResetMs !== null) {
      return t('dashboard.vital_quota_next_reset', {
        relative: formatRelativeInstant(headroom.nextResetMs, nowMs, i18n.resolvedLanguage),
      });
    }
    return quotaLoading
      ? t('quota_management.roster_health_loading')
      : t('dashboard.vital_quota_pending');
  })();

  const credentialsTone: MeterTone | undefined = credentials
    ? credentials.unavailable > 0
      ? 'warning'
      : credentials.active > 0
        ? 'good'
        : 'idle'
    : undefined;

  const runtimeRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('dashboard.runtime_routing'), value: routingStrategy },
    { label: t('dashboard.runtime_retry'), value: String(config?.requestRetry ?? 0) },
    {
      label: t('dashboard.stat_provider_keys'),
      value: counts.providerKeys === null ? DASH : counts.providerKeys.toLocaleString(),
    },
    {
      label: t('dashboard.stat_models'),
      value: counts.models === null ? DASH : counts.models.toLocaleString(),
    },
    {
      label: t('dashboard.runtime_management_keys'),
      value: counts.managementKeys === null ? DASH : String(counts.managementKeys),
    },
    { label: t('dashboard.runtime_version'), value: serverVersion?.trim() || DASH },
    {
      label: t('dashboard.runtime_build'),
      value: formatDateValue(serverBuildDate, i18n.language) || DASH,
    },
    { label: t('dashboard.runtime_proxy'), value: config?.proxyUrl?.trim() || DASH, mono: true },
  ];

  const runtimeToggles = config
    ? [
        { label: t('dashboard.runtime_debug'), on: Boolean(config.debug) },
        { label: t('dashboard.runtime_file_logging'), on: Boolean(config.loggingToFile) },
        { label: t('dashboard.runtime_request_log'), on: Boolean(config.requestLog) },
        { label: t('dashboard.runtime_ws_auth'), on: Boolean(config.wsAuth) },
        { label: t('dashboard.runtime_model_prefix'), on: Boolean(config.forceModelPrefix) },
      ]
    : [];

  const ctaCards = [
    {
      to: '/ai-providers',
      icon: <IconBot size={18} />,
      title: t('nav.ai_providers'),
      description: t('dashboard.cta_providers_desc'),
    },
    {
      to: '/auth-files',
      icon: <IconFileText size={18} />,
      title: t('nav.auth_files'),
      description: t('dashboard.cta_auth_files_desc'),
    },
    {
      to: '/config',
      icon: <IconSidebarConfig size={18} />,
      title: t('nav.config_management'),
      description: t('dashboard.cta_config_desc'),
    },
    {
      to: '/quota',
      icon: <IconSidebarQuota size={18} />,
      title: t('nav.quota_management'),
      description: t('dashboard.cta_quota_desc'),
    },
    {
      to: '/logs',
      icon: <IconSidebarLogs size={18} />,
      title: t('nav.logs'),
      description: t('dashboard.cta_logs_desc'),
    },
    {
      to: '/system',
      icon: <IconSidebarSystem size={18} />,
      title: t('nav.system_info'),
      description: t('dashboard.cta_system_desc'),
    },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.ambient} aria-hidden="true">
        <span className={styles.washTop} />
        <span className={styles.gridWash} />
      </div>

      {/* ---------- Command header ---------- */}
      <section className={styles.hero} ref={heroRef}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow} data-reveal>
            {t('dashboard.command_eyebrow')}
          </span>
          <h1 className={styles.heroTitle} data-reveal>
            {t(`dashboard.${verdict.key}`)}
            <span
              className={`${styles.heroPeriod} ${heroAlive ? styles.heroPeriodLive : ''}`}
              style={{ color: verdict.accent }}
            >
              {t('dashboard.hero_period')}
            </span>
          </h1>
          <p className={styles.heroMeta} data-reveal>
            {heroMetaLine}
          </p>
          {liveStatus && (
            <p
              className={`${styles.liveStatus} ${
                liveStatus.tone === 'warning'
                  ? styles.liveStatusWarning
                  : liveStatus.tone === 'paused'
                    ? styles.liveStatusPaused
                    : ''
              }`}
              role="status"
              data-reveal
            >
              <i className={styles.liveStatusDot} aria-hidden="true" />
              {liveStatus.text}
            </p>
          )}
          <div className={styles.heroActions} data-reveal>
            <Link to="/ai-providers" className={styles.primaryAction}>
              {t('dashboard.cta_manage_providers')}
            </Link>
            <Link to="/logs" className={styles.ghostAction}>
              {t('dashboard.cta_inspect_logs')}{' '}
              <span className={styles.linkArrow} aria-hidden="true">
                →
              </span>
            </Link>
          </div>
        </div>

        <div className={styles.heroPanel} data-reveal="scale">
          <div className={styles.heroPanelTop}>
            <span className={styles.heroPanelLabel}>{t('dashboard.hero_requests_label')}</span>
            {connected && (
              <span className={styles.liveBadge}>
                <i className={styles.liveDot} aria-hidden="true" />
                {t('dashboard.hero_live')}
              </span>
            )}
          </div>
          <strong className={styles.heroFigure}>
            {connected ? formatHeadline(animatedTotal) : DASH}
          </strong>
          <span className={styles.heroPanelMeta}>
            {t('dashboard.hero_window_meta', { window: windowLabel })}
          </span>
          {traffic.total > 0 && (
            <div className={styles.ratioBar} aria-hidden="true">
              {traffic.totalSuccess > 0 && (
                <span
                  className={`${styles.ratioSegment} ${styles.splitSuccess}`}
                  style={{ flexGrow: traffic.totalSuccess }}
                />
              )}
              {traffic.totalFailure > 0 && (
                <span
                  className={`${styles.ratioSegment} ${styles.splitFailure}`}
                  style={{ flexGrow: traffic.totalFailure }}
                />
              )}
            </div>
          )}
          <div className={styles.heroSplit}>
            <span className={styles.heroSplitItem}>
              <i className={`${styles.splitSwatch} ${styles.splitSuccess}`} aria-hidden="true" />
              {t('stats.success')}
              <b>{traffic.totalSuccess.toLocaleString()}</b>
            </span>
            <span className={styles.heroSplitItem}>
              <i className={`${styles.splitSwatch} ${styles.splitFailure}`} aria-hidden="true" />
              {t('stats.failure')}
              <b>{traffic.totalFailure.toLocaleString()}</b>
            </span>
          </div>
        </div>

        <div className={styles.heroWire}>
          <LiveWire
            points={heroSparkPoints}
            ariaLabel={t('dashboard.hero_spark_label', { window: windowLabel })}
          />
        </div>
      </section>

      {/* ---------- Vitals ---------- */}
      <section className={styles.statsRow} ref={statsRef} aria-label={t('dashboard.stats_aria')}>
        <article
          className={`${styles.statTile} ${styles.statTileFeature}`}
          data-reveal
          style={{ '--tile-accent': TILE_ACCENTS[activeTone] } as React.CSSProperties}
        >
          <span className={styles.statLabel}>
            {activeCount > 0 && <i className={styles.statLiveDot} aria-hidden="true" />}
            {t('dashboard.vital_active')}
          </span>
          <strong className={styles.statValue}>
            {accountsLoaded ? activeCount.toLocaleString() : DASH}
            {accountsLoaded && (
              <span className={styles.statUnit}>
                {t('dashboard.vital_active_of', { total: activeTotal })}
              </span>
            )}
          </strong>
          {activeTotal > 0 && (
            <span className={styles.dotStrip} aria-hidden="true">
              {views.map((view) => (
                <i
                  key={view.source.key}
                  className={
                    view.live
                      ? `${styles.stripDot} ${styles.stripDotLive}`
                      : view.state === 'disabled'
                        ? `${styles.stripDot} ${styles.stripDotOff}`
                        : styles.stripDot
                  }
                />
              ))}
            </span>
          )}
          <span className={styles.statHint}>{t('dashboard.vital_active_hint')}</span>
        </article>

        <article
          className={styles.statTile}
          data-reveal
          style={{ '--tile-accent': TILE_ACCENTS[successRateTone] } as React.CSSProperties}
        >
          <span className={styles.statLabel}>{t('dashboard.success_rate')}</span>
          <strong className={styles.statValue}>
            {traffic.successRate === null ? DASH : formatPercent(traffic.successRate)}
          </strong>
          {traffic.successRate !== null && (
            <Meter
              value={traffic.successRate}
              tone={successRateTone}
              ariaLabel={t('dashboard.success_rate')}
              className={styles.statMeter}
            />
          )}
          <span className={styles.statHint}>
            {t('dashboard.stat_success_hint', { total: traffic.total.toLocaleString() })}
          </span>
        </article>

        <article
          className={styles.statTile}
          data-reveal
          style={{ '--tile-accent': TILE_ACCENTS[quotaTone] } as React.CSSProperties}
        >
          <span className={styles.statLabel}>{t('dashboard.vital_quota')}</span>
          <strong className={styles.statValue}>
            {headroom.tracked === 0 ? DASH : headroom.open.toLocaleString()}
            {headroom.tracked > 0 && (
              <span className={styles.statUnit}>
                {t('dashboard.vital_quota_of', { total: headroom.tracked })}
              </span>
            )}
          </strong>
          {headroom.tracked > 0 && (
            <span className={styles.quotaStrip} aria-hidden="true">
              {views.map(({ source, quota }) => {
                if (!quota) return null;
                // Same language as the board's meters: the green fill is quota used.
                const mostUsed = quota.windows.reduce(
                  (max, window) => Math.max(max, window.usedPercent),
                  0
                );
                return (
                  <i
                    key={source.key}
                    className={`${styles.quotaCell} ${
                      quota.health === 'error' ? styles.quotaCellFailed : ''
                    }`}
                  >
                    <b className={styles.quotaCellFill} style={{ width: `${mostUsed}%` }} />
                  </i>
                );
              })}
            </span>
          )}
          <span className={styles.statHint}>{quotaHint}</span>
        </article>

        <article
          className={styles.statTile}
          data-reveal
          style={
            {
              '--tile-accent': credentialsTone
                ? TILE_ACCENTS[credentialsTone]
                : 'var(--border-hover)',
            } as React.CSSProperties
          }
        >
          <span className={styles.statLabel}>{t('dashboard.stat_credentials')}</span>
          <strong className={styles.statValue}>
            {credentials ? credentials.total.toLocaleString() : DASH}
          </strong>
          {credentials && credentials.total > 0 && (
            <Meter
              value={(credentials.active / credentials.total) * 100}
              tone={credentialsTone}
              ariaLabel={t('dashboard.stat_credentials')}
              className={styles.statMeter}
            />
          )}
          <span className={styles.statHint}>
            {credentials
              ? t('dashboard.stat_credentials_hint', {
                  active: credentials.active,
                  disabled: credentials.disabled + credentials.unavailable,
                })
              : t('dashboard.stat_credentials_empty')}
          </span>
        </article>
      </section>

      {/* ---------- Account board ---------- */}
      <section className={styles.section} ref={boardRef}>
        <header className={styles.sectionHeadRow}>
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}>{t('dashboard.board_eyebrow')}</span>
            <h2 className={styles.sectionTitle}>{t('dashboard.board_title')}</h2>
            <p className={styles.sectionDescription}>{t('dashboard.board_description')}</p>
          </div>
          <Link to="/quota" className={styles.panelLink}>
            {t('dashboard.board_open_quota')}{' '}
            <span className={styles.linkArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </header>
        <AccountBoard
          views={views}
          loading={connected && authFiles === null}
          filter={boardFilter}
          counts={filterCounts}
          onFilterChange={setBoardFilter}
          maskNames={!showEmails}
          onToggleMask={toggleEmails}
          quotaRefreshing={quotaLoading}
          canRefreshQuota={connected && headroom.tracked > 0}
          onRefreshQuota={refreshQuota}
          resolvedTheme={resolvedTheme}
          nowMs={nowMs}
          windowLabel={windowLabel}
        />
      </section>

      {/* ---------- Traffic ---------- */}
      <section className={styles.section} ref={trafficRef}>
        <header className={styles.sectionHead}>
          <span className={styles.eyebrow}>{t('dashboard.traffic_eyebrow')}</span>
          <h2 className={styles.sectionTitle}>{t('dashboard.traffic_title')}</h2>
          <p className={styles.sectionDescription}>
            {t('dashboard.traffic_description', { window: windowLabel })}
          </p>
        </header>
        <div className={styles.panel}>
          <ThroughputChart traffic={traffic} />
        </div>
      </section>

      {/* ---------- Provider fleet ---------- */}
      <section className={styles.section} ref={fleetRef}>
        <header className={styles.sectionHead}>
          <span className={styles.eyebrow}>{t('dashboard.fleet_eyebrow')}</span>
          <h2 className={styles.sectionTitle}>{t('dashboard.fleet_title')}</h2>
          <p className={styles.sectionDescription}>
            {t('dashboard.fleet_description_window', { window: windowLabel })}
          </p>
        </header>
        <div className={styles.panel}>
          {providers.length === 0 ? (
            <p className={styles.emptyNote}>{t('dashboard.fleet_empty')}</p>
          ) : (
            <ul className={styles.fleetList}>
              {providers.map((provider, index) => (
                <li key={provider.id} className={styles.fleetRow}>
                  <span className={styles.fleetRank} aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className={styles.fleetIdentity}>
                    <span className={styles.fleetName}>
                      {providerLabel(provider.id, unknownProviderLabel)}
                    </span>
                    <span className={styles.fleetMeta}>
                      {t('dashboard.fleet_credentials', { value: provider.credentials })}
                    </span>
                  </div>
                  <Sparkline
                    points={provider.buckets.map((bucket) => bucket.success + bucket.failed)}
                    ariaLabel={t('dashboard.fleet_spark_label', {
                      provider: providerLabel(provider.id, unknownProviderLabel),
                    })}
                    className={styles.fleetSpark}
                  />
                  <div className={styles.fleetNumbers}>
                    <span className={styles.fleetTotal}>{provider.total.toLocaleString()}</span>
                    <span className={styles.fleetTotalLabel}>
                      {t('dashboard.fleet_lifetime', {
                        value: provider.lifetimeTotal.toLocaleString(),
                      })}
                    </span>
                  </div>
                  <div className={styles.fleetRate}>
                    <span className={styles.fleetRateValue}>
                      {provider.successRate === null ? DASH : formatPercent(provider.successRate)}
                    </span>
                    <Meter
                      value={provider.successRate}
                      ariaLabel={t('dashboard.success_rate')}
                      className={styles.fleetMeter}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ---------- Credential health + runtime ---------- */}
      <section className={styles.detailGrid} ref={detailRef}>
        <div className={styles.panel} data-reveal>
          <header className={styles.panelHead}>
            <span className={styles.eyebrow}>{t('dashboard.health_eyebrow')}</span>
            <h2 className={styles.panelTitle}>{t('dashboard.health_title')}</h2>
          </header>
          {!credentials || credentials.total === 0 ? (
            <p className={styles.emptyNote}>{t('dashboard.health_empty')}</p>
          ) : (
            <>
              <div className={styles.healthBar}>
                {credentials.active > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthActive}`}
                    style={{ flexGrow: credentials.active }}
                  />
                )}
                {credentials.unavailable > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthUnavailable}`}
                    style={{ flexGrow: credentials.unavailable }}
                  />
                )}
                {credentials.disabled > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthDisabled}`}
                    style={{ flexGrow: credentials.disabled }}
                  />
                )}
              </div>
              <ul className={styles.healthLegend}>
                <li>
                  <i className={`${styles.healthKey} ${styles.healthActive}`} aria-hidden="true" />
                  {t('dashboard.health_active')}
                  <b>{credentials.active.toLocaleString()}</b>
                </li>
                <li>
                  <i
                    className={`${styles.healthKey} ${styles.healthUnavailable}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_unavailable')}
                  <b>{credentials.unavailable.toLocaleString()}</b>
                </li>
                <li>
                  <i
                    className={`${styles.healthKey} ${styles.healthDisabled}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_disabled')}
                  <b>{credentials.disabled.toLocaleString()}</b>
                </li>
              </ul>
              <div className={styles.typeBreakdown}>
                <span className={styles.typeBreakdownLabel}>{t('dashboard.health_by_type')}</span>
                <ul className={styles.typeList}>
                  {credentials.byType.map((entry) => (
                    <li key={entry.type} className={styles.typeChip}>
                      {providerLabel(entry.type, unknownProviderLabel)}
                      <b>{entry.count.toLocaleString()}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <Link to="/auth-files" className={styles.panelLink}>
                {t('dashboard.health_link')}{' '}
                <span className={styles.linkArrow} aria-hidden="true">
                  →
                </span>
              </Link>
            </>
          )}
        </div>

        <div className={styles.panel} data-reveal>
          <header className={styles.panelHead}>
            <span className={styles.eyebrow}>{t('dashboard.runtime_eyebrow')}</span>
            <h2 className={styles.panelTitle}>{t('dashboard.runtime_title')}</h2>
          </header>
          <dl className={styles.specList}>
            {runtimeRows.map((row) => (
              <div key={row.label} className={styles.specRow}>
                <dt className={styles.specLabel}>{row.label}</dt>
                <dd className={`${styles.specValue} ${row.mono ? styles.specMono : ''}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {runtimeToggles.length > 0 && (
            <ul className={styles.toggleList}>
              {runtimeToggles.map((toggle) => (
                <li
                  key={toggle.label}
                  className={`${styles.togglePill} ${toggle.on ? styles.toggleOn : styles.toggleOff}`}
                >
                  {toggle.label}
                  <b>{toggle.on ? t('common.yes') : t('common.no')}</b>
                </li>
              ))}
            </ul>
          )}
          <Link to="/config" className={styles.panelLink}>
            {t('dashboard.runtime_link')}{' '}
            <span className={styles.linkArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </section>

      {/* ---------- Jump to ---------- */}
      <section className={styles.section} ref={ctaRef}>
        <header className={styles.sectionHead} data-reveal>
          <span className={styles.eyebrow}>{t('dashboard.cta_eyebrow')}</span>
        </header>
        <nav className={styles.ctaGrid} aria-label={t('dashboard.cta_title')}>
          {ctaCards.map((card) => (
            <Link
              key={card.to}
              to={card.to}
              className={styles.ctaCard}
              title={card.description}
              data-reveal
            >
              <span className={styles.ctaIcon}>{card.icon}</span>
              <span className={styles.ctaText}>
                <span className={styles.ctaTitle}>{card.title}</span>
                <span className={styles.ctaDescription}>{card.description}</span>
              </span>
              <span className={styles.ctaArrow} aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </nav>
      </section>
    </div>
  );
}
