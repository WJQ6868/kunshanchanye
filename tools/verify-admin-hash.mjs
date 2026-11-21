/* 校验内置管理员的两个哈希常量是否与口令匹配。
   只用于本地自检，不参与运行；跑完可删。
   node rollcall/tools/verify-admin-hash.mjs <初始口令>
   仓库里不存明文口令，口令从命令行参数或 ADMIN_PW 环境变量传入。 */
import { scryptSync, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

const PW = process.argv[2] || process.env.ADMIN_PW || '';
if (!PW) {
  console.error('用法：node rollcall/tools/verify-admin-hash.mjs <初始口令>（或用 ADMIN_PW 环境变量）');
  process.exit(2);
}

/* ---------- 服务端 scrypt ---------- */
const stored = 'scrypt$32768$8$1$UTkiqRuYFXPL/gAbaO/SrQ==$UVjiIn0dHmBnFtUfFvqC85NRXgPyOZ1vAVN0H6SKNKI=';
const parts = stored.split('$');
const N = Number(parts[1]);
const r = Number(parts[2]);
const p = Number(parts[3]);
const salt = Buffer.from(parts[4], 'base64');
const want = Buffer.from(parts[5], 'base64');
const got = scryptSync(PW, salt, want.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
const okServer = got.length === want.length && timingSafeEqual(got, want);

/* ---------- 前端 pbkdf2 ---------- */
const front = {
  iter: 20000,
  salt: 'HCMDaSBGTCX6SvR27fAzHw==',
  hash: 'MiW5FCktR1x15p9Psp8szdZ2MidaAnzZeQUKCxUjtgM=',
};
const fGot = pbkdf2Sync(PW, Buffer.from(front.salt, 'base64'), front.iter, 32, 'sha256');
const okFront = fGot.toString('base64') === front.hash;

const bad = pbkdf2Sync(PW + 'x', Buffer.from(front.salt, 'base64'), front.iter, 32, 'sha256');
const okFrontBad = bad.toString('base64') === front.hash;

console.log(JSON.stringify({ pw: PW, okServer, okFront, okFrontBad }, null, 2));
