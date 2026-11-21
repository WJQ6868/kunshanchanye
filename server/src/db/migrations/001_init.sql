-- ============================================================
-- 001_init.sql — P1 服务端基座建表
-- ------------------------------------------------------------
-- 说明：
-- · 这份 SQL 同时跑在 PostgreSQL 与 SQLite（本机开发用）。
--   方言差异用双花括号占位符表示，由 db/dialect.ts 在迁移时替换：
--     {{pk_uuid}}   PG: uuid PRIMARY KEY DEFAULT gen_random_uuid()
--                   SQLite: text PRIMARY KEY
--     {{pk_serial}} PG: bigserial PRIMARY KEY
--                   SQLite: integer PRIMARY KEY AUTOINCREMENT
--     {{json}}      PG: jsonb  /  SQLite: text
-- · 时间统一 timestamptz（SQLite 会退化为 TEXT，值一律 ISO 字符串）
-- · 布尔统一 integer 0/1，应用层转换（避免两种方言的 true/false 差异）
-- · 业务表全部带 school_id：单校部署也保留，多校 SaaS 不改表
-- ============================================================

/* ---------- 租户 ---------- */

CREATE TABLE IF NOT EXISTS school (
  id            {{pk_uuid}},
  code          text        NOT NULL,
  name          text        NOT NULL,
  external_org_id text,
  sso_issuer    text,
  deployment_mode text      NOT NULL DEFAULT 'onprem',  -- saas | onprem
  status        text        NOT NULL DEFAULT 'active',  -- active | suspended
  created_at    timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_school_code ON school(code);

/* ---------- 用户 ---------- */

CREATE TABLE IF NOT EXISTS app_user (
  id            {{pk_uuid}},
  school_id     text        NOT NULL,
  username      text,                                   -- SSO 用户可为空
  display_name  text        NOT NULL,                   -- 加分记录的姓名快照来源
  employee_no   text,
  password_hash text,                                   -- SSO 用户为 NULL
  auth_source   text        NOT NULL DEFAULT 'local',   -- local | sso | both
  role          text        NOT NULL DEFAULT 'teacher', -- admin | teacher | viewer
  permissions   {{json}},                               -- 权限覆盖项（相对角色默认）
  class_scopes  {{json}},                               -- 班级范围；NULL 表示不限
  status        text        NOT NULL DEFAULT 'active',  -- active | disabled
  must_change   integer     NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_username
  ON app_user(school_id, lower(username))
  WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_employee
  ON app_user(school_id, employee_no)
  WHERE employee_no IS NOT NULL;

/* ---------- 会话 ---------- */
-- 只存 token 的 sha256，库泄露也拿不到可用会话

CREATE TABLE IF NOT EXISTS session (
  id           {{pk_uuid}},
  user_id      text        NOT NULL,
  school_id    text        NOT NULL,
  token_hash   text        NOT NULL,
  csrf_secret  text        NOT NULL,
  issued_at    timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ip           text,
  user_agent   text,
  revoked_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_session_token ON session(token_hash);
CREATE INDEX IF NOT EXISTS ix_session_user ON session(user_id, issued_at);

/* ---------- 登录失败计数（限流） ---------- */
-- 落库而不是放内存：多进程/重启后限流依然有效

CREATE TABLE IF NOT EXISTS login_attempt (
  id          {{pk_serial}},
  school_id   text        NOT NULL,
  username    text        NOT NULL,
  ip          text        NOT NULL,
  ok          integer     NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_login_attempt_lookup
  ON login_attempt(school_id, username, ip, created_at);

/* ---------- 审计日志（append-only） ---------- */

CREATE TABLE IF NOT EXISTS audit_log (
  id            {{pk_serial}},
  school_id     text        NOT NULL,
  actor_user_id text,
  actor_name    text,
  actor_ip      text,
  user_agent    text,
  action        text        NOT NULL,
  target_type   text,
  target_id     text,
  before_data   {{json}},
  after_data    {{json}},
  request_id    text,
  created_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_school_time ON audit_log(school_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_log(actor_user_id, created_at);

/* ---------- 迁移记录 ---------- */

CREATE TABLE IF NOT EXISTS schema_migration (
  name        text        PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL
);
