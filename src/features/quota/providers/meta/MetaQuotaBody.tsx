import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetaQuotaState } from '@/types';
import { useNow } from '@/hooks/useNow';
import { buildResetDisplay } from '@/utils/quota';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps } from '../../types';

export function MetaQuotaBody({ quota, classes }: QuotaBodyProps<MetaQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const soonestRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('meta', quota), now),
    [quota, now]
  );
  const data = quota.data;
  if (!data) return <div className={classes.quotaMessage}>{t('meta_quota.empty_data')}</div>;

  return (
    <>
      {(data.planName || data.isSubscriptionActive !== undefined) && (
        <div className={classes.codexPlan}>
          {data.planName && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('meta_quota.plan')}</span>
              <span className={classes.codexPlanValue}>{data.planName}</span>
            </span>
          )}
          {data.isSubscriptionActive !== undefined && (
            <span className={classes.codexPlanValue}>
              {t(data.isSubscriptionActive ? 'meta_quota.active' : 'meta_quota.inactive')}
            </span>
          )}
        </div>
      )}
      {data.windows.every((window) => window.usedPercent === null) && (
        <div className={classes.quotaMessage}>{t('meta_quota.empty_data')}</div>
      )}
      {data.windows.map((window, index) => {
        const used =
          window.usedPercent === null
            ? null
            : Math.max(0, Math.min(100, Math.round(window.usedPercent)));
        const resetDisplay = buildResetDisplay(
          null,
          window.resetAt === undefined ? null : window.resetAt * 1000,
          now,
          i18n.resolvedLanguage
        );
        const soon = window.id === soonestRowId;
        const label =
          window.id === 'window' && window.durationMinutes
            ? t('meta_quota.window_duration', { minutes: window.durationMinutes })
            : t(`meta_quota.${window.id}`);
        return (
          <div key={window.id} className={classes.quotaRow}>
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{label}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {used === null ? t('meta_quota.unknown') : `${used}%`}
                </span>
                {resetDisplay && (
                  <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
                )}
              </div>
            </div>
            <div
              role={used === null ? undefined : 'meter'}
              aria-label={used === null ? undefined : label}
              aria-valuemin={used === null ? undefined : 0}
              aria-valuemax={used === null ? undefined : 100}
              aria-valuenow={used ?? undefined}
            >
              <QuotaMeter percent={used} classes={classes} index={index} />
            </div>
          </div>
        );
      })}
    </>
  );
}
