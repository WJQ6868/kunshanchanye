/**
 * mock-edu.mjs — 假教务系统，用于联调「一键读取教务名单」
 *
 * 用法：
 *   node scripts/mock-edu.mjs 3400
 *   # 然后让主服务指向它：
 *   #   EDU_BASE_URL=http://127.0.0.1:3400 EDU_TOKEN=demo-token
 *
 * 返回 GET /api/classes →
 *   { classes: [ { externalId, name, term, students:[{name,studentNo,idCard}],
 *                  teachers:[{name,employeeNo,idCard}] } ] }
 *
 * 数据里刻意包含三种情况，用来验证 edu.ts 的三步匹配逻辑：
 *   1) 学生带学号 + 身份证 → 应按学号命中已存在的学生
 *   2) 学生只有身份证（无学号） → 应按身份证摘要命中
 *   3) 学生什么都没有 → 只能按「同班同名」命中
 *   4) 讲师带工号 → 应自动建 role=teacher 且 password_hash=NULL 的账号
 *   5) 讲师无工号 → 用身份证摘要后 8 位生成登录名
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 3400);
const TOKEN = process.env.MOCK_EDU_TOKEN || 'demo-token';

/** 教务侧的身份证明文只在这里出现，绝不会被主服务落库 */
const CLASSES = [
  {
    externalId: 'EDU-C-1001',
    name: '电气2301',
    term: '2026-2027-1',
    students: [
      // ① 带学号 + 身份证
      { name: '张伟', studentNo: '2023001', idCard: '110101200501011234' },
      // ② 只有身份证
      { name: '李娜', idCard: '110101200502022345' },
      // ③ 什么都没有
      { name: '王强' },
      // ④ 教务新增的学生（本地库里没有）
      { name: '赵敏', studentNo: '2023009', idCard: '110101200503033456' },
    ],
    teachers: [
      // 带工号 → 登录名 t1001
      { name: '陈老师', employeeNo: '1001', idCard: '110101198001014567' },
      // 无工号 → 登录名取身份证摘要后 8 位
      { name: '刘老师', idCard: '110101198202025678' },
    ],
  },
  {
    externalId: 'EDU-C-1002',
    name: '自动化2302',
    term: '2026-2027-1',
    students: [
      { name: '孙浩', studentNo: '2023101', idCard: '110101200504044567' },
      { name: '周婷', studentNo: '2023102' },
    ],
    teachers: [{ name: '陈老师', employeeNo: '1001' }],
  },
];

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== '/api/classes') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const auth = req.headers.authorization || '';
  if (TOKEN && auth !== 'Bearer ' + TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad token' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ classes: CLASSES }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock-edu] listening on http://127.0.0.1:' + PORT);
  console.log('[mock-edu] GET /api/classes  (Authorization: Bearer ' + TOKEN + ')');
  console.log('[mock-edu] ' + CLASSES.length + ' classes / ' +
    CLASSES.reduce((n, c) => n + c.students.length, 0) + ' students / ' +
    CLASSES.reduce((n, c) => n + c.teachers.length, 0) + ' teacher rows');
});
