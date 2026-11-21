-- ============================================================
-- 002_domain.sql — P2 领域层
-- ------------------------------------------------------------
-- 计划书 §6.1（user_class_scope）、§6.2（class / student / class_student）、
-- §6.3（score_record append-only）、§6.4（审计已有）
--
-- 占位符只有三种：pk_uuid / pk_serial / json（见 db/dialect.ts）。
-- 时间统一 timestamptz 存 ISO 字符串；布尔统一 integer 0/1。
--
-- 与计划书的两处有意偏差（已评估，记在此处免得后来人以为是漏写）：
--   1. class_student 主键用 (class_id, student_id)，不用三列含 joined_at。
--      原因：前端是「整班名单整体替换」语义，三列区间主键会让每次替换
--      变成 close + insert + 清理三步，容易写出重复有效行。转班历史
--      已经由 score_record 与 audit_log 留痕，成员表只需表达「当前在班」。
--   2. class.term 用 NOT NULL DEFAULT ''，不用可空。
--      原因：唯一索引里 NULL 互不相等，可空 term 会让同名班级绕过唯一约束。
-- ============================================================

-- ---------- 班级 ----------

CREATE TABLE IF NOT EXISTS class (
  id                {{pk_uuid}},
  school_id         text NOT NULL,
  name              text NOT NULL,
  name_norm         text NOT NULL,
  term              text NOT NULL DEFAULT '',
  external_class_id text,
  legacy_name       text,
  status            text NOT NULL DEFAULT 'active',
  version           integer NOT NULL DEFAULT 1,
  created_by        text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  deleted_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_class_name
  ON class (school_id, term, name_norm) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_class_school
  ON class (school_id, deleted_at);

CREATE INDEX IF NOT EXISTS ix_class_external
  ON class (school_id, external_class_id) WHERE external_class_id IS NOT NULL;

-- ---------- 学生（校级实体，不归属班级） ----------

CREATE TABLE IF NOT EXISTS student (
  id                  {{pk_uuid}},
  school_id           text NOT NULL,
  external_student_id text NOT NULL DEFAULT '',
  external_person_id  text NOT NULL DEFAULT '',
  name                text NOT NULL,
  name_norm           text NOT NULL,
  legacy_key          text,
  status              text NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  deleted_at          timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_student_no
  ON student (school_id, external_student_id) WHERE external_student_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_student_person
  ON student (school_id, external_person_id) WHERE external_person_id <> '';

CREATE INDEX IF NOT EXISTS ix_student_name
  ON student (school_id, name_norm);

-- ---------- 班级成员（当前在班关系） ----------

CREATE TABLE IF NOT EXISTS class_student (
  class_id   text NOT NULL,
  student_id text NOT NULL,
  seat_no    integer,
  source     text NOT NULL DEFAULT 'import',
  joined_at  timestamptz NOT NULL,
  left_at    timestamptz,
  PRIMARY KEY (class_id, student_id)
);

CREATE INDEX IF NOT EXISTS ix_cs_student
  ON class_student (student_id);

CREATE INDEX IF NOT EXISTS ix_cs_live
  ON class_student (class_id) WHERE left_at IS NULL;

-- ---------- 加分流水（append-only） ----------

CREATE TABLE IF NOT EXISTS score_record (
  id                     {{pk_serial}},
  school_id              text NOT NULL,
  class_id               text NOT NULL,
  student_id             text NOT NULL,
  delta                  numeric(6,2) NOT NULL CHECK (delta <> 0 AND abs(delta) <= 1000),
  reason_code            text NOT NULL DEFAULT 'other',
  reason_text            text NOT NULL DEFAULT '',
  operator_user_id       text NOT NULL,
  operator_name_snapshot text NOT NULL,
  operator_role          text,
  occurred_at            timestamptz NOT NULL,
  created_at             timestamptz NOT NULL,
  batch_id               text,
  client_request_id      text,
  client_record_id       text,
  source                 text NOT NULL DEFAULT 'web',
  revoke_of_id           integer,
  revoked_at             timestamptz,
  revoked_by             text
);

CREATE INDEX IF NOT EXISTS ix_score_class_time
  ON score_record (class_id, occurred_at);

CREATE INDEX IF NOT EXISTS ix_score_class_student
  ON score_record (class_id, student_id, occurred_at);

CREATE INDEX IF NOT EXISTS ix_score_operator
  ON score_record (operator_user_id, occurred_at);

CREATE INDEX IF NOT EXISTS ix_score_live
  ON score_record (class_id) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_score_request
  ON score_record (school_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_score_batch
  ON score_record (batch_id) WHERE batch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_score_client_record
  ON score_record (class_id, client_record_id) WHERE client_record_id IS NOT NULL;

-- ---------- 讲师带班范围（越权防护核心表） ----------

CREATE TABLE IF NOT EXISTS user_class_scope (
  user_id    text NOT NULL,
  class_id   text NOT NULL,
  source     text NOT NULL DEFAULT 'manual',
  granted_by text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, class_id)
);

CREATE INDEX IF NOT EXISTS ix_ucs_class
  ON user_class_scope (class_id);

-- ---------- 校级设置（key/value，前端 settings 对象落这里） ----------

CREATE TABLE IF NOT EXISTS app_setting (
  school_id  text NOT NULL,
  key        text NOT NULL,
  value      {{json}},
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (school_id, key)
);

-- ---------- 教务同步留痕 ----------

CREATE TABLE IF NOT EXISTS edu_sync_run (
  id             {{pk_serial}},
  school_id      text NOT NULL,
  trigger_by     text,
  source         text NOT NULL DEFAULT 'edu',
  status         text NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  class_count    integer NOT NULL DEFAULT 0,
  student_count  integer NOT NULL DEFAULT 0,
  teacher_count  integer NOT NULL DEFAULT 0,
  created_count  integer NOT NULL DEFAULT 0,
  updated_count  integer NOT NULL DEFAULT 0,
  message        text
);

CREATE INDEX IF NOT EXISTS ix_edu_run_school
  ON edu_sync_run (school_id, started_at);
