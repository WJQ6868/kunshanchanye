/* ============================================================
   domain/classes.ts — 班级与学生名单（P2 领域层）
   ------------------------------------------------------------
   设计要点（与计划书 §6.2 一致，个别处有意的偏差写在下面）：

   1. 班级是独立实体（class 表），不再只是名单里的一个字符串。
      唯一键是 (school_id, term, name_norm) —— term 用 '' 而不是
      NULL，因为唯一索引里 NULL 互不相等，可空 term 会让同名班级
      绕过约束。

   2. 学生与班级是多对多（class_student），但前端是「整班名单整体
      替换」语义，所以主键用 (class_id, student_id) 而不是带时间
      区间的三列主键：三列主键会让每次替换变成 close+insert+清理
      三步，容易写出重复有效行。转班历史由 score_record 与
      audit_log 留痕，成员表只表达「当前在班」。

   3. 学生身份：有学号用 external_student_id；没学号（教务不给学号
      的学校）用 name_norm + 班级 兜底，落在 legacy_key 里。

   4. 所有写操作都在一个事务里完成，失败整体回滚 —— 前端发的是
      「整份名单」，半截生效比不生效更难排查。
   ============================================================ */

import type { Ctx } from '../ctx.ts';
import type { Db, Tx } from '../db/driver.ts';
import { err } from '../http.ts';
import { log } from '../log.ts';
import {
  MAX_CLASS_NAME,
  normClassName,
  nameNorm,
  normStudentName,
  nowIso,
  schoolIdOf,
} from './common.ts';

export interface ClassRow {
  id: string;
  school_id: string;
  name: string;
  name_norm: string;
  term: string;
  external_class_id: string | null;
  legacy_name: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StudentRow {
  id: string;
  school_id: string;
  external_student_id: string;
  external_person_id: string;
  name: string;
  name_norm: string;
  legacy_key: string | null;
  status: string;
  deleted_at: string | null;
}

/** 前端形态的学生：{name, id, group} —— id 是学号 */
export interface StudentDTO {
  name: string;
  id: string;
  group: string;
}

/** 前端形态的班级：{id, name, createdAt, students} */
export interface ClassDTO {
  id: string;
  name: string;
  createdAt: number;
  students: StudentDTO[];
}

const SETTING_CURRENT = 'classes.current';

/* ---------- 读 ---------- */

export async function findClassByName(
  db: Db | Tx,
  schoolId: string,
  name: string,
  term = '',
): Promise<ClassRow | null> {
  const row = await db.get<ClassRow>(
    `SELECT * FROM class
      WHERE school_id = ? AND term = ? AND name_norm = ? AND deleted_at IS NULL
      LIMIT 1`,
    [schoolId, term, nameNorm(name)],
  );
  return row ?? null;
}

export async function findClassById(db: Db | Tx, schoolId: string, id: string): Promise<ClassRow | null> {
  const row = await db.get<ClassRow>(
    'SELECT * FROM class WHERE school_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
    [schoolId, id],
  );
  return row ?? null;
}

/** 全部在用班级（按创建时间升序 —— 与前端首页顺序一致） */
export async function listClasses(db: Db | Tx, schoolId: string): Promise<ClassRow[]> {
  return db.all<ClassRow>(
    `SELECT * FROM class
      WHERE school_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC, name ASC`,
    [schoolId],
  );
}

/** 某班当前在册学生（按 seat_no / 姓名排序，保持导入顺序） */
export async function listClassStudents(
  db: Db | Tx,
  schoolId: string,
  classId: string,
): Promise<StudentDTO[]> {
  const rows = await db.all<{
    name: string;
    external_student_id: string;
    class_name: string;
  }>(
    `SELECT s.name, s.external_student_id, c.name AS class_name
       FROM class_student cs
       JOIN student s ON s.id = cs.student_id
       JOIN class c ON c.id = cs.class_id
      WHERE cs.class_id = ? AND cs.left_at IS NULL
        AND s.deleted_at IS NULL AND s.school_id = ?
      ORDER BY cs.seat_no ASC, cs.joined_at ASC, s.name ASC`,
    [classId, schoolId],
  );
  return rows.map((r) => ({
    name: r.name,
    id: r.external_student_id || '',
    group: r.class_name,
  }));
}

/** 整份名单（跨班，按班级顺序 + 班内顺序展开） */
export async function loadRoster(db: Db | Tx, schoolId: string): Promise<StudentDTO[]> {
  const classes = await listClasses(db, schoolId);
  const out: StudentDTO[] = [];
  for (const c of classes) {
    const list = await listClassStudents(db, schoolId, c.id);
    for (const s of list) out.push(s);
  }
  // 未分班学生（理论上不会出现，前端把 '' 当未分班，但服务端不建空名班级）
  return out;
}

/** 当前班级（存在 app_setting 里，找不到就取第一个） */
export async function loadCurrentClass(db: Db | Tx, schoolId: string): Promise<string> {
  const row = await db.get<{ value: unknown }>(
    'SELECT value FROM app_setting WHERE school_id = ? AND key = ?',
    [schoolId, SETTING_CURRENT],
  );
  const v = parseJson(row?.value);
  if (typeof v === 'string') return v;
  const classes = await listClasses(db, schoolId);
  return classes[0]?.name || '';
}

export async function saveCurrentClass(db: Db | Tx, schoolId: string, name: string): Promise<void> {
  const now = nowIso();
  await db.run(
    `INSERT INTO app_setting (school_id, key, value, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT (school_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [schoolId, SETTING_CURRENT, JSON.stringify(String(name || '')), now],
  );
}

function parseJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/* ---------- 权限 ---------- */

/** 按班级名做可读校验（ctx 的 helper 只认名字） */
export function assertCanView(ctx: Ctx, className: string): void {
  if (!ctx.canViewClass(className)) {
    throw err.forbidden('当前账号没有「' + (className || '未分班') + '」的查看权限');
  }
}

export function assertCanEdit(ctx: Ctx, className: string): void {
  if (!ctx.canEditClass(className)) {
    throw err.forbidden('当前账号没有「' + (className || '未分班') + '」的修改权限');
  }
}

/* ---------- 写：班级 ---------- */

export async function ensureClassRow(
  t: Tx,
  schoolId: string,
  name: string,
  createdAtIso: string,
  createdBy: string,
): Promise<ClassRow> {
  const existed = await findClassByName(t, schoolId, name);
  if (existed) return existed;
  const id = 'c_' + Math.random().toString(36).slice(2, 10);
  const now = nowIso();
  await t.run(
    `INSERT INTO class (id, school_id, name, name_norm, term, status, version, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, schoolId, normClassName(name), nameNorm(name), '', 'active', 1, createdBy, createdAtIso || now, now],
  );
  const row = await findClassById(t, schoolId, id);
  if (!row) throw err.internal('班级创建后读取失败');
  return row;
}

/**
 * 整份班级元数据替换（前端 PUT /classes）。
 * 不在 incoming 里的班级 → 软删除（deleted_at），学生成员关系一并关闭。
 * 返回 {current, list}，与 GET /classes 同形，方便前端直接用返回值刷新。
 */
export async function replaceClasses(
  ctx: Ctx,
  payload: { current?: unknown; list?: unknown },
): Promise<{ current: string; list: ClassDTO[] }> {
  const schoolId = schoolIdOf(ctx);
  const actor = ctx.user?.id || '';
  const rawList = Array.isArray(payload.list) ? payload.list : [];

  // 规范化 + 去重（保留首个）
  const incoming: Array<{ name: string; createdAt: number }> = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    const name = normClassName((item as { name?: unknown })?.name);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    incoming.push({ name, createdAt: Number((item as { createdAt?: unknown })?.createdAt) || Date.now() });
  }

  await ctx.db.tx(async (t) => {
    const before = await listClasses(t, schoolId);
    const beforeNames = new Set(before.map((c) => c.name));

    // 1) 新建缺的
    for (const c of incoming) {
      await ensureClassRow(t, schoolId, c.name, new Date(c.createdAt).toISOString(), actor);
    }

    // 2) 软删除多出来的（前端删班）
    const keep = new Set(incoming.map((c) => c.name));
    for (const c of before) {
      if (keep.has(c.name)) continue;
      const now = nowIso();
      await t.run('UPDATE class SET deleted_at = ?, updated_at = ?, status = ? WHERE id = ?', [
        now,
        now,
        'archived',
        c.id,
      ]);
      await t.run('UPDATE class_student SET left_at = ? WHERE class_id = ? AND left_at IS NULL', [now, c.id]);
      log.info('班级已归档', { name: c.name, existed: beforeNames.has(c.name) });
    }

    // 3) 当前班级
    const current = normClassName(payload.current);
    const validCurrent = keep.has(current) ? current : incoming[0]?.name || '';
    await saveCurrentClass(t, schoolId, validCurrent);
  });

  const schoolId2 = schoolId;
  const list = await listClasses(ctx.db, schoolId2);
  const current = await loadCurrentClass(ctx.db, schoolId2);
  const dto: ClassDTO[] = [];
  for (const c of list) {
    dto.push({
      id: c.id,
      name: c.name,
      createdAt: Date.parse(c.created_at) || Date.now(),
      students: await listClassStudents(ctx.db, schoolId2, c.id),
    });
  }
  return { current, list: dto };
}

/* ---------- 写：名单 ---------- */

function studentKeyOf(s: StudentDTO, className: string): string {
  const sid = String(s.id || '').trim();
  if (sid) return 'no:' + sid;
  return 'nm:' + normStudentName(s.name) + '\u0000' + className;
}

/**
 * 部分名单护栏（2026-11-21 线上事故的直接原因）。
 *
 * PUT /roster 是**全量对账**：没出现在 body 里的学生一律 left_at = now，
 * 没有在册班级的学生再被软删。前端只要漏提交一个班（例如只把当前班的
 * 学生发上来、或者导入时只传了新表里的班），那个班会整班消失，
 * 连带把该班的加分变成「挂在已删学生上的幽灵分」。
 *
 * 所以：body 里出现的班级集合必须覆盖「库里有在册学生的全部班级」。
 * 确实要整班删除时，必须带 ?confirm=partial 显式确认。
 */
async function assertRosterCoversLiveClasses(
  ctx: Ctx,
  schoolId: string,
  incomingClassNames: Set<string>,
): Promise<void> {
  const live = await ctx.db.all<{ name: string }>(
    `SELECT DISTINCT c.name
       FROM class c
       JOIN class_student cs ON cs.class_id = c.id AND cs.left_at IS NULL
      WHERE c.school_id = ? AND c.deleted_at IS NULL`,
    [schoolId],
  );
  const missing = live.map((r) => r.name).filter((n) => n && !incomingClassNames.has(n));
  if (!missing.length) return;
  if (String(ctx.query.get('confirm') || '') === 'partial') {
    log.warn('名单部分提交已确认，将关闭缺失班级的成员关系', { missing });
    return;
  }
  throw err.conflict(
    '这次提交的名单里没有「' + missing.join('、') + '」，直接写入会把'
    + (missing.length > 1 ? '这些班' : '这个班') + '的成员全部移出并软删学生。'
    + '如果是导入表格只包含部分班级，请提交完整名单；'
    + '如果确实要清空' + (missing.length > 1 ? '这些班' : '这个班') + '，请带 confirm=partial 重新提交。',
    { reason: 'ROSTER_PARTIAL', missingClasses: missing },
  );
}

/**
 * 整份名单替换（前端 PUT /roster，body 是学生数组本身）。
 *
 * 对账策略（幂等，可重复执行）：
 *   · incoming 里出现、库里没有 → 建 student + 建 class_student
 *   · 两边都有 → 更新姓名/学号，确保 left_at 为 NULL
 *   · 库里有、incoming 没有 → class_student.left_at = now
 *   · 学生没有任何在册班级 → student.deleted_at = now（软删，保留加分流水引用）
 *
 * 班级按名字自动补建：前端可能先 saveRoster 再 saveClasses，
 * 这里不能因为班级还不存在就丢数据。
 */
export async function replaceRoster(ctx: Ctx, list: unknown): Promise<{ count: number; classes: number }> {
  const schoolId = schoolIdOf(ctx);
  const actor = ctx.user?.id || '';
  const incomingRaw = Array.isArray(list) ? list : [];

  const incoming: StudentDTO[] = [];
  for (const item of incomingRaw) {
    const o = item as { name?: unknown; id?: unknown; group?: unknown };
    const name = normStudentName(o?.name);
    if (!name) continue;
    incoming.push({
      name,
      id: String(o?.id == null ? '' : o.id).trim().slice(0, 40),
      group: normClassName(o?.group),
    });
  }

  const classCount = new Set(incoming.map((s) => s.group).filter(Boolean)).size;

  // 空名单由路由层的 assertClearAllowed 管；这里管「有数据但漏了班」
  if (incoming.length) {
    await assertRosterCoversLiveClasses(
      ctx,
      schoolId,
      new Set(incoming.map((s) => s.group).filter(Boolean)),
    );
  }

  await ctx.db.tx(async (t) => {
    const now = nowIso();

    // 1) 班级自动补建
    const classIdByName = new Map<string, string>();
    for (const name of new Set(incoming.map((s) => s.group).filter(Boolean))) {
      const row = await ensureClassRow(t, schoolId, name, now, actor);
      classIdByName.set(name, row.id);
    }

    // 2) 现有学生索引：学号 → 行；legacy_key → 行
    //
    // 这里必须把**软删的行也一起索引**。线上曾经出现过 49 组「软删旧行 + 在世新行」
    // 的同人双记录（2026-11-21 11:32 那次整班误删事故的产物）：只索引在世行时，
    // 重新导入名单会给同一个人再 INSERT 一条新行，历史加分留在旧行上，
    // 于是变成「班级总分有 5 分、学生排行榜里找不到这个人」的幽灵分。
    // 现在的策略是：命中软删行就复活它（deleted_at 置回 NULL），不新建。
    const existing = await t.all<StudentRow>(
      'SELECT * FROM student WHERE school_id = ?',
      [schoolId],
    );
    const byNo = new Map<string, StudentRow>();
    const byLegacy = new Map<string, StudentRow>();
    // 同一 key 可能同时有在世行与软删行，永远让在世行占位
    const put = (map: Map<string, StudentRow>, key: string, r: StudentRow): void => {
      const cur = map.get(key);
      if (cur && !cur.deleted_at) return;
      map.set(key, r);
    };
    for (const r of existing) {
      if (r.external_student_id) put(byNo, r.external_student_id, r);
      if (r.legacy_key) put(byLegacy, r.legacy_key, r);
    }

    // 3) 逐条对账
    const liveKeys = new Set<string>();
    for (let i = 0; i < incoming.length; i++) {
      const s = incoming[i];
      const key = studentKeyOf(s, s.group);
      liveKeys.add(key);

      let row = s.id ? byNo.get(s.id) : undefined;
      if (!row) row = byLegacy.get(key);

      if (!row) {
        const id = 's_' + Math.random().toString(36).slice(2, 10);
        await t.run(
          `INSERT INTO student
             (id, school_id, external_student_id, external_person_id, name, name_norm, legacy_key, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, schoolId, s.id, '', s.name, nameNorm(s.name), key, 'active', now, now],
        );
        const created = await t.get<StudentRow>('SELECT * FROM student WHERE id = ?', [id]);
        if (created) {
          row = created;
          if (s.id) byNo.set(s.id, created);
          byLegacy.set(key, created);
        }
      } else {
        const revive = !!row.deleted_at;
        if (revive || row.name !== s.name || row.external_student_id !== s.id) {
          await t.run(
            'UPDATE student SET name = ?, name_norm = ?, external_student_id = ?, legacy_key = ?, deleted_at = NULL, updated_at = ? WHERE id = ?',
            [s.name, nameNorm(s.name), s.id, key, now, row.id],
          );
          if (revive) log.info('学生复活（命中软删行，历史加分保留）', { name: s.name, id: row.id });
          row.deleted_at = null;
        }
      }
      if (!row) continue;

      // 4) 成员关系：有则复位 left_at，无则插入
      const classId = s.group ? classIdByName.get(s.group) : '';
      if (!classId) continue;
      const cs = await t.get<{ left_at: string | null }>(
        'SELECT left_at FROM class_student WHERE class_id = ? AND student_id = ?',
        [classId, row.id],
      );
      if (!cs) {
        await t.run(
          'INSERT INTO class_student (class_id, student_id, seat_no, source, joined_at, left_at) VALUES (?,?,?,?,?,NULL)',
          [classId, row.id, i, 'import', now],
        );
      } else if (cs.left_at) {
        await t.run('UPDATE class_student SET left_at = NULL, joined_at = ?, seat_no = ? WHERE class_id = ? AND student_id = ?', [
          now,
          i,
          classId,
          row.id,
        ]);
      } else {
        await t.run('UPDATE class_student SET seat_no = ? WHERE class_id = ? AND student_id = ?', [i, classId, row.id]);
      }
    }

    // 5) 关闭不在 incoming 里的成员关系
    const liveRows = await t.all<{ class_id: string; student_id: string }>(
      `SELECT cs.class_id, cs.student_id
         FROM class_student cs
         JOIN class c ON c.id = cs.class_id
        WHERE c.school_id = ? AND cs.left_at IS NULL AND c.deleted_at IS NULL`,
      [schoolId],
    );
    const keepPairs = new Set<string>();
    for (const s of incoming) {
      const cid = s.group ? classIdByName.get(s.group) : '';
      const st = s.id ? byNo.get(s.id) : byLegacy.get(studentKeyOf(s, s.group));
      if (cid && st) keepPairs.add(cid + '\u0000' + st.id);
    }
    for (const r of liveRows) {
      if (keepPairs.has(r.class_id + '\u0000' + r.student_id)) continue;
      await t.run('UPDATE class_student SET left_at = ? WHERE class_id = ? AND student_id = ?', [
        now,
        r.class_id,
        r.student_id,
      ]);
    }

    // 6) 没有任何在册班级的学生 → 软删除
    await t.run(
      `UPDATE student SET deleted_at = ?, updated_at = ?
        WHERE school_id = ? AND deleted_at IS NULL
          AND id NOT IN (SELECT student_id FROM class_student WHERE left_at IS NULL)`,
      [now, now, schoolId],
    );
  });

  return { count: incoming.length, classes: classCount };
}

/* ---------- 导出（供路由层复用） ---------- */

export async function classesDTO(ctx: Ctx): Promise<{ current: string; list: ClassDTO[] }> {
  const schoolId = schoolIdOf(ctx);
  const list = await listClasses(ctx.db, schoolId);
  const current = await loadCurrentClass(ctx.db, schoolId);
  const out: ClassDTO[] = [];
  for (const c of list) {
    out.push({
      id: c.id,
      name: c.name,
      createdAt: Date.parse(c.created_at) || Date.now(),
      students: await listClassStudents(ctx.db, schoolId, c.id),
    });
  }
  return { current, list: out };
}

export { MAX_CLASS_NAME };
