/* ============================================================
   seed.ts — 首次启动引导
   ------------------------------------------------------------
   单校私有化部署时不该要求管理员先跑 SQL 才能登录。

   规则：
   · 库里没有任何 school → 建一个（code 来自 DEFAULT_SCHOOL_CODE）
   · 该 school 没有内置最高管理员 → 补建
     · 登录名 wjqcool，姓名「深之一」，固定 id，角色 admin
     · 密码**只以 scrypt 哈希形式存在**（见 DEFAULT_ADMIN_PASSWORD_HASH），
       明文不写进代码、不写进仓库、也不打进日志
   · 内置管理员已存在 → 什么都不做（幂等，不覆盖用户改过的密码）
   ============================================================ */

import type { Db } from '../db/driver.ts';
import type { Config } from '../config.ts';
import { randomToken } from './password.ts';
import { createUser, findByLogin } from './users.ts';
import { log } from '../log.ts';

/* ------------------------------------------------------------
   内置默认最高管理员
   ------------------------------------------------------------
   下面是初始口令的 scrypt 哈希（N=32768, r=8, p=1, salt 16B, key 32B），
   由 hashPassword() 生成，格式见 auth/password.ts。
   这里只存派生结果——即使源码公开，也无法从哈希反推明文口令。
   初始口令见部署文档，不在仓库里出现。
   校验脚本：rollcall/tools/verify-admin-hash.mjs
   ------------------------------------------------------------ */
export const DEFAULT_ADMIN_LOGIN = 'wjqcool';
export const DEFAULT_ADMIN_NAME = '深之一';
export const DEFAULT_ADMIN_ID = 'u_default_admin';
export const DEFAULT_ADMIN_PASSWORD_HASH =
  'scrypt$32768$8$1$UTkiqRuYFXPL/gAbaO/SrQ==$UVjiIn0dHmBnFtUfFvqC85NRXgPyOZ1vAVN0H6SKNKI=';

export interface SeedResult {
  schoolId: string;
  createdSchool: boolean;
  createdAdmin: boolean;
  /** 内置管理员的登录名（创建或已存在时都会返回） */
  adminLogin?: string;
}

export async function seed(db: Db, cfg: Config): Promise<SeedResult> {
  let school = await db.get<{ id: string; code: string }>('SELECT id, code FROM school WHERE code = ?', [
    cfg.defaultSchoolCode,
  ]);

  let createdSchool = false;
  if (!school) {
    const id = 'sc_' + randomToken(9);
    await db.run(
      `INSERT INTO school (id, code, name, external_org_id, sso_issuer, deployment_mode, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, cfg.defaultSchoolCode, cfg.defaultSchoolCode, null, null, 'onprem', 'active', new Date().toISOString()],
    );
    school = { id, code: cfg.defaultSchoolCode };
    createdSchool = true;
    log.info('已创建学校', { schoolId: id, code: cfg.defaultSchoolCode });
  }

  /* 内置管理员必须始终存在：即使库里已经有别的管理员（比如老部署里
     手工建的 admin），也要补上这个账号，否则「系统内置最高管理员」
     这句话在升级后的老库上就是假的。
     已存在时只跳过，不覆盖密码——用户改过的密码不能被重启重置。 */
  const login = DEFAULT_ADMIN_LOGIN;
  const existing = await findByLogin(db, school.id, login);
  if (existing) {
    if (existing.role !== 'admin' || existing.status !== 'active') {
      /* 被降级或停用了：不擅自提权，只告警，交给运维决定 */
      log.warn('内置管理员账号存在但已不是启用的管理员，跳过创建', {
        login,
        status: existing.status,
        role: existing.role,
      });
      return { schoolId: school.id, createdSchool, createdAdmin: false, adminLogin: login };
    }
    return { schoolId: school.id, createdSchool, createdAdmin: false, adminLogin: login };
  }

  await createUser(db, {
    schoolId: school.id,
    username: login,
    displayName: DEFAULT_ADMIN_NAME,
    role: 'admin',
    passwordHash: DEFAULT_ADMIN_PASSWORD_HASH,
    authSource: 'local',
    mustChange: false,
  });

  log.info('已创建内置最高管理员', {
    login,
    displayName: DEFAULT_ADMIN_NAME,
    role: 'admin',
    note: '密码以 scrypt 哈希存储；如需更换请登录后自助修改',
  });

  return {
    schoolId: school.id,
    createdSchool,
    createdAdmin: true,
    adminLogin: login,
  };
}
