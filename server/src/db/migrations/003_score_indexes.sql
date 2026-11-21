-- ============================================================
-- 003_score_indexes.sql — 修正 002 里两个唯一索引的语义
-- ------------------------------------------------------------
-- 002 把「幂等键」和「前端记录 id」都建成了逐行唯一，
-- 这在一次请求提交多条记录时必然自撞：
--
--   1) client_request_id 是**批次级**的（一个 Idempotency-Key
--      对应一整批记录，一批 5 条就有 5 行同值）。
--      逐行唯一 → 第 2 条 INSERT 就 UNIQUE 冲突。
--      改为普通索引：幂等由 replaceScores 里的
--      「先查该 key 是否已有记录」在事务内短路，不需要唯一约束兜底。
--      （事务是 BEGIN IMMEDIATE，天然串行，不存在并发漏判）
--
--   2) client_record_id 需要「同一班内同一前端记录只活一条」，
--      但允许历史上被冲正的旧行继续留着（append-only）。
--      所以唯一性只约束**未冲正**的行 → 加 revoked_at IS NULL 的部分索引。
--      否则「改分数 → 冲正旧的 → 插入新的同 id」会在插入时撞上
--      那条已冲正但还占着唯一键的旧行。
-- ============================================================

DROP INDEX IF EXISTS ux_score_request;
DROP INDEX IF EXISTS ux_score_client_record;

CREATE INDEX IF NOT EXISTS ix_score_request
  ON score_record (school_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_score_client_record_live
  ON score_record (class_id, client_record_id)
  WHERE client_record_id IS NOT NULL AND revoked_at IS NULL;
