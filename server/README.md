# rollcall-server

课堂加分与随机点名的服务端（P1 第 4 项）。**前端不依赖它也能跑**——双击 `../index.html` 就是纯本地模式；这个服务端只在需要「多台电脑共享名单与加分记录」时才启动。

## 快速开始

```bash
cd rollcall/server
cp .env.example .env      # 至少看一眼 PORT 和 DB_DRIVER
node src/index.ts
```

Node 24 可以直接跑 `.ts`（类型剥离），不需要 `tsc`、不需要 `ts-node`、不需要 `npm install`。

首次启动会依次做四件事，并创建**内置最高管理员**（账号 `wjqcool`，姓名「深之一」）：

```
[migrate] applied 001_init.sql (370ea1c670ffd08a)
已创建学校 schoolId=sc_BBB_qufPm9fA code=default
已创建内置最高管理员  login=wjqcool
服务已启动 url=http://127.0.0.1:3210
```

内置管理员的密码是固定的，**只以 scrypt 哈希形式存在** `src/auth/seed.ts`（`DEFAULT_ADMIN_PASSWORD_HASH`），明文既不写进代码、不写进仓库，也不打进日志。启动日志里只打印登录名。校验脚本：`node ../tools/verify-admin-hash.mjs`。

登录后请在「账号 → 修改密码」里换成自己的密码——`seed` 只在账号不存在时创建，改过的密码不会被重启重置。

密码丢了：用另一个管理员账号重置，或删掉 `data/rollcall.db` 重来（本地模式的数据在浏览器里，不受影响）。

## 数据库

`DB_DRIVER` 两个值：

| 值 | 依赖 | 用在哪 |
| --- | --- | --- |
| `sqlite`（默认） | Node 内置 `node:sqlite` | 本机、单机演示、小规模单校 |
| `pg` | `npm install pg` | 生产。需要 `DATABASE_URL` |

两套结构由**同一份** `src/db/migrations/*.sql` 生成：SQL 里写 `{{pk_uuid}}` / `{{pk_serial}}` / `{{json}}`，`dialect.ts` 按方言替换。维护两套 DDL 必然漂移，一套加替换层能保证 PG 与 SQLite 永远同构。

迁移文件一旦执行就不能再改——`schema_migration` 存了 checksum，改动会直接抛错并要求新增文件。

## 配置

全部走环境变量，完整列表见 `.env.example`。几个要点：

- `NODE_ENV=prod` 时**强制** `COOKIE_SECURE=true`，否则启动即失败（避免生产环境误发不加密的会话 cookie）。
- `HOST` 默认 `127.0.0.1`，只监听本机。要给局域网用改成 `0.0.0.0`，并注意此时是 `http://`，浏览器不提供 `crypto.subtle`（前端已有纯 JS 兜底，但会话 cookie 无法 Secure）。
- `STATIC_DIR` 默认 `../`，即把整个 `rollcall/` 当前端静态根。
- 内置管理员是**代码内置**的（`src/auth/seed.ts`），不再读 `BOOTSTRAP_ADMIN_*` 环境变量，也不会随机生成密码。

## 接口

前缀 `/api/v1`，另有根路径别名 `/healthz`、`/readyz`（docker healthcheck 与前端探活打根路径）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 存活检查，不查库 |
| GET | `/readyz` | 就绪检查，查 `SELECT 1` + 迁移表 + 学校表 |
| POST | `/auth/login` | 登录，下发 `rc_sid`（HttpOnly）+ `rc_csrf` |
| POST | `/auth/logout` | 吊销当前会话 |
| POST | `/auth/refresh` | 续期 |
| GET | `/me` | 当前用户 + 权限 + 班级范围（未登录 401） |
| POST | `/auth/password` | 改密，成功后吊销该用户其余会话 |

约定：

- 响应统一带 `X-Request-Id`，错误体 `{code, message, details}`。
- 写请求要求 `X-CSRF-Token`（双提交；`rc_csrf` 刻意非 HttpOnly，前端读出来放头里）。
- 登录失败统一回「登录名或密码不正确」，不区分账号是否存在；10 分钟 5 次后限流 429。
- 会话空闲 30 分钟、绝对 12 小时；单用户并发上限 5，超出踢最早的。
- 库里只存 token 的 sha256，库泄露也拿不到可用 token。

## 冒烟测试

```bash
node scripts/smoke.mjs http://127.0.0.1:3210 <管理员密码>
```

19 条断言，覆盖健康检查、未登录 401、错误密码文案、登录下发两个 cookie、已登录 `/me`、缺 CSRF 403、登出后 401。

## 静态资源安全

静态根是整个 `rollcall/`，里面同时有服务端源码、`data/rollcall.db`（密码哈希与 token）、构建脚本、内部文档。`serveStatic` 做了三层：

1. `path.normalize` + 前缀校验，拦 `../`；
2. 路径段黑名单 `server` / `tools` / `data` / `docs` / `.git` / `.npmcache`；
3. 任何以 `.` 开头的路径段（`.env`、`.gitignore`）一律不服务。

入口先 `decodeURIComponent` 再交给上述校验，所以 `%2e%2e` 编码穿越同样被拦；中文文件名（`/sample/高一(3)班.csv`）也能正常下载。

## 目录

```
src/
├── index.ts            启动入口：配置 → 建库 → 迁移 → seed → HTTP → 优雅退出
├── server.ts           请求编排、静态托管、CSP、敏感目录拦截
├── config.ts           环境变量解析与校验
├── http.ts             统一响应、错误类型、cookie 序列化
├── log.ts              单行 JSON 日志 + 递归脱敏
├── router.ts           极简路由（:id 段 + 405 判定）
├── ctx.ts              请求上下文、权限助手（can / classScopes / viewScopes）
├── audit.ts            审计写入
├── db/
│   ├── driver.ts       Db 接口 + sqlite / pg 两个实现
│   ├── dialect.ts      方言占位符替换、参数占位符转换
│   ├── migrate.ts      迁移执行器（checksum 防改动）
│   └── migrations/     001_init.sql（8 张表）
├── auth/
│   ├── password.ts     scrypt 哈希与校验
│   ├── session.ts      会话签发/解析、CSRF、吊销
│   ├── perm.ts         33 条权限、7 分组、4 角色
│   ├── users.ts        用户读写与 PublicUser 映射
│   └── seed.ts         首个学校与管理员
└── routes/
    ├── auth.ts         登录登出改密 me
    └── health.ts       healthz / readyz
```

## 已知限制

- 业务接口（班级、名单、加分、撤销）在 **P2**，当前只有认证与健康检查。
- 教务单点登录（`/auth/sso/*`）在 **P3**，当前 `signInWithProvider` 只返回「尚未配置」。
- 没有多进程/多实例支持，SQLite 模式下也不该多开。
- 限流是进程内计数，重启清零；多实例部署需要挪到 Redis 或数据库。
