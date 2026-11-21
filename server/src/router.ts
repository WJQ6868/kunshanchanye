/* ============================================================
   router.ts — 极简路由
   ------------------------------------------------------------
   为什么不用 express：
   · 私有化部署要「一个 npm install 就能起」，依赖越少越好
   · 我们只需要 20 来条路由，express 的中间件生态用不上
   · node:http 足够，且请求/响应行为完全可预期（审计友好）

   支持的路径模式：/classes/:id/scores
   ============================================================ */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './ctx.ts';

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  /** 是否要求已登录 */
  auth: boolean;
  /** 写操作要求 CSRF */
  csrf: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { auth?: boolean; csrf?: boolean } = {}): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      handler,
      auth: opts.auth !== false,
      csrf: opts.csrf ?? method.toUpperCase() !== 'GET',
    });
    return this;
  }

  get(p: string, h: Handler, o?: { auth?: boolean }) { return this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: { auth?: boolean; csrf?: boolean }) { return this.add('POST', p, h, o); }
  patch(p: string, h: Handler, o?: { auth?: boolean }) { return this.add('PATCH', p, h, o); }
  put(p: string, h: Handler, o?: { auth?: boolean }) { return this.add('PUT', p, h, o); }
  del(p: string, h: Handler, o?: { auth?: boolean }) { return this.add('DELETE', p, h, o); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const m = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== m) continue;
      const params = matchPattern(route.pattern, path);
      if (params) return { route, params };
    }
    return null;
  }

  /** 用于 405 判断：路径存在但方法不对 */
  pathExists(path: string): boolean {
    return this.routes.some((r) => matchPattern(r.pattern, path) !== null);
  }
}

export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const pa = pattern.split('/').filter(Boolean);
  const sa = path.split('/').filter(Boolean);
  if (pa.length !== sa.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pa.length; i++) {
    const p = pa[i];
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(sa[i]);
      } catch {
        params[p.slice(1)] = sa[i];
      }
    } else if (p !== sa[i]) {
      return null;
    }
  }
  return params;
}

export type { IncomingMessage, ServerResponse };
