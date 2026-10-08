import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en.json';
import ru from '@/i18n/locales/ru.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';

const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
const styles = readFileSync('src/features/quota/QuotaPage.module.scss', 'utf8');

describe('refresh all quota controls', () => {
  test('the header button and the timer refresh every account', () => {
    const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    const header = readFileSync('src/features/quota/components/QuotaHeader.tsx', 'utf8');

    expect(page).toContain('loadQuota(refreshAllQuotaTargets(entries))');
    expect(page).toContain('quotaAutoRefreshDelay(');
    expect(page).toContain('shouldStartQuotaRefresh(');
    expect(page).toContain('showQuotaInitialSkeleton(');
    expect(page).not.toContain('loadQuota(pageItems)');
    expect(header).toContain("t('quota_management.refresh_all_quota')");
    expect(header).toContain("t('quota_management.refresh_every_five_minutes')");
  });

  test('names the button and the five minute cadence in every locale', () => {
    expect(en.quota_management.refresh_all_quota).toBe('Refresh all quota');
    expect(en.quota_management.refresh_every_five_minutes).toBe('Refreshes every 5 minutes');
    for (const locale of [zhCN, zhTW, ru]) {
      expect(locale.quota_management.refresh_all_quota.trim().length).toBeGreaterThan(0);
      expect(locale.quota_management.refresh_every_five_minutes.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('quota toolbar presentation contracts', () => {
  test('uses a named, explicit clear action and restores input focus', () => {
    expect(source).toContain('type="search"');
    expect(source).toContain('ref={searchInputRef}');
    expect(source).toContain('{search && (');
    expect(source).toContain("aria-label={t('quota_management.search_clear')}");
    expect(source).toContain(
      "handleSearchChange('');\n                  searchInputRef.current?.focus();"
    );
    expect(source).toContain('<IconX size={14} aria-hidden="true" />');
    expect(styles).toMatch(/&::-webkit-search-cancel-button,[\s\S]*?appearance: none;/);
  });

  test('groups search and sorting separately from provider navigation', () => {
    const toolbarStart = source.indexOf('<div className={styles.toolbar}>');
    const searchStart = source.indexOf('<div className={styles.search}>');
    const sortStart = source.indexOf('<div className={styles.sort}>');
    expect(toolbarStart).toBeGreaterThan(source.indexOf('<ProviderTabs'));
    expect(searchStart).toBeGreaterThan(toolbarStart);
    expect(sortStart).toBeGreaterThan(searchStart);
    expect(styles).toMatch(/\.toolbar\s*\{[^}]*flex-wrap: wrap;/);
    expect(styles).toContain('&:focus-within');
    expect(styles).toContain('&:focus-visible');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
