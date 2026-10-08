/**
 * Glance data for the scale ledger.
 *
 * One row has to stay short when there are dozens of accounts, so this reads
 * the same provider shapes the timeline already understands and returns only
 * what a row can show: health, up to a handful of used-percents, the plan,
 * and the soonest reset. The full card still renders every window.
 */

import { normalizePlanType, PREMIUM_CODEX_PLAN_TYPES } from '@/utils/quota';
import type { QuotaProviderType } from './providers/types';
import { buildTimelineLane } from './quotaTimelineModel';
import { nextRecoveryMs } from './resetSchedule';

export const ROSTER_FILTERS = ['all', 'exhausted', 'available', 'idle', 'error'] as const;

export type RosterFilter = (typeof ROSTER_FILTERS)[number];

/** `exhausted` means at least one window is fully used. */
export type RosterHealth = 'idle' | 'loading' | 'error' | 'exhausted' | 'available' | 'unknown';

export interface RosterWindow {
  /** Full label, or an i18n key when the source stored one. */
  label: string;
  /** Short label drawn above the bar. Never painted on the fill. */
  shortLabel: string;
  /** Used percent, 0–100. */
  usedPercent: number;
}

export interface RosterPlan {
  /** i18n key. The caller falls back to `text` when the key is missing. */
  key?: string;
  text?: string;
}

export interface RosterGlance {
  health: RosterHealth;
  windows: RosterWindow[];
  nextResetMs: number | null;
  plan: RosterPlan | null;
}

/** Plan label: the translated key when one exists, else the provider's own text. */
export function rosterPlanText(
  translate: (key: string) => string,
  plan: RosterPlan | null
): string | null {
  if (!plan) return null;
  if (plan.key) {
    const translated = translate(plan.key);
    if (translated && translated !== plan.key) return translated;
  }
  return plan.text ?? null;
}

/** Window labels are stored either as text or as an i18n key. */
export function rosterWindowTitle(translate: (key: string) => string, label: string): string {
  if (!label.includes('.')) return label;
  const translated = translate(label);
  return translated === label ? label : translated;
}

/** How many windows a row draws before it collapses the rest into +N. */
export const ROSTER_WINDOW_CAP = 3;

const clampUsed = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

export function shortWindowLabel(input: {
  label?: string;
  labelKey?: string;
  id?: string;
  periodHours?: number | null;
}): string {
  const blob = `${input.labelKey ?? ''} ${input.id ?? ''} ${input.label ?? ''}`.toLowerCase();

  if (blob.includes('fable')) return 'Fable';
  if (blob.includes('opus')) return 'Opus';
  if (blob.includes('sonnet')) return 'Sonnet';
  if (blob.includes('cowork')) return 'Cowork';
  if (blob.includes('iguana') || blob.includes('necktie')) return 'Iguana';
  if (blob.includes('oauth')) return 'OAuth';
  if (blob.includes('grokbuild')) return 'Build';
  if (blob.includes('appbuilder') || blob.includes('grokapp')) return 'App';
  if (blob.includes('imagine')) return 'Imagine';
  if (
    blob.includes('five') ||
    blob.includes('5-hour') ||
    blob.includes('5 hour') ||
    blob.includes('five-hour')
  ) {
    return '5h';
  }
  if (
    blob.includes('seven_day') ||
    blob.includes('7-day') ||
    blob.includes('7 day') ||
    blob.includes('weekly') ||
    blob.includes('seven-day')
  ) {
    return '7d';
  }
  if (blob.includes('daily')) return 'Day';

  if (typeof input.periodHours === 'number') {
    if (input.periodHours <= 6) return '5h';
    if (input.periodHours >= 144) return '7d';
  }

  const raw = (input.label || input.id || '').replace(/\s+(limit|usage)$/i, '').trim();
  if (!raw) return '—';
  return raw.length > 12 ? `${raw.slice(0, 11)}…` : raw;
}

function windowFromRemaining(
  label: string,
  remaining: number,
  extra?: {
    labelKey?: string;
    id?: string;
    periodHours?: number | null;
  }
): RosterWindow {
  return {
    label,
    shortLabel: shortWindowLabel({ label, ...extra }),
    usedPercent: clampUsed(100 - remaining),
  };
}

export function rosterPlan(provider: QuotaProviderType, quota: unknown): RosterPlan | null {
  const state = quota as { status?: string } | null;
  if (!state || state.status !== 'success') return null;
  const record = quota as Record<string, unknown>;

  if (provider === 'claude') {
    return typeof record.planType === 'string' && record.planType
      ? { key: `claude_quota.${record.planType}` }
      : null;
  }

  if (provider === 'codex') {
    const normalized = normalizePlanType(record.planType);
    if (!normalized) return null;
    if (normalized === 'self_serve_business_prolite')
      return { key: 'codex_quota.plan_business_premium' };
    if (normalized === 'pro') return { key: 'codex_quota.plan_pro' };
    if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
      return { key: 'codex_quota.plan_prolite' };
    }
    if (normalized === 'plus') return { key: 'codex_quota.plan_plus' };
    if (normalized === 'team') return { key: 'codex_quota.plan_team' };
    if (normalized === 'free') return { key: 'codex_quota.plan_free' };
    return { text: String(record.planType || normalized) };
  }

  if (provider === 'xai') {
    const billing = record.billing as { planLabel?: unknown } | null | undefined;
    return typeof billing?.planLabel === 'string' && billing.planLabel
      ? { text: billing.planLabel }
      : null;
  }

  if (provider === 'antigravity') {
    const subscription = record.subscription as { tierName?: unknown; plan?: unknown } | null;
    const text = subscription?.tierName || subscription?.plan;
    return typeof text === 'string' && text ? { text } : null;
  }

  if (provider === 'devin') {
    return typeof record.plan === 'string' && record.plan ? { text: record.plan } : null;
  }

  if (provider === 'meta') {
    const data = record.data as { planName?: unknown } | undefined;
    return typeof data?.planName === 'string' && data.planName ? { text: data.planName } : null;
  }

  return null;
}

function windowsFor(
  provider: QuotaProviderType,
  quota: { status?: string } | undefined
): RosterWindow[] {
  const lane = buildTimelineLane({
    name: '',
    displayName: '',
    provider,
    quota,
  });

  const windows = lane.limits.map((limit) => windowFromRemaining(limit.label, limit.remaining));

  if (provider === 'xai' && lane.remaining !== null) {
    const weekly = windowFromRemaining('xai_quota.weekly_limit', lane.remaining, {
      id: 'weekly',
      periodHours: 168,
    });
    const duplicate = windows.some(
      (window) =>
        window.shortLabel === weekly.shortLabel && window.usedPercent === weekly.usedPercent
    );
    if (!duplicate) windows.unshift(weekly);
  }

  return windows;
}

/** Health ignores the clock. A full window stays full until a refresh says otherwise. */
export function rosterHealthOf(
  provider: QuotaProviderType,
  quota: { status?: string } | undefined
): RosterHealth {
  const status = quota?.status ?? 'idle';
  if (status === 'loading') return 'loading';
  if (status === 'error') return 'error';
  if (status !== 'success') return 'idle';

  const windows = windowsFor(provider, quota);
  if (windows.length === 0) return 'unknown';
  if (windows.some((window) => window.usedPercent >= 100)) return 'exhausted';
  return 'available';
}

export function glanceQuota(
  provider: QuotaProviderType,
  quota: { status?: string } | undefined,
  nowMs: number
): RosterGlance {
  const health = rosterHealthOf(provider, quota);
  if (health === 'idle' || health === 'loading' || health === 'error') {
    return { health, windows: [], nextResetMs: null, plan: null };
  }

  return {
    health,
    windows: windowsFor(provider, quota),
    nextResetMs: nextRecoveryMs(provider, quota, nowMs),
    plan: rosterPlan(provider, quota),
  };
}

export function shownRosterWindows(
  windows: readonly RosterWindow[],
  cap = ROSTER_WINDOW_CAP
): { shown: RosterWindow[]; hidden: RosterWindow[] } {
  return {
    shown: windows.slice(0, cap),
    hidden: windows.slice(cap),
  };
}

export function matchesRosterFilter(health: RosterHealth, filter: RosterFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'idle') return health === 'idle' || health === 'loading';
  if (filter === 'available') return health === 'available';
  return health === filter;
}

export function countRosterHealth(healths: readonly RosterHealth[]): Record<RosterFilter, number> {
  const counts: Record<RosterFilter, number> = {
    all: healths.length,
    exhausted: 0,
    available: 0,
    idle: 0,
    error: 0,
  };
  (['exhausted', 'available', 'idle', 'error'] as const).forEach((filter) => {
    counts[filter] = healths.filter((health) => matchesRosterFilter(health, filter)).length;
  });
  return counts;
}
