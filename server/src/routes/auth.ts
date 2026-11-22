/* ============================================================
   routes/auth.ts — 认证路由
   ------------------------------------------------------------
   POST /auth/login    登录（失败计数 + 锁定）
   POST /auth/logout   登出（幂等）
   POST /auth/refresh  续期
   GET  /me            当前用户 + 权限 + 范围
   POST /auth/password 改自己的密码（改后吊销其它会话）
   POST /auth/verify-password 校验当前登录者的密码（危险操作二次确认）
   ============================================================ */

import type { Router } from '../router.ts';
import type { Ctx } from '../ctx.ts';
import { json, err, cookie } from '../http.ts';
import type { Reply } from '../http.ts';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/password.ts';
import { createUser, findByLogin, toMe, touchLogin, updateUser, findById } from '../auth/users.ts';
import { CSRF_COOKIE, issueSession, revokeAllForUser, revokeSession } from '../auth/session.ts';
import { log } from '../log.ts';

/* ---------- 内置访客账号 ---------- */

/** 访客登录复用的唯一账号（role='viewer'，无密码，不能走 /auth/login） */
export const GUEST_LOGIN = 'guest';

/* ---------- 登录失败计数 ---------- */

/**
 * 统计窗口内的失败次数。
 *
 * 必须显式传 schoolId：登录路由是 auth:false 的匿名请求，ctx.session 恒为 null，
 * 早先写成 `ctx.session?.school_id || ''` 会让查询用空串、写入用真实 school_id，
 * 两边永不匹配 → fails 恒为 0 → 限流完全失效（验收测试实测 35 次连错无一 429）。
 *
 * 账号与 IP 分开计数：同一个 NAT 后面的全校共用一个出口 IP，
 * 如果两者同阈值，一个学生手滑输错 5 次就能把整个学校锁在门外。
 */
async function recentFailures(
  ctx: Ctx,
  schoolId: string,
  username: string,
): Promise<{ byName: number; byIp: number }> {
  const since = new Date(Date.now() - ctx.cfg.loginWindowMs).toISOString();
  const nameRow = await ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM login_attempt
      WHERE school_id = ? AND lower(username) = lower(?) AND ok = 0 AND created_at >= ?`,
    [schoolId, username, since],
  );
  const ipRow = await ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM login_attempt
      WHERE school_id = ? AND ip = ? AND ok = 0 AND created_at >= ?`,
    [schoolId, ctx.ip, since],
  );
  return { byName: Number(nameRow?.n ?? 0), byIp: Number(ipRow?.n ?? 0) };
}

async function noteAttempt(ctx: Ctx, schoolId: string, username: string, ok: boolean): Promise<void> {
  await ctx.db.run(
    'INSERT INTO login_attempt (school_id, username, ip, ok, created_at) VALUES (?,?,?,?,?)',
    [schoolId, username.slice(0, 64), ctx.ip, ok ? 1 : 0, new Date().toISOString()],
  );
}

/* ---------- 危险操作的密码校验失败计数 ---------- */

/**
 * 「删除班级」这类不可撤销的操作，前端会让用户再输一次登录密码。
 * 如果只校验不计数，一个偷到会话的人就能在这里无限次猜密码 ——
 * 而登录接口那边已经被限流挡住了，等于开了个后门。
 *
 * 计数放在内存里：单进程部署够用，进程重启即清零（可接受，
 * 重启本身就要重新登录）。按 user.id 计数，不按 IP ——
 * 同一个办公室的 NAT 后面可能坐着好几个老师。
 */
const VERIFY_WINDOW_MS = 10 * 60_000;
const MAX_VERIFY_FAILS = 5;
const verifyFails = new Map<string, { n: number; since: number }>();

function verifyFailCount(userId: string): number {
  const e = verifyFails.get(userId);
  if (!e) return 0;
  if (Date.now() - e.since > VERIFY_WINDOW_MS) {
    verifyFails.delete(userId);
    return 0;
  }
  return e.n;
}

function noteVerifyFail(userId: string): void {
  const now = Date.now();
  const e = verifyFails.get(userId);
  if (!e || now - e.since > VERIFY_WINDOW_MS) {
    verifyFails.set(userId, { n: 1, since: now });
    return;
  }
  e.n += 1;
  // 顺手清掉过期的键，别让 Map 无限长
  if (verifyFails.size > 500) {
    for (const [k, v] of verifyFails) {
      if (now - v.since > VERIFY_WINDOW_MS) verifyFails.delete(k);
    }
  }
}

export function registerAuthRoutes(r: Router): void {
  /* ---------- 登录 ---------- */
  r.post(
    '/auth/login',
    async (ctx: Ctx): Promise<Reply> => {
      const body = (ctx.body || {}) as { login?: string; username?: string; password?: string };
      const login = String(body.login || body.username || '').trim();
      const password = String(body.password || '');

      if (!login || !password) throw err.badRequest('请输入登录名和密码');

      // 学校：单校部署用默认 school；多校时由域名/子域决定（P2）
      const school = await ctx.db.get<{ id: string }>('SELECT id FROM school WHERE code = ?', [
        ctx.cfg.defaultSchoolCode,
      ]);
      if (!school) throw err.internal('学校未初始化');

      const fails = await recentFailures(ctx, school.id, login);
      if (fails.byName >= ctx.cfg.loginMaxFails) {
        log.warn('登录被限流（账号）', { login, ip: ctx.ip, fails: fails.byName });
        throw err.tooMany(
          `尝试次数过多，请 ${Math.ceil(ctx.cfg.loginWindowMs / 60000)} 分钟后再试`,
        );
      }
      // IP 阈值放宽到 4 倍：教室/校园网共用一个出口 IP，
      // 与账号同阈值会让一个学生手滑把全校锁在门外。
      if (fails.byIp >= ctx.cfg.loginMaxFails * 4) {
        log.warn('登录被限流（IP）', { login, ip: ctx.ip, fails: fails.byIp });
        throw err.tooMany(
          `尝试次数过多，请 ${Math.ceil(ctx.cfg.loginWindowMs / 60000)} 分钟后再试`,
        );
      }

      const user = await findByLogin(ctx.db, school.id, login);
      // 统一文案：不泄露账号是否存在
      const badLogin = err.unauthorized('登录名或密码不正确');
      if (!user) {
        await noteAttempt(ctx, school.id, login, false);
        throw badLogin;
      }
      if (user.status !== 'active') {
        await noteAttempt(ctx, school.id, login, false);
        throw err.forbidden('该账号已被停用，请联系管理员');
      }
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        await noteAttempt(ctx, school.id, login, false);
        throw badLogin;
      }

      await noteAttempt(ctx, school.id, login, true);
      await touchLogin(ctx.db, user.id);

      const issued = await issueSession(ctx.db, ctx.cfg, user, { ip: ctx.ip, userAgent: ctx.userAgent });
      const maxAgeSec = Math.floor(ctx.cfg.sessionAbsoluteMs / 1000);

      await ctx.audit('auth.login', { targetType: 'user', targetId: user.id });

      return json(
        200,
        toMe(user, { issued_at: issued.issuedAt, expires_at: issued.expiresAt }),
        {
          'Set-Cookie': [
            cookie(ctx.cfg.cookieName, issued.token, {
              maxAgeSec,
              secure: ctx.cfg.cookieSecure,
              httpOnly: true,
              sameSite: 'Lax',
            }),
            cookie(CSRF_COOKIE, issued.csrf, {
              maxAgeSec,
              secure: ctx.cfg.cookieSecure,
              httpOnly: false,
              sameSite: 'Lax',
            }),
          ],
        },
      );
    },
    { auth: false },
  );

  /* ---------- 访客登录（只读） ----------
     不创建任意账号：全库只有一个内置访客账号 GUEST_LOGIN，
     首次使用时建出来（password_hash = NULL，无法用密码登录），
     之后每次点「访客登录」都复用它，并下发一个普通会话。
     权限由 role='viewer' 的默认值决定，服务端仍在每个写接口上校验，
     所以即便前端被改，访客也加不了分。 */
  r.post(
    '/auth/guest',
    async (ctx: Ctx): Promise<Reply> => {
      const school = await ctx.db.get<{ id: string }>('SELECT id FROM school WHERE code = ?', [
        ctx.cfg.defaultSchoolCode,
      ]);
      if (!school) throw err.internal('学校未初始化');

      let guest = await findByLogin(ctx.db, school.id, GUEST_LOGIN);
      if (!guest) {
        guest = await createUser(ctx.db, {
          schoolId: school.id,
          username: GUEST_LOGIN,
          displayName: '访客',
          role: 'viewer',
          passwordHash: null,
          authSource: 'local',
          permissions: null,
          classScopes: null,
          mustChange: false,
        });
        log.info('已创建内置访客账号', { login: GUEST_LOGIN });
      }
      if (guest.status !== 'active') throw err.forbidden('访客账号已被停用，请联系管理员');

      await touchLogin(ctx.db, guest.id);
      const issued = await issueSession(ctx.db, ctx.cfg, guest, { ip: ctx.ip, userAgent: ctx.userAgent });
      const maxAgeSec = Math.floor(ctx.cfg.sessionAbsoluteMs / 1000);

      await ctx.audit('auth.guest_login', { targetType: 'user', targetId: guest.id });

      return json(
        200,
        toMe(guest, { issued_at: issued.issuedAt, expires_at: issued.expiresAt }),
        {
          'Set-Cookie': [
            cookie(ctx.cfg.cookieName, issued.token, {
              maxAgeSec,
              secure: ctx.cfg.cookieSecure,
              httpOnly: true,
              sameSite: 'Lax',
            }),
            cookie(CSRF_COOKIE, issued.csrf, {
              maxAgeSec,
              secure: ctx.cfg.cookieSecure,
              httpOnly: false,
              sameSite: 'Lax',
            }),
          ],
        },
      );
    },
    { auth: false },
  );

  /* ---------- 登出 ---------- */
  r.post('/auth/logout', async (ctx: Ctx): Promise<Reply> => {
    if (ctx.session) {
      await revokeSession(ctx.db, ctx.session.id);
      await ctx.audit('auth.logout', { targetType: 'user', targetId: ctx.session.user_id });
    }
    return {
      status: 204,
      headers: {
        'Set-Cookie': [
          cookie(ctx.cfg.cookieName, '', { maxAgeSec: 0, secure: ctx.cfg.cookieSecure }),
          cookie(CSRF_COOKIE, '', { maxAgeSec: 0, secure: ctx.cfg.cookieSecure, httpOnly: false }),
        ],
      },
    };
  });

  /* ---------- 续期（滑动过期） ---------- */
  r.post('/auth/refresh', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.user) throw err.unauthorized();
    return json(200, toMe(ctx.user, ctx.session));
  });

  /* ---------- 当前用户 ---------- */
  r.get(
    '/me',
    async (ctx: Ctx): Promise<Reply> => {
      if (!ctx.user) throw err.unauthorized();
      return json(200, toMe(ctx.user, ctx.session));
    },
    { auth: false },
  );

  /* ---------- 校验登录密码（危险操作二次确认） ----------
     用途：删除班级这种不可撤销的操作，前端要求再输一次登录密码。
     只校验当前登录者自己的密码，不查别人，也不需要额外权限
     —— 能登录就说明有密码，输对就放行。

     注意两点：
     1) 密码错必须回 403，不能回 401。前端 adapter-remote 的 401 分支
        会统一调 RCSession.expireNow('unauthorized') 把人踢回登录页，
        用户只是手滑输错一次密码，不该被登出。
     2) 失败要计数限流。登录接口有限流，这里不限的话就是绕过限流
        猜密码的后门。 */
  r.post('/auth/verify-password', async (ctx: Ctx): Promise<Reply> => {
    const user = ctx.user;
    if (!user) throw err.unauthorized();

    const fails = verifyFailCount(user.id);
    if (fails >= MAX_VERIFY_FAILS) {
      log.warn('危险操作密码校验被限流', { userId: user.id, fails });
      throw err.tooMany('密码输错次数过多，请 10 分钟后再试');
    }

    const body = (ctx.body || {}) as { password?: string };
    const password = String(body.password || '');
    if (!password) throw err.badRequest('请输入登录密码');

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      noteVerifyFail(user.id);
      await ctx.audit('auth.verify_password_failed', { targetType: 'user', targetId: user.id });
      throw err.forbidden('密码不正确');
    }

    // 校验通过就清掉计数，别让白天的几次手滑累积到晚上
    verifyFails.delete(user.id);
    return json(200, { ok: true });
  });

  /* ---------- 改自己的密码 ---------- */
  r.post('/auth/password', async (ctx: Ctx): Promise<Reply> => {
    const user = ctx.user;
    if (!user) throw err.unauthorized();
    if (!ctx.can('auth.change_password')) throw err.forbidden('没有修改密码的权限');

    const body = (ctx.body || {}) as { oldPassword?: string; newPassword?: string };
    const oldPw = String(body.oldPassword || '');
    const newPw = String(body.newPassword || '');

    const policy = checkPasswordPolicy(newPw);
    if (!policy.ok) throw err.badRequest(policy.msg || '新密码不符合要求');

    const ok = await verifyPassword(oldPw, user.password_hash);
    if (!ok) throw err.badRequest('原密码不正确');
    if (oldPw === newPw) throw err.badRequest('新密码不能与原密码相同');

    const hash = await hashPassword(newPw);
    await updateUser(ctx.db, user.id, { passwordHash: hash, mustChange: false });

    // 改密后吊销其它会话，只保留当前这个
    const revoked = await revokeAllForUser(ctx.db, user.id, ctx.session?.id);
    await ctx.audit('auth.change_password', {
      targetType: 'user',
      targetId: user.id,
      after: { revokedSessions: revoked },
    });

    const fresh = await findById(ctx.db, user.id);
    return json(200, fresh ? toMe(fresh, ctx.session) : { ok: true });
  });
}
