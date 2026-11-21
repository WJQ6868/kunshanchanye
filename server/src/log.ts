/* ============================================================
   log.ts — 结构化日志（计划书 §12）
   ------------------------------------------------------------
   一行一个 JSON，字段固定，方便直接进 ELK/Loki：
     ts, level, msg, request_id, user_id, school_id,
     route, method, status, duration_ms, + 业务字段
   敏感字段（密码、token）在写日志前由调用方剔除；
   这里再兜底过滤一次，避免手滑把密码打进日志。
   ============================================================ */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN: Level = (process.env.LOG_LEVEL as Level) || 'info';

/** 兜底脱敏：任何层级的 extra 里出现这些键都不输出值 */
const SECRET_KEYS = /^(password|passwd|pwd|token|csrf|secret|authorization|cookie|hash)$/i;

function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrub(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[MIN]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...scrub(extra),
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};
