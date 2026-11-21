-- 004_student_indexes.sql
--
-- 修复：学生软删除后仍占用唯一索引，导致教务同步无法重新建回该学生。
--
-- 现象：PUT /roster 把名单整体替换时，不在新名单里的学生会软删（student.deleted_at 置位）。
--       之后 POST /edu/sync 重新读回同一名学生，按「学号 / 身份证摘要」查不到（查询都带
--       deleted_at IS NULL），于是走 INSERT，结果撞上唯一索引：
--         UNIQUE constraint failed: student.school_id, student.external_person_id
--       因为原索引没有排除已软删的行。
--
-- 修法：唯一性只约束「在世」的学生。软删行保留下来是为了给 score_record 的
--       student_id 留引用（加分流水不能因为学生被移出名单就变成悬空外键），
--       但它不应该再参与身份唯一性判定。

DROP INDEX IF EXISTS ux_student_no;
DROP INDEX IF EXISTS ux_student_person;

CREATE UNIQUE INDEX IF NOT EXISTS ux_student_no_live
  ON student (school_id, external_student_id)
  WHERE external_student_id <> '' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_student_person_live
  ON student (school_id, external_person_id)
  WHERE external_person_id <> '' AND deleted_at IS NULL;
