import { describe, expect, test } from 'bun:test';
import {
  countRosterHealth,
  glanceQuota,
  matchesRosterFilter,
  rosterHealthOf,
  shortWindowLabel,
  shownRosterWindows,
} from '@/features/quota/rosterModel';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('shortWindowLabel', () => {
  test('keeps the model name when a weekly window is model-scoped', () => {
    expect(shortWindowLabel({ label: '5-hour limit' })).toBe('5h');
    expect(shortWindowLabel({ label: '7-day limit' })).toBe('7d');
    expect(shortWindowLabel({ label: '7-day Fable 5' })).toBe('Fable');
    expect(shortWindowLabel({ label: '7-day Opus' })).toBe('Opus');
    expect(shortWindowLabel({ label: 'GrokBuild usage' })).toBe('Build');
    expect(shortWindowLabel({ label: 'GrokAppBuilder usage' })).toBe('App');
    expect(shortWindowLabel({ label: 'GrokImagine usage' })).toBe('Imagine');
  });
});

describe('glanceQuota', () => {
  test('marks a Claude account used up when any window is full and keeps window order', () => {
    const glance = glanceQuota(
      'claude',
      {
        status: 'success',
        planType: 'plan_max',
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 100,
            resetAtMs: NOW + HOUR,
            periodHours: 5,
          },
          {
            id: 'seven-day',
            label: '7-day limit',
            usedPercent: 41,
            resetAtMs: NOW + 4 * DAY,
            periodHours: 168,
          },
          {
            id: 'fable',
            label: '7-day Fable 5',
            usedPercent: 0,
            resetAtMs: NOW + 4 * DAY,
            periodHours: 168,
          },
        ],
      },
      NOW
    );

    expect(glance.health).toBe('exhausted');
    expect(glance.windows.map((window) => window.shortLabel)).toEqual(['5h', '7d', 'Fable']);
    expect(glance.windows.map((window) => window.usedPercent)).toEqual([100, 41, 0]);
    expect(glance.nextResetMs).toBe(NOW + HOUR);
    expect(glance.plan).toEqual({ key: 'claude_quota.plan_max' });
  });

  test('an open account is one whose windows are all under 100', () => {
    expect(
      rosterHealthOf('claude', {
        status: 'success',
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 12,
            resetAtMs: NOW + HOUR,
            periodHours: 5,
          },
        ],
      })
    ).toBe('available');
  });

  test('xAI glance leads with the weekly window and drops unknown products', () => {
    const glance = glanceQuota(
      'xai',
      {
        status: 'success',
        billing: {
          periodType: 'weekly',
          usagePercent: 1,
          resetAtMs: NOW + 6 * DAY,
          periodHours: 168,
          planLabel: 'SuperGrok Heavy',
          productUsage: [
            { product: 'GrokBuild usage', usagePercent: 1 },
            { product: 'GrokAppBuilder usage', usagePercent: null },
            { product: 'GrokImagine usage', usagePercent: null },
          ],
        },
      },
      NOW
    );

    expect(glance.health).toBe('available');
    expect(glance.plan).toEqual({ text: 'SuperGrok Heavy' });
    expect(glance.windows.map((window) => [window.shortLabel, window.usedPercent])).toEqual([
      ['7d', 1],
      ['Build', 1],
    ]);
    expect(glance.nextResetMs).toBe(NOW + 6 * DAY);
  });

  test('idle, loading, and error stay out of the used-up bucket', () => {
    expect(rosterHealthOf('claude', undefined)).toBe('idle');
    expect(rosterHealthOf('claude', { status: 'loading' })).toBe('loading');
    expect(rosterHealthOf('claude', { status: 'error' })).toBe('error');
    expect(glanceQuota('claude', undefined, NOW).windows).toEqual([]);
  });

  test('a past reset is not the next reset', () => {
    const glance = glanceQuota(
      'claude',
      {
        status: 'success',
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 10,
            resetAtMs: NOW - HOUR,
            periodHours: 5,
          },
        ],
      },
      NOW
    );
    expect(glance.nextResetMs).toBeNull();
  });
});

describe('roster filters', () => {
  test('used-up, open, not-loaded, and failed partition without double counting', () => {
    const healths = ['exhausted', 'available', 'idle', 'loading', 'error', 'unknown'] as const;
    const counts = countRosterHealth(healths);

    expect(counts).toEqual({
      all: 6,
      exhausted: 1,
      available: 1,
      idle: 2,
      error: 1,
    });
    expect(matchesRosterFilter('unknown', 'available')).toBe(false);
    expect(matchesRosterFilter('loading', 'idle')).toBe(true);
    expect(matchesRosterFilter('exhausted', 'all')).toBe(true);
  });

  test('a row shows three windows and keeps the rest for the detail', () => {
    const windows = ['5h', '7d', 'Fable', 'Opus', 'Sonnet'].map((shortLabel, index) => ({
      label: shortLabel,
      shortLabel,
      usedPercent: index,
    }));
    const { shown, hidden } = shownRosterWindows(windows);
    expect(shown.map((window) => window.shortLabel)).toEqual(['5h', '7d', 'Fable']);
    expect(hidden.map((window) => window.shortLabel)).toEqual(['Opus', 'Sonnet']);
  });
});
