/* ============================================================
   domain/common.ts — 领域层公共工具
   ------------------------------------------------------------
   这里只放「多个领域模块都要用」的规范化与解析函数，
   不放任何 HTTP 相关的东西（那是 routes/ 的职责）。

   为什么班级名要 norm + norm：
     · normClassName 折叠空白/去首尾/截断 20 字 —— 与前端
       RCClasses.normName 完全一致，否则「电气 2301」与
       「电气  2301」会变成两个班
     · nameNorm 再转小写 —— 只用于唯一索引判重，
       显示名永远用原始 name
   ============================================================ */

import type { Ctx } from '../ctx.ts';
import { err } from '../http.ts';
import { randomToken } from '../auth/password.ts';

/** 与前端 RCClasses.MAX_NAME 对齐 */
export const MAX_CLASS_NAME = 20;
/** 与前端 RCScore.MAX_REASON 对齐 */
export const MAX_REASON = 40;
/** 与前端 RCScore.MAX_ABS 对齐 */
export const MAX_ABS = 1000;

/** 班级显示名规范化：折叠空白、去首尾、截断 20 字 */
export function normClassName(v: unknown): string {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLASS_NAME);
}

/** 判重用的小写键 */
export function nameNorm(v: unknown): string {
  return normClassName(v).toLowerCase();
}

/** 学生姓名规范化 */
export function normStudentName(v: unknown): string {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function round2(n: unknown): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 新记录 id（与前端 RCScore.makeId 同形：s + base36 时间 + 5 位随机） */
export function newRecordId(): string {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function newBatchId(): string {
  return 'b' + randomToken(9);
}

/** 当前请求所属学校 id（单校部署下由 seed 建出来的那一个） */
export function schoolIdOf(ctx: Ctx): string {
  const id = ctx.session?.school_id || ctx.user?.school_id;
  if (!id) throw err.internal('会话缺少学校信息');
  return id;
}

/**
 * 身份证等敏感标识的落库形式：只存 sha256 摘要，绝不存明文。
 * 计划书 §12 明确「不采集身份证号」，但教务以身份证为登录标识，
 * 所以用摘要做对账键 —— 能判断「是不是同一个人」，
 * 却无法从库里还原出号码。
 */
export async function personDigest(raw: string): Promise<string> {
  const v = String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
  if (!v) return '';
  const { createHash } = await import('node:crypto');
  return 'sha256:' + createHash('sha256').update(v, 'utf8').digest('hex');
}

/** 时间戳（统一走 dialect.nowIso，保证格式一致） */
export { nowIso } from '../db/dialect.ts';
