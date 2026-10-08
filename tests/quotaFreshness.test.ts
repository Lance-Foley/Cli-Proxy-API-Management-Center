import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { QUOTA_AUTO_REFRESH_MS } from '@/features/quota/constants';
import { mapWithConcurrency, staleQuotaEntries } from '@/features/quota/logic';
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
    useQuotaStore.getState().markQuotaFetched(['a.json', 'b.json'], NOW);
    expect(useQuotaStore.getState().fetchedAtByKey).toEqual({ 'a.json': NOW, 'b.json': NOW });
  });

  test('clearing one file forgets only its load time', () => {
    useQuotaStore.getState().markQuotaFetched(['a.json', 'b.json'], NOW);
    useQuotaStore.getState().clearQuotaCache(['a.json']);
    expect(useQuotaStore.getState().fetchedAtByKey).toEqual({ 'b.json': NOW });
  });

  test('pruning keeps only listed keys', () => {
    useQuotaStore.getState().markQuotaFetched(['a.json', 'b.json', 'c.json'], NOW);
    useQuotaStore.getState().pruneQuotaFetches(new Set(['b.json']));
    expect(useQuotaStore.getState().fetchedAtByKey).toEqual({ 'b.json': NOW });
  });

  test('a session reset forgets every load time', () => {
    useQuotaStore.getState().markQuotaFetched(['a.json'], NOW);
    useQuotaStore.getState().clearQuotaCache();
    expect(useQuotaStore.getState().fetchedAtByKey).toEqual({});
  });
});

describe('mapWithConcurrency', () => {
  test('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0, 6], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, value));
      inFlight -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
  });

  test('handles empty input and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 4, async (value: number) => value)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (value) => value + 1)).toEqual([2, 3]);
  });
});

describe('quota loading contracts', () => {
  test('a background refresh keeps the last good numbers on screen', () => {
    const batch = readFileSync('src/features/quota/hooks/useQuotaBatchLoader.ts', 'utf8');
    expect(batch).toContain(
      "if (prev[key]?.status !== 'success') nextState[key] = adapter.buildLoadingState();"
    );
    expect(batch).toContain('mapWithConcurrency(');
    expect(batch).toContain('QUOTA_FETCH_CONCURRENCY');
  });

  test('the quota page forgets fetch times for removed credentials', () => {
    const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    expect(page).toContain('.pruneQuotaFetches(');
  });

  test('both loaders record load times, so the dashboard and quota page share freshness', () => {
    const batch = readFileSync('src/features/quota/hooks/useQuotaBatchLoader.ts', 'utf8');
    const single = readFileSync('src/features/quota/hooks/useQuotaActions.ts', 'utf8');
    expect(batch).toContain('markQuotaFetched([...committedStates.keys()], Date.now())');
    // Stamped when the request starts too, so a second page cannot fetch the same account.
    expect(batch).toMatch(/markQuotaFetched\(\s*entries\.map/);
    expect(single.match(/markQuotaFetched\(\[cacheKey\], Date\.now\(\)\)/g)).toHaveLength(3);
  });

  test('the quota page loads stale accounts on arrival, once per session', () => {
    const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    expect(page).toContain('staleQuotaEntries(entries, useQuotaStore.getState().fetchedAtByKey');
    expect(page).toContain('arrivalLoadSessionRef.current === sessionGeneration');
  });

  test('the ledger collapses on its own width, not the viewport', () => {
    const styles = readFileSync('src/features/quota/components/QuotaRoster.module.scss', 'utf8');
    expect(styles).toContain('container-type: inline-size;');
    expect(styles).toMatch(/@container \(max-width: \d+px\)\s*\{\s*\.shell/);
    expect(styles).not.toContain('@media (max-width: 1100px)');
  });
});
