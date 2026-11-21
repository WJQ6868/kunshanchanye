/* ============================================================
   server.ts — HTTP 入口与中间层
   ------------------------------------------------------------
   请求流程（顺序很重要）：
     1. 生成 requestId，挂 X-Request-Id
     2. 解析 URL / Cookie / body
     3. 解析会话 → 载入用户 → 计算权限
     4. 匹配路由
     5. 鉴权（登录 + 权限由 handler 自己 need()）
     6. CSRF（写操作：双提交 + 同源）
     7. 执行 handler
     8. 统一错误 → {code,message,details}
     9. 结构化访问日志

   为什么 CSRF 放在「匹配路由之后」：只有写路由才需要，
   静态资源和 GET 不该为它付出代价。
   ============================================================ */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db } from './db/driver.ts';
import { Router, type Reply } from './router.ts';
import { ApiError, err, readJson, parseCookies, send, json } from './http.ts';
import { log } from './log.ts';
import { makePermHelpers, type Ctx, type AuditExtra } from './ctx.ts';
import { resolveSession, verifyCsrf, verifyOrigin, requireSession } from './auth/session.ts';
import { findById, type UserRow } from './auth/users.ts';
import { writeAudit } from './audit.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerClassRoutes } from './routes/classes.ts';
import { registerScoreRoutes } from './routes/scores.ts';
import { registerEduRoutes } from './routes/edu.ts';

export interface AppOptions {
  cfg: Config;
  db: Db;
  /** 启动时间，用于 /healthz 的 uptime */
  startedAt?: number;
}

export function buildRouter(): Router {
  const r = new Router();
  registerHealthRoutes(r);
  registerAuthRoutes(r);
  // P2 领域层：班级/名单/设置/排行榜 + 加分流水 + 教务对接
  registerClassRoutes(r);
  registerScoreRoutes(r);
  registerEduRoutes(r);
  return r;
}

function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

export function createApp(opts: AppOptions) {
  const { cfg, db } = opts;
  const startedAt = opts.startedAt ?? Date.now();
  const router = buildRouter();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t0 = Date.now();
    const requestId = randomUUID();
    const method = (req.method || 'GET').toUpperCase();

    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    } catch {
      send(res, json(400, { code: 'BAD_REQUEST', message: '非法请求路径' }), requestId);
      return;
    }
    /* pathname 保留百分号编码，中文文件名（如 /docs/实施进度.md）直接 join 会
       变成字面 %E5... 而找不到文件；这里先解码。解码后再交给 serveStatic 做
       normalize + 前缀校验，所以 %2e%2e 这类编码穿越同样会被拦。 */
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      send(res, json(400, { code: 'BAD_REQUEST', message: '非法请求路径' }), requestId);
      return;
    }

    /* ---------- 探活别名 ----------
       负载均衡 / docker healthcheck / 前端适配器探活都可能打根路径的
       /healthz、/readyz；API 前缀版 /api/v1/healthz 也要能用。
       统一在这里改写成 API 前缀，路由表只维护一份。 */
    const probePath =
      path === '/healthz' || path === '/readyz' ? '/api/v1' + path : path;

    let ctx: Ctx | null = null;

    try {
      /* ---------- 静态资源（前端） ---------- */
      if (method === 'GET' && !path.startsWith('/api/')) {
        const served = await serveStatic(cfg, path, res, requestId);
        if (served) {
          logAccess(cfg, { method, path, status: 200, ms: Date.now() - t0, requestId, static: true });
          return;
        }
      }

      if (!probePath.startsWith('/api/')) {
        throw err.notFound('页面不存在');
      }

      /* ---------- body ---------- */
      let body: unknown;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        body = await readJson(req);
      }

      /* ---------- 会话与权限 ---------- */
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[cfg.cookieName];
      const sessionRow = await resolveSession(db, cfg, token);
      const user: UserRow | null = sessionRow ? await findById(db, sessionRow.user_id) : null;

      const helpers = makePermHelpers(user && user.status === 'active' ? user : null);

      ctx = {
        req,
        res,
        cfg,
        db,
        method,
        path,
        query: url.searchParams,
        params: {},
        headers: req.headers,
        body,
        requestId,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        session: sessionRow,
        user: user && user.status === 'active' ? user : null,
        perms: helpers.perms,
        role: helpers.role,
        can: helpers.can,
        need(key: string) {
          if (!helpers.can(key)) {
            throw err.forbidden('当前账号没有该操作权限（' + key + '）');
          }
        },
        classScopes: helpers.classScopes,
        viewScopes: helpers.viewScopes,
        canViewClass: helpers.canViewClass,
        canEditClass: helpers.canEditClass,
        canClass: helpers.canClass,
        async audit(action: string, extra?: AuditExtra) {
          await writeAudit(db, {
            schoolId: sessionRow?.school_id || (await defaultSchoolId(db, cfg)),
            actorUserId: sessionRow?.user_id || null,
            actorName: user?.display_name || null,
            actorIp: clientIp(req),
            userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
            action,
            targetType: extra?.targetType,
            targetId: extra?.targetId,
            before: extra?.before,
            after: extra?.after,
            requestId,
          });
        },
        deny(action: string, message?: string, extra?: AuditExtra): never {
          // 越权尝试必须留痕（计划书 §11）
          void writeAudit(db, {
            schoolId: sessionRow?.school_id || '',
            actorUserId: sessionRow?.user_id || null,
            actorName: user?.display_name || null,
            actorIp: clientIp(req),
            userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
            action: 'authz.denied',
            targetType: extra?.targetType || action,
            targetId: extra?.targetId,
            after: { attempted: action, message: message || null },
            requestId,
          });
          throw err.forbidden(message || '没有权限执行该操作');
        },
      };

      /* ---------- 路由 ---------- */
      const apiPath = probePath.slice('/api/v1'.length) || '/';
      const matched = router.match(method, apiPath);
      if (!matched) {
        if (router.pathExists(apiPath)) {
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该接口不支持 ' + method);
        }
        throw err.notFound('接口不存在：' + method + ' ' + path);
      }
      ctx.params = matched.params;
      const route = matched.route;

      /* ---------- 鉴权 ---------- */
      if (route.auth) requireSession(sessionRow);

      /* ---------- CSRF ---------- */
      if (route.csrf && sessionRow) {
        const header = String(req.headers['x-csrf-token'] || '');
        if (!verifyCsrf(sessionRow, header)) {
          throw new ApiError(403, 'CSRF_INVALID', 'CSRF 校验失败，请刷新页面后重试');
        }
        if (!verifyOrigin(
          req.headers.origin as string | undefined,
          req.headers.referer as string | undefined,
          req.headers.host as string | undefined,
        )) {
          throw new ApiError(403, 'CSRF_ORIGIN', '请求来源不被信任');
        }
      }

      /* ---------- 执行 ---------- */
      const reply = await route.handler(ctx);
      const finalReply: Reply = {
        status: reply.status,
        headers: reply.headers || {},
        body: reply.body,
      };
      send(res, finalReply, requestId);
      logAccess(cfg, {
        method,
        path,
        status: finalReply.status,
        ms: Date.now() - t0,
        requestId,
        userId: ctx.user?.id,
        schoolId: sessionRow?.school_id,
      });
    } catch (e) {
      const isApi = path.startsWith('/api/');
      let status = 500;
      let payload: { code: string; message: string; details?: unknown } = {
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误',
      };

      if (e instanceof ApiError) {
        status = e.status;
        payload = { code: e.code, message: e.message, details: e.details };
      } else {
        // 未预期错误：日志留全栈，响应不回显（计划书 §11）
        log.error('未处理的异常', {
          requestId,
          method,
          path,
          err: String((e as Error)?.message || e),
          stack: (e as Error)?.stack?.split('\n').slice(0, 6).join(' | '),
        });
      }

      if (isApi) {
        send(res, json(status, payload), requestId);
      } else {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Request-Id': requestId });
        res.end(payload.message);
      }
      logAccess(cfg, { method, path, status, ms: Date.now() - t0, requestId, err: payload.code });
    }
  };

  return createServer((req, res) => {
    handler(req, res).catch((e) => {
      log.error('响应阶段异常', { err: String(e?.message || e) });
      try { res.destroy(); } catch { /* ignore */ }
    });
  });
}

/* ============================================================
   静态资源（前端 rollcall/ 目录）
   ------------------------------------------------------------
   只用 GET；路径穿越靠 path.normalize + 前缀校验。
   缓存策略：index.html 与 js/css 一律 no-cache（课堂现场改完
   刷新就要生效，不能让老师清缓存），vendor 与图片长缓存。
   ============================================================ */

async function serveStatic(
  cfg: Config,
  path: string,
  res: ServerResponse,
  requestId: string,
): Promise<boolean> {
  const { join, normalize, extname, sep } = await import('node:path');
  const { readFile, stat } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');

  const root = join(dirname(fileURLToPath(import.meta.url)), '..', cfg.staticDir);
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const target = normalize(join(root, rel));

  // 路径穿越防护
  if (!target.startsWith(normalize(root + sep))) {
    return false;
  }

  /* 敏感目录黑名单。
     静态根是 rollcall/，里面同时放着 server/（源码 + data/rollcall.db 里的
     密码哈希与 token）、tools/（构建脚本）、docs/（内部文档）。
     不拦的话 /server/src/config.ts、/server/data/rollcall.db 直接可下载。
     用路径段匹配，避免 /servering 这类误伤。 */
  const DENY_DIRS = ['server', 'tools', 'data', 'docs', '.git', '.npmcache'];
  const relNorm = target.slice(normalize(root + sep).length).split(sep);
  /* 只看首段。这些都是静态根下的一级目录；若逐段匹配，前端自己的
     js/data/ 会被 'data' 误伤，整套数据适配器 404（页面静默回退本地模式）。 */
  const firstSeg = (relNorm[0] || '').toLowerCase();
  if (DENY_DIRS.indexOf(firstSeg) >= 0) {
    return false;
  }
  // 隐藏文件一律不服务（.env、.gitignore 等）
  if (relNorm.some((seg) => seg.startsWith('.'))) {
    return false;
  }

  try {
    const st = await stat(target);
    if (!st.isFile()) return false;
    const buf = await readFile(target);
    const ext = extname(target).toLowerCase();

    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.csv': 'text/csv; charset=utf-8',
    };

    const longCache = /[\\/](vendor|screenshots)[\\/]/.test(target) || /\.(png|jpg|svg|woff2)$/.test(target);

    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Content-Length': String(buf.length),
      'Cache-Control': longCache ? 'public, max-age=604800' : 'no-cache',
      'X-Request-Id': requestId,
      // CSP：允许自身资源与内联样式（现有 CSS 有 style 属性写法）
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

async function defaultSchoolId(db: Db, cfg: Config): Promise<string> {
  const row = await db.get<{ id: string }>('SELECT id FROM school WHERE code = ?', [cfg.defaultSchoolCode]);
  return row?.id || '';
}

function logAccess(
  cfg: Config,
  m: { method: string; path: string; status: number; ms: number; requestId: string; userId?: string; schoolId?: string; static?: boolean; err?: string },
): void {
  if (m.static) {
    log.debug('static', { route: m.path, status: m.status, duration_ms: m.ms, request_id: m.requestId });
    return;
  }
  const level = m.status >= 500 ? 'error' : m.status >= 400 ? 'warn' : 'info';
  log[level]('http', {
    request_id: m.requestId,
    method: m.method,
    route: m.path,
    status: m.status,
    duration_ms: m.ms,
    user_id: m.userId,
    school_id: m.schoolId,
    err: m.err,
  });
}
