/* ============================================================
   session.ts — 服务端会话
   ------------------------------------------------------------
   计划书 §11：
   · 库里只存 token 的 sha256（库泄露拿不到可用会话）
   · Cookie: HttpOnly + Secure + SameSite=Lax + Path=/
   · 空闲 30 分钟 / 绝对 2 小时（满 2 小时必须重新登录，见 SESSION_ABS_MIN）
   · 改密、禁用、权限变更 → 吊销该用户全部会话
   · 单用户并发会话 ≤ 5
   · 写操作要求 X-CSRF-Token（双提交，对比 csrf_secret）

   为什么 CSRF 用「双提交 + 同源校验」两道：
   双提交依赖前端能读到 cookie，但我们的会话 cookie 是 HttpOnly，
   所以 CSRF token 走**另一个非 HttpOnly** 的 cookie（rc_csrf），
   前端读它放 header；服务端比对 session.csrf_secret。
   同时校验 Origin/Referer，防止 token 被第三方页面带出来。
   ============================================================ */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import { randomToken } from './password.ts';
import type { Config } from '../config.ts';
import { err } from '../http.ts';

export interface SessionRow {
  id: string;
  user_id: string;
  school_id: string;
  token_hash: string;
  csrf_secret: string;
  issued_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
}

export const CSRF_COOKIE = 'rc_csrf';
export const MAX_SESSIONS_PER_USER = 5;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  token: string;
  csrf: string;
  sessionId: string;
  issuedAt: string;
  expiresAt: string;
}

/** 新建会话；超过并发上限时踢掉最早的（课堂场景下最旧的多半是别人电脑） */
export async function issueSession(
  db: Db,
  cfg: Config,
  user: { id: string; school_id: string },
  meta: { ip?: string; userAgent?: string },
): Promise<IssuedSession> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + cfg.sessionAbsoluteMs).toISOString();

  // 先清理该用户已过期/已吊销的会话，避免占用并发额度
  await db.run(
    `UPDATE session SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at <= ?`,
    [nowIso, user.id, nowIso],
  );

  const active = await db.all<{ id: string }>(
    `SELECT id FROM session
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY issued_at ASC`,
    [user.id, nowIso],
  );
  const overflow = active.length - (MAX_SESSIONS_PER_USER - 1);
  if (overflow > 0) {
    const victims = active.slice(0, overflow).map((r) => r.id);
    for (const id of victims) {
      await db.run('UPDATE session SET revoked_at = ? WHERE id = ?', [nowIso, id]);
    }
  }

  const id = 's_' + randomToken(9);
  await db.run(
    `INSERT INTO session
       (id, user_id, school_id, token_hash, csrf_secret, issued_at, expires_at, last_seen_at, ip, user_agent, revoked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
    [
      id,
      user.id,
      user.school_id,
      hashToken(token),
      csrf,
      nowIso,
      expiresAt,
      nowIso,
      meta.ip || null,
      meta.userAgent || null,
    ],
  );

  return { token, csrf, sessionId: id, issuedAt: nowIso, expiresAt };
}

/** 按 token 查会话；同时做空闲超时与滑动续期 */
export async function resolveSession(
  db: Db,
  cfg: Config,
  token: string | undefined,
): Promise<SessionRow | null> {
  if (!token) return null;
  const row = await db.get<SessionRow>('SELECT * FROM session WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return null;
  if (row.revoked_at) return null;

  const now = Date.now();
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return null;

  const lastSeen = Date.parse(row.last_seen_at);
  if (Number.isFinite(lastSeen) && now - lastSeen > cfg.sessionIdleMs) {
    await db.run('UPDATE session SET revoked_at = ? WHERE id = ?', [new Date(now).toISOString(), row.id]);
    return null;
  }

  // 滑动续期：每 60 秒最多写一次，避免每个请求都 UPDATE
  if (!Number.isFinite(lastSeen) || now - lastSeen > 60_000) {
    await db.run('UPDATE session SET last_seen_at = ? WHERE id = ?', [new Date(now).toISOString(), row.id]);
  }
  return row;
}

/** 校验 CSRF：header 与库里的 csrf_secret 等长比对 */
export function verifyCsrf(row: SessionRow, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(row.csrf_secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 同源校验：CSRF 的第二道。
 * 没 Origin/Referer 的请求（curl、脚本）放行——它们带不了受害者 cookie；
 * 有 Origin 且不匹配 Host 的，一律拒绝。
 */
export function verifyOrigin(origin: string | undefined, referer: string | undefined, host: string | undefined): boolean {
  if (!host) return true;
  const src = origin || referer;
  if (!src) return true;
  try {
    const u = new URL(src);
    return u.host === host;
  } catch {
    return false;
  }
}

/** 吊销单个会话 */
export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.run('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    new Date().toISOString(),
    sessionId,
  ]);
}

/** 吊销某用户全部会话（改密 / 禁用 / 权限变更时调用） */
export async function revokeAllForUser(db: Db, userId: string, exceptSessionId?: string): Promise<number> {
  const now = new Date().toISOString();
  if (exceptSessionId) {
    return db.run(
      'UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
      [now, userId, exceptSessionId],
    );
  }
  return db.run('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
}

/** 断言已登录，否则抛 401 */
export function requireSession(row: SessionRow | null): SessionRow {
  if (!row) throw err.unauthorized();
  return row;
}
