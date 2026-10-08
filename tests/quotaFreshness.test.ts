import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { QUOTA_AUTO_REFRESH_MS } from '@/features/quota/constants';
import { staleQuotaEntries } from '@/features/quota/logic';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { AuthFileItem } from '@/types/authFile';

const NOW = Date.UTC(2026, 9, 8, 16, 0, 0);
const entry = (name: string) => ({ file: { name, type: 'claude' } as AuthFileItem });

describe('staleQuotaEntries', () => {
  test('never-loaded and expired accounts are due; fresh ones are not', () => {
    const entries = [entry('never.json'), entry('old.json'), entry('fresh.json')];
    const loadedAt = {
      'old.json': NOW - QUOTA_AUTO_REFRESH_MS,
      'fresh.json': NOW - QUOTA_AUTO_REFRESH_MS + 1,
    };
    expect(staleQuotaEntries(entries, loadedAt, NOW).map((item) => item.file.name)).toEqual([
      'never.json',
      'old.json',
    ]);
  });

  test('a custom max age is honoured', () => {
    expect(staleQuotaEntries([entry('a.json')], { 'a.json': NOW - 1000 }, NOW, 500)).toHaveLength(
      1
    );
  });
});

describe('quota load times in the store', () => {
  afterEach(() => useQuotaStore.getState().clearQuotaCache());

  test('records when each account settled', () => {
    useQuotaStore.getState().markQuotaLoaded(['a.json', 'b.json'], NOW);
    expect(useQuotaStore.getState().loadedAtByKey).toEqual({ 'a.json': NOW, 'b.json': NOW });
  });

  test('clearing one file forgets only its load time', () => {
    useQuotaStore.getState().markQuotaLoaded(['a.json', 'b.json'], NOW);
    useQuotaStore.getState().clearQuotaCache(['a.json']);
    expect(useQuotaStore.getState().loadedAtByKey).toEqual({ 'b.json': NOW });
  });

  test('a session reset forgets every load time', () => {
    useQuotaStore.getState().markQuotaLoaded(['a.json'], NOW);
    useQuotaStore.getState().clearQuotaCache();
    expect(useQuotaStore.getState().loadedAtByKey).toEqual({});
  });
});

describe('quota loading contracts', () => {
  test('both loaders record load times, so the dashboard and quota page share freshness', () => {
    const batch = readFileSync('src/features/quota/hooks/useQuotaBatchLoader.ts', 'utf8');
    const single = readFileSync('src/features/quota/hooks/useQuotaActions.ts', 'utf8');
    expect(batch).toContain('markQuotaLoaded([...committedStates.keys()], Date.now())');
    expect(single.match(/markQuotaLoaded\(\[cacheKey\], Date\.now\(\)\)/g)).toHaveLength(2);
  });

  test('the quota page loads stale accounts on arrival, once per session', () => {
    const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    expect(page).toContain('staleQuotaEntries(entries, useQuotaStore.getState().loadedAtByKey');
    expect(page).toContain('arrivalLoadSessionRef.current === sessionGeneration');
  });

  test('the ledger collapses on its own width, not the viewport', () => {
    const styles = readFileSync('src/features/quota/components/QuotaRoster.module.scss', 'utf8');
    expect(styles).toContain('container-type: inline-size;');
    expect(styles).toMatch(/@container \(max-width: \d+px\)\s*\{\s*\.shell/);
    expect(styles).not.toContain('@media (max-width: 1100px)');
  });
});
