/* ============================================================
   driver.ts — 数据库访问抽象
   ------------------------------------------------------------
   目标：业务代码只依赖这里的接口，不关心背后是 PG 还是 SQLite。

   接口设计取舍：
   · 全部 async（PG 天生异步，SQLite 也包成 Promise），
     避免「本地同步、线上异步」两套代码路径。
   · SQL 一律写 ? 占位符，由 toNativeParams 转成 $1..$n，
     这样同一句 SQL 两边都能跑。
   · 事务用 tx(fn) 回调形式，禁止手写 BEGIN/COMMIT
     （手写必然出现漏 ROLLBACK 的连接泄漏）。
   ============================================================ */

import type { Dialect } from './dialect.ts';
import { toNativeParams, translate } from './dialect.ts';

export interface Row {
  [key: string]: unknown;
}

export interface Db {
  readonly dialect: Dialect;
  /** 取多行 */
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 取一行，没有返回 null */
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  /** 执行写操作，返回受影响行数 */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** 执行 DDL / 多语句脚本 */
  exec(sql: string): Promise<void>;
  /** 事务：fn 抛错则自动回滚 */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface Tx {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<number>;
}

/* ============================================================
   SQLite 驱动（node:sqlite 内置，零依赖）
   ============================================================ */

export async function createSqliteDb(file: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file === ':memory:' ? ':memory:' : file);

  // 外键默认关闭，必须显式打开；WAL 提升并发读
  raw.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    try { raw.exec('PRAGMA journal_mode = WAL'); } catch { /* 内存库不支持 */ }
  }

  const prep = (sql: string) => raw.prepare(sql);

  const api = {
    all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      return Promise.resolve(prep(sql).all(...(params as never[])) as T[]);
    },
    get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
      const r = prep(sql).get(...(params as never[])) as T | undefined;
      return Promise.resolve(r === undefined ? null : r);
    },
    run(sql: string, params: unknown[] = []): Promise<number> {
      const r = prep(sql).run(...(params as never[]));
      return Promise.resolve(Number(r.changes ?? 0));
    },
  };

  const db: Db = {
    dialect: 'sqlite',
    ...api,
    async exec(sql: string) {
      raw.exec(sql);
    },
    async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(api);
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* 已回滚 */ }
        throw e;
      }
    },
    async close() {
      raw.close();
    },
  };
  return db;
}

/* ============================================================
   PostgreSQL 驱动（生产）
   ------------------------------------------------------------
   pg 是可选依赖：本机没装也不影响开发，只有真正连 PG 时才报错。
   ============================================================ */

export async function createPgDb(url: string): Promise<Db> {
  let pg: any;
  try {
    // 用变量绕过打包器的静态解析
    const mod = 'pg';
    pg = await import(mod);
  } catch {
    throw new Error(
      '[db] 连接 PostgreSQL 需要安装 pg 驱动：在 server 目录执行 npm install pg。\n' +
        '本机开发可直接用 SQLite：DB_DRIVER=sqlite',
    );
  }

  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: url, max: 10 });
  const dialect: Dialect = 'pg';

  type Runner = { all: Db['all']; get: Db['get']; run: Db['run'] };

  const makeRunner = (client: any): Runner => ({
    async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const r = await client.query(toNativeParams(sql, dialect), params);
      return r.rows as T[];
    },
    async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
      const r = await client.query(toNativeParams(sql, dialect), params);
      return (r.rows[0] as T) ?? null;
    },
    async run(sql: string, params: unknown[] = []): Promise<number> {
      const r = await client.query(toNativeParams(sql, dialect), params);
      return r.rowCount ?? 0;
    },
  });

  const base = makeRunner(pool);

  const db: Db = {
    dialect,
    all: base.all,
    get: base.get,
    run: base.run,
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(makeRunner(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* 已回滚 */ }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}

/* ============================================================
   工厂
   ============================================================ */

export async function openDb(opts: { driver: 'sqlite' | 'pg'; sqliteFile?: string; pgUrl?: string }): Promise<Db> {
  if (opts.driver === 'pg') {
    if (!opts.pgUrl) throw new Error('[db] DB_DRIVER=pg 时必须提供 DATABASE_URL');
    return createPgDb(opts.pgUrl);
  }
  return createSqliteDb(opts.sqliteFile || ':memory:');
}

export { translate };
