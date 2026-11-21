/* ============================================================
   index.ts — 启动入口
   ------------------------------------------------------------
   顺序（错了会出各种怪问题）：
     1. 读配置（失败直接退出，不带着半截配置跑）
     2. 打开数据库（建目录 → 打开 → 跑迁移）
     3. 引导首个管理员（幂等）
     4. 起 HTTP 服务
     5. 注册优雅退出（SIGINT/SIGTERM：先停止接受新连接，
        再关数据库，避免正在写的事务被硬砍）

   为什么迁移在启动时自动跑：
   单校私有化部署没有 CI/CD 流程，运维只会 `docker compose up`。
   迁移器本身是幂等的（schema_migration 表记录 checksum），
   自动跑比让运维手动执行 SQL 可靠得多。
   ============================================================ */

import { loadConfig, describeConfig } from './config.ts';
import { openDb } from './db/driver.ts';
import { migrate } from './db/migrate.ts';
import { seed } from './auth/seed.ts';
import { pruneSessions } from './auth/session.ts';
import { createApp } from './server.ts';
import { log } from './log.ts';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  /* ---------- 1. 配置 ---------- */
  const cfg = loadConfig();
  log.info('启动中', { config: describeConfig(cfg) });

  /* ---------- 2. 数据库 ---------- */
  if (cfg.dbDriver === 'sqlite') {
    // SQLite 文件所在目录可能不存在（首次部署）
    const abs = cfg.sqliteFile.startsWith(':') ? cfg.sqliteFile : cfg.sqliteFile;
    if (!abs.startsWith(':')) {
      try {
        await mkdir(dirname(abs), { recursive: true });
      } catch (e) {
        log.error('创建数据库目录失败', { dir: dirname(abs), err: String((e as Error)?.message || e) });
        process.exit(1);
      }
    }
  }

  const db = await openDb({
    driver: cfg.dbDriver,
    sqliteFile: cfg.sqliteFile,
    pgUrl: cfg.databaseUrl,
  });
  log.info('数据库已连接', { driver: db.dialect });

  /* ---------- 3. 迁移 ---------- */
  const migrationsDir = join(HERE, 'db', 'migrations');
  try {
    const applied = await migrate(db, { dir: migrationsDir });
    log.info('迁移完成', { applied: applied.applied.length, skipped: applied.skipped.length });
  } catch (e) {
    log.error('迁移失败，启动中止', { err: String((e as Error)?.message || e) });
    await db.close();
    process.exit(1);
  }

  /* ---------- 4. 清理上次进程遗留的「进行中」记录 ----------
     教务同步在写 edu_sync_run 时先插一行 status='running'，
     正常结束再改成 ok/failed。如果进程被 kill 或断电，
     这行就永远停在 running，前端会一直显示「同步中」。
     启动时统一收尾，是唯一能兜住这种「没人来改」的时机。 */
  try {
    const stale = await db.run(
      `UPDATE edu_sync_run SET status = 'failed', finished_at = ?, message = ?
        WHERE status = 'running'`,
      [new Date().toISOString(), '服务进程重启中断，未完成'],
    );
    if (stale > 0) log.warn('已收尾上次中断的教务同步记录', { count: stale });
  } catch (e) {
    // 表可能还没建（首次部署迁移失败等），不影响启动
    log.warn('清理遗留同步记录失败', { err: String((e as Error)?.message || e) });
  }

  /* ---------- 5. 引导管理员 ---------- */
  const seeded = await seed(db, cfg);
  if (seeded.createdAdmin) {
    /* 内置管理员的密码是固定的（哈希写在 seed.ts 里），
       这里不打印任何密码——打印出来就等于把口令写进日志文件。 */
    const banner = [
      '',
      '========================================',
      '  已创建内置最高管理员',
      `  登录名：${seeded.adminLogin}`,
      '  密码：部署文档约定的初始密码（只以 scrypt 哈希存储）',
      '  登录后请在「账号 → 修改密码」中更换',
      '========================================',
      '',
    ].join('\n');
    process.stdout.write(banner + '\n');
  }

  /* ---------- 5.5 清理过期会话 ----------
     session 表以前只增不减（性能测试 P2-1：生产库 121 行里 105 行已吊销、
     31 行是用户已删的孤儿）。启动时清一次，之后每小时清一次；
     timer.unref() 保证它不会阻止进程退出。 */
  try {
    const removed = await pruneSessions(db);
    if (removed > 0) log.info('已清理过期会话', { count: removed });
    const timer = setInterval(() => {
      pruneSessions(db).catch((e) => {
        log.warn('定时清理会话失败', { err: String((e as Error)?.message || e) });
      });
    }, 3600_000);
    timer.unref();
  } catch (e) {
    // 表还没建（首次部署迁移失败等）时不影响启动
    log.warn('清理过期会话失败', { err: String((e as Error)?.message || e) });
  }

  /* ---------- 6. HTTP ---------- */
  const server = createApp({ cfg, db });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });

  log.info('服务已启动', {
    url: `http://${cfg.host}:${cfg.port}`,
    env: cfg.env,
    db: db.dialect,
  });

  /* ---------- 7. 优雅退出 ---------- */
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('收到退出信号，正在关闭', { signal });

    const force = setTimeout(() => {
      log.error('关闭超时，强制退出');
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(async (e) => {
      if (e) log.warn('关闭 HTTP 服务时出错', { err: String(e.message) });
      try {
        await db.close();
        log.info('已安全退出');
      } catch (err) {
        log.error('关闭数据库失败', { err: String((err as Error)?.message || err) });
      }
      clearTimeout(force);
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { err: String(reason) });
  });
  process.on('uncaughtException', (e) => {
    log.error('未捕获异常', { err: e.message, stack: e.stack?.split('\n').slice(0, 6).join(' | ') });
  });
}

main().catch((e) => {
  log.error('启动失败', { err: String(e?.message || e), stack: e?.stack?.split('\n').slice(0, 8).join(' | ') });
  process.exit(1);
});
