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
  var TTL = 12 * 60 * 60 * 1000;   // 12 小时无操作自动失效
  var MAX_FAIL = 5;                 // 连续失败次数上限
  var LOCK_MS = 5 * 60 * 1000;      // 锁定时长

  var current = null;   // 当前用户（扁平 safe 副本，供内部判断）
  var perms = {};       // 有效权限表
  var snapshot = null;  // 对外的 me() 返回值：{user, permissions, classScopes}
  var failKey = 'rollcall.loginfail.v1';

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

  /* ---------- 会话持久化 ---------- */

  function readSession() {
    try {
      var d = JSON.parse(global.localStorage.getItem(KEY) || 'null');
      if (!d || !d.userId) return null;
      if (d.expire && d.expire < Date.now()) return null;
      return d;
    } catch (e) { return null; }
  }

  function writeSession(userId) {
    var d = { userId: userId, expire: Date.now() + TTL, at: Date.now() };
    try { global.localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {}
    return d;
  }

  function touch() {
    /* 远程模式的续期由服务端在每次请求时滑动刷新，前端不需要写本地会话 */
    if (remoteMode) return;
    var d = readSession();
    if (d) writeSession(d.userId);
  }

  /* ---------- 装载用户 ---------- */

  function build(user) {
    var safe = global.RCAuthStore.safe(user);
    var eff = global.RCPerm.effective(user.role, user.perms);
    current = safe;
    perms = eff;
    snapshot = { user: safe, permissions: eff, classScopes: user.classScopes || [] };
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
    current = {
      id: u.id,
      login: u.login,
      displayName: u.displayName,
      role: u.role,
      employeeNo: u.employeeNo || '',
      disabled: false,
      mustChange: !!u.mustChange,
      classScopes: payload.classScopes || []
    };
    perms = payload.permissions || {};
    snapshot = { user: current, permissions: perms, classScopes: payload.classScopes || [] };
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
      var snap = buildRemote(payload);
      if (!snap) return null;
      if (global.RCData.refreshMe) {
        global.RCData.refreshMe().then(function (r) {
          if (r && r.ok && r.me) buildRemote(r.me);
          else if (r && !r.ok && r.msg === '未登录') {
            signOut();
            if (global.RCLogin && global.RCLogin.signOut) global.RCLogin.signOut();
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
      writeSession(u.id);
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
    writeSession(g.user.id);
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
    current = null;
    perms = {};
    snapshot = null;
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
    return current.classScopes || [];
  }

  /**
   * 可查看班级（可读范围）：null 表示不限。
   * 有 class.view_all 的账号（含讲师默认）能看全部班级，但只有任教班级能改。
   */
  function viewScopes() {
    if (!current) return [];
    if (current.role === 'admin' || current.role === 'local') return null;
    if (perms['class.view_all']) return null;
    return current.classScopes || [];
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
        .then(function () { return { ok: true }; })
        .catch(function (e) {
          return { ok: false, msg: (e && e.message) ? String(e.message).replace(/^HTTP \d+ /, '') : '修改失败' };
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
    /* 远程模式账号存在服务端，P4 人员管理接口尚未提供，先如实拒绝，
       不要假装成功——否则管理员以为改好了，实际学生还能用旧密码登录。 */
    if (remoteMode) {
      return Promise.resolve({ ok: false, msg: '服务器模式下重置密码功能尚未开放，请用该账号自助修改' });
    }
    var chk = global.RCCrypto.checkPassword(newPw);
    if (!chk.ok) return Promise.resolve({ ok: false, msg: chk.msg });
    return global.RCCrypto.derive(newPw).then(function (pw) {
      var r = global.RCAuthStore.update(userId, { pw: pw });
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
    lockedFor: lockedFor
  };
})(window);
