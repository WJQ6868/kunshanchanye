/* ============================================================
   migrate.ts — 迁移框架
   ------------------------------------------------------------
   约定（计划书 §12 expand-contract）：
   · 迁移文件按文件名排序执行，一个文件一个事务
   · schema_migration 记录 name + checksum；已执行的迁移被改动过
     就报错退出（防止「本地改了但线上没跑」的静默漂移）
   · 不做 down 迁移：回滚靠 expand-contract + 备份，不靠 reverse SQL
     （reverse SQL 在生产上从没被真正信任过，写它只是自我安慰）
   ============================================================ */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './driver.ts';
import { translate } from './dialect.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export async function migrate(db: Db, opts: { dir?: string; silent?: boolean } = {}): Promise<MigrationResult> {
  const dir = opts.dir || MIGRATIONS_DIR;
  const log = opts.silent ? () => {} : (m: string) => console.log('[migrate] ' + m);

  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL
  )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = await db.all<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration');
  const doneMap = new Map(done.map((d) => [d.name, d.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    const sum = checksum(raw);
    const prev = doneMap.get(file);

    if (prev) {
      if (prev !== sum) {
        throw new Error(
          `[migrate] 迁移 "${file}" 内容已变更（记录 ${prev}，当前 ${sum}）。\n` +
            '已执行的迁移不允许改动——请新增一个迁移文件来做变更。',
        );
      }
      skipped.push(file);
      continue;
    }

    const sql = translate(raw, db.dialect);
    await db.tx(async (t) => {
      // SQLite 的 exec 不能走 tx 接口，这里用语句切分逐条跑
      for (const stmt of splitStatements(sql)) {
        await t.run(stmt);
      }
      await t.run('INSERT INTO schema_migration (name, checksum, applied_at) VALUES (?, ?, ?)', [
        file,
        sum,
        new Date().toISOString(),
      ]);
    });
    applied.push(file);
    log(`applied ${file} (${sum})`);
  }

  if (!applied.length) log(`已是最新（${skipped.length} 个迁移已应用）`);
  return { applied, skipped };
}

/** 按分号切分 SQL，忽略注释与字符串里的分号 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inStr = false;

  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];

    if (inLine) {
      if (c === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (n === "'") { buf += n; i += 2; continue; }
        inStr = false;
      }
      i++;
      continue;
    }

    if (c === '-' && n === '-') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === "'") { inStr = true; buf += c; i++; continue; }

    if (c === ';') {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
