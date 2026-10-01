import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { loadEnv } from '../config/env.js';
import { closePools, getPool, withTransaction } from './pool.js';

const FILENAME_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

type MigrationFile = {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
};

type AppliedRow = {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
};

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    const match = FILENAME_PATTERN.exec(entry);
    if (!match) continue;

    const [, version, name] = match;
    const sql = await readFile(path.join(dir, entry), 'utf8');
    files.push({ version: version!, name: name!, filename: entry, sql, checksum: checksum(sql) });
  }

  const versions = new Set(files.map((f) => f.version));
  if (versions.size !== files.length) {
    throw new Error(`Duplicate migration version numbers found in ${dir}`);
  }

  return files.sort((a, b) => a.version.localeCompare(b.version));
}

async function appliedMigrations(): Promise<Map<string, AppliedRow>> {
  await getPool().query(TRACKING_DDL);
  const result = await getPool().query<AppliedRow>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations',
  );
  return new Map(result.rows.map((r: AppliedRow) => [r.version, r]));
}

async function status(): Promise<number> {
  const files = await loadMigrations(loadEnv().MIGRATIONS_DIR);
  const applied = await appliedMigrations();
  let drift = 0;

  process.stdout.write('version  name                        state\n');
  process.stdout.write('-------  --------------------------  ----------\n');

  for (const file of files) {
    const record = applied.get(file.version);
    let state: string;

    if (!record) {
      state = 'pending';
    } else if (record.checksum !== file.checksum) {
      state = 'DRIFT';
      drift += 1;
    } else {
      state = 'applied';
    }

    process.stdout.write(`${file.version}   ${file.filename.slice(4).padEnd(26)}  ${state}\n`);
  }

  for (const record of applied.values()) {
    if (!files.some((f) => f.version === record.version)) {
      process.stdout.write(`${record.version}   ${record.name.padEnd(26)}  ORPHANED (no file)\n`);
      drift += 1;
    }
  }

  if (drift > 0) {
    process.stderr.write(
      `\n${drift} problem(s): applied migrations were edited or deleted.\n` +
        'Applied migrations are immutable. Add a new migration instead.\n',
    );
  }

  return drift > 0 ? 1 : 0;
}

async function apply(dryRun: boolean): Promise<number> {
  const files = await loadMigrations(loadEnv().MIGRATIONS_DIR);
  const applied = await appliedMigrations();

  const drift = files.filter(
    (f) => applied.has(f.version) && applied.get(f.version)!.checksum !== f.checksum,
  );

  if (drift.length > 0) {
    process.stderr.write(
      `Refusing to apply: ${drift.map((f) => f.filename).join(', ')} changed after being applied.\n` +
        'Applied migrations are immutable. Add a new migration instead.\n',
    );
    return 1;
  }

  const pending = files.filter((f) => !applied.has(f.version));

  if (pending.length === 0) {
    process.stdout.write('Nothing to apply; database is up to date.\n');
    return 0;
  }

  for (const file of pending) {
    if (dryRun) {
      process.stdout.write(`would apply  ${file.filename}\n`);
      continue;
    }

    await withTransaction(async (tx) => {
      await tx.query(file.sql);
      await tx.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [file.version, file.name, file.checksum],
      );
    });

    process.stdout.write(`applied  ${file.filename}\n`);
  }

  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const code = args.includes('--status')
    ? await status()
    : await apply(args.includes('--dry-run'));

  process.exitCode = code;
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`[migrate] failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePools());