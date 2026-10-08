/**
 * Deploy the single-file build to a locally running CLIProxyAPI.
 *
 * The backend serves management.html from its static directory on every request, so no restart
 * is needed. When that file is missing it downloads the upstream panel instead, so the new build
 * is written beside it and renamed into place. Dated backups allow rolling back by copying one back.
 *
 * Usage: bun run deploy:local
 *   MANAGEMENT_STATIC_PATH  static directory or management.html path (backend semantics)
 *   CPA_PANEL_URL           served panel URL used to confirm the deployment
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PANEL_FILE = 'management.html';
const BACKUP_PREFIX = `${PANEL_FILE}.bak-deploy-`;
export const DEFAULT_PANEL_PATH = '/opt/homebrew/etc/static/management.html';
export const DEFAULT_PANEL_URL = 'http://127.0.0.1:8317/management.html';
export const DEFAULT_KEEP_BACKUPS = 5;

export interface DeployResult {
  target: string;
  hash: string;
  changed: boolean;
  backup?: string;
  pruned: string[];
}

export type ServedStatus = 'match' | 'mismatch' | 'unreachable';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const pad = (value: number) => String(value).padStart(2, '0');
const timestamp = (date: Date) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
  `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/** Mirrors the backend: MANAGEMENT_STATIC_PATH may name the directory or the file itself. */
export const resolvePanelPath = (override = process.env.MANAGEMENT_STATIC_PATH): string => {
  const value = override?.trim();
  if (!value) return DEFAULT_PANEL_PATH;
  const cleaned = resolve(value);
  return basename(cleaned).toLowerCase() === PANEL_FILE ? cleaned : join(cleaned, PANEL_FILE);
};

const uniqueBackupPath = (dir: string, now: Date) => {
  const base = join(dir, `${BACKUP_PREFIX}${timestamp(now)}`);
  let candidate = base;
  for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
};

/** Only backups created by this script are pruned; manual backups are never touched. */
const pruneBackups = (dir: string, keep: number) => {
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort();
  const removed = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of removed) rmSync(join(dir, name));
  return removed;
};

export const deployPanel = ({
  source,
  target,
  keepBackups = DEFAULT_KEEP_BACKUPS,
  now = new Date(),
}: {
  source: string;
  target: string;
  keepBackups?: number;
  now?: Date;
}): DeployResult => {
  if (!existsSync(source)) throw new Error(`${source} does not exist; run bun run build first`);
  const html = readFileSync(source);
  if (!/^\s*<!doctype html/i.test(html.subarray(0, 64).toString('utf8'))) {
    throw new Error(`${source} is not a built panel; run bun run build first`);
  }
  const dir = dirname(target);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `Static directory ${dir} does not exist; set MANAGEMENT_STATIC_PATH to the proxy's static directory`
    );
  }

  const hash = sha256(html);
  if (existsSync(target) && sha256(readFileSync(target)) === hash) {
    return { target, hash, changed: false, pruned: [] };
  }

  let backup: string | undefined;
  if (existsSync(target)) {
    backup = uniqueBackupPath(dir, now);
    copyFileSync(target, backup);
  }
  const temp = join(dir, `.${PANEL_FILE}.deploy-${process.pid}.tmp`);
  try {
    writeFileSync(temp, html);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return { target, hash, changed: true, backup, pruned: pruneBackups(dir, keepBackups) };
};

export const checkServedPanel = async (url: string, hash: string): Promise<ServedStatus> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return 'unreachable';
    return sha256(new Uint8Array(await response.arrayBuffer())) === hash ? 'match' : 'mismatch';
  } catch {
    return 'unreachable';
  }
};

const main = async () => {
  const target = resolvePanelPath();
  const url = process.env.CPA_PANEL_URL?.trim() || DEFAULT_PANEL_URL;
  try {
    const result = deployPanel({ source: resolve('dist/index.html'), target });
    if (!result.changed) {
      console.log(`Panel already up to date at ${result.target}`);
    } else {
      console.log(`Deployed panel to ${result.target}`);
      if (result.backup) console.log(`Previous panel backed up to ${result.backup}`);
      if (result.pruned.length) console.log(`Removed old backups: ${result.pruned.join(', ')}`);
    }

    const served = await checkServedPanel(url, result.hash);
    if (served === 'match') {
      console.log(`Proxy is serving this build at ${url}`);
    } else if (served === 'unreachable') {
      console.warn(`Could not load ${url}; the file is deployed and is served once the proxy runs`);
    } else {
      console.error(
        `${url} serves a different panel; check MANAGEMENT_STATIC_PATH or the proxy's config path`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
};

if (import.meta.main) void main();
