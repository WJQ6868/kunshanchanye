/* ============================================================
   users.ts — 用户仓储（服务端）
   ------------------------------------------------------------
   与前端 js/auth/auth-store.js 的关系：
     前端那套是「本机模式」的存储（localStorage），保留不动；
     这里是服务端模式的真源。两边字段名不同（snake_case vs
     camelCase），转换只在这一层做，业务代码不碰 SQL 列名。
   ============================================================ */

import type { Db } from '../db/driver.ts';
import { randomToken } from './password.ts';
import { effective, type Role } from './perm.ts';

export interface UserRow {
  id: string;
  school_id: string;
  username: string | null;
  display_name: string;
  employee_no: string | null;
  password_hash: string | null;
  auth_source: string;
  role: Role;
  permissions: string | null;
  class_scopes: string | null;
  status: string;
  must_change: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  login: string;
  displayName: string;
  role: Role;
  employeeNo: string;
  disabled: boolean;
  mustChange: boolean;
  perms: Record<string, boolean> | null;
  classScopes: string[] | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    login: row.username || '',
    displayName: row.display_name,
    role: row.role,
    employeeNo: row.employee_no || '',
    disabled: row.status !== 'active',
    mustChange: row.must_change === 1,
    perms: parseJson<Record<string, boolean> | null>(row.permissions, null),
    classScopes: parseJson<string[] | null>(row.class_scopes, null),
  };
}

/** 给 /me 用的完整视图：用户 + 有效权限 + 范围 */
export function toMe(row: UserRow) {
  const pub = toPublic(row);
  const perms = effective(row.role, pub.perms);
  return {
    user: {
      id: pub.id,
      login: pub.login,
      displayName: pub.displayName,
      role: pub.role,
      employeeNo: pub.employeeNo,
      mustChange: pub.mustChange,
    },
    permissions: perms,
    classScopes: pub.classScopes,
  };
}

export async function findByLogin(db: Db, schoolId: string, login: string): Promise<UserRow | null> {
  return db.get<UserRow>(
    'SELECT * FROM app_user WHERE school_id = ? AND lower(username) = lower(?) LIMIT 1',
    [schoolId, login],
  );
}

export async function findById(db: Db, id: string): Promise<UserRow | null> {
  return db.get<UserRow>('SELECT * FROM app_user WHERE id = ?', [id]);
}

export async function listUsers(db: Db, schoolId: string): Promise<UserRow[]> {
  return db.all<UserRow>(
    'SELECT * FROM app_user WHERE school_id = ? ORDER BY created_at ASC',
    [schoolId],
  );
}

export async function countActiveAdmins(db: Db, schoolId: string): Promise<number> {
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM app_user WHERE school_id = ? AND role = 'admin' AND status = 'active'",
    [schoolId],
  );
  return Number(row?.n ?? 0);
}

export interface CreateUserInput {
  schoolId: string;
  username: string | null;
  displayName: string;
  role: Role;
  employeeNo?: string;
  passwordHash?: string | null;
  authSource?: string;
  permissions?: Record<string, boolean> | null;
  classScopes?: string[] | null;
  mustChange?: boolean;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<UserRow> {
  const now = new Date().toISOString();
  const id = 'u_' + randomToken(9);
  await db.run(
    `INSERT INTO app_user
       (id, school_id, username, display_name, employee_no, password_hash, auth_source,
        role, permissions, class_scopes, status, must_change, last_login_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    [
      id,
      input.schoolId,
      input.username,
      input.displayName,
      input.employeeNo || null,
      input.passwordHash || null,
      input.authSource || 'local',
      input.role,
      input.permissions ? JSON.stringify(input.permissions) : null,
      input.classScopes ? JSON.stringify(input.classScopes) : null,
      'active',
      input.mustChange ? 1 : 0,
      now,
      now,
    ],
  );
  const row = await findById(db, id);
  if (!row) throw new Error('[users] 新建用户后回查失败');
  return row;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: Role;
  employeeNo?: string | null;
  passwordHash?: string | null;
  permissions?: Record<string, boolean> | null;
  classScopes?: string[] | null;
  status?: 'active' | 'disabled';
  mustChange?: boolean;
}

export async function updateUser(db: Db, id: string, patch: UpdateUserInput): Promise<UserRow> {
  const cur = await findById(db, id);
  if (!cur) throw new Error('[users] 用户不存在');

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, v: unknown) => {
    sets.push(col + ' = ?');
    params.push(v);
  };

  if (patch.displayName !== undefined) push('display_name', patch.displayName);
  if (patch.role !== undefined) push('role', patch.role);
  if (patch.employeeNo !== undefined) push('employee_no', patch.employeeNo || null);
  if (patch.passwordHash !== undefined) push('password_hash', patch.passwordHash);
  if (patch.permissions !== undefined) {
    push('permissions', patch.permissions ? JSON.stringify(patch.permissions) : null);
  }
  if (patch.classScopes !== undefined) {
    push('class_scopes', patch.classScopes ? JSON.stringify(patch.classScopes) : null);
  }
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.mustChange !== undefined) push('must_change', patch.mustChange ? 1 : 0);

  if (!sets.length) return cur;
  push('updated_at', new Date().toISOString());
  params.push(id);

  await db.run(`UPDATE app_user SET ${sets.join(', ')} WHERE id = ?`, params);
  const row = await findById(db, id);
  if (!row) throw new Error('[users] 更新用户后回查失败');
  return row;
}

export async function touchLogin(db: Db, id: string): Promise<void> {
  await db.run('UPDATE app_user SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), id]);
}
