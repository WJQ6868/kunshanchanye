/* ============================================================
   ctx.ts — 请求上下文
   ------------------------------------------------------------
   把「这个请求是谁发的、他有什么权限、能不能碰这个班」
   收在一个对象里，handler 只拿 ctx，不碰 req/res 原始对象。
   这样做的好处：写审计时 actor 信息一定齐全，不会出现
   「某个 handler 忘了记 operator」。
   ============================================================ */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Db } from './db/driver.ts';
import type { SessionRow } from './auth/session.ts';
import { effective, type Role } from './auth/perm.ts';
import { toPublic, type UserRow } from './auth/users.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  cfg: Config;
  db: Db;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  requestId: string;
  ip: string;
  userAgent: string;

  /** 已登录时非空 */
  session: SessionRow | null;
  user: UserRow | null;

  /** 当前用户的有效权限（未登录为空对象） */
  perms: Record<string, boolean>;
  role: Role | null;

  /** 是否拥有某权限 */
  can(key: string): boolean;
  /** 断言权限，缺则抛 403 */
  need(key: string): void;
  /** 当前用户可访问的班级名；null 表示不限 */
  /** 任教班级（可写范围）：null 表示不限 */
  classScopes(): string[] | null;
  /** 可查看班级（可读范围）：null 表示不限 */
  viewScopes(): string[] | null;
  /** 能不能看这个班（讲师默认看全部，只读） */
  canViewClass(name: string): boolean;
  /** 能不能改这个班（加减分/撤销/删记录） */
  canEditClass(name: string): boolean;
  /** 能不能操作这个班（= canEditClass，保留旧名） */
  canClass(name: string): boolean;

  /** 写审计（不 await 也不阻塞响应，失败只记日志） */
  audit(action: string, extra?: AuditExtra): Promise<void>;
  /** 抛错用：越权尝试自动写审计 */
  deny(action: string, message?: string, extra?: AuditExtra): never;
}

export interface AuditExtra {
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

export function makePermHelpers(row: UserRow | null): {
  perms: Record<string, boolean>;
  role: Role | null;
  can: (k: string) => boolean;
  classScopes: () => string[] | null;
  viewScopes: () => string[] | null;
  canViewClass: (name: string) => boolean;
  canEditClass: (name: string) => boolean;
  canClass: (name: string) => boolean;
} {
  if (!row) {
    return {
      perms: {},
      role: null,
      can: () => false,
      classScopes: () => [],
      viewScopes: () => [],
      canViewClass: () => false,
      canEditClass: () => false,
      canClass: () => false,
    };
  }
  const pub = toPublic(row);
  const perms = effective(row.role, pub.perms);
  const role = row.role;

  // 可写范围：只看任教班级。管理员/本机用户不限。
  const classScopes = (): string[] | null => {
    if (role === 'admin' || role === 'local') return null;
    return pub.classScopes || [];
  };

  // 可读范围：有 class.view_all 就能看全部班级（默认给讲师），但改不了。
  const viewScopes = (): string[] | null => {
    if (role === 'admin' || role === 'local') return null;
    if (perms['class.view_all']) return null;
    return pub.classScopes || [];
  };

  const canViewClass = (name: string): boolean => {
    const sc = viewScopes();
    return sc === null || sc.includes(name);
  };

  const canEditClass = (name: string): boolean => {
    const sc = classScopes();
    return sc === null || sc.includes(name);
  };

  return {
    perms,
    role,
    can: (k: string) => !!perms[k],
    classScopes,
    viewScopes,
    canViewClass,
    canEditClass,
    canClass: canEditClass,
  };
}
