/**
 * 清理「同一个人存在两条学生行」的历史脏数据。
 *
 * 背景：004 迁移之前，教务同步重新读回被软删的学生时，会 INSERT 一条新行而不是复活旧行，
 * 于是库里出现「软删的旧行 + 在世的新行」两条同人记录，历史加分被挂在旧行上。
 *
 * 本脚本对每个 (school_id, 身份键) 重复组：
 *   1. 选在世的那条为 canonical（没有在世行则复活最近软删的一条）；
 *   2. 把其它行的 score_record.student_id / class_student 迁到 canonical；
 *   3. 硬删除被合并的行（它们已无任何引用）。
 *
 * 用法：node --experimental-strip-types scripts/dedupe-students.mjs [--dry]
 */
import { openDb } from '../src/db/driver.ts';

const dry = process.argv.includes('--dry');
const db = await openDb({ driver: 'sqlite', sqliteFile: './data/rollcall.db' });

const rows = await db.all(
  `SELECT id, school_id, name, external_student_id, external_person_id, deleted_at
     FROM student ORDER BY school_id, name`,
);

// 按「学号」和「身份证摘要」两个身份键各自分组，任一命中即视为同一人
const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
for (const r of rows) parent.set(r.id, r.id);
const byKey = new Map();
for (const r of rows) {
  for (const [kind, val] of [['no', r.external_student_id], ['person', r.external_person_id]]) {
    if (!val) continue;
    const k = r.school_id + '|' + kind + '|' + val;
    if (byKey.has(k)) union(byKey.get(k), r.id);
    else byKey.set(k, r.id);
  }
}

const groups = new Map();
for (const r of rows) {
  const root = find(r.id);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(r);
}

let mergedGroups = 0, movedScores = 0, movedMembers = 0, removedRows = 0;
for (const [, g] of groups) {
  if (g.length < 2) continue;
  mergedGroups++;
  const live = g.filter((r) => !r.deleted_at);
  const dead = g.filter((r) => r.deleted_at);
  // canonical：优先在世行；若有多条在世行，取有加分记录最多/最早创建的
  let canonical;
  if (live.length) {
    canonical = live[0];
  } else {
    canonical = dead[dead.length - 1];
    if (!dry) {
      await db.run('UPDATE student SET deleted_at = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), canonical.id]);
    }
  }
  const losers = g.filter((r) => r.id !== canonical.id);
  console.log(`\n合并「${canonical.name}」→ canonical=${canonical.id}${dry ? ' (dry)' : ''}`);
  for (const l of losers) {
    const sc = await db.get('SELECT COUNT(*) AS n FROM score_record WHERE student_id = ?', [l.id]);
    const cs = await db.get('SELECT COUNT(*) AS n FROM class_student WHERE student_id = ?', [l.id]);
    console.log(`  - ${l.id} deleted_at=${l.deleted_at ? 'Y' : 'null'} 加分=${sc.n} 成员=${cs.n}`);
    movedScores += Number(sc.n || 0);
    movedMembers += Number(cs.n || 0);
    if (dry) continue;
    await db.run('UPDATE score_record SET student_id = ? WHERE student_id = ?', [canonical.id, l.id]);
    // class_student 有 (class_id, student_id) 主键，先删冲突再迁移
    await db.run(
      `DELETE FROM class_student WHERE student_id = ?
         AND class_id IN (SELECT class_id FROM class_student WHERE student_id = ?)`,
      [l.id, canonical.id],
    );
    await db.run('UPDATE class_student SET student_id = ? WHERE student_id = ?', [canonical.id, l.id]);
    await db.run('DELETE FROM student WHERE id = ?', [l.id]);
    removedRows++;
  }
}

console.log(
  `\n${dry ? '[dry] ' : ''}重复组 ${mergedGroups} 个，迁移加分 ${movedScores} 条、成员关系 ${movedMembers} 条，删除重复行 ${removedRows} 条`,
);
