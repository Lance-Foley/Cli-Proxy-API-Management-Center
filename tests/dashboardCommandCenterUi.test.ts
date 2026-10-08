import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en.json';
import ru from '@/i18n/locales/ru.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';

const page = readFileSync('src/features/dashboard/DashboardPage.tsx', 'utf8');
const board = readFileSync('src/features/dashboard/components/AccountBoard.tsx', 'utf8');
const boardStyles = readFileSync(
  'src/features/dashboard/components/AccountBoard.module.scss',
  'utf8'
);
const hook = readFileSync('src/features/dashboard/hooks/useDashboardOverview.ts', 'utf8');

const keysOf = (locale: { dashboard: Record<string, string> }) =>
  Object.keys(locale.dashboard).sort();

describe('command center locales', () => {
  test('every locale carries the same dashboard keys', () => {
    const english = keysOf(en);
    for (const locale of [zhCN, zhTW, ru]) {
      expect(keysOf(locale)).toEqual(english);
    }
  });

  test('every dashboard key used in the page and board exists', () => {
    const used = new Set(
      [
        ...page.matchAll(/t\('dashboard\.([a-z_]+)'/g),
        ...board.matchAll(/t\('dashboard\.([a-z_]+)'/g),
      ].map((match) => match[1])
    );
    // Template keys built at runtime.
    [
      'board_filter_all',
      'board_filter_live',
      'board_filter_idle',
      'board_filter_attention',
    ].forEach((key) => used.add(key));
    ['ready', 'cooling', 'problem', 'disabled'].forEach((state) =>
      used.add(`board_state_${state}`)
    );
    for (const key of used) {
      for (const locale of [en, zhCN, zhTW, ru]) {
        expect(
          (locale.dashboard as Record<string, string>)[key]?.trim().length ?? 0
        ).toBeGreaterThan(0);
      }
    }
  });

  test('the board says it counts accounts, not sessions', () => {
    expect(en.dashboard.board_footnote).toContain('not report individual coding sessions');
    expect(en.dashboard.vital_active_hint).toContain('last 10 minutes');
  });
});

describe('account board accessibility', () => {
  test('filters are a labelled group of pressed-state toggles', () => {
    expect(board).toContain('role="group"');
    expect(board).toContain("aria-label={t('dashboard.board_filter_label')}");
    expect(board).toContain('aria-pressed={filter === id}');
  });

  test('the table has a caption and row headers', () => {
    expect(board).toContain('<caption className={styles.srOnly}>');
    expect(board).toContain('<th scope="row"');
  });

  test('motion stops for reduced-motion users and controls show focus', () => {
    expect(boardStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.liveDot,[\s\S]*animation: none;/
    );
    expect(boardStyles).toContain('&:focus-visible');
  });
});

describe('status announcements', () => {
  test('the visible status line is not a live region; transitions are announced separately', () => {
    const line = page.slice(page.indexOf('className={`${styles.liveStatus}'));
    expect(line.slice(0, line.indexOf('</p>'))).not.toContain('role="status"');
    expect(page).toMatch(
      /<span className=\{styles\.srOnly\} role="status">\s*\{liveAnnouncement\}/
    );
    // The announcement carries no clock, so it changes only when the state does.
    const announcement = page.slice(page.indexOf('const liveAnnouncement'));
    expect(announcement.slice(0, announcement.indexOf(';'))).not.toContain('formatClock');
  });

  test('the scrollable board is a focusable, labelled region', () => {
    expect(board).toMatch(/className=\{styles\.tableWrap\}\s*role="region"/);
    expect(board).toContain('tabIndex={0}');
    expect(boardStyles).toMatch(/\.tableWrap \{[\s\S]*?&:focus-visible/);
  });
});

describe('live polling contract', () => {
  test('API-key activity is stamped with the usage fetch time, not the render time', () => {
    expect(hook).toContain('receivedAtMs: usageFetchedAtMs');
    expect(hook).not.toMatch(/advanceActivity\(scope\.apiKeys[\s\S]{0,120}Date\.now\(\)/);
  });

  test('polls only while connected and visible, and drops superseded responses', () => {
    expect(hook).toContain('connected && pageVisible ? DASHBOARD_LIVE_POLL_MS : null');
    expect(hook).toContain('revision === apiClient.getConnectionRevision()');
    expect(hook).toContain('requestId === listRequestRef.current');
  });

  test('a failed poll keeps the last good board instead of blanking it', () => {
    expect(hook).toContain('if (isCurrent()) setPollFailed(true);');
    expect(hook).not.toContain('setSnapshot(null)');
  });
});
