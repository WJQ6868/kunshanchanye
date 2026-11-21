/* ============================================================
   dialect.ts — SQL 方言适配
   ------------------------------------------------------------
   计划书 §6 要求 PostgreSQL；本机没有 PG（且不能装），所以
   基座做成「驱动可切换」：
     · 生产/staging → PG（pg 驱动）
     · 本机开发    → node:sqlite（内置，零依赖）
   两边共用同一份 migrations/*.sql，方言差异在这里替换。

   为什么用 {{占位符}} 而不是两套 SQL：
   两套 SQL 必然漂移，且评审时看不出差异；占位符只有 4 个，
   替换规则一目了然，且能在测试里断言「替换后不含 {{」。
   ============================================================ */

export type Dialect = 'pg' | 'sqlite';

/** SQLite 没有 uuid/jsonb/bigserial，全部降级为 text/integer */
const SQLITE_MAP: Record<string, string> = {
  '{{pk_uuid}}': 'text PRIMARY KEY',
  '{{pk_serial}}': 'integer PRIMARY KEY AUTOINCREMENT',
  '{{json}}': 'text',
};

/** PG 用原生类型 */
const PG_MAP: Record<string, string> = {
  '{{pk_uuid}}': 'uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '{{pk_serial}}': 'bigserial PRIMARY KEY',
  '{{json}}': 'jsonb',
};

export function translate(sql: string, dialect: Dialect): string {
  const map = dialect === 'pg' ? PG_MAP : SQLITE_MAP;
  let out = sql;
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v);
  }
  if (out.includes('{{')) {
    throw new Error('[db] 迁移 SQL 里有未识别的占位符：' + out.slice(out.indexOf('{{'), out.indexOf('{{') + 40));
  }
  return out;
}

/** 参数占位符：PG 用 $1..$n，SQLite 用 ? */
export function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'pg' ? '$' + (index + 1) : '?';
}

/** 把 ? 风格的 SQL 转成当前方言 */
export function toNativeParams(sql: string, dialect: Dialect): string {
  if (dialect === 'pg') {
    let i = 0;
    return sql.replace(/\?/g, () => '$' + ++i);
  }
  return sql;
}

/** 布尔：两种方言都存 0/1，读出来再转 */
export function toDbBool(v: boolean): number {
  return v ? 1 : 0;
}
export function fromDbBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

/** 时间：统一 ISO 字符串，PG 的 timestamptz 能直接吃 */
export function nowIso(): string {
  return new Date().toISOString();
}
