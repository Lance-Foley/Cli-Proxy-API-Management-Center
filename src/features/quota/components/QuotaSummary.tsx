/**
 * Provider rollup strip: one cell per provider with the pooled headline limit
 * ("409% of 500%"), a segment per credential, and the soonest reset.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { ProviderSummary } from '../quotaSummary';
import { rosterWindowTitle } from '../rosterModel';
import styles from './QuotaSummary.module.scss';

export type QuotaSummaryProps = {
  summaries: ProviderSummary[];
  resolvedTheme: ResolvedTheme;
  nowMs: number;
  onSelect: (provider: ProviderSummary['provider']) => void;
};

export function QuotaSummary({ summaries, resolvedTheme, nowMs, onSelect }: QuotaSummaryProps) {
  const { t, i18n } = useTranslation();
  if (summaries.length === 0) return null;

  return (
    <section className={styles.strip} aria-label={t('quota_management.summary_label')}>
      {summaries.map((summary) => {
        const { provider } = summary;
        const iconSrc = getAuthFileIcon(provider, resolvedTheme);
        const typeLabel = getTypeLabel(t, provider);
        const known = summary.segments.filter((value): value is number => value !== null);
        const usedTotal =
          known.length === 0
            ? null
            : Math.round(known.reduce((sum, remaining) => sum + (100 - remaining), 0));
        const reset =
          summary.nextResetMs === null
            ? null
            : `${formatRelativeInstant(summary.nextResetMs, nowMs, i18n.resolvedLanguage)} · ${formatInstantShort(summary.nextResetMs)}`;

        return (
          <button
            key={provider}
            type="button"
            className={styles.cell}
            onClick={() => onSelect(provider)}
            title={typeLabel}
          >
            <span className={styles.top}>
              <span
                className={styles.iconWrap}
                style={
                  isThemeSurfaceIconProvider(provider)
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
              <span className={styles.name}>{typeLabel}</span>
              <span className={styles.count}>
                {t('quota_management.summary_credentials', { count: summary.credentialCount })}
              </span>
            </span>

            <span className={styles.label}>
              {summary.label
                ? rosterWindowTitle(t, summary.label)
                : t('quota_management.summary_no_data')}
            </span>
            <span className={styles.figure}>
              <span className={styles.value}>{usedTotal === null ? '--' : `${usedTotal}%`}</span>
              <span className={styles.of}>
                {t('quota_management.summary_of', { total: summary.capacityTotal })}
              </span>
            </span>

            <span className={styles.segments} aria-hidden="true">
              {summary.segments.map((remaining, index) => {
                const used =
                  remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining));
                return (
                  <span key={index} className={styles.segmentTrack}>
                    <span
                      className={`${styles.segmentFill} ${used === null ? styles.segmentUnknown : styles.segmentHigh}`}
                      style={{ width: `${used ?? 0}%` }}
                    />
                  </span>
                );
              })}
            </span>

            <span className={styles.reset}>{reset ?? t('quota_management.summary_no_reset')}</span>
          </button>
        );
      })}
    </section>
  );
}
