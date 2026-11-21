/* ============================================================
   routes/classes.ts — 班级 / 名单 / 设置 / 排行榜
   ------------------------------------------------------------
   这一组接口的形状完全由前端 adapter-remote.js 决定，
   因为目标是「前端零改动接入服务端」：

     GET  /classes            → {current, list:[{id,name,createdAt,students}]}
     PUT  /classes            ← {current, list}
     GET  /roster             → [{name,id,group}]
     PUT  /roster             ← [{name,id,group}]   （body 是数组本身）
     GET  /settings           → {anim,theme,...}    （裸对象，不包 value）
     PUT  /settings           ← {anim,theme,...}
     GET  /leaderboard?period=all|week|month
                              → {period, classes:[...], students:[...]}

   权限（与 auth/perm.ts 的 key 对齐）：
     · 读班级/名单 → 需登录 + class.view_all 或在自己 scope 内
     · 写班级      → class.create / class.rename / class.delete
     · 写名单      → roster.import
     · 写设置      → settings.open
   ============================================================ */

import type { Router } from '../router.ts';
import type { Ctx } from '../ctx.ts';
import { json, err, type Reply } from '../http.ts';
import { log } from '../log.ts';
import {
  classesDTO,
  loadRoster,
  replaceClasses,
  replaceRoster,
} from '../domain/classes.ts';
import { classStats, periodStart, studentStats } from '../domain/scores.ts';
import { loadSettings, saveSettings } from '../domain/settings.ts';
import { schoolIdOf } from '../domain/common.ts';

/** 只保留当前账号能看见的班级 */
function filterVisible(ctx: Ctx, list: Array<{ name: string }>): Array<{ name: string }> {
  return list.filter((c) => ctx.canViewClass(c.name));
}

export function registerClassRoutes(r: Router): void {
  /* ---------- 班级 ---------- */

  r.get('/classes', async (ctx: Ctx): Promise<Reply> => {
    const data = await classesDTO(ctx);
    const list = filterVisible(ctx, data.list) as typeof data.list;
    const current = list.some((c) => c.name === data.current) ? data.current : list[0]?.name || '';
    return json(200, { current, list });
  });

  r.put('/classes', async (ctx: Ctx): Promise<Reply> => {
    // 写班级是「建/改名/删」的混合操作，统一要求管理类权限；
    // 讲师默认没有 class.create，因此这里对讲师会 403 —— 与前端
    // applyPerms() 把「新建班级」按钮置灰的行为一致。
    if (!ctx.can('class.create') && !ctx.can('class.rename') && !ctx.can('class.delete')) {
      throw err.forbidden('当前账号没有管理班级的权限');
    }
    const body = (ctx.body || {}) as { current?: unknown; list?: unknown };
    const out = await replaceClasses(ctx, body);
    await ctx.audit('class.replace', {
      targetType: 'class',
      after: { count: out.list.length, current: out.current },
    });
    return json(200, { current: out.current, list: out.list });
  });

  /* ---------- 名单 ---------- */

  r.get('/roster', async (ctx: Ctx): Promise<Reply> => {
    const schoolId = schoolIdOf(ctx);
    const all = await loadRoster(ctx.db, schoolId);
    const visible = all.filter((s) => ctx.canViewClass(s.group));
    return json(200, visible);
  });

  r.put('/roster', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('roster.import')) throw err.forbidden('当前账号没有导入名单的权限');
    // body 是学生数组本身（前端 setRoster 直接发数组）
    const list = Array.isArray(ctx.body) ? ctx.body : [];
    // 越权保护：讲师只能改自己任教班级的名单
    const scopes = ctx.classScopes();
    if (scopes !== null) {
      const outside = new Set<string>();
      for (const item of list) {
        const g = String((item as { group?: unknown })?.group || '').trim();
        if (g && !scopes.includes(g)) outside.add(g);
      }
      if (outside.size) {
        throw err.forbidden('当前账号没有「' + Array.from(outside).join('、') + '」的名单修改权限');
      }
    }
    const out = await replaceRoster(ctx, list);
    await ctx.audit('roster.replace', { targetType: 'roster', after: out });
    log.info('名单已同步', out);
    return json(200, out);
  });

  /* ---------- 设置 ---------- */

  r.get('/settings', async (ctx: Ctx): Promise<Reply> => {
    const s = await loadSettings(ctx.db, schoolIdOf(ctx));
    return json(200, s);
  });

  r.put('/settings', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('settings.open')) throw err.forbidden('当前账号没有修改设置的权限');
    const saved = await saveSettings(ctx, ctx.body);
    await ctx.audit('settings.save', { targetType: 'setting', after: saved });
    return json(200, saved);
  });

  /* ---------- 排行榜 ---------- */

  r.get('/leaderboard', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('record.view_class') && !ctx.can('export.rank')) {
      throw err.forbidden('当前账号没有查看排行榜的权限');
    }
    const period = String(ctx.query.get('period') || 'all');
    const since = periodStart(period);
    const schoolId = schoolIdOf(ctx);

    const cls = filterVisible(ctx, await classStats(ctx.db, schoolId, since));
    // 学生榜按「可见班级」过滤，避免讲师从榜上看到别班学生姓名
    const stu = (await studentStats(ctx.db, schoolId, since, 15)).filter((s) =>
      ctx.canViewClass(s.className),
    );

    return json(200, {
      period,
      since,
      classes: cls,
      students: stu,
    });
  });
}
