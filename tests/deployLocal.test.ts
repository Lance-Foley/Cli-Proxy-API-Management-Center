import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PANEL_PATH,
  checkServedPanel,
  deployPanel,
  resolvePanelPath,
} from '../scripts/deployLocal';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (built = '<!doctype html><p>new</p>', served?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'cpamc-deploy-'));
  dirs.push(root);
  const source = join(root, 'index.html');
  const staticDir = join(root, 'static');
  mkdirSync(staticDir);
  writeFileSync(source, built);
  const target = join(staticDir, 'management.html');
  if (served !== undefined) writeFileSync(target, served);
  return { source, staticDir, target };
};

describe('local panel deployment', () => {
  test('resolves the static path with backend MANAGEMENT_STATIC_PATH semantics', () => {
    expect(resolvePanelPath('')).toBe(DEFAULT_PANEL_PATH);
    expect(resolvePanelPath('/srv/static')).toBe('/srv/static/management.html');
    expect(resolvePanelPath('/srv/static/Management.html')).toBe('/srv/static/Management.html');
  });

  test('replaces the served panel and backs up the previous build', () => {
    const { source, staticDir, target } = fixture('<!doctype html><p>new</p>', 'old');
    const result = deployPanel({ source, target, now: new Date(2026, 9, 8, 13, 5, 9) });

    expect(result.changed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('<!doctype html><p>new</p>');
    expect(result.backup).toBe(join(staticDir, 'management.html.bak-deploy-20261008-130509'));
    expect(readFileSync(result.backup!, 'utf8')).toBe('old');
    expect(readdirSync(staticDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('skips identical builds without creating a backup', () => {
    const html = '<!doctype html><p>same</p>';
    const { source, staticDir, target } = fixture(html, html);
    expect(deployPanel({ source, target })).toMatchObject({ changed: false, pruned: [] });
    expect(readdirSync(staticDir)).toEqual(['management.html']);
  });

  test('keeps recent script backups and never prunes manual backups', () => {
    const { source, staticDir, target } = fixture('<!doctype html><p>v3</p>', 'v2');
    writeFileSync(join(staticDir, 'management.html.bak-20261006'), 'manual');
    writeFileSync(join(staticDir, 'management.html.bak-deploy-20261001-000000'), 'v0');
    writeFileSync(join(staticDir, 'management.html.bak-deploy-20261002-000000'), 'v1');

    const result = deployPanel({ source, target, keepBackups: 2, now: new Date(2026, 9, 8) });

    expect(result.pruned).toEqual(['management.html.bak-deploy-20261001-000000']);
    expect(readdirSync(staticDir).sort()).toEqual([
      'management.html',
      'management.html.bak-20261006',
      'management.html.bak-deploy-20261002-000000',
      'management.html.bak-deploy-20261008-000000',
    ]);
  });

  test('never overwrites an earlier backup taken in the same second', () => {
    const { source, staticDir, target } = fixture('<!doctype html><p>v2</p>', 'v1');
    const now = new Date(2026, 9, 8, 9, 0, 0);
    writeFileSync(join(staticDir, 'management.html.bak-deploy-20261008-090000'), 'v0');
    const result = deployPanel({ source, target, now });
    expect(result.backup).toBe(join(staticDir, 'management.html.bak-deploy-20261008-090000-2'));
    expect(
      readFileSync(join(staticDir, 'management.html.bak-deploy-20261008-090000'), 'utf8')
    ).toBe('v0');
  });

  test('refuses unbuilt sources and missing static directories without writing', () => {
    const { source, target } = fixture('not html', 'old');
    expect(() => deployPanel({ source, target })).toThrow('not a built panel');
    expect(readFileSync(target, 'utf8')).toBe('old');

    const missing = join(tmpdir(), 'cpamc-missing-static', 'management.html');
    const built = fixture().source;
    expect(() => deployPanel({ source: built, target: missing })).toThrow('does not exist');
    expect(existsSync(missing)).toBe(false);
  });

  test('confirms the proxy serves the deployed hash', async () => {
    const html = '<!doctype html><p>served</p>';
    const { source, target } = fixture(html, 'old');
    const { hash } = deployPanel({ source, target });
    const server = Bun.serve({ port: 0, fetch: () => new Response(html) });
    try {
      const url = `http://127.0.0.1:${server.port}/management.html`;
      expect(await checkServedPanel(url, hash)).toBe('match');
      expect(await checkServedPanel(url, 'other')).toBe('mismatch');
    } finally {
      server.stop(true);
    }
    expect(await checkServedPanel('http://127.0.0.1:9/management.html', hash)).toBe('unreachable');
  });
});
