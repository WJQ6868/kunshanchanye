/* ============================================================
   config.ts — 配置（全部来自环境变量，计划书 §12）
   ------------------------------------------------------------
   原则：
   · 配置只有一个入口，业务代码不许直接读 process.env
   · 启动时校验，缺失/非法立即退出（fail fast），不要等到
     第一个请求进来才发现 DATABASE_URL 没配
   · 密钥类只打印「是否已配置」，绝不打印内容
   ============================================================ */

export type Env = 'dev' | 'staging' | 'prod';

export interface Config {
  env: Env;
  port: number;
  host: string;
  /** 数据库 */
  dbDriver: 'sqlite' | 'pg';
  sqliteFile: string;
  databaseUrl: string;
  /** 安全 */
  cookieName: string;
  cookieSecure: boolean;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  loginWindowMs: number;
  loginMaxFails: number;
  /** 静态资源：前端 rollcall/ 目录 */
  staticDir: string;
  /** 是否允许 /healthz 暴露版本号等细节 */
  exposeVersion: boolean;
  /** 单校部署的默认 school code */
  defaultSchoolCode: string;
  /** 教务系统对接（P3）。baseUrl 为空表示「未接入」，接口返回明确的未配置提示 */
  eduBaseUrl: string;
  /** 教务接口凭据（API Token / AppKey），只打印是否已配置，不打印值 */
  eduToken: string;
  /** 教务接口超时（毫秒）—— 教务挂了不能拖死课堂 */
  eduTimeoutMs: number;
  /** 教务系统的学生标识字段：idcard（身份证，默认）| studentno（学号） */
  eduIdField: 'idcard' | 'studentno';
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function int(name: string, def: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`[config] ${name} 必须是数字，当前值 "${raw}"`);
  if (min !== undefined && n < min) throw new Error(`[config] ${name} 不能小于 ${min}`);
  if (max !== undefined && n > max) throw new Error(`[config] ${name} 不能大于 ${max}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function loadConfig(): Config {
  const env = str('NODE_ENV', 'dev') as Env;
  if (!['dev', 'staging', 'prod'].includes(env)) {
    throw new Error(`[config] NODE_ENV 只能是 dev|staging|prod，当前 "${env}"`);
  }

  const dbDriver = str('DB_DRIVER', 'sqlite') as 'sqlite' | 'pg';
  if (!['sqlite', 'pg'].includes(dbDriver)) {
    throw new Error(`[config] DB_DRIVER 只能是 sqlite|pg，当前 "${dbDriver}"`);
  }

  const databaseUrl = str('DATABASE_URL', '');
  if (dbDriver === 'pg' && !databaseUrl) {
    throw new Error('[config] DB_DRIVER=pg 时必须配置 DATABASE_URL');
  }

  // 生产环境强制 Secure Cookie：http 下发 Secure 会让会话彻底失效，
  // 所以宁可启动失败，也不要上线后「能登录但一刷新就掉」
  const cookieSecure = bool('COOKIE_SECURE', env !== 'dev');
  if (env === 'prod' && !cookieSecure) {
    throw new Error('[config] 生产环境必须 COOKIE_SECURE=true（全站 HTTPS）');
  }

  return {
    env,
    port: int('PORT', 3000, 1, 65535),
    host: str('HOST', '127.0.0.1'),
    dbDriver,
    sqliteFile: str('SQLITE_FILE', './data/rollcall.db'),
    databaseUrl,
    cookieName: str('COOKIE_NAME', 'rc_sid'),
    cookieSecure,
    sessionIdleMs: int('SESSION_IDLE_MIN', 30, 1, 720) * 60_000,
    sessionAbsoluteMs: int('SESSION_ABS_MIN', 720, 1, 7200) * 60_000,
    loginWindowMs: int('LOGIN_WINDOW_MIN', 10, 1, 1440) * 60_000,
    loginMaxFails: int('LOGIN_MAX_FAILS', 5, 1, 100),
    staticDir: str('STATIC_DIR', '../'),
    exposeVersion: bool('EXPOSE_VERSION', env !== 'prod'),
    defaultSchoolCode: str('DEFAULT_SCHOOL_CODE', 'default'),
    eduBaseUrl: str('EDU_BASE_URL', ''),
    eduToken: str('EDU_TOKEN', ''),
    eduTimeoutMs: int('EDU_TIMEOUT_MS', 8000, 1000, 60000),
    eduIdField: str('EDU_ID_FIELD', 'idcard') === 'studentno' ? 'studentno' : 'idcard',
  };
}

/** 打印配置摘要（密钥只报是否存在） */
export function describeConfig(c: Config): string {
  const lines = [
    `env=${c.env} host=${c.host}:${c.port}`,
    `db=${c.dbDriver}${c.dbDriver === 'sqlite' ? ' file=' + c.sqliteFile : ' url=' + maskUrl(c.databaseUrl)}`,
    `cookie=${c.cookieName} secure=${c.cookieSecure} idle=${c.sessionIdleMs / 60000}min abs=${c.sessionAbsoluteMs / 60000}min`,
    `login: ${c.loginMaxFails} 次 / ${c.loginWindowMs / 60000} 分钟`,
    `static=${c.staticDir}`,
    c.eduBaseUrl
      ? `edu=${c.eduBaseUrl} token=${c.eduToken ? '已配置' : '未配置'} id=${c.eduIdField} timeout=${c.eduTimeoutMs}ms`
      : 'edu=未接入（EDU_BASE_URL 为空，教务相关接口会返回未配置提示）',
  ];
  return lines.join('\n');
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(无法解析)';
  }
}
