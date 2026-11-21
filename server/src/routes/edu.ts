/* ============================================================
   routes/edu.ts — 教务对接接口
   ------------------------------------------------------------
   GET  /edu/status  → 是否已配置 + 最近几次同步记录
   POST /edu/sync    → 一键读取教务名单并落库

   权限：roster.sync（管理员与已授权的教务管理员）。
   为什么不是所有人都能点：一次同步会建班、建学生、建讲师账号，
   影响面比加分大得多，默认只给管理员。
   ============================================================ */

import type { Router } from '../router.ts';
import type { Ctx } from '../ctx.ts';
import { json, err, type Reply } from '../http.ts';
import { log } from '../log.ts';
import { schoolIdOf } from '../domain/common.ts';
import {
  applyEduSnapshot,
  fetchEduSnapshot,
  recentEduRuns,
} from '../domain/edu.ts';

export function registerEduRoutes(r: Router): void {
  /* ---------- 状态 ---------- */
  r.get(
    '/edu/status',
    async (ctx: Ctx): Promise<Reply> => {
      ctx.need('roster.sync');
      const schoolId = schoolIdOf(ctx);
      const runs = await recentEduRuns(ctx.db, schoolId, 5);
      return json(200, {
        configured: !!ctx.cfg.eduBaseUrl,
        baseUrl: ctx.cfg.eduBaseUrl || '',
        hasToken: !!ctx.cfg.eduToken,
        idField: ctx.cfg.eduIdField,
        timeoutMs: ctx.cfg.eduTimeoutMs,
        runs,
      });
    },
  );

  /* ---------- 一键同步 ---------- */
  r.post(
    '/edu/sync',
    async (ctx: Ctx): Promise<Reply> => {
      ctx.need('roster.sync');
      const schoolId = schoolIdOf(ctx);
      const actor = ctx.user?.id || '';
      const actorName = ctx.user?.display_name || '';

      const t0 = Date.now();
      const snapshot = await fetchEduSnapshot(ctx.cfg);
      if (!snapshot.classes.length) {
        throw err.badRequest('教务系统返回的名单是空的，请确认教务侧已排课或有权限读取');
      }

      const out = await applyEduSnapshot(ctx.db, ctx.cfg, snapshot, {
        schoolId,
        actorUserId: actor,
        triggerBy: actorName || actor,
      });

      await ctx.audit('edu.sync', {
        targetType: 'edu_sync_run',
        targetId: String(out.runId),
        after: {
          classes: out.classCount,
          students: out.studentCount,
          teachers: out.teacherCount,
          created: out.createdClasses + out.createdStudents + out.createdTeachers,
        },
      });
      log.info('教务同步完成', {
        runId: out.runId,
        classes: out.classCount,
        students: out.studentCount,
        teachers: out.teacherCount,
        ms: Date.now() - t0,
      });
      return json(200, out);
    },
    { csrf: true },
  );
}
