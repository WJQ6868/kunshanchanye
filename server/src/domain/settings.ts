/* ============================================================
   domain/settings.ts — 校级设置（key/value）
   ------------------------------------------------------------
   前端 settings 是一个对象：{anim, theme, fast, sound, autoClose,
   repeat, panel, rankPeriod}。整对象存 app_setting 的一行，
   key = 'app'，value = JSON。

   为什么不拆成多行：这些设置永远整体读写，拆开只会让
   PUT /settings 变成 N 条 upsert，没有任何收益。
   ============================================================ */

import type { Ctx } from '../ctx.ts';
import type { Db, Tx } from '../db/driver.ts';
import { nowIso, schoolIdOf } from './common.ts';

const SETTING_KEY = 'app';

export const DEFAULT_SETTINGS = {
  anim: 'spotlight',
  theme: 'white',
  fast: false,
  sound: true,
  autoClose: false,
  repeat: false,
  panel: true,
  rankPeriod: 'all',
} as const;

export type Settings = Record<string, unknown>;

function parse(v: unknown): Settings | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' ? (o as Settings) : null;
    } catch {
      return null;
    }
  }
  return typeof v === 'object' ? (v as Settings) : null;
}

export async function loadSettings(db: Db | Tx, schoolId: string): Promise<Settings> {
  const row = await db.get<{ value: unknown }>(
    'SELECT value FROM app_setting WHERE school_id = ? AND key = ?',
    [schoolId, SETTING_KEY],
  );
  const saved = parse(row?.value);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export async function saveSettings(ctx: Ctx, body: unknown): Promise<Settings> {
  const schoolId = schoolIdOf(ctx);
  const incoming = body && typeof body === 'object' ? (body as Settings) : {};
  const merged = { ...DEFAULT_SETTINGS, ...incoming };
  const now = nowIso();
  await ctx.db.run(
    `INSERT INTO app_setting (school_id, key, value, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT (school_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [schoolId, SETTING_KEY, JSON.stringify(merged), now],
  );
  return merged;
}

export async function settingsOf(ctx: Ctx): Promise<Settings> {
  return loadSettings(ctx.db, schoolIdOf(ctx));
}
