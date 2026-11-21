/**
 * 修复「同一个人存在两条学生行」的历史脏数据（按 legacy_key 归并）。
 *
 * 背景：2026-11-21 11:32 的整班误删事故里，`PUT /roster` 把两个班的学生全部软删，
 * 11:33 重新导入时 `replaceRoster` 只索引了 `deleted_at IS NULL` 的行，
 * 于是给同一个人又 INSERT 了一条新行 —— 库里留下 49 组「软删旧行 + 在世新行」，
 * 而代闻轩的 5 条加分挂在旧行上，成了「班级总分有 5 分、学生排行榜里找不到人」的幽灵分。
 *
 * `replaceRoster` 已改为命中软删行时复活（不再新建），本脚本负责把存量修好：
 *   对每个 (school_id, legacy_key) 重复组，选在世行为 canonical，
 *   把死行的 score_record / class_student 迁过去，再硬删死行。
 *
 * 用法：
 *   node scripts/repair-ghost-students.mjs --dry   # 只报告
 *   node scripts/repair-ghost-students.mjs         # 实际修复
 */
import { openDb } from '../src/db/driver.ts';

const dry = process.argv.includes('--dry');
const db = await openDb({ driver: 'sqlite', sqliteFile: './data/rollcall.db' });

const rows = await db.all(
  `SELECT id, school_id, name, legacy_key, deleted_at
     FROM student
    WHERE legacy_key IS NOT NULL AND legacy_key <> ''
    ORDER BY school_id, legacy_key, created_at`,
);

const groups = new Map();
for (const r of rows) {
  const k = r.school_id + '\u0001' + r.legacy_key;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

let dupGroups = 0;
let movedScores = 0;
let movedMembers = 0;
let removedRows = 0;
let skipped = 0;

for (const [k, g] of groups) {
  if (g.length < 2) continue;
  const live = g.filter((r) => !r.deleted_at);
  if (live.length !== 1) {
    // 组里 0 条或 ≥2 条在世行，情况复杂，交给人判断，不自动动
    console.log(`跳过（在世行 ${live.length} 条）: ${g[0].name} legacy_key=${g[0].legacy_key}`);
    skipped++;
    continue;
  }
  const canonical = live[0];
  const losers = g.filter((r) => r.id !== canonical.id);
  dupGroups++;
  console.log(`\n合并「${canonical.name}」→ canonical=${canonical.id}${dry ? ' (dry)' : ''}`);
  for (const l of losers) {
    const sc = await db.get(
      'SELECT COUNT(*) AS n, SUM(CASE WHEN revoked_at IS NULL THEN delta ELSE 0 END) AS d FROM score_record WHERE student_id = ?',
      [l.id],
    );
    const cs = await db.get('SELECT COUNT(*) AS n FROM class_student WHERE student_id = ?', [l.id]);
    console.log(`  - ${l.id} deleted_at=${l.deleted_at ? 'Y' : 'null'} 加分=${sc.n}（有效 ${sc.d ?? 0} 分） 成员=${cs.n}`);
    movedScores += Number(sc.n || 0);
    movedMembers += Number(cs.n || 0);
    if (dry) continue;
    await db.tx(async (t) => {
      await t.run('UPDATE score_record SET student_id = ? WHERE student_id = ?', [canonical.id, l.id]);
      // class_student 主键是 (class_id, student_id)：canonical 已在的班先删死行的那条，
      // 免得迁移时撞主键；canonical 没有的班才搬过去。
      await t.run(
        `DELETE FROM class_student
          WHERE student_id = ?
            AND class_id IN (SELECT class_id FROM class_student WHERE student_id = ?)`,
        [l.id, canonical.id],
      );
      await t.run('UPDATE class_student SET student_id = ? WHERE student_id = ?', [canonical.id, l.id]);
      await t.run('DELETE FROM student WHERE id = ?', [l.id]);
    });
    removedRows++;
  }
}

console.log(
  `\n${dry ? '[dry] ' : ''}重复组 ${dupGroups} 个，迁移加分 ${movedScores} 条、成员关系 ${movedMembers} 条，`
  + `删除重复行 ${removedRows} 条，跳过 ${skipped} 组`,
);
await db.close();
