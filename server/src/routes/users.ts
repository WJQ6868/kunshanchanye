/* ============================================================
   routes/users.ts — 人员管理（P4）
   ------------------------------------------------------------
   这一组接口是为了让「服务器模式」和「本机模式」功能对齐：
   本机模式一直能改账号（RCAuthStore + js/auth/user-ui.js），但服务端
   之前只有登录/改自己密码，没有人员管理，前端只能把入口藏掉
   （js/auth/user-ui.js:138 的 !remote）。

   接口形状刻意对齐 js/auth/auth-store.js 的字段与约束，
   这样 user-ui.js 两种模式能共用同一套渲染逻辑：

     GET    /users              → [{id,login,displayName,role,employeeNo,disabled,...}]
     POST   /users              ← {login,displayName,role,employeeNo,password,perms,classScopes}
     PATCH  /users/:id          ← {displayName,role,employeeNo,perms,classScopes,disabled,mustChange}
     POST   /users/:id/password ← {newPassword}（管理员改别人密码，不需要原密码）
     DELETE /users/:id          → {ok:true}
     GET    /users/meta         → {roles,groups} 权限定义，供前端渲染勾选表

   三条硬约束（与 auth-store.js 的 add/update/remove 一一对应）：
     1. 登录名唯一且不区分大小写；格式 3–24 位 [a-z0-9_.-]
     2. 至少保留一个启用的管理员 —— 不能把最后一个降级、停用或删除
     3. 不能删除自己

   安全语义（比本机模式严，因为这里是多用户共享一个库）：
     · 改密码 / 改角色 / 改权限 / 改班级范围 / 停用 → 吊销该用户全部会话
       （session.ts 的约定：权限变了就不能让旧会话拿着旧权限继续跑）
     · 任何字段变更都写 audit_log，before/after 各一份
     · 内置最高管理员 wjqcool 可以改资料、改密码，但**不能被降级/停用/删除**：
       seed.ts 每次启动都会补建它，允许删除就会变成「重启后又冒出一个
       密码未知的管理员」；允许降级则系统的最高管理员从库里消失。
   ============================================================ */

import type { Router } from '../router.ts';
import type { Ctx } from '../ctx.ts';
import { json, err, type Reply } from '../http.ts';
import { checkPasswordPolicy, hashPassword } from '../auth/password.ts';
import {
  countActiveAdmins,
  createUser,
  findById,
  findByLogin,
  listUsers,
  updateUser,
  type UpdateUserInput,
  type UserRow,
} from '../auth/users.ts';
import { grouped, ROLE_LABEL, type Role } from '../auth/perm.ts';
import { revokeAllForUser } from '../auth/session.ts';
import { DEFAULT_ADMIN_ID, DEFAULT_ADMIN_LOGIN } from '../auth/seed.ts';
import { schoolIdOf } from '../domain/common.ts';

/** 新增/重置密码时留空用的默认值（与本机模式 user-ui.js 的 DEFAULT_PW 一致） */
export const DEFAULT_NEW_PASSWORD = '123456';

const ROLE_SET: Role[] = ['admin', 'teacher', 'viewer'];

/** 登录名规则，与 auth-store.js 的 add() 完全一致 */
const LOGIN_RE = /^[a-z0-9_.-]{3,24}$/;

function isBuiltinAdmin(row: UserRow): boolean {
  return row.id === DEFAULT_ADMIN_ID
    || String(row.username || '').toLowerCase() === DEFAULT_ADMIN_LOGIN;
}

/* ---------- 行 → 前端 DTO（字段名对齐 auth-store.js 的 safe()） ---------- */

function parseJsonObject(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function parseScopes(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    const out = v.filter((x): x is string => typeof x === 'string' && !!x);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function toDto(row: UserRow) {
  return {
    id: row.id,
    login: row.username || '',
    displayName: row.display_name,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role] || row.role,
    employeeNo: row.employee_no || '',
    disabled: row.status !== 'active',
    // 管理员恒为全开，不存覆盖项；与本机模式一致返回空对象
    perms: row.role === 'admin' ? {} : parseJsonObject(row.permissions),
    classScopes: parseScopes(row.class_scopes),
    mustChange: row.must_change === 1,
    lastLoginAt: row.last_login_at || '',
    createdAt: row.created_at,
    builtin: isBuiltinAdmin(row),
  };
}

/* ---------- 入参规范化 ---------- */

/** 权限覆盖项：只留布尔值，其余丢弃（防止脏数据放大权限） */
function normalizePerms(input: unknown): Record<string, boolean> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** 班级范围：null 表示不限（与本机模式「全选归一成 null」一致） */
function normalizeScopes(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out = Array.from(
    new Set(input.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => !!x)),
  );
  return out.length ? out : null;
}

function normalizeRole(input: unknown): Role {
  const r = String(input == null ? '' : input).trim() as Role;
  if (ROLE_SET.indexOf(r) < 0) throw err.badRequest('角色只能是管理员、讲师或访客');
  return r;
}

function normLogin(input: unknown): string {
  return String(input == null ? '' : input).trim().toLowerCase();
}

function normName(input: unknown): string {
  return String(input == null ? '' : input).replace(/\s+/g, ' ').trim().slice(0, 20);
}

function str(v: unknown, max = 24): string {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/* ---------- 断言 ---------- */

async function targetUser(ctx: Ctx, id: string): Promise<UserRow> {
  const row = await findById(ctx.db, id);
  if (!row || row.school_id !== schoolIdOf(ctx)) throw err.notFound('账号不存在');
  return row;
}

/** 最后一个启用管理员的保护；nextRole/nextStatus 是「将要变成的值」 */
async function guardLastAdmin(
  ctx: Ctx,
  row: UserRow,
  nextRole: Role,
  nextStatus: 'active' | 'disabled',
): Promise<void> {
  const wasActiveAdmin = row.role === 'admin' && row.status === 'active';
  const willBeActiveAdmin = nextRole === 'admin' && nextStatus === 'active';
  if (!wasActiveAdmin || willBeActiveAdmin) return;
  if ((await countActiveAdmins(ctx.db, row.school_id)) <= 1) {
    throw err.badRequest('至少保留一个启用的管理员');
  }
}

function guardBuiltin(row: UserRow, what: string): void {
  if (isBuiltinAdmin(row)) {
    throw err.badRequest(`内置管理员「${row.display_name}」不能被${what}`);
  }
}

/* ============================================================ */

export function registerUserRoutes(r: Router): void {
  /* ---------- 权限定义（前端渲染勾选表用） ---------- */
  r.get('/users/meta', async (ctx: Ctx): Promise<Reply> => {
    ctx.need('user.manage');
    return json(200, {
      roles: ROLE_SET.map((role) => ({ role, label: ROLE_LABEL[role] })),
      groups: grouped(),
    });
  });

  /* ---------- 列表 ---------- */
  r.get('/users', async (ctx: Ctx): Promise<Reply> => {
    ctx.need('user.manage');
    const rows = await listUsers(ctx.db, schoolIdOf(ctx));
    return json(200, rows.map(toDto));
  });

  /* ---------- 新增 ---------- */
  r.post('/users', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('user.manage')) ctx.deny('user.create');
    const body = (ctx.body || {}) as Record<string, unknown>;

    const login = normLogin(body.login);
    if (!LOGIN_RE.test(login)) {
      throw err.badRequest('登录名 3–24 位，只能用字母、数字、下划线、点、短横');
    }
    const displayName = normName(body.displayName);
    if (!displayName) throw err.badRequest('请填写姓名');
    const role = normalizeRole(body.role);

    const schoolId = schoolIdOf(ctx);
    if (await findByLogin(ctx.db, schoolId, login)) {
      throw err.conflict(`登录名「${login}」已存在`);
    }

    const rawPw = String(body.password == null ? '' : body.password);
    const password = rawPw || DEFAULT_NEW_PASSWORD;
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) throw err.badRequest(policy.msg || '密码不符合要求');

    const employeeNo = str(body.employeeNo);
    if (employeeNo) {
      const dupEmp = await ctx.db.get<{ id: string }>(
        'SELECT id FROM app_user WHERE school_id = ? AND employee_no = ?',
        [schoolId, employeeNo],
      );
      if (dupEmp) throw err.conflict(`工号「${employeeNo}」已被占用`);
    }

    const row = await createUser(ctx.db, {
      schoolId,
      username: login,
      displayName,
      role,
      employeeNo,
      passwordHash: await hashPassword(password),
      authSource: 'local',
      permissions: normalizePerms(body.perms),
      classScopes: normalizeScopes(body.classScopes),
      // 与本机模式一致：新建账号首次登录强制改密
      mustChange: true,
    });

    await ctx.audit('user.create', {
      targetType: 'user',
      targetId: row.id,
      after: { login, displayName, role },
    });

    return json(201, toDto(row));
  });

  /* ---------- 修改 ---------- */
  r.patch('/users/:id', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('user.manage')) ctx.deny('user.update', '没有人员管理权限');
    const row = await targetUser(ctx, ctx.params.id);
    const body = (ctx.body || {}) as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    const before = {
      displayName: row.display_name,
      role: row.role,
      employeeNo: row.employee_no,
      status: row.status,
      perms: row.permissions,
      classScopes: row.class_scopes,
    };

    const patch: UpdateUserInput = {};
    let sensitive = false; // 权限面变了 → 旧会话必须失效

    if (has('displayName')) {
      const name = normName(body.displayName);
      if (!name) throw err.badRequest('请填写姓名');
      patch.displayName = name;
    }

    if (has('role')) {
      const role = normalizeRole(body.role);
      if (role !== row.role) {
        if (isBuiltinAdmin(row)) guardBuiltin(row, '降级');
        patch.role = role;
        sensitive = true;
      }
    }

    if (has('employeeNo')) {
      const employeeNo = str(body.employeeNo);
      if (employeeNo && employeeNo !== (row.employee_no || '')) {
        const dupEmp = await ctx.db.get<{ id: string }>(
          'SELECT id FROM app_user WHERE school_id = ? AND employee_no = ? AND id <> ?',
          [row.school_id, employeeNo, row.id],
        );
        if (dupEmp) throw err.conflict(`工号「${employeeNo}」已被占用`);
      }
      patch.employeeNo = employeeNo || null;
    }

    if (has('perms')) {
      patch.permissions = normalizePerms(body.perms);
      sensitive = true;
    }

    if (has('classScopes')) {
      patch.classScopes = normalizeScopes(body.classScopes);
      sensitive = true;
    }

    if (has('disabled')) {
      const disabled = !!body.disabled;
      if (disabled !== (row.status !== 'active')) {
        if (disabled) guardBuiltin(row, '停用');
        patch.status = disabled ? 'disabled' : 'active';
        sensitive = true;
      }
    }

    if (has('mustChange')) patch.mustChange = !!body.mustChange;

    await guardLastAdmin(
      ctx,
      row,
      (patch.role ?? row.role) as Role,
      (patch.status ?? row.status) as 'active' | 'disabled',
    );

    const updated = await updateUser(ctx.db, row.id, patch);

    let revokedSessions = 0;
    if (sensitive) {
      revokedSessions = await revokeAllForUser(ctx.db, row.id, ctx.session?.id);
    }

    await ctx.audit('user.update', {
      targetType: 'user',
      targetId: row.id,
      before,
      after: {
        displayName: updated.display_name,
        role: updated.role,
        employeeNo: updated.employee_no,
        status: updated.status,
        perms: updated.permissions,
        classScopes: updated.class_scopes,
        revokedSessions,
      },
    });

    return json(200, toDto(updated));
  });

  /* ---------- 管理员重置他人密码 ---------- */
  r.post('/users/:id/password', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('user.manage')) ctx.deny('user.reset_password', '没有人员管理权限');
    const row = await targetUser(ctx, ctx.params.id);

    const body = (ctx.body || {}) as { newPassword?: unknown };
    const raw = String(body.newPassword == null ? '' : body.newPassword);
    const newPassword = raw || DEFAULT_NEW_PASSWORD;

    const policy = checkPasswordPolicy(newPassword);
    if (!policy.ok) throw err.badRequest(policy.msg || '密码不符合要求');

    await updateUser(ctx.db, row.id, {
      passwordHash: await hashPassword(newPassword),
      mustChange: true,
    });

    // 改密后踢掉该用户全部会话（保留操作者自己这张）
    const revoked = await revokeAllForUser(ctx.db, row.id, ctx.session?.id);

    await ctx.audit('user.reset_password', {
      targetType: 'user',
      targetId: row.id,
      after: { mustChange: true, revokedSessions: revoked },
    });

    return json(200, { ok: true, mustChange: true, revokedSessions: revoked });
  });

  /* ---------- 删除 ---------- */
  r.del('/users/:id', async (ctx: Ctx): Promise<Reply> => {
    if (!ctx.can('user.manage')) ctx.deny('user.delete', '没有人员管理权限');
    const row = await targetUser(ctx, ctx.params.id);

    if (row.id === ctx.session?.user_id) throw err.badRequest('不能删除当前登录的账号');
    guardBuiltin(row, '删除');

    if (row.role === 'admin' && row.status === 'active'
      && (await countActiveAdmins(ctx.db, row.school_id)) <= 1) {
      throw err.badRequest('至少保留一个启用的管理员');
    }

    /* 物理删除而不是软删：本机模式也是直接移出列表，行为要一致。
       score_record 存的是 operator_name_snapshot + operator_user_id，
       两表都没有外键约束（见 002_domain.sql），所以删账号不会破坏历史流水；
       audit_log 同样不做级联，历史审计保持原样。 */
    await revokeAllForUser(ctx.db, row.id, ctx.session?.id);
    await ctx.db.run('DELETE FROM app_user WHERE id = ?', [row.id]);

    await ctx.audit('user.delete', {
      targetType: 'user',
      targetId: row.id,
      before: { login: row.username, displayName: row.display_name, role: row.role },
    });

    return json(200, { ok: true });
  });
}
