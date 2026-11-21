/* ============================================================
   audit.ts — 审计写入
   ------------------------------------------------------------
   计划书 §6.4：audit_log 是 append-only，生产环境用独立 DB 账号
   （只有 INSERT 权限）。这里只提供 insert，不提供 update/delete，
   从代码层面就堵死「改历史」。

   写审计失败不该让业务失败：审计挂了要记 error 日志并继续，
   但**敏感操作**（删除班级、清空记录）会额外告警——见 auditStrict。
   ============================================================ */

import type { Db } from './db/driver.ts';
import { log } from './log.ts';

export interface AuditInput {
  schoolId: string;
  actorUserId?: string | null;
  actorName?: string | null;
  actorIp?: string | null;
  userAgent?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

function json(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.run(
      `INSERT INTO audit_log
         (school_id, actor_user_id, actor_name, actor_ip, user_agent,
          action, target_type, target_id, before_data, after_data, request_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.schoolId,
        input.actorUserId || null,
        input.actorName || null,
        input.actorIp || null,
        input.userAgent || null,
        input.action,
        input.targetType || null,
        input.targetId || null,
        json(input.before),
        json(input.after),
        input.requestId || null,
        new Date().toISOString(),
      ],
    );
  } catch (e) {
    // 审计写失败必须可见：生产上这意味着「有人在删东西但我们没记下」
    log.error('审计写入失败', {
      action: input.action,
      target: input.targetType + ':' + input.targetId,
      err: String((e as Error).message || e),
    });
  }
}

/** 敏感操作：审计写失败时把错误抛出去，宁可操作失败也不能无痕 */
export async function auditStrict(db: Db, input: AuditInput): Promise<void> {
  await db.run(
    `INSERT INTO audit_log
       (school_id, actor_user_id, actor_name, actor_ip, user_agent,
        action, target_type, target_id, before_data, after_data, request_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.schoolId,
      input.actorUserId || null,
      input.actorName || null,
      input.actorIp || null,
      input.userAgent || null,
      input.action,
      input.targetType || null,
      input.targetId || null,
      json(input.before),
      json(input.after),
      input.requestId || null,
      new Date().toISOString(),
    ],
  );
}
