/* ============================================================
   password.ts — 密码派生与校验
   ------------------------------------------------------------
   计划书 §11 要求 argon2id（m=64MB,t=3,p=1）或 bcrypt cost=12。
   实际实现用 Node 内置 scrypt，原因：
     · argon2 / bcrypt 都是原生编译模块，本机装不上（无 MSVC）
     · scrypt 同为「内存硬」KDF，OWASP 认可（N=2^15,r=8,p=1 ≈32MB）
     · 零依赖 = 私有化部署时不会因编译环境失败
   记录里带 algo 字段，将来能装 argon2 时可以按用户平滑升级。

   存储格式：scrypt$N$r$p$salt_b64$hash_b64
   ============================================================ */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** 默认参数：N=32768 → 约 32MB 内存，单次约 60–120ms（登录可接受） */
export const DEFAULT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

const KEYLEN = 32;
const SALT_LEN = 16;

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  if (typeof password !== 'string' || password.length < 1) {
    throw new Error('[password] 密码不能为空');
  }
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password, salt, KEYLEN, { ...params, maxmem: 128 * 1024 * 1024 });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
  // 长度不等时 timingSafeEqual 会抛，先挡掉
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** 密码强度：与服务端策略对齐前端 checkPassword（≥6 位，建议混合） */
export function checkPasswordPolicy(pw: string): { ok: boolean; msg?: string } {
  if (typeof pw !== 'string' || pw.length < 6) return { ok: false, msg: '密码至少 6 位' };
  if (pw.length > 128) return { ok: false, msg: '密码不能超过 128 位' };
  return { ok: true };
}

/** 生成随机 token（会话、CSRF 都用它） */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
