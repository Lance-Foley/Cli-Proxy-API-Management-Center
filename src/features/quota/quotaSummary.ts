/**
 * Per-provider rollup for the summary strip above the credential list.
 *
 * Pure: no React, no clock of its own. Reads each credential through the timeline lane
 * builder, which already knows where every provider keeps its windows.
 */

import { QUOTA_TAB_ORDER } from './constants';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { buildTimelineLane, DAY_MS } from './quotaTimelineModel';

export interface ProviderSummary {
  provider: QuotaProviderType;
  credentialCount: number;
  loadedCount: number;
  /** Label of the headline limit, or null when nothing has loaded. */
  label: string | null;
  /** Remaining percent per credential, entry order; null = unknown. */
  segments: Array<number | null>;
  /** Sum of known remaining percents, or null when none are known. */
  remainingTotal: number | null;
  /** 100 per credential, loaded or not. */
  capacityTotal: number;
  /** Soonest future reset across credentials. */
  nextResetMs: number | null;
}

const HEADLINE_SPAN_HOURS = 14 * (DAY_MS / 3_600_000);

export function buildProviderSummaries(
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  nowMs: number
): ProviderSummary[] {
  const summaries: ProviderSummary[] = [];

  QUOTA_TAB_ORDER.forEach((provider) => {
    const group = entries.filter((entry) => entry.type === provider);
    if (group.length === 0) return;

    const segments: Array<number | null> = [];
    const labelVotes = new Map<string, number>();
    let remainingTotal = 0;
    let known = 0;
    let loadedCount = 0;
    let nextResetMs: number | null = null;

    group.forEach((entry) => {
      const quota = quotaFor(entry);
      if (quota?.status === 'success') loadedCount += 1;
      const lane = buildTimelineLane({
        name: entry.file.name,
        displayName: entry.file.name,
        provider,
        quota,
        maxPeriodHours: HEADLINE_SPAN_HOURS,
      });
      segments.push(lane.remaining);
      if (lane.remaining === null) return;

      known += 1;
      remainingTotal += lane.remaining;
      // Name the window that was counted. Matching on an equal percentage picked
      // whichever window happened to share the number (xAI read "GrokBuild" for
      // its weekly total; Claude could read "5-hour limit" for the 7-day one).
      if (lane.label) labelVotes.set(lane.label, (labelVotes.get(lane.label) ?? 0) + 1);
      if (lane.anchorMs !== null && lane.anchorMs > nowMs) {
        nextResetMs = nextResetMs === null ? lane.anchorMs : Math.min(nextResetMs, lane.anchorMs);
      }
    });

    let label: string | null = null;
    let best = 0;
    labelVotes.forEach((votes, candidate) => {
      if (votes > best) {
        best = votes;
        label = candidate;
      }
    });

    summaries.push({
      provider,
      credentialCount: group.length,
      loadedCount,
      label,
      segments,
      remainingTotal: known > 0 ? Math.round(remainingTotal) : null,
      capacityTotal: group.length * 100,
      nextResetMs,
    });
  });

  return summaries;
}
