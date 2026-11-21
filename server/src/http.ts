/* ============================================================
   http.ts — 错误规范与响应封装（计划书 §7）
   ------------------------------------------------------------
   统一约定：
   · 成功：直接返回数据对象（不套 {data:...} 信封，
     前端 adapter-remote 已按裸对象解析，套信封会全线改）
   · 失败：{ code, message, details? } + 对应 HTTP 状态
   · 每个响应都带 X-Request-Id（前端报错时能让用户报这个号）
   ============================================================ */

import type { IncomingMessage, ServerResponse } from 'node:http';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 常用错误工厂：把「写 400 还是 401」这种决定收敛到一处 */
export const err = {
  badRequest: (message: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = '未登录或会话已过期') => new ApiError(401, 'UNAUTHORIZED', message),
  forbidden: (message = '没有权限执行该操作') => new ApiError(403, 'FORBIDDEN', message),
  notFound: (message = '资源不存在') => new ApiError(404, 'NOT_FOUND', message),
  conflict: (message: string, details?: unknown) => new ApiError(409, 'CONFLICT', message, details),
  versionConflict: (message = '数据已被他人修改，请刷新后重试') =>
    new ApiError(409, 'VERSION_CONFLICT', message),
  tooMany: (message = '操作过于频繁，请稍后再试') => new ApiError(429, 'TOO_MANY_REQUESTS', message),
  internal: (message = '服务器内部错误') => new ApiError(500, 'INTERNAL_ERROR', message),
};

export interface Reply {
  status: number;
  /**
   * 头值允许 string[]：Set-Cookie 必须是数组。
   * 拼成 "a=1; Path=/, b=2; Path=/" 的单个字符串时，
   * 浏览器与 fetch 的 getSetCookie() 都只认第一条，
   * 表现就是「登录成功但 CSRF cookie 丢了」。
   */
  headers: Record<string, string | string[]>;
  body?: unknown;
}

export function json(status: number, body: unknown, headers: Record<string, string | string[]> = {}): Reply {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body };
}

export function noContent(headers: Record<string, string | string[]> = {}): Reply {
  return { status: 204, headers };
}

/** 把 Reply 写到原生响应 */
export function send(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string | string[]> = {
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
    ...reply.headers,
  };
  res.writeHead(reply.status, headers);
  if (reply.body === undefined) {
    res.end();
    return;
  }
  res.end(JSON.stringify(reply.body));
}

/** 读请求体（限 5MB，与计划书「上传 ≤5MB」对齐） */
export async function readJson(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(err.badRequest('请求体过大（上限 5MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(err.badRequest('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 解析 Cookie 头 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** 生成 Set-Cookie 值 */
export function cookie(name: string, value: string, opts: {
  maxAgeSec?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
} = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=' + (opts.path || '/'));
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push('SameSite=' + (opts.sameSite || 'Lax'));
  if (opts.maxAgeSec !== undefined) parts.push('Max-Age=' + Math.max(0, Math.floor(opts.maxAgeSec)));
  return parts.join('; ');
}
