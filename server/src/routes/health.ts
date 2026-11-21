/* ============================================================
   routes/health.ts — 探活与就绪
   ------------------------------------------------------------
   GET /healthz  进程活着就行，不查数据库（给负载均衡用）
   GET /readyz   必须能查库 + 迁移已跑完（给部署脚本用）
   ------------------------------------------------------------
   为什么不合成一个：K8s / docker healthcheck 的语义不同，
   数据库短暂不可用时进程是健康的（不该重启），只是不 ready。
   ============================================================ */

import type { Router } from '../router.ts';
import type { Ctx } from '../ctx.ts';
import { json, type Reply } from '../http.ts';

const STARTED_AT = Date.now();

export function registerHealthRoutes(r: Router): void {
  r.get(
    '/healthz',
    async (ctx: Ctx): Promise<Reply> => {
      return json(200, {
        ok: true,
        service: 'rollcall-server',
        version: ctx.cfg.exposeVersion ? '1.0.0' : undefined,
        uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
        time: new Date().toISOString(),
      });
    },
    { auth: false, csrf: false },
  );

  r.get(
    '/readyz',
    async (ctx: Ctx): Promise<Reply> => {
      const checks: Record<string, string> = {};
      let ok = true;

      // 1. 数据库可查
      try {
        await ctx.db.get('SELECT 1 AS one');
        checks.db = 'ok';
      } catch (e) {
        ok = false;
        checks.db = 'fail: ' + String((e as Error)?.message || e);
      }

      // 2. 迁移是否跑过
      try {
        const row = await ctx.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM schema_migration',
        );
        const n = Number(row?.n ?? 0);
        checks.migrations = n > 0 ? `ok (${n})` : 'none';
        if (n === 0) ok = false;
      } catch {
        ok = false;
        checks.migrations = 'fail';
      }

      // 3. 学校是否已初始化
      try {
        const row = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM school');
        const n = Number(row?.n ?? 0);
        checks.school = n > 0 ? 'ok' : 'none';
        if (n === 0) ok = false;
      } catch {
        ok = false;
        checks.school = 'fail';
      }

      return json(ok ? 200 : 503, { ok, checks, driver: ctx.db.dialect, time: new Date().toISOString() });
    },
    { auth: false, csrf: false },
  );
}
