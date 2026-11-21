/* ============================================================
   domain/scores.ts — 加分流水（append-only + 冲正）
   ------------------------------------------------------------
   为什么是 append-only（计划书 §6.3）：
     · 教室里多人同时加分，UPDATE 一条记录的「总分」必然丢写；
       追加只增不改，天然无冲突
     · 撤销/删除不做物理删除，而是写一条 revoked_at 标记（冲正），
       任何时刻都能回答「这条分是谁在什么时候因为什么加/撤的」

   与前端的关系（重要）：
     前端 adapter 的 setScores(className, records) 发的是「整班
     全部记录」——它把本地数组当真相。所以 PUT /classes/{k}/scores
     必须做**对账**而不是追加：
       · payload 有、库里没有（按 client_record_id）→ INSERT
       · 库里 live、payload 没有 → 冲正（revoked_at）
       · 两边都有 → 不动（若 delta/reason 变了 → 冲正旧的 + 插新的）
     这样前端的「删除一条」「清空某人」「多步撤销」全都不用改，
     服务端仍然只增不改。

   幂等：客户端每次写操作带 Idempotency-Key（前端已实现），
   落在 client_request_id 上，(school_id, client_request_id) 唯一索引
   保证重放不会重复加分。
   ============================================================ */

import type { Ctx } from '../ctx.ts';
import type { Db, Tx } from '../db/driver.ts';
import { err } from '../http.ts';
import {
  MAX_ABS,
  MAX_REASON,
  newBatchId,
  newRecordId,
  normClassName,
  nowIso,
  round2,
  schoolIdOf,
} from './common.ts';
import { assertCanEdit, assertCanView, findClassByName, listClasses } from './classes.ts';

/** 前端形态的加分记录：{id, t, name, sid, delta, reason, op} */
export interface ScoreDTO {
  id: string;
  t: number;
  name: string;
  sid: string;
  delta: number;
  reason: string;
  /** 操作人姓名快照（讲师/管理员真名），旧数据可能为空 */
  op: string;
}

interface ScoreRow {
  id: number;
  class_id: string;
  student_id: string;
  delta: number;
  reason_code: string;
  reason_text: string;
  operator_user_id: string;
  operator_name_snapshot: string;
  occurred_at: string;
  batch_id: string | null;
  client_record_id: string | null;
  revoked_at: string | null;
  revoke_of_id: number | null;
}

/* ---------- 读 ---------- */

function toDTO(row: ScoreRow, name: string, sid: string): ScoreDTO {
  return {
    id: row.client_record_id || 'r' + row.id,
    t: Date.parse(row.occurred_at) || 0,
    name,
    sid,
    delta: round2(row.delta),
    reason: row.reason_text || '',
    op: row.operator_name_snapshot || '',
  };
}

/** 某班全部有效记录（按时间升序 —— 前端渲染日志用倒序，但它自己会反） */
export async function listScores(db: Db | Tx, schoolId: string, classId: string): Promise<ScoreDTO[]> {
  const rows = await db.all<ScoreRow & { s_name: string; s_no: string }>(
    `SELECT r.*, s.name AS s_name, s.external_student_id AS s_no
       FROM score_record r
       JOIN student s ON s.id = r.student_id
      WHERE r.class_id = ? AND r.school_id = ? AND r.revoked_at IS NULL
      ORDER BY r.occurred_at ASC, r.id ASC`,
    [classId, schoolId],
  );
  return rows.map((r) => toDTO(r, r.s_name, r.s_no || ''));
}

/** 某班全部记录（含已冲正）—— 管理台与审计用 */
export async function listScoresAll(
  db: Db | Tx,
  schoolId: string,
  classId: string,
): Promise<Array<ScoreDTO & { revokedAt: string | null; operator: string }>> {
  const rows = await db.all<ScoreRow & { s_name: string; s_no: string }>(
    `SELECT r.*, s.name AS s_name, s.external_student_id AS s_no
       FROM score_record r
       JOIN student s ON s.id = r.student_id
      WHERE r.class_id = ? AND r.school_id = ?
      ORDER BY r.occurred_at ASC, r.id ASC`,
    [classId, schoolId],
  );
  return rows.map((r) => ({
    ...toDTO(r, r.s_name, r.s_no || ''),
    revokedAt: r.revoked_at,
    operator: r.operator_name_snapshot,
  }));
}

/** 按班级名取记录（找不到班级 → 空数组，不报错：新班还没有任何流水） */
export async function scoresByClassName(ctx: Ctx, className: string): Promise<ScoreDTO[]> {
  const schoolId = schoolIdOf(ctx);
  const name = normClassName(className);
  assertCanView(ctx, name);
  const cls = await findClassByName(ctx.db, schoolId, name);
  if (!cls) return [];
  return listScores(ctx.db, schoolId, cls.id);
}

/* ---------- 写 ---------- */

interface IncomingRecord {
  id: string;
  t: number;
  name: string;
  sid: string;
  delta: number;
  reason: string;
}

function normalizeIncoming(raw: unknown): IncomingRecord[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: IncomingRecord[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const delta = round2(o?.delta);
    if (!delta || Math.abs(delta) > MAX_ABS) continue;
    const name = String(o?.name == null ? '' : o.name).trim().slice(0, 40);
    if (!name) continue;
    out.push({
      id: String(o?.id == null ? '' : o.id).trim().slice(0, 64) || newRecordId(),
      t: Number(o?.t) || Date.now(),
      name,
      sid: String(o?.sid == null ? '' : o.sid).trim().slice(0, 40),
      delta,
      reason: String(o?.reason == null ? '' : o.reason).trim().slice(0, MAX_REASON),
    });
  }
  return out;
}

/** 找学生行：优先学号，其次姓名（同班内姓名唯一） */
async function resolveStudent(
  t: Tx,
  schoolId: string,
  classId: string,
  name: string,
  sid: string,
): Promise<string | null> {
  if (sid) {
    const row = await t.get<{ id: string }>(
      'SELECT id FROM student WHERE school_id = ? AND external_student_id = ? AND deleted_at IS NULL LIMIT 1',
      [schoolId, sid],
    );
    if (row) return row.id;
  }
  const row = await t.get<{ student_id: string }>(
    `SELECT cs.student_id
       FROM class_student cs
       JOIN student s ON s.id = cs.student_id
      WHERE cs.class_id = ? AND cs.left_at IS NULL AND s.name = ? AND s.deleted_at IS NULL
      LIMIT 1`,
    [classId, name],
  );
  return row?.student_id ?? null;
}

/**
 * 对账式写入：把 payload 当作该班的「全部有效记录」。
 * 返回写入后的有效记录（前端可直接用返回值覆盖本地）。
 */
export async function replaceScores(
  ctx: Ctx,
  className: string,
  payload: { records?: unknown; removed?: unknown },
): Promise<{ records: ScoreDTO[] }> {
  const schoolId = schoolIdOf(ctx);
  const name = normClassName(className);
  assertCanEdit(ctx, name);

  const cls = await findClassByName(ctx.db, schoolId, name);
  if (!cls) throw err.notFound('班级不存在：' + (name || '未分班'));

  const incoming = normalizeIncoming(payload.records);
  const actorId = ctx.user?.id || '';
  const actorName = ctx.user?.display_name || ctx.user?.username || '';
  const actorRole = ctx.user?.role || '';
  const idem = String(ctx.headers['idempotency-key'] || '').slice(0, 64) || null;
  const batch = newBatchId();
  const now = nowIso();

  await ctx.db.tx(async (t) => {
    // 幂等：同一 Idempotency-Key 已经处理过，直接跳过整批
    if (idem) {
      const done = await t.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM score_record WHERE school_id = ? AND client_request_id = ?',
        [schoolId, idem],
      );
      if (Number(done?.n || 0) > 0) return;
    }

    const liveRows = await t.all<ScoreRow>(
      `SELECT * FROM score_record
        WHERE class_id = ? AND school_id = ? AND revoked_at IS NULL
        ORDER BY id ASC`,
      [cls.id, schoolId],
    );
    const liveByClient = new Map<string, ScoreRow>();
    for (const r of liveRows) {
      if (r.client_record_id) liveByClient.set(r.client_record_id, r);
    }

    const keep = new Set<string>();

    for (const rec of incoming) {
      keep.add(rec.id);
      const existed = liveByClient.get(rec.id);
      if (existed) {
        // 值没变 → 完全不动（最常见的重复提交路径）
        if (round2(existed.delta) === rec.delta && (existed.reason_text || '') === rec.reason) continue;
        // 值变了 → 冲正旧的（append-only：不改历史）
        await t.run('UPDATE score_record SET revoked_at = ?, revoked_by = ? WHERE id = ?', [
          now,
          actorId,
          existed.id,
        ]);
      }

      const studentId = await resolveStudent(t, schoolId, cls.id, rec.name, rec.sid);
      if (!studentId) {
        // 学生不在本班（可能是转班遗留的记录）→ 跳过，不制造悬空引用
        continue;
      }
      await t.run(
        `INSERT INTO score_record
           (school_id, class_id, student_id, delta, reason_code, reason_text,
            operator_user_id, operator_name_snapshot, operator_role,
            occurred_at, created_at, batch_id, client_request_id, client_record_id, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          schoolId,
          cls.id,
          studentId,
          rec.delta,
          'other',
          rec.reason,
          actorId,
          actorName,
          actorRole,
          new Date(rec.t).toISOString(),
          now,
          batch,
          idem,
          rec.id,
          'web',
        ],
      );
    }

    // 库里 live 但 payload 里没有 → 以前一律冲正。这正是「双标签页互相抹掉
    // 对方加分」的根源（性能测试 P0-2 / 验收 S3）：另一个标签页基于旧快照提交，
    // 它没见过别人新加的记录，于是把别人的记录全部冲正，而且返回 200 没有任何提示。
    //
    // 现在只冲正「调用方明确声明要删的」。前端在 setScores 里用
    // 「提交前基线 − 本次提交」算出 removed 列表，撤销一步只删那一条，
    // 别人的新记录不在任何人的基线里，因此永远不会被误删。
    //
    // removed 缺省时（部署前就打开着的旧标签页，JS 还是老版本）**一个都不删**。
    // 早先的写法是「缺省就退回全量对账」，实测那条路径依然会抹掉别人的加分 ——
    // 也就是漏洞还在，只是换了个入口。两害相权：旧前端会退化成「撤销只在本机生效，
    // 刷新后记录回来」，这是可见的、刷新即自愈的；而静默删别人的分是不可恢复的。
    // 由于静态资源是 no-cache + ETag，刷新一次就会拿到新 JS，这个窗口很短。
    const explicitRemoved = Array.isArray(payload.removed)
      ? new Set(
          (payload.removed as unknown[])
            .map((x) => String(x == null ? '' : x).trim())
            .filter(Boolean),
        )
      : null;

    for (const r of liveRows) {
      const cid = r.client_record_id;
      if (cid && keep.has(cid)) continue;
      // 没有 client_record_id 的老数据无法被前端点名，一律保留（要清空走 DELETE 整班）
      if (!cid) continue;
      if (!explicitRemoved || !explicitRemoved.has(cid)) continue;
      await t.run('UPDATE score_record SET revoked_at = ?, revoked_by = ? WHERE id = ?', [now, actorId, r.id]);
    }
  });

  await ctx.audit('score.replace', {
    targetType: 'class',
    targetId: cls.id,
    after: { class: cls.name, records: incoming.length, batch },
  });

  return { records: await listScores(ctx.db, schoolId, cls.id) };
}

/** 清空某班全部记录（DELETE /classes/{k}/scores） */
export async function clearScores(ctx: Ctx, className: string): Promise<{ cleared: number }> {
  const schoolId = schoolIdOf(ctx);
  const name = normClassName(className);
  assertCanEdit(ctx, name);
  const cls = await findClassByName(ctx.db, schoolId, name);
  if (!cls) return { cleared: 0 };

  const now = nowIso();
  const actorId = ctx.user?.id || '';
  const n = await ctx.db.run(
    'UPDATE score_record SET revoked_at = ?, revoked_by = ? WHERE class_id = ? AND school_id = ? AND revoked_at IS NULL',
    [now, actorId, cls.id, schoolId],
  );
  await ctx.audit('score.clear_class', {
    targetType: 'class',
    targetId: cls.id,
    after: { class: cls.name, cleared: n },
  });
  return { cleared: n };
}

/* ---------- 汇总 / 排行榜 ---------- */

export interface ClassStat {
  name: string;
  count: number;
  total: number;
  records: number;
  last: number;
}

export async function classStats(
  db: Db | Tx,
  schoolId: string,
  sinceMs: number | null,
): Promise<ClassStat[]> {
  const classes = await listClasses(db, schoolId);
  const out: ClassStat[] = [];
  for (const c of classes) {
    const cntRow = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM class_student WHERE class_id = ? AND left_at IS NULL`,
      [c.id],
    );
    const agg = await db.get<{ total: number | null; n: number; last: string | null }>(
      `SELECT SUM(delta) AS total, COUNT(*) AS n, MAX(occurred_at) AS last
         FROM score_record
        WHERE class_id = ? AND school_id = ? AND revoked_at IS NULL
          AND occurred_at >= ?`,
      [c.id, schoolId, sinceMs == null ? '0000-01-01T00:00:00.000Z' : new Date(sinceMs).toISOString()],
    );
    out.push({
      name: c.name,
      count: Number(cntRow?.n || 0),
      total: round2(agg?.total || 0),
      records: Number(agg?.n || 0),
      last: agg?.last ? Date.parse(agg.last) || 0 : 0,
    });
  }
  return out;
}

export interface StudentStat {
  name: string;
  sid: string;
  className: string;
  total: number;
}

export async function studentStats(
  db: Db | Tx,
  schoolId: string,
  sinceMs: number | null,
  limit: number,
): Promise<StudentStat[]> {
  const rows = await db.all<{ name: string; sid: string; class_name: string; total: number }>(
    `SELECT s.name AS name,
            s.external_student_id AS sid,
            c.name AS class_name,
            SUM(r.delta) AS total
       FROM score_record r
       JOIN student s ON s.id = r.student_id
       JOIN class c ON c.id = r.class_id
      WHERE r.school_id = ? AND r.revoked_at IS NULL
        AND r.occurred_at >= ?
        AND s.deleted_at IS NULL
      GROUP BY s.id, s.name, s.external_student_id, c.name
      HAVING SUM(r.delta) <> 0
      ORDER BY total DESC, s.name ASC
      LIMIT ?`,
    [schoolId, sinceMs == null ? '0000-01-01T00:00:00.000Z' : new Date(sinceMs).toISOString(), limit],
  );
  return rows.map((r) => ({
    name: r.name,
    sid: r.sid || '',
    className: r.class_name,
    total: round2(r.total),
  }));
}

/** 周期起点（毫秒）：'all' → null；'week' → 本周一 00:00；'month' → 本月 1 日 00:00 */
export function periodStart(period: string, nowMs = Date.now()): number | null {
  const d = new Date(nowMs);
  if (period === 'week') {
    const dow = d.getDay(); // 0=周日
    const back = dow === 0 ? 6 : dow - 1;
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 0, 0, 0, 0);
    return s.getTime();
  }
  if (period === 'month') {
    return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  }
  return null;
}
