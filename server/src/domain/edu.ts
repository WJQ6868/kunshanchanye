/* ============================================================
   domain/edu.ts — 教务系统对接（P3）
   ------------------------------------------------------------
   目标：老师点一次「从教务读取名单」，就把教务里的
   班级 + 学生 + 授课教师全部拉进来，落到本地库。

   三条硬约束（来自计划书 §12 与用户 m09224 的说明）：

   1) 教务用「身份证号」做人员标识，但计划书 §12:668 明确
      「不采集身份证号、手机号、住址」。
      → 我们只存 sha256 摘要（student.external_person_id），
        明文只在请求内存里过一遍，绝不落盘、绝不进日志。

   2) 教务是「名单来源」，不是课堂运行时依赖。
      → 同步是显式动作（按钮/接口），失败不影响加分；
        同步结果写 edu_sync_run 留痕。

   3) 讲师账号自动建出来，但密码由教务身份决定 ——
      教务还没接 SSO 时，先建「无密码、待激活」的账号
      （password_hash=NULL → 无法密码登录），
      等 SSO 接入后由 auth_source='sso' 放行。

   数据契约（教务方需按此返回，或由适配层转换）：
     GET {EDU_BASE_URL}/api/classes
     → { classes: [ { externalId, name, term?, students: [...], teachers: [...] } ] }
     学生项：{ name, studentNo?, idCard?, className? }
     教师项：{ name, employeeNo?, idCard? }
   ============================================================ */

import { createHash } from 'node:crypto';
import type { Db, Tx } from '../db/driver.ts';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { err } from '../http.ts';
import { randomToken } from '../auth/password.ts';
import { createUser, findByLogin } from '../auth/users.ts';
import {
  MAX_CLASS_NAME,
  nameNorm,
  normClassName,
  normStudentName,
  personDigest,
  round2,
} from './common.ts';
import { ensureClassRow, findClassByName } from './classes.ts';

/* ---------- 教务返回的原始结构 ---------- */

export interface EduStudent {
  name: string;
  studentNo?: string;
  idCard?: string;
  className?: string;
}

export interface EduTeacher {
  name: string;
  employeeNo?: string;
  idCard?: string;
}

export interface EduClass {
  externalId?: string;
  name: string;
  term?: string;
  students: EduStudent[];
  teachers: EduTeacher[];
}

export interface EduSnapshot {
  classes: EduClass[];
  fetchedAt: number;
  /** 教务不可用时的降级说明（有值表示这份数据来自缓存） */
  degraded?: string;
}

/* ---------- 拉取 ---------- */

/** 从教务系统拉一份完整快照。超时/网络错误一律抛 ApiError，不拖死课堂 */
export async function fetchEduSnapshot(cfg: Config): Promise<EduSnapshot> {
  if (!cfg.eduBaseUrl) {
    throw err.badRequest('尚未配置教务系统地址（EDU_BASE_URL），请先在服务端环境变量里填写');
  }
  const base = cfg.eduBaseUrl.replace(/\/+$/, '');
  const url = base + '/api/classes';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.eduTimeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(cfg.eduToken ? { Authorization: 'Bearer ' + cfg.eduToken } : {}),
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw err.badRequest(
        '教务系统返回 ' + res.status + '（' + url + '），请检查地址与凭据',
      );
    }
    const raw = (await res.json()) as unknown;
    const classes = normalizeEduPayload(raw);
    log.info('教务名单已拉取', { classes: classes.length, ms: Date.now() - t0 });
    return { classes, fetchedAt: Date.now() };
  } catch (e) {
    const ae = e as Error & { name?: string };
    if (ae?.name === 'AbortError') {
      throw err.badRequest('连接教务系统超时（' + cfg.eduTimeoutMs + 'ms），请稍后重试');
    }
    if ((e as { status?: number })?.status) throw e; // 已经是 ApiError
    throw err.badRequest('无法连接教务系统：' + String(ae?.message || e));
  } finally {
    clearTimeout(timer);
  }
}

/** 兼容几种常见返回形状：{classes:[...]} / [...] / {data:{classes:[...]}} */
export function normalizeEduPayload(raw: unknown): EduClass[] {
  const pick = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    const o = v as Record<string, unknown> | null;
    if (o && Array.isArray(o.classes)) return o.classes;
    if (o && o.data) {
      if (Array.isArray(o.data)) return o.data;
      const d = o.data as Record<string, unknown>;
      if (Array.isArray(d.classes)) return d.classes;
    }
    return [];
  };
  const list = pick(raw);
  const out: EduClass[] = [];
  for (const item of list) {
    const c = item as Record<string, unknown>;
    const name = normClassName(c?.name ?? c?.className ?? c?.title);
    if (!name) continue;
    const students = Array.isArray(c?.students) ? (c.students as Record<string, unknown>[]) : [];
    const teachers = Array.isArray(c?.teachers) ? (c.teachers as Record<string, unknown>[]) : [];
    out.push({
      externalId: c?.externalId ? String(c.externalId) : c?.id ? String(c.id) : undefined,
      name,
      term: c?.term ? String(c.term) : '',
      students: students
        .map((s) => ({
          name: normStudentName(s?.name ?? s?.studentName ?? s?.realName),
          studentNo: s?.studentNo ? String(s.studentNo) : s?.no ? String(s.no) : '',
          idCard: s?.idCard ? String(s.idCard) : s?.idcard ? String(s.idcard) : '',
        }))
        .filter((s) => s.name),
      teachers: teachers
        .map((t) => ({
          name: normStudentName(t?.name ?? t?.teacherName ?? t?.realName),
          employeeNo: t?.employeeNo ? String(t.employeeNo) : t?.no ? String(t.no) : '',
          idCard: t?.idCard ? String(t.idCard) : t?.idcard ? String(t.idcard) : '',
        }))
        .filter((t) => t.name),
    });
  }
  return out;
}

/* ---------- 落库 ---------- */

export interface EduSyncResult {
  runId: number;
  classCount: number;
  studentCount: number;
  teacherCount: number;
  createdClasses: number;
  createdStudents: number;
  createdTeachers: number;
  /** 教务读回后复活的软删学生数（之前被移出名单、这次又出现在教务里） */
  revivedStudents: number;
  updated: number;
  message: string;
}

function todayIso(): string {
  return new Date().toISOString();
}

/**
 * 给讲师「追加」一个任教班级。
 *
 * 两处都要写：
 * · app_user.class_scopes（JSON 数组）—— 鉴权时 ctx.ts 直接读它，是真正的权限来源；
 * · user_class_scope（关联表）—— 计划书 §6.1 要求的关系表，供「按班查老师」「转班」等场景。
 *
 * 用并集而不是覆盖：一个老师教两个班时，第二次同步不能把第一个班的加分权限抹掉。
 * 反过来，教务里取消了他的某个班，我们也不主动删 —— 名单同步只增不减，
 * 撤权是管理员的显式动作，不能因为一次同步误删而让老师上不了课。
 */
async function mergeClassScope(
  t: Tx,
  schoolId: string,
  userId: string,
  className: string,
): Promise<void> {
  const row = await t.get<{ class_scopes: string | null }>(
    'SELECT class_scopes FROM app_user WHERE id = ?',
    [userId],
  );
  let list: string[] = [];
  try {
    const parsed = row?.class_scopes ? JSON.parse(row.class_scopes) : null;
    if (Array.isArray(parsed)) list = parsed.map((v) => String(v));
  } catch {
    list = [];
  }
  if (list.indexOf(className) < 0) {
    list.push(className);
    await t.run('UPDATE app_user SET class_scopes = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(list),
      todayIso(),
      userId,
    ]);
  }

  const cls = await findClassByName(t, schoolId, className);
  if (cls) {
    const has = await t.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM user_class_scope WHERE user_id = ? AND class_id = ?',
      [userId, cls.id],
    );
    if (!Number(has?.n || 0)) {
      await t.run(
        "INSERT INTO user_class_scope (user_id, class_id, source, created_at) VALUES (?, ?, 'edu', ?)",
        [userId, cls.id, todayIso()],
      );
    }
  }
}

/**
 * 把教务快照写进本地库。
 *
 * 设计要点：
 * · 班级以「名字」为身份（与前端一致），教务的 externalId 只做辅助字段；
 * · 学生身份优先级：学号 > 身份证摘要 > (姓名+班级)；
 * · 讲师身份：工号 > 身份证摘要 > 姓名。新建的讲师一律
 *   role='teacher'、password_hash=NULL（等 SSO 或管理员重置密码）；
 * · 已存在的讲师只补工号/姓名，绝不覆盖密码与权限 ——
 *   否则每次同步都会把管理员手工调的权限冲掉。
 */
export async function applyEduSnapshot(
  db: Db,
  cfg: Config,
  snapshot: EduSnapshot,
  opts: { schoolId: string; actorUserId: string; triggerBy: string },
): Promise<EduSyncResult> {
  const { schoolId } = opts;
  const now = todayIso();
  let createdClasses = 0;
  let createdStudents = 0;
  let createdTeachers = 0;
  let revivedStudents = 0;
  let updated = 0;
  let studentCount = 0;
  let teacherCount = 0;

  // 注意：db.run() 返回的是「影响行数」，不是自增主键。
  // 所以这里插完必须回查 id，否则 runId 恒等于 1，
  // 后续 UPDATE ... WHERE id = ? 会改到别人的记录上，
  // 本次同步就永远停在 status='running'。
  await db.run(
    `INSERT INTO edu_sync_run (school_id, trigger_by, source, status, started_at)
     VALUES (?, ?, 'edu', 'running', ?)`,
    [schoolId, opts.actorUserId, now],
  );
  const runRow = await db.get<{ id: number }>(
    `SELECT id FROM edu_sync_run
      WHERE school_id = ? AND started_at = ?
      ORDER BY id DESC LIMIT 1`,
    [schoolId, now],
  );
  const runId = Number(runRow?.id || 0);

  try {
    await db.tx(async (t: Tx) => {
      for (const ec of snapshot.classes) {
        const className = normClassName(ec.name);
        if (!className) continue;
        const before = await findClassByName(t, schoolId, className);
        if (!before) {
          await ensureClassRow(t, schoolId, className, now, opts.actorUserId);
          createdClasses++;
        } else {
          // 只补 external_class_id，不动 status/version
          if (ec.externalId && before.external_class_id !== ec.externalId) {
            await t.run('UPDATE class SET external_class_id = ?, updated_at = ? WHERE id = ?', [
              ec.externalId,
              now,
              before.id,
            ]);
            updated++;
          }
        }
        const cls = await findClassByName(t, schoolId, className);
        if (!cls) continue;

        /* ----- 学生 ----- */
        let seat = 0;
        for (const es of ec.students) {
          const sname = normStudentName(es.name);
          if (!sname) continue;
          seat++;
          studentCount++;
          const studentNo = String(es.studentNo || '').trim();
          const digest = await personDigest(String(es.idCard || ''));
          // 三步定位：学号 → 身份证摘要 → 同班同名。
          // 每一步都先在「在世」学生里找，找不到再找被软删的那条并复活它。
          // 理由：学生被移出名单时是软删（deleted_at 置位，为 score_record 留引用），
          // 教务之后重新读回同一人，如果直接 INSERT 就会插出重复学生，
          // 历史加分被分裂到两个 student_id 上——排行榜里同一个名字出现两次。
          type SyncRow = { id: string; deleted_at: string | null };
          const findAny = async (sql: string, params: unknown[]): Promise<SyncRow | null> =>
            (await t.get<SyncRow>(sql, params)) || null;

          let row: SyncRow | null = null;
          if (studentNo) {
            row =
              (await findAny(
                'SELECT id, deleted_at FROM student WHERE school_id = ? AND external_student_id = ? AND deleted_at IS NULL',
                [schoolId, studentNo],
              )) ||
              (await findAny(
                'SELECT id, deleted_at FROM student WHERE school_id = ? AND external_student_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1',
                [schoolId, studentNo],
              ));
          }
          if (!row && digest) {
            row =
              (await findAny(
                'SELECT id, deleted_at FROM student WHERE school_id = ? AND external_person_id = ? AND deleted_at IS NULL',
                [schoolId, digest],
              )) ||
              (await findAny(
                'SELECT id, deleted_at FROM student WHERE school_id = ? AND external_person_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1',
                [schoolId, digest],
              ));
          }
          if (!row) {
            // 同班同名：软删行可能已经 left_at，所以第二段不要求 cs.left_at IS NULL
            row =
              (await findAny(
                `SELECT s.id, s.deleted_at FROM student s
                   JOIN class_student cs ON cs.student_id = s.id
                  WHERE s.school_id = ? AND s.name_norm = ? AND cs.class_id = ?
                    AND s.deleted_at IS NULL AND cs.left_at IS NULL`,
                [schoolId, nameNorm(sname), cls.id],
              )) ||
              (await findAny(
                `SELECT s.id, s.deleted_at FROM student s
                   JOIN class_student cs ON cs.student_id = s.id
                  WHERE s.school_id = ? AND s.name_norm = ? AND cs.class_id = ?
                    AND s.deleted_at IS NOT NULL
                  ORDER BY s.deleted_at DESC LIMIT 1`,
                [schoolId, nameNorm(sname), cls.id],
              ));
          }

          let studentId: string;
          if (row) {
            studentId = row.id;
            // 补齐缺的字段（教务比我们全），但不覆盖已有非空值；
            // 若这条之前被软删，教务重新读回说明人在册，一并复活。
            await t.run(
              `UPDATE student SET
                 external_student_id = CASE WHEN external_student_id = '' THEN ? ELSE external_student_id END,
                 external_person_id  = CASE WHEN external_person_id  = '' THEN ? ELSE external_person_id  END,
                 name = ?, name_norm = ?,
                 deleted_at = NULL,
                 updated_at = ?
               WHERE id = ?`,
              [studentNo, digest, sname, nameNorm(sname), now, studentId],
            );
            if (row.deleted_at) revivedStudents++;
          } else {
            studentId = 's_' + randomToken(9);
            await t.run(
              `INSERT INTO student
                 (id, school_id, external_student_id, external_person_id, name, name_norm, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
              [studentId, schoolId, studentNo, digest, sname, nameNorm(sname), now, now],
            );
            createdStudents++;
          }

          // 成员关系：存在则恢复 left_at，不存在则插入
          const cs = await t.get<{ left_at: string | null }>(
            'SELECT left_at FROM class_student WHERE class_id = ? AND student_id = ?',
            [cls.id, studentId],
          );
          if (!cs) {
            await t.run(
              `INSERT INTO class_student (class_id, student_id, seat_no, source, joined_at)
               VALUES (?, ?, ?, 'edu', ?)`,
              [cls.id, studentId, seat, now],
            );
          } else if (cs.left_at) {
            await t.run(
              'UPDATE class_student SET left_at = NULL, seat_no = ?, source = ? WHERE class_id = ? AND student_id = ?',
              [seat, 'edu', cls.id, studentId],
            );
          } else {
            await t.run('UPDATE class_student SET seat_no = ? WHERE class_id = ? AND student_id = ?', [
              seat,
              cls.id,
              studentId,
            ]);
          }
        }

        /* ----- 授课教师（自动建号） ----- */
        for (const et of ec.teachers) {
          const tname = normStudentName(et.name);
          if (!tname) continue;
          teacherCount++;
          const empNo = String(et.employeeNo || '').trim();
          const digest = await personDigest(String(et.idCard || ''));
          // 讲师用 employee_no 做身份（已有唯一索引 ux_user_employee）
          let user: { id: string } | null = null;
          if (empNo) {
            user = await t.get<{ id: string }>(
              'SELECT id FROM app_user WHERE school_id = ? AND employee_no = ?',
              [schoolId, empNo],
            );
          }
          if (!user) {
            // 退化到工号为空时用姓名拼音/姓名建登录名：t_<hash8>
            const login = empNo ? 't' + empNo.replace(/[^a-zA-Z0-9_.-]/g, '') : 't' + digest.slice(-8);
            if (login.length >= 3 && login.length <= 24) {
              const byLogin = await findByLogin(t, schoolId, login);
              if (byLogin) user = { id: byLogin.id };
            }
          }
          if (user) {
            // 已存在：只补姓名/工号，不碰密码与权限
            await t.run(
              `UPDATE app_user SET
                 display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END,
                 employee_no  = CASE WHEN employee_no  = '' THEN ? ELSE employee_no  END,
                 updated_at = ?
               WHERE id = ?`,
              [tname, empNo, now, user.id],
            );
            // 任教班级要「并集」而不是覆盖：同一个老师教两个班时，
            // 第二次同步不能把他第一个班的加分权限抹掉。
            await mergeClassScope(t, schoolId, user.id, className);
          } else {
            const login = empNo
              ? 't' + empNo.replace(/[^a-zA-Z0-9_.-]/g, '')
              : 't' + digest.slice(-8);
            const safeLogin = login.slice(0, 24) || 't' + randomToken(4).slice(0, 8);
            try {
              const created = await createUser(t as unknown as Db, {
                schoolId,
                username: safeLogin,
                displayName: tname,
                role: 'teacher',
                employeeNo: empNo || null,
                // 教务尚未接 SSO 时先不设密码：无法密码登录，
                // 等 SSO 打通或管理员重置密码后启用
                passwordHash: null,
                authSource: 'sso',
                permissions: null,
                classScopes: [className],
                mustChange: false,
              });
              createdTeachers++;
              await mergeClassScope(t, schoolId, created.id, className);
            } catch (e) {
              // 唯一约束冲突（并发同步）不致命，记一笔继续
              log.warn('教务讲师建号失败，已跳过', {
                login: safeLogin,
                err: String((e as Error)?.message || e),
              });
            }
          }
        }
      }
    });

    const message =
      '同步完成：' +
      snapshot.classes.length +
      ' 个班级 / ' +
      studentCount +
      ' 名学生 / ' +
      teacherCount +
      ' 名教师' +
      (revivedStudents ? '（复活 ' + revivedStudents + ' 名曾移出的学生）' : '') +
      (snapshot.degraded ? '（' + snapshot.degraded + '）' : '');

    await db.run(
      `UPDATE edu_sync_run SET status = 'ok', finished_at = ?, class_count = ?, student_count = ?,
         teacher_count = ?, created_count = ?, updated_count = ?, message = ? WHERE id = ?`,
      [
        todayIso(),
        snapshot.classes.length,
        studentCount,
        teacherCount,
        createdClasses + createdStudents + createdTeachers,
        updated,
        message,
        runId,
      ],
    );

    return {
      runId,
      classCount: snapshot.classes.length,
      studentCount,
      teacherCount,
      createdClasses,
      createdStudents,
      createdTeachers,
      revivedStudents,
      updated,
      message,
    };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    await db
      .run(
        `UPDATE edu_sync_run SET status = 'failed', finished_at = ?, message = ? WHERE id = ?`,
        [todayIso(), msg.slice(0, 500), runId],
      )
      .catch(() => undefined);
    throw e;
  }
}

/** 最近的同步记录，给前端「上次同步于…」提示 */
export async function recentEduRuns(db: Db, schoolId: string, limit = 5) {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT id, status, started_at, finished_at, class_count, student_count,
            teacher_count, created_count, updated_count, message
       FROM edu_sync_run WHERE school_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
    [schoolId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    status: String(r.status || ''),
    startedAt: String(r.started_at || ''),
    finishedAt: r.finished_at ? String(r.finished_at) : '',
    classCount: Number(r.class_count || 0),
    studentCount: Number(r.student_count || 0),
    teacherCount: Number(r.teacher_count || 0),
    created: Number(r.created_count || 0),
    updated: Number(r.updated_count || 0),
    message: String(r.message || ''),
  }));
}
