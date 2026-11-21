/* ============================================================
   session.js —— 会话与当前用户
   ------------------------------------------------------------
   本地模式的「会话」= localStorage 里的一条会话记录。
   服务端版本会换成 HttpOnly Cookie，本文件的对外接口保持不变，
   所以 app.js 只依赖 RCSession.can / RCSession.me 这两个东西。

   安全边界（必须写在代码里，避免以后被误改）：
   - 这里的 can() 只决定「界面显示与否」。它拦不住任何人手动改 localStorage。
     真正的强制校验在服务端（P1 第 4 项）。本地模式下权限是「防误操作」，
     不是「防攻击」——这一点在 README 和 UI 上都要说清楚。
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'rollcall.session.v1';
  var TTL = 2 * 60 * 60 * 1000;     // 本地模式：登录满 2 小时必须重新登录
  /* 服务端模式的绝对有效期，与服务端 SESSION_ABS_MIN=120 对齐。
     正常情况用 /me 返回的 session.expiresAt（服务端真源）；
     这个常量只在服务端没回到期时间时兜底，避免前端完全不设防。 */
  var ABS_MS = 2 * 60 * 60 * 1000;
  var MAX_FAIL = 5;                 // 连续失败次数上限
  var LOCK_MS = 5 * 60 * 1000;      // 锁定时长
  var WATCH_MS = 20 * 1000;         // 到期巡检间隔（20 秒，够快又不浪费）

  var current = null;   // 当前用户（扁平 safe 副本，供内部判断）
  var perms = {};       // 有效权限表
  var snapshot = null;  // 对外的 me() 返回值：{user, permissions, classScopes}
  var failKey = 'rollcall.loginfail.v1';

  /* 会话到期时刻（毫秒）。0 = 未知（老服务端 / 本地模式）。
     来源优先级：/me 的 session.expiresAt > 登录时 now + ABS_MS。 */
  var expiresAtMs = 0;
  /* 过期后要执行的回调（app.js 注册，用来清界面状态）；空数组时退回 RCLogin.signOut */
  var expireHandlers = [];
  var expiring = false;   // 防重入：定时巡检与 401 可能同时判定过期
  /* 会话代次：登录 / 退出 / 过期时自增。restore() 里异步发起的 refreshMe() 回来时
     如果代次变了，说明这期间用户已经退出或重新登录，结果必须丢弃——
     否则会把已退出的登录态又装回内存，紧接着触发一次假的「到期」跳转。 */
  var epoch = 0;
  var watchTimer = null;  // 到期巡检定时器
  var watchBound = false; // 是否已绑定 visibilitychange / focus 监听
  /* 冷启动时发现缓存的会话已过期：登录页 start() 读到这条提示并显示，
     否则用户只会看到「莫名其妙又回到登录页」。 */
  var pendingNotice = '';

  /* 数据模式：'local'（浏览器本地账号体系）| 'remote'（服务端会话 Cookie）。
     由 RCLogin.start({mode}) 在启动时写入，之后所有认证动作按它分流。 */
  var remoteMode = false;

  function setMode(mode) {
    remoteMode = mode === 'remote';
    return remoteMode;
  }

  function isRemote() {
    return remoteMode;
  }

  /* ---------- 失败计数（简单防爆破） ---------- */

  function failState() {
    try {
      var d = JSON.parse(global.localStorage.getItem(failKey) || '{}');
      if (!d || typeof d !== 'object') return { n: 0, until: 0 };
      return { n: d.n || 0, until: d.until || 0 };
    } catch (e) { return { n: 0, until: 0 }; }
  }

  function setFailState(d) {
    try { global.localStorage.setItem(failKey, JSON.stringify(d)); } catch (e) {}
  }

  function lockedFor() {
    var f = failState();
    var left = f.until - Date.now();
    return left > 0 ? left : 0;
  }

  function noteFail() {
    var f = failState();
    f.n = (f.n || 0) + 1;
    if (f.n >= MAX_FAIL) {
      f.until = Date.now() + LOCK_MS;
      f.n = 0;
    }
    setFailState(f);
    return f.until > Date.now() ? LOCK_MS : 0;
  }

  function clearFail() { setFailState({ n: 0, until: 0 }); }

  /**
   * 从适配器抛出的错误里抠出人话。
   *
   * 适配器把非 2xx 统一包成 `Error('HTTP 400 {"code":"BAD_REQUEST","message":"原密码不正确"}')`，
   * 直接甩给用户就是一串 JSON。这里优先取服务端的 message 字段，
   * 取不到才退回兜底文案 —— 与 adapter-remote.js 里的同名函数保持一致。
   */
  function pickMsg(e, fallback) {
    var raw = (e && e.message) || '';
    var m = /"message"\s*:\s*"([^"]+)"/.exec(raw);
    if (m) return m[1];
    if (e && e.status === 401) return '登录已过期，请重新登录';
    if (!raw) return fallback;
    return fallback + '：' + raw;
  }


  /* ---------- 会话持久化 ---------- */

  function readSession() {
    try {
      var d = JSON.parse(global.localStorage.getItem(KEY) || 'null');
      if (!d || !d.userId) return null;
      if (d.expire && d.expire < Date.now()) return null;
      /* 绝对超时兜底：登录时刻 + TTL。防止 expire 被别处改写后无限续命。
         命中时留一条提示，登录页 start() 会显示出来，
         否则用户只看到「登录状态莫名丢了」。 */
      if (d.at && Date.now() - d.at > TTL) {
        pendingNotice = '登录已超过 2 小时，请重新登录';
        return null;
      }
      return d;
    } catch (e) { return null; }
  }

  function writeSession(userId) {
    var d = { userId: userId, expire: Date.now() + TTL, at: Date.now() };
    try { global.localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {}
    return d;
  }
  function touch() {
    /* 远程模式的续期由服务端在每次请求时滑动刷新，前端不需要写本地会话。
       注意：绝对超时是「登录满 2 小时」而不是「闲置 2 小时」，
       所以这里不再续期，只做一次到期校验（续期会让 2 小时变成滑动窗口）。 */
    if (remoteMode) { checkExpiry(); return; }
    var d = readSession();
    if (!d) { expireNow('timeout'); return; }
    if (!expiresAtMs) { expiresAtMs = d.expire; startWatch(); }
    checkExpiry();
  }

  /* ---------- 登录态到期（满 2 小时必须重新登录） ---------- */

  /**
   * 记录会话到期时刻。
   * 优先用服务端 /me 返回的 session.expiresAt（真源，绝对超时由服务端裁决）；
   * 服务端没给（老版本）时用 fallbackMs 兜底成 now + 2 小时，
   * 避免前端完全不设防、让用户以为登录态永不过期。
   * @param {Object} payload /me 结构
   * @param {number} [fallbackMs] 兜底时长
   */
  function applySessionMeta(payload, fallbackMs) {
    var s = payload && payload.session;
    var exp = s && s.expiresAt ? Date.parse(s.expiresAt) : NaN;
    if (isFinite(exp) && exp > 0) expiresAtMs = exp;
    /* 兜底只在「完全没有到期时刻」时生效一次。
       否则每次 refresh()/buildRemote() 都会把到期时间推到 now+2h，2 小时变成永不失效。 */
    else if (fallbackMs && !expiresAtMs) expiresAtMs = Date.now() + fallbackMs;
    if (expiresAtMs) { bindWatchEvents(); startWatch(); }
    return expiresAtMs;
  }

  /** 到期回调注册（app.js 用来清界面状态）；返回注销函数 */
  function onExpire(fn) {
    if (typeof fn !== 'function') return function () {};
    expireHandlers.push(fn);
    return function () {
      var i = expireHandlers.indexOf(fn);
      if (i >= 0) expireHandlers.splice(i, 1);
    };
  }

  /**
   * 立即判定并执行过期。
   * 定时巡检、切回标签页、以及任何接口返回 401 都走这里，保证只有一条出口：
   * 清掉内存里的登录态 → 清本地会话 → 通知界面回到登录页。
   * @param {string} [reason] 'timeout'（满 2 小时）| 'unauthorized'（服务端判过期）
   * @returns {boolean} 是否真的执行了过期
   */
  function expireNow(reason) {
    if (expiring || !current) return false;
    expiring = true;
    epoch++;
    try {
      current = null;
      perms = {};
      snapshot = null;
      expiresAtMs = 0;
      try { global.localStorage.removeItem(KEY); } catch (e) {}
      stopWatch();
      /* 远程模式还要把适配器里的 /me 副本清掉（logout() 会先同步清 cache.me 再发请求，
         此时 Cookie 已失效，请求会 401，这里不在乎结果）。否则界面回到登录页了，
         适配器仍认为自己有登录用户，写守卫会放行一堆注定 401 的请求。 */
      if (remoteMode && global.RCData && typeof global.RCData.logout === 'function') {
        try { global.RCData.logout(); } catch (e) {}
      }
      var hs = expireHandlers.slice();
      for (var i = 0; i < hs.length; i++) {
        try { hs[i](reason || 'timeout'); } catch (e) {}
      }
      /* 没注册回调时退回登录页自身的收尾逻辑，保证一定跳得回去 */
      if (!hs.length && global.RCLogin && typeof global.RCLogin.signOut === 'function') {
        try { global.RCLogin.signOut(); } catch (e) {}
      }
    } finally {
      expiring = false;
    }
    return true;
  }

  /** 到期检查：到点即过期。返回 true 表示这次真的过期了 */
  function checkExpiry() {
    if (!current || !expiresAtMs) return false;
    if (Date.now() < expiresAtMs) return false;
    return expireNow('timeout');
  }

  /** 取出并清空「待提示」文案（登录页启动时用；取过一次就不再重复弹） */
  function takeNotice() {
    var s = pendingNotice;
    pendingNotice = '';
    return s;
  }

  /** 会话到期时刻（毫秒）；0 = 未知 */
  function expiresAt() {
    return expiresAtMs;
  }

  /** 距到期还有多少毫秒（未知返回 -1，已过期返回 0） */
  function remainingMs() {
    if (!expiresAtMs) return -1;
    var left = expiresAtMs - Date.now();
    return left > 0 ? left : 0;
  }

  function stopWatch() {
    if (watchTimer) {
      try { global.clearInterval(watchTimer); } catch (e) {}
      watchTimer = null;
    }
  }

  function startWatch() {
    if (watchTimer || !global.setInterval) return;
    watchTimer = global.setInterval(function () {
      if (!current) { stopWatch(); return; }
      checkExpiry();
    }, WATCH_MS);
  }

  /* 标签页切回来时立刻校验一次：后台标签页的定时器会被浏览器降频，
     只靠 setInterval 会晚几十秒才跳登录页。 */
  function bindWatchEvents() {
    if (watchBound) return;
    watchBound = true;
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) checkExpiry();
      });
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('focus', function () { checkExpiry(); });
    }
  }

  /* ---------- 装载用户 ---------- */

  function build(user) {
    var safe = global.RCAuthStore.safe(user);
    var eff = global.RCPerm.effective(user.role, user.perms);
    current = safe;
    perms = eff;
    // classScopes 为 null = 不限（全部班级），必须原样保留，不能 `|| []` 退化成「零个班」
    snapshot = { user: safe, permissions: eff, classScopes: safe.classScopes };
    return snapshot;
  }

  /**
   * 装载服务端返回的 /me 结构。
   * 服务端已经算好了 effective permissions（含角色默认值），这里不再二次叠加，
   * 否则本地默认值会把服务端「已收回的权限」又打开。
   * @param {{user:Object, permissions:Object, classScopes:Array}} payload
   */
  function buildRemote(payload) {
    if (!payload || !payload.user) {
      current = null; perms = {}; snapshot = null;
      return null;
    }
    var u = payload.user;
    // classScopes 为 null = 不限（全部班级）；数组 = 只能碰这些班；
    // 千万不要 `|| []`，那会把「不限」退化成「一个班都不能碰」，表现就是有权限却只读。
    var scopes = payload.classScopes === undefined ? null : payload.classScopes;
    current = {
      id: u.id,
      login: u.login,
      displayName: u.displayName,
      role: u.role,
      employeeNo: u.employeeNo || '',
      disabled: false,
      mustChange: !!u.mustChange,
      classScopes: scopes
    };
    perms = payload.permissions || {};
    snapshot = { user: current, permissions: perms, classScopes: scopes };
    /* 记录到期时刻并启动巡检：满 2 小时（或服务端给的 expiresAt 到点）自动回登录页 */
    applySessionMeta(payload, remoteMode ? ABS_MS : 0);
    return snapshot;
  }

  /**
   * 尝试用已保存的会话恢复登录态。
   * @returns {Object|null} me 结构，或 null 表示未登录
   */
  function restore() {
    /* 远程模式：会话是服务端下发的 HttpOnly Cookie，前端拿不到也读不了。
       能同步判断的只有适配器缓存里的 /me 副本，所以先按它恢复界面，
       再异步 refreshMe() 校验会话是否仍有效（Cookie 过期就退回登录页）。 */
    if (remoteMode) {
      var payload = global.RCData ? global.RCData.me() : null;
      if (!payload || !payload.user) return null;
      /* 先做一次到期判断：缓存里的会话可能早就过了 2 小时（比如隔夜开着的标签页） */
      var cachedExp = payload.session && payload.session.expiresAt ? Date.parse(payload.session.expiresAt) : NaN;
      if (isFinite(cachedExp) && cachedExp > 0 && cachedExp <= Date.now()) {
        pendingNotice = '登录已超过 2 小时，请重新登录';
        signOut();
        return null;
      }
      var snap = buildRemote(payload);
      if (!snap) return null;
      /* 记下代次：refreshMe() 回来时若用户已退出/重新登录，这次结果必须丢弃 */
      var myEpoch = epoch;
      if (global.RCData.refreshMe) {
        global.RCData.refreshMe().then(function (r) {
          if (epoch !== myEpoch) return;   // 期间已退出或换人登录，别把旧态装回去
          if (r && r.ok && r.me) buildRemote(r.me);
          else if (r && !r.ok && r.msg === '未登录') {
            /* 401 已经由 adapter-remote 的 request() 统一调过 expireNow()（那里会清态并回登录页）；
               这里只兜两种没走到回调的情况：冷启动时 current 已被清、或并发守卫跳过了。
               两种都走 RCLogin.signOut({expired:true})，保证提示文案不被后续的清空操作抹掉。 */
            if (isIn()) {
              expireNow('unauthorized');
            } else if (global.RCLogin && typeof global.RCLogin.signOut === 'function') {
              global.RCLogin.signOut({ expired: true, reason: 'unauthorized' });
            }
          }
        }).catch(function () { /* 网络异常时保留本地副本，不打断课堂 */ });
      }
      return snap;
    }

    var s = readSession();
    if (!s) return null;
    var u = global.RCAuthStore.byId(s.userId);
    if (!u || u.disabled) {
      signOut();
      return null;
    }
    /* 本地模式刷新后同样要恢复到期时刻并启动巡检，
       否则「刷新一下就永久不过期」，2 小时限制只在首次登录那个页面内有效。
       这里不能用 checkExpiry()：它要求 current 已装载，此刻还没 build。
       到期时刻取「登录时刻 + TTL」与「会话里记的 expire」中更早的那个。 */
    var hard = s.at ? s.at + TTL : 0;
    var exp = hard ? Math.min(s.expire || hard, hard) : (s.expire || 0);
    if (exp && exp <= Date.now()) {
      signOut();
      pendingNotice = '登录已超过 2 小时，请重新登录';
      return null;
    }

    expiresAtMs = exp;
    if (expiresAtMs) { bindWatchEvents(); startWatch(); }
    return build(u);
  }

  /**
   * 登录。
   * @returns {Promise<{ok:boolean, msg?:string, me?:Object}>}
   */
  function signIn(login, password) {
    /* 远程模式：身份由服务端裁决（scrypt 哈希在库里，前端不接触密码哈希）。
       失败计数也在服务端做（login_attempt 表 + 429），这里不重复计数。 */
    if (remoteMode) {
      if (!global.RCData || typeof global.RCData.login !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪，请刷新页面重试' });
      }
      epoch++;
      var res = global.RCData.login(login, password);
      if (!res) return Promise.resolve({ ok: false, msg: '当前模式不支持服务端登录' });
      return res.then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '登录失败' };
        var snap = buildRemote(r.me);
        if (!snap) return { ok: false, msg: '登录返回的数据不完整' };
        clearFail();
        return { ok: true, me: snap };
      });
    }

    var left = lockedFor();
    if (left > 0) {
      return Promise.resolve({ ok: false, msg: '尝试次数过多，请 ' + Math.ceil(left / 1000) + ' 秒后再试' });
    }

    var u = global.RCAuthStore.byLogin(login);
    if (!u) {
      noteFail();
      return Promise.resolve({ ok: false, msg: '登录名或密码不正确' });
    }
    if (u.disabled) {
      return Promise.resolve({ ok: false, msg: '该账号已被停用，请联系管理员' });
    }

    return global.RCCrypto.verify(password, u.pw).then(function (ok) {
      if (!ok) {
        var locked = noteFail();
        return { ok: false, msg: locked ? '尝试次数过多，请 5 分钟后再试' : '登录名或密码不正确' };
      }
      clearFail();
      var sd = writeSession(u.id);
      expiresAtMs = sd.expire;
      bindWatchEvents();
      startWatch();
      return { ok: true, me: build(u) };
    });
  }

  /**
   * 访客登录（只读）。
   *
   * 远程模式：服务端 POST /auth/guest 会复用/创建唯一的内置 viewer 账号并下发会话 Cookie。
   * 本机模式：auth-store 里复用/创建本地内置 viewer 账号（随机哈希 → 无法用密码登录）。
   * 两条路都不需要用户输入任何凭据。
   * @returns {Promise<{ok:boolean, msg?:string, me?:Object}>}
   */
  function signInAsGuest() {
    if (remoteMode) {
      if (!global.RCData || typeof global.RCData.guestLogin !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪，请刷新页面重试' });
      }
      epoch++;
      var res = global.RCData.guestLogin();
      if (!res) return Promise.resolve({ ok: false, msg: '当前模式不支持访客登录' });
      return res.then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '访客登录失败' };
        var snap = buildRemote(r.me);
        if (!snap) return { ok: false, msg: '登录返回的数据不完整' };
        clearFail();
        return { ok: true, me: snap };
      });
    }

    var g = global.RCAuthStore.ensureGuest();
    if (!g.ok) return Promise.resolve({ ok: false, msg: g.msg || '访客账号创建失败' });
    if (g.user.disabled) return Promise.resolve({ ok: false, msg: '访客账号已被停用，请联系管理员' });

    clearFail();
    var gd = writeSession(g.user.id);
    expiresAtMs = gd.expire;
    bindWatchEvents();
    startWatch();
    return Promise.resolve({ ok: true, me: build(g.user) });
  }

  /** 本地模式的「SSO」入口：由 IdentityProvider 实现，这里只留占位 */
  function signInWithProvider(providerId) {
    return Promise.resolve({
      ok: false,
      msg: '尚未配置教务单点登录（' + (providerId || 'sso') + '），请先用账号密码登录'
    });
  }

  function signOut() {
    epoch++;
    current = null;
    perms = {};
    snapshot = null;
    expiresAtMs = 0;
    stopWatch();
    try { global.localStorage.removeItem(KEY); } catch (e) {}
    /* 远程模式还要让服务端吊销会话并清 Cookie，否则下次打开还是登录态 */
    if (remoteMode && global.RCData && typeof global.RCData.logout === 'function') {
      try { global.RCData.logout(); } catch (e) {}
    }
  }

  /** 当前用户（未登录返回 null）。返回 {user, permissions, classScopes} */
  function me() {
    return snapshot;
  }

  /** 是否已登录 */
  function isIn() {
    return !!current;
  }

  /**
   * 权限判断。
   * 管理员与本地用户恒为 true（对应 perm.js 的默认值，这里不重复开洞）。
   */
  function can(key) {
    if (!current) return false;
    if (!key) return true;
    return !!perms[key];
  }

  /**
   * 任教班级（可写范围）：null 表示不限，数组表示只能改这些班。
   * 这是「能不能加分/扣分/撤销」的依据，与「能不能看」无关。
   */
  function classScopes() {
    if (!current) return [];
    if (current.role === 'admin' || current.role === 'local') return null;
    return current.classScopes === undefined ? [] : current.classScopes;
  }

  /**
   * 可查看班级（可读范围）：null 表示不限。
   * 有 class.view_all 的账号（含讲师默认）能看全部班级，但只有任教班级能改。
   */
  function viewScopes() {
    if (!current) return [];
    if (current.role === 'admin' || current.role === 'local') return null;
    if (perms['class.view_all']) return null;
    return current.classScopes === undefined ? [] : current.classScopes;
  }

  /** 某个班级是否可进入查看 */
  function canEnterClass(name) {
    var sc = viewScopes();
    if (sc === null) return true;
    return sc.indexOf(name) >= 0;
  }

  /** 某个班级是否可编辑（加减分、撤销、清空、删记录） */
  function canEditClass(name) {
    var sc = classScopes();
    if (sc === null) return true;
    return sc.indexOf(name) >= 0;
  }

  /** 修改自己的密码 */
  function changePassword(oldPw, newPw) {
    if (!current) return Promise.resolve({ ok: false, msg: '未登录' });

    /* 远程模式：原密码校验、策略校验、改后吊销其它会话都在服务端 */
    if (remoteMode) {
      if (!global.RCData || typeof global.RCData.request !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪' });
      }
      return global.RCData.request('POST', '/auth/password', { oldPassword: oldPw, newPassword: newPw })
        .then(function (r) {
          /* 服务端改密成功会回新的 /me（mustChange 已清），就地重装；
             同时刷一次适配器缓存 —— 登录页改完密会紧接着调 refresh()，
             而 refresh() 远程分支读的是适配器缓存，缓存不刷新就会把
             mustChange:true 的旧副本装回来，人又被弹回改密页。 */
          if (r && r.user) buildRemote(r);
          if (global.RCData && typeof global.RCData.refreshMe === 'function') {
            return global.RCData.refreshMe().then(function (rr) {
              if (rr && rr.ok && rr.me) buildRemote(rr.me);
              return { ok: true };
            }).catch(function () { return { ok: true }; });
          }
          return { ok: true };
        })
        .catch(function (e) {
          return { ok: false, msg: pickMsg(e, '修改失败') };
        });
    }

    var u = global.RCAuthStore.byId(current.id);
    if (!u) return Promise.resolve({ ok: false, msg: '账号不存在' });

    return global.RCCrypto.verify(oldPw, u.pw).then(function (ok) {
      if (!ok) return { ok: false, msg: '原密码不正确' };
      var chk = global.RCCrypto.checkPassword(newPw);
      if (!chk.ok) return { ok: false, msg: chk.msg };
      return global.RCCrypto.derive(newPw).then(function (pw) {
        var r = global.RCAuthStore.update(u.id, { pw: pw });
        if (!r.ok) return { ok: false, msg: r.msg };
        build(r.user);
        return { ok: true };
      });
    });
  }

  /** 管理员改别人密码（不需要原密码） */
  function resetPassword(userId, newPw) {
    if (!can('user.manage')) return Promise.resolve({ ok: false, msg: '没有权限' });
    /* 两种模式都走 RCUserStore：本机模式内部派生后写 localStorage，
       服务器模式转发 POST /users/:id/password 让服务端 scrypt 后入库。
       重置后一律要求对方下次登录改密。 */
    if (global.RCUserStore && typeof global.RCUserStore.resetPassword === 'function') {
      return global.RCUserStore.resetPassword(userId, newPw);
    }
    if (remoteMode) {
      return Promise.resolve({ ok: false, msg: '账号存储未就绪，请刷新页面后重试' });
    }
    var chk = global.RCCrypto.checkPassword(newPw);
    if (!chk.ok) return Promise.resolve({ ok: false, msg: chk.msg });
    return global.RCCrypto.derive(newPw).then(function (pw) {
      var r = global.RCAuthStore.update(userId, { pw: pw, mustChange: true });
      return r.ok ? { ok: true } : { ok: false, msg: r.msg };
    });
  }

  /** 账号被改动后刷新当前用户（改权限、改角色后调用） */
  function refresh() {
    if (!current) return null;
    if (remoteMode) {
      var payload = global.RCData ? global.RCData.me() : null;
      return payload && payload.user ? buildRemote(payload) : null;
    }
    var u = global.RCAuthStore.byId(current.id);
    if (!u || u.disabled) { signOut(); return null; }
    return build(u);
  }

  global.RCSession = {
    KEY: KEY,
    setMode: setMode,
    isRemote: isRemote,
    signIn: signIn,
    signInAsGuest: signInAsGuest,
    signInWithProvider: signInWithProvider,
    signOut: signOut,
    restore: restore,
    me: me,
    isIn: isIn,
    can: can,
    classScopes: classScopes,
    viewScopes: viewScopes,
    canEnterClass: canEnterClass,
    canEditClass: canEditClass,
    changePassword: changePassword,
    resetPassword: resetPassword,
    refresh: refresh,
    touch: touch,
    lockedFor: lockedFor,
    /* ---- 登录态 2 小时绝对过期 ---- */
    onExpire: onExpire,          // 注册过期回调（app.js 用来清界面状态）
    expireNow: expireNow,        // 立即判过期并回登录页（401 统一出口）
    checkExpiry: checkExpiry,    // 手动触发一次到期检查
    expiresAt: expiresAt,        // 到期时刻（毫秒），0=未知
    remainingMs: remainingMs,    // 距到期毫秒数，-1=未知
    takeNotice: takeNotice       // 取「会话已过期」提示文案（登录页显示一次）
  };
})(window);
