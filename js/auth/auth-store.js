/* ============================================================
   auth-store.js —— 本机账号存储
   ------------------------------------------------------------
   本地模式下的「用户表」，落在 localStorage 的 rollcall.users.v1。
   服务端版本上线后这张表会被 app_user 取代，但字段名保持一致，
   迁移时一一对应，不返工。

   关键约束：
   - 只存 password_hash（PBKDF2 派生），不存明文，也不存可逆加密。
   - 用户名唯一且不区分大小写；登录名不参与任何展示（展示用 displayName）。
   - 首次使用时自动创建管理员账号（见 ensureDefaultAdmin）。
   - 至少保留 1 个启用状态的管理员，不允许把最后一个管理员删掉或降级。
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'rollcall.users.v1';
  var MAX_NAME = 20;
  var GUEST_LOGIN = 'guest';
  var GUEST_DISPLAY_NAME = '访客';

  function read() {
    try {
      var raw = global.localStorage.getItem(KEY);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || typeof d !== 'object') return { list: [], seeded: false };
      if (!Array.isArray(d.list)) d.list = [];
      return d;
    } catch (e) {
      return { list: [], seeded: false };
    }
  }

  function write(d) {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(d));
      return true;
    } catch (e) {
      return false;
    }
  }

  function normLogin(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }

  function normName(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  /** 字节数组 → base64（访客账号造随机哈希用，不引入额外依赖） */
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }

  /** 全部账号（含已禁用的；调用方自己过滤） */
  function list() {
    return read().list;
  }

  function byLogin(login) {
    var k = normLogin(login);
    var found = null;
    list().forEach(function (u) {
      if (!found && normLogin(u.login) === k) found = u;
    });
    return found;
  }

  function byId(id) {
    var found = null;
    list().forEach(function (u) {
      if (!found && u.id === id) found = u;
    });
    return found;
  }

  function adminCount() {
    return list().filter(function (u) {
      return u.role === 'admin' && !u.disabled;
    }).length;
  }

  /**
   * 新增账号。密码已由调用方派生好（{algo,iter,salt,hash}）。
   * @returns {{ok:boolean, msg?:string, user?:Object}}
   */
  function add(input) {
    var d = read();
    var login = normLogin(input.login);
    var name = normName(input.displayName);

    if (!/^[a-z0-9_.-]{3,24}$/.test(login)) {
      return { ok: false, msg: '登录名 3–24 位，只能用字母、数字、下划线、点、短横' };
    }
    if (!name) return { ok: false, msg: '请填写姓名' };
    if (!input.pw || !input.pw.hash) return { ok: false, msg: '密码未设置' };
    if (byLogin(login)) return { ok: false, msg: '登录名「' + login + '」已存在' };

    var user = {
      id: input.id || global.RCCrypto.randomId('u_'),
      login: login,
      displayName: name,
      role: input.role === 'admin' || input.role === 'viewer' ? input.role : 'teacher',
      employeeNo: String(input.employeeNo || '').trim(),
      disabled: !!input.disabled,
      pw: input.pw,
      perms: input.perms && typeof input.perms === 'object' ? input.perms : {},
      classScopes: Array.isArray(input.classScopes) ? input.classScopes.slice() : null,
      mustChange: !!input.mustChange,
      createdAt: input.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    d.list.push(user);
    if (!write(d)) return { ok: false, msg: '写入本机存储失败（可能空间已满或浏览器禁用存储）' };
    return { ok: true, user: user };
  }

  /**
   * 修改账号。不允许把最后一个启用的管理员降级或禁用。
   * @returns {{ok:boolean, msg?:string, user?:Object}}
   */
  function update(id, patch) {
    var d = read();
    var idx = -1;
    for (var i = 0; i < d.list.length; i++) {
      if (d.list[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, msg: '账号不存在' };
    var u = d.list[idx];

    // 最后一个管理员的保护
    var willLoseAdmin = (patch.role && patch.role !== 'admin') || patch.disabled === true;
    if (u.role === 'admin' && !u.disabled && willLoseAdmin && adminCount() <= 1) {
      return { ok: false, msg: '至少保留一个启用的管理员' };
    }

    if (patch.login != null) {
      var login = normLogin(patch.login);
      if (!/^[a-z0-9_.-]{3,24}$/.test(login)) {
        return { ok: false, msg: '登录名 3–24 位，只能用字母、数字、下划线、点、短横' };
      }
      var dup = byLogin(login);
      if (dup && dup.id !== id) return { ok: false, msg: '登录名「' + login + '」已存在' };
      u.login = login;
    }
    if (patch.displayName != null) {
      var name = normName(patch.displayName);
      if (!name) return { ok: false, msg: '请填写姓名' };
      u.displayName = name;
    }
    if (patch.role != null) u.role = patch.role;
    if (patch.employeeNo != null) u.employeeNo = String(patch.employeeNo).trim();
    if (patch.disabled != null) u.disabled = !!patch.disabled;
    if (patch.pw != null) u.pw = patch.pw;
    if (patch.perms != null) u.perms = patch.perms;
    if (patch.classScopes !== undefined) u.classScopes = patch.classScopes;
    if (patch.mustChange != null) u.mustChange = !!patch.mustChange;
    u.updatedAt = Date.now();

    if (!write(d)) return { ok: false, msg: '写入本机存储失败' };
    return { ok: true, user: u };
  }

  /** 删除账号（同样保护最后一个管理员） */
  function remove(id) {
    var d = read();
    var u = null;
    var rest = [];
    d.list.forEach(function (x) {
      if (x.id === id) u = x;
      else rest.push(x);
    });
    if (!u) return { ok: false, msg: '账号不存在' };
    if (u.role === 'admin' && !u.disabled && adminCount() <= 1) {
      return { ok: false, msg: '至少保留一个启用的管理员' };
    }
    d.list = rest;
    if (!write(d)) return { ok: false, msg: '写入本机存储失败' };
    return { ok: true };
  }

  /**
   * 首次使用：没有账号时创建一个管理员。
   * 登录名 admin，密码留空由登录页「首次设置」引导用户填写，
   * 而不是硬编码一个默认密码（硬编码密码是典型安全隐患）。
   * @returns {boolean} 是否执行了初始化
   */
  function needsSeed() {
    var d = read();
    return !d.seeded && d.list.length === 0;
  }

  function markSeeded() {
    var d = read();
    d.seeded = true;
    write(d);
  }

  /* ------------------------------------------------------------
     内置默认最高管理员
     ------------------------------------------------------------
     系统内置唯一最高管理员：登录名 wjqcool，姓名「深之一」。
     这里只保存 PBKDF2 派生结果（algo/iter/salt/hash），
     不保存明文密码，也不在前端任何地方出现明文。
     与服务端 seed.ts 里的同一个账号对应（服务端用 scrypt 存储）。
     ------------------------------------------------------------ */
  var DEFAULT_ADMIN = {
    login: 'wjqcool',
    displayName: '深之一',
    role: 'admin',
    employeeNo: '',
    mustChange: false,
    // PBKDF2-HMAC-SHA256, iter=20000, 32 字节输出（纯 JS 档位，http 下也能验）
    pw: {
      algo: 'pbkdf2-sha256-js',
      iter: 20000,
      salt: 'HCMDaSBGTCX6SvR27fAzHw==',
      hash: 'MiW5FCktR1x15p9Psp8szdZ2MidaAnzZeQUKCxUjtgM='
    }
  };

  /**
   * 确保内置管理员存在（幂等）。
   * 已被用户改名/改密时不覆盖——只在「该登录名不存在」时补建，
   * 否则每次刷新都会把管理员密码重置回默认值。
   * @returns {{ok:boolean, created:boolean, msg?:string, user?:Object}}
   */
  function ensureDefaultAdmin() {
    var d = read();
    var exists = null;
    d.list.forEach(function (u) {
      if (!exists && normLogin(u.login) === DEFAULT_ADMIN.login) exists = u;
    });
    if (exists) {
      if (!d.seeded) { d.seeded = true; write(d); }
      return { ok: true, created: false, user: exists };
    }

    var user = {
      id: 'u_default_admin',
      login: DEFAULT_ADMIN.login,
      displayName: DEFAULT_ADMIN.displayName,
      role: DEFAULT_ADMIN.role,
      employeeNo: DEFAULT_ADMIN.employeeNo,
      disabled: false,
      pw: DEFAULT_ADMIN.pw,
      perms: {},
      classScopes: null,
      mustChange: DEFAULT_ADMIN.mustChange,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    d.list.push(user);
    d.seeded = true;
    if (!write(d)) return { ok: false, created: false, msg: '写入本机存储失败' };
    return { ok: true, created: true, user: user };
  }

  function createFirstAdmin(pw, displayName, login) {
    if (!needsSeed()) return { ok: false, msg: '已经初始化过了' };
    var r = add({
      login: normLogin(login) || 'admin',
      displayName: displayName || '管理员',
      role: 'admin',
      pw: pw
    });
    if (r.ok) markSeeded();
    return r;
  }

  /* ---------- 内置访客账号（只读，本机模式） ---------- */

  /**
   * 确保内置访客账号存在（幂等）。
   *
   * 为什么要专门造一个账号、而不是直接拼一个 viewer 快照：
   *   RCSession 的会话恢复是「按 userId 回查用户」，直接拼快照的话
   *   刷新页面就丢会话。写进 store 才能像正常账号一样被 restore() 找回。
   *
   * 为什么密码哈希是随机的：访客本来就不该能用密码登录。给一个谁都算不出来的
   * 随机哈希，RCCrypto.verify 必然返回 false，等价于「无密码但记录完整」。
   */
  function ensureGuest() {
    var d = read();
    var exists = null;
    d.list.forEach(function (u) {
      if (!exists && normLogin(u.login) === GUEST_LOGIN) exists = u;
    });
    if (exists) return { ok: true, created: false, user: exists };

    /* 随机盐 + 随机哈希：谁都算不出来 → verify 恒假 → 无法用密码登录 */
    var saltBytes = global.RCCrypto.randomBytes(16);
    var fakeBytes = global.RCCrypto.randomBytes(32);
    var user = {
      id: 'u_guest',
      login: GUEST_LOGIN,
      displayName: GUEST_DISPLAY_NAME,
      role: 'viewer',
      employeeNo: '',
      disabled: false,
      pw: { algo: 'pbkdf2-sha256-js', iter: 20000, salt: toB64(saltBytes), hash: toB64(fakeBytes) },
      perms: {},
      classScopes: null,
      mustChange: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    d.list.push(user);
    if (!write(d)) return { ok: false, created: false, msg: '写入本机存储失败' };
    return { ok: true, created: true, user: user };
  }

  /** 对外展示用的安全副本（去掉密码哈希） */
  function safe(u) {
    if (!u) return null;
    return {
      id: u.id,
      login: u.login,
      displayName: u.displayName,
      role: u.role,
      employeeNo: u.employeeNo,
      disabled: !!u.disabled,
      perms: u.perms || {},
      classScopes: u.classScopes,
      mustChange: !!u.mustChange,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt
    };
  }

  global.RCAuthStore = {
    KEY: KEY,
    list: list,
    safe: safe,
    byLogin: byLogin,
    byId: byId,
    add: add,
    update: update,
    remove: remove,
    adminCount: adminCount,
    needsSeed: needsSeed,
    createFirstAdmin: createFirstAdmin,
    ensureDefaultAdmin: ensureDefaultAdmin,
    ensureGuest: ensureGuest,
    GUEST_LOGIN: GUEST_LOGIN,
    DEFAULT_ADMIN: DEFAULT_ADMIN,
    normLogin: normLogin,
    normName: normName
  };
})(window);
