/* ============================================================
   routes/scores.ts — 加分流水
   ------------------------------------------------------------
     GET    /classes/:name/scores   → {records:[{id,t,name,sid,delta,reason}]}
     PUT    /classes/:name/scores   ← {records:[...]}   （对账式写入）
     DELETE /classes/:name/scores   → {cleared:n}       （全部冲正）
     GET    /classes/:name/scores/all → 含已冲正，管理台用

   为什么 PUT 而不是 POST：
     前端把「本班全部记录」当作真相发上来（它本地就是数组），
     服务端做对账 —— 语义上是「用这份替换掉那份」，所以是 PUT，
     也因此天然幂等（同一份 payload 重放不会多出记录）。

   :name 是班级名（URL 编码）。这里必须走 assertCanEdit 做权限，
   且断言发生在任何写库动作之前。
   ============================================================ */

import type { Router } from '../router.ts';
import type { Ctx } from '../ctx.ts';
import { json, err, type Reply } from '../http.ts';
import { normClassName, schoolIdOf } from '../domain/common.ts';
import { assertCanView, findClassByName } from '../domain/classes.ts';
import {
  clearScores,
  listScores,
  listScoresAll,
  replaceScores,
  scoresByClassName,
} from '../domain/scores.ts';

export function registerScoreRoutes(r: Router): void {
  r.get('/classes/:name/scores', async (ctx: Ctx): Promise<Reply> => {
    const name = normClassName(ctx.params.name);
    const records = await scoresByClassName(ctx, name);
    return json(200, { records });
  });

  r.get('/classes/:name/scores/all', async (ctx: Ctx): Promise<Reply> => {
    const name = normClassName(ctx.params.name);
    assertCanView(ctx, name);
    if (!ctx.can('record.view_cross_class') && !ctx.can('audit.view')) {
      // 含冲正明细属于审计级信息，普通讲师看不到别人的
      const scopes = ctx.classScopes();
      if (scopes !== null && !scopes.includes(name)) {
        throw err.forbidden('当前账号没有查看该班冲正明细的权限');
      }
    }
    const schoolId = schoolIdOf(ctx);
    const cls = await findClassByName(ctx.db, schoolId, name);
    if (!cls) return json(200, { records: [] });
    return json(200, { records: await listScoresAll(ctx.db, schoolId, cls.id) });
  });

  r.put('/classes/:name/scores', async (ctx: Ctx): Promise<Reply> => {
    const name = normClassName(ctx.params.name);
    // 权限细粒度：加/扣/自定义分是不同的 key。
    // 这里无法逐条判断（一次请求里可能既有 +1 又有 -2），
    // 所以要求「至少有一种改分权限」，具体的越界由前端按钮控制 +
    // 服务端按角色兜底（viewer 一个都没有 → 直接 403）。
    const canAny =
      ctx.can('score.add') || ctx.can('score.subtract') || ctx.can('score.custom_value');
    if (!canAny) throw err.forbidden('当前账号没有加减分的权限');

    const body = (ctx.body || {}) as { records?: unknown };
    const out = await replaceScores(ctx, name, body);
    return json(200, { records: out.records });
  });

  r.del('/classes/:name/scores', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('score.void') && !ctx.can('score.delete_record')) {
      throw err.forbidden('当前账号没有清空加分记录的权限');
    }
    const name = normClassName(ctx.params.name);
    const out = await clearScores(ctx, name);
    return json(200, out);
  });
}
