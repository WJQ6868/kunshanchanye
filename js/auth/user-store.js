/* ============================================================
   user-store.js —— 账号存储的统一入口（本机模式 / 服务器模式）
   ------------------------------------------------------------
   为什么需要这一层：
     人员管理界面（user-ui.js）本来直接调 RCAuthStore —— 那是纯同步的
     localStorage 读写。但服务器模式的账号在服务端数据库里，必须发 HTTP，
     必然是异步的。两种模式的调用形状差太远，界面代码没法共用。

     所以把差异收在这里：对外统一是 Promise + {ok, ...}，
     本机模式内部包一层 RCAuthStore（同步 → Promise.resolve），
     服务器模式内部转发到 RCData 的人员管理方法。

   密码的处理也不一样，这里是关键差异点：
     · 本机模式：明文密码必须先在浏览器里 PBKDF2 派生（RCCrypto.derive），
       存进 localStorage 的是 {algo,iter,salt,hash} 记录。
     · 服务器模式：明文密码直接发给服务端，由服务端 scrypt 派生后入库。
       前端**不**做派生，也不接触服务端的哈希。
     调用方永远只传明文，由本层决定怎么处理。

   两种模式的字段形状是一致的（对齐 auth-store.js 的 safe()）：
     {id, login, displayName, role, employeeNo, disabled, perms, classScopes,
      mustChange, createdAt, updatedAt, builtin?}
   ============================================================ */
(function (global) {
  'use strict';

  /** 新增/重置时留空用的默认密码（与 user-ui.js、服务端 routes/users.ts 一致） */
  var DEFAULT_PW = '123456';

  function isRemote() {
    return !!(global.RCSession && typeof global.RCSession.isRemote === 'function'
      && global.RCSession.isRemote());
  }

  /** 本机模式的账号需要先派生密码记录 */
  function deriveLocal(pw) {
    return global.RCCrypto.derive(pw);
  }

  /* -------------------- 读 -------------------- */

  /**
   * 把 RCAuthStore 返回的对象裁成对外的 DTO。
   * 两件事：
   *   1. add()/update() 返回的是存储里的原始记录，里面带着密码哈希（pw 字段），
   *      不能让它流到界面层 —— 削掉，和 list() 走 safe() 的结果保持一致。
   *   2. 补一个 builtin 标记，和服务器模式对齐：内置最高管理员
   *      （wjqcool / u_default_admin）不允许停用或删除，界面据此隐藏按钮。
   */
  function stripLocal(u) {
    if (!u) return u;
    var out = {};
    Object.keys(u).forEach(function (k) { if (k !== 'pw') out[k] = u[k]; });
    if (out.builtin == null) out.builtin = isBuiltinLocal(u);
    return out;
  }

  /** 本机模式的内置最高管理员判定（与 auth-store.js 的 DEFAULT_ADMIN 一致） */
  function isBuiltinLocal(u) {
    if (!u) return false;
    if (u.id === 'u_default_admin') return true;
    var da = global.RCAuthStore && global.RCAuthStore.DEFAULT_ADMIN;
    return !!(da && String(u.login || '').toLowerCase() === da.login);
  }

  /**
   * 列出全部账号。
   * @returns {Promise<{ok:boolean, list?:Array, msg?:string}>}
   */
  function list() {
    if (isRemote()) {
      if (!global.RCData || typeof global.RCData.listUsers !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪' });
      }
      return global.RCData.listUsers().then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '读取失败' };
        return { ok: true, list: r.list || [] };
      });
    }

    try {
      var all = global.RCAuthStore.list() || [];
      return Promise.resolve({ ok: true, list: all.map(stripLocal) });
    } catch (e) {
      return Promise.resolve({ ok: false, msg: '读取本机账号失败：' + ((e && e.message) || e) });
    }
  }

  /* -------------------- 新增 -------------------- */

  /**
   * @param {{login:string, displayName:string, role:string, employeeNo?:string,
   *          password?:string, perms?:Object, classScopes?:Array|null}} input
   * @returns {Promise<{ok:boolean, user?:Object, msg?:string}>}
   */
  function create(input) {
    var p = input || {};
    var password = p.password || DEFAULT_PW;

    // 两种模式都要先过前端这道策略检查（服务端还会再查一遍，本机模式只有这一道）
    var chk = global.RCCrypto.checkPassword(password);
    if (!chk.ok) return Promise.resolve({ ok: false, msg: chk.msg });

    if (isRemote()) {
      if (!global.RCData || typeof global.RCData.createUser !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪' });
      }
      return global.RCData.createUser({
        login: p.login,
        displayName: p.displayName,
        role: p.role,
        employeeNo: p.employeeNo || '',
        password: password,
        perms: p.perms || {},
        classScopes: p.classScopes || null
      }).then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '新增失败' };
        return { ok: true, user: r.user };
      });
    }

    return deriveLocal(password).then(function (pwRec) {
      var r = global.RCAuthStore.add({
        login: p.login,
        displayName: p.displayName,
        role: p.role,
        employeeNo: p.employeeNo || '',
        pw: pwRec,
        perms: p.perms || {},
        classScopes: p.classScopes || null,
        mustChange: true
      });
      if (!r.ok) return { ok: false, msg: r.msg };
      return { ok: true, user: stripLocal(r.user) };
    }).catch(function (e) {
      return { ok: false, msg: '密码处理失败：' + ((e && e.message) || e) };
    });
  }

  /* -------------------- 修改 -------------------- */

  /**
   * 改资料 / 角色 / 工号 / 权限 / 任教班级 / 启停用。
   * 登录名不可改（两种模式一致：历史记录要能对上人）。
   * @returns {Promise<{ok:boolean, user?:Object, msg?:string}>}
   */
  function update(id, patch) {
    var p = patch || {};

    if (isRemote()) {
      if (!global.RCData || typeof global.RCData.updateUser !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪' });
      }
      var body = {};
      if (p.displayName != null) body.displayName = p.displayName;
      if (p.role != null) body.role = p.role;
      if (p.employeeNo != null) body.employeeNo = p.employeeNo;
      if (p.perms != null) body.perms = p.perms;
      if (p.classScopes !== undefined) body.classScopes = p.classScopes;
      if (p.disabled != null) body.disabled = !!p.disabled;
      if (p.mustChange != null) body.mustChange = !!p.mustChange;

      return global.RCData.updateUser(id, body).then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '保存失败' };
        return { ok: true, user: r.user };
      });
    }

    var r = global.RCAuthStore.update(id, p);
    return Promise.resolve(r.ok ? { ok: true, user: stripLocal(r.user) } : { ok: false, msg: r.msg });
  }

  /* -------------------- 删除 -------------------- */

  function remove(id) {
    if (isRemote()) {
      if (!global.RCData || typeof global.RCData.removeUser !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪' });
      }
      return global.RCData.removeUser(id).then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '删除失败' };
        return { ok: true };
      });
    }

    var r = global.RCAuthStore.remove(id);
    return Promise.resolve(r.ok ? { ok: true } : { ok: false, msg: r.msg });
  }

  /* -------------------- 重置密码 -------------------- */

  /**
   * 管理员重置他人密码（不需要原密码）。
   * 重置后一律要求对方下次登录改密。
   */
  function resetPassword(id, newPassword) {
    var password = newPassword || DEFAULT_PW;

    var chk = global.RCCrypto.checkPassword(password);
    if (!chk.ok) return Promise.resolve({ ok: false, msg: chk.msg });

    if (isRemote()) {
      if (!global.RCData || typeof global.RCData.resetUserPassword !== 'function') {
        return Promise.resolve({ ok: false, msg: '数据适配器未就绪' });
      }
      return global.RCData.resetUserPassword(id, password).then(function (r) {
        if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '重置失败' };
        return { ok: true };
      });
    }

    return deriveLocal(password).then(function (pwRec) {
      var r = global.RCAuthStore.update(id, { pw: pwRec, mustChange: true });
      return r.ok ? { ok: true } : { ok: false, msg: r.msg };
    }).catch(function (e) {
      return { ok: false, msg: '密码处理失败：' + ((e && e.message) || e) };
    });
  }

  global.RCUserStore = {
    DEFAULT_PW: DEFAULT_PW,
    isRemote: isRemote,
    list: list,
    create: create,
    update: update,
    remove: remove,
    resetPassword: resetPassword
  };
})(window);
