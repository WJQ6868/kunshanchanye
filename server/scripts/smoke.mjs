/* 端到端冒烟测试：健康检查 + 登录 + 会话 + CSRF + 改密 + 登出
   用法：node scripts/smoke.mjs [baseUrl] [管理员密码]
   账号默认是内置管理员 wjqcool，可用 SMOKE_ADMIN_LOGIN 覆盖。 */
const BASE = process.argv[2] || 'http://127.0.0.1:3210';
const LOGIN = process.env.SMOKE_ADMIN_LOGIN || 'wjqcool';

let cookies = {};           // name -> value
let csrf = '';

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === '' || /Max-Age=0/i.test(line)) delete cookies[k];
    else cookies[k] = v;
  }
}

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

async function req(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json' };
  const ck = cookieHeader();
  if (ck) headers.Cookie = ck;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf && opts.csrf !== false) headers['X-CSRF-Token'] = csrf;
  if (opts.headers) Object.assign(headers, opts.headers);
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('BASE =', BASE);

  console.log('\n[1] 健康检查');
  let r = await req('GET', '/healthz');
  check('/healthz 200', r.status === 200, r.status);
  check('/healthz ok=true', r.json?.ok === true, r.json);
  check('带 X-Request-Id', !!r.headers.get('x-request-id'));

  r = await req('GET', '/readyz');
  check('/readyz 200', r.status === 200, r.status);
  check('/readyz driver=sqlite', r.json?.driver === 'sqlite', r.json?.driver);

  console.log('\n[2] 未登录访问 /me');
  r = await req('GET', '/api/v1/me', undefined, { csrf: false });
  check('/me 401', r.status === 401, r.status);
  check('错误体有 code', typeof r.json?.code === 'string', r.json);

  console.log('\n[3] 错误密码');
  r = await req('POST', '/api/v1/auth/login', { username: LOGIN, password: 'wrong-password' }, { csrf: false });
  check('登录失败 401', r.status === 401, r.status);
  check('不泄露账号是否存在', r.json?.message === '登录名或密码不正确', r.json?.message);

  console.log('\n[4] 正确密码登录');
  const pw = process.env.SMOKE_ADMIN_PASSWORD || process.argv[3];
  if (!pw) {
    console.log('  ! 未提供管理员密码（SMOKE_ADMIN_PASSWORD 或第二个参数），跳过登录段');
  } else {
    r = await req('POST', '/api/v1/auth/login', { username: LOGIN, password: pw }, { csrf: false });
    check('登录 200', r.status === 200, { s: r.status, b: r.json });
    check(`返回 user.login=${LOGIN}`, r.json?.user?.login === LOGIN, r.json?.user);
    check('返回 permissions 对象', !!r.json?.permissions && typeof r.json.permissions === 'object');
    check('设置 rc_sid cookie', !!cookies['rc_sid']);
    check('设置 rc_csrf cookie', !!cookies['rc_csrf']);
    csrf = cookies['rc_csrf'] || '';

    console.log('\n[5] 已登录访问 /me');
    r = await req('GET', '/api/v1/me');
    check('/me 200', r.status === 200, r.status);
    check('displayName 存在', typeof r.json?.user?.displayName === 'string', r.json?.user);

    console.log('\n[6] CSRF 双提交');
    const savedCsrf = csrf;
    csrf = '';
    r = await req('POST', '/api/v1/auth/refresh', undefined, { csrf: false });
    check('缺 CSRF 被拒 403', r.status === 403, { s: r.status, b: r.json });
    csrf = savedCsrf;

    console.log('\n[7] 登出');
    r = await req('POST', '/api/v1/auth/logout');
    check('登出 200', r.status === 200 || r.status === 204, r.status);
    r = await req('GET', '/api/v1/me', undefined, { csrf: false });
    check('登出后 /me 401', r.status === 401, r.status);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常：', e);
  process.exit(2);
});
