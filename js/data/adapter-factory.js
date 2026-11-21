/* ============================================================
   adapter-factory.js + RCData 门面
   ------------------------------------------------------------
   门面（Facade）对外暴露的方法名与旧 RCStorage 完全一致，
   因此 app.js 只需把 RCStorage. 换成 RCData. 即可切换数据源，
   不产生第二套业务代码。

   模式判定（见 docs/项目计划书 §10.7）：
     file: 协议                → 本地模式（离线双击打开，永不发请求）
     ?offline=1 / ?local=1     → 强制本地模式
     ?remote=1                 → 强制远程模式（调试用）
     http(s):                  → 先探活 GET /healthz
                                 成功 → 远程模式
                                 失败 → 本地模式（并提示）
   ============================================================ */
(function (global) {
  'use strict';

  var C = global.RCDataContract;
  var validate = C.validate;

  var HEALTH_TIMEOUT = 2500;

  /* ---------- 探活 ---------- */

  function probeHealth(baseUrl) {
    var url = (baseUrl || '/api/v1').replace(/\/+$/, '') + '/healthz';
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(false); }
      }, HEALTH_TIMEOUT);
      try {
        fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' })
          .then(function (res) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(res.ok);
          })
          .catch(function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(false);
          });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve(false); }
      }
    });
  }

  /* ---------- 读取 URL 参数 ---------- */

  function param(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  /* ---------- 门面 ---------- */

  var adapter = null;
  var mode = 'local';
  var readyFired = false;
  var readyCbs = [];
  var changeCbs = [];
  var initPromise = null;

  function assertReady() {
    if (!adapter) {
      throw new Error('[RCData] 适配器尚未初始化，请先调用 RCData.init()');
    }
  }

  function fireReady(info) {
    if (readyFired) return;
    readyFired = true;
    readyCbs.forEach(function (cb) {
      try { cb(info); } catch (e) { console.warn('[RCData] ready listener failed', e); }
    });
    readyCbs.length = 0;
  }

  function fireChange(info) {
    changeCbs.forEach(function (cb) {
      try { cb(info); } catch (e) { console.warn('[RCData] change listener failed', e); }
    });
  }

  function useAdapter(next, info) {
    if (adapter === next) return;
    if (adapter && typeof adapter.dispose === 'function') adapter.dispose();
    adapter = next;
    mode = next.mode;
    fireChange(info || { mode: mode });
  }

  var RCData = {
    /** 当前模式：'local' | 'remote' */
    get mode() { return mode; },

    /** 是否已初始化完成 */
    isReady: function () { return readyFired; },

    /**
     * 初始化数据源。
     * @param {Object} opts { baseUrl, forceMode: 'local'|'remote' }
     * @returns {Promise<{mode, reason, offline?}>}
     */
    init: function (opts) {
      if (initPromise) return initPromise;
      opts = opts || {};

      var baseUrl = opts.baseUrl || '/api/v1';
      var forced = opts.forceMode || param('mode') || '';
      var isFile = false;
      try { isFile = global.location.protocol === 'file:'; } catch (e) { isFile = true; }

      var decide;
      if (forced === 'local' || forced === 'offline' || param('offline') === '1' || param('local') === '1') {
        decide = Promise.resolve({ mode: 'local', reason: '按参数强制本地模式' });
      } else if (forced === 'remote' || param('remote') === '1') {
        decide = Promise.resolve({ mode: 'remote', reason: '按参数强制远程模式' });
      } else if (isFile) {
        decide = Promise.resolve({ mode: 'local', reason: 'file:// 打开，使用本地模式（数据仅在本机）' });
      } else {
        decide = probeHealth(baseUrl).then(function (ok) {
          return ok
            ? { mode: 'remote', reason: '已连接服务端' }
            : { mode: 'local', reason: '服务端不可用，已回退本地模式（数据仅在本机）' };
        });
      }

      initPromise = decide.then(function (d) {
        var next;
        if (d.mode === 'remote') {
          next = validate('remote', global.RCDataRemote.create({ baseUrl: baseUrl }));
        } else {
          next = validate('local', global.RCDataLocal.create());
        }
        useAdapter(next, d);
        return next.init(opts).then(function (r) {
          // 判定原因优先于适配器自述（「服务端不可用，已回退本地模式」比「localStorage 本地模式」更有信息量）
          var reason = d.reason || (r && r.reason) || '';
          if (d.mode === 'remote' && r && r.offline) {
            reason = (r && r.reason) || '服务端不可用，已进入离线模式';
          }
          var info = {
            mode: mode,
            reason: reason,
            offline: !!(r && r.offline) || mode === 'local'
          };
          fireReady(info);
          return info;
        });
      }).catch(function (err) {
        // 初始化失败也要能上课：强制本地模式兜底
        console.warn('[RCData] 初始化失败，回退本地模式', err);
        var fallback = validate('local', global.RCDataLocal.create());
        useAdapter(fallback, { mode: 'local', reason: '初始化异常，已回退本地模式' });
        return fallback.init({}).then(function () {
          var info = { mode: 'local', reason: '初始化异常，已回退本地模式', offline: true, error: String(err && err.message || err) };
          fireReady(info);
          return info;
        });
      });

      return initPromise;
    },

    /** 初始化完成后回调（若已完成则立即异步触发） */
    ready: function (cb) {
      if (typeof cb !== 'function') return;
      if (readyFired) { setTimeout(function () { cb({ mode: mode }); }, 0); return; }
      readyCbs.push(cb);
    },

    /** 模式变化订阅 */
    onChange: function (cb) {
      if (typeof cb === 'function') changeCbs.push(cb);
    },

    /** 当前用户与权限（本地模式返回本机用户） */
    me: function () { assertReady(); return adapter.me(); },

    /* ---------- 认证（远程模式由服务端裁决；本地模式返回 null 表示不适用） ---------- */

    /**
     * 账号密码登录。
     * 本地模式返回 null，由 RCSession 走本地 PBKDF2 校验；
     * 远程模式转调适配器的 /auth/login。
     * @returns {Promise<{ok,msg?,me?}>|null}
     */
    login: function (loginName, password) {
      assertReady();
      if (typeof adapter.login !== 'function') return null;
      return adapter.login(loginName, password);
    },

    guestLogin: function () {
      assertReady();
      if (typeof adapter.guestLogin !== 'function') return Promise.resolve({ ok: false, msg: '本机模式不需要访客登录' });
      return adapter.guestLogin();
    },

    logout: function () {
      assertReady();
      if (typeof adapter.logout !== 'function') return Promise.resolve({ ok: true });
      return adapter.logout();
    },

    refreshMe: function () {
      assertReady();
      if (typeof adapter.refreshMe !== 'function') return Promise.resolve({ ok: false, msg: '本地模式无服务端会话' });
      return adapter.refreshMe();
    },

    /**
     * 透传到当前适配器的 request(method, path, body)。
     *
     * 为什么需要它：远程适配器内部有一个带 CSRF/credentials 的通用 request，
     * 但它是闭包私有方法。RCSession.changePassword 之类「只发一个自定义请求、
     * 不值得为它在适配器里另开一个具名方法」的场景，需要门面把这条路让出来。
     * 本机模式没有网络层，如实返回失败而不是假装成功。
     * @returns {Promise<any>}
     */
    request: function (method, path, body, extraHeaders) {
      assertReady();
      if (!adapter || typeof adapter.request !== 'function') {
        return Promise.reject(new Error('本机模式没有服务端请求通道'));
      }
      return adapter.request(method, path, body, extraHeaders);
    },

    /* ---------- 教务对接（仅服务器模式） ---------- */

    eduStatus: function () {
      if (!adapter || typeof adapter.eduStatus !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式没有教务对接' });
      }
      return adapter.eduStatus();
    },

    eduSync: function () {
      if (!adapter || typeof adapter.eduSync !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式没有教务对接' });
      }
      return adapter.eduSync();
    },

    /* ---------- 人员管理（仅服务器模式；本地模式由 user-store 走 RCAuthStore） ---------- */

    listUsers: function () {
      if (!adapter || typeof adapter.listUsers !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式请用 RCAuthStore' });
      }
      return adapter.listUsers();
    },

    createUser: function (input) {
      if (!adapter || typeof adapter.createUser !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式请用 RCAuthStore' });
      }
      return adapter.createUser(input);
    },

    updateUser: function (id, patch) {
      if (!adapter || typeof adapter.updateUser !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式请用 RCAuthStore' });
      }
      return adapter.updateUser(id, patch);
    },

    removeUser: function (id) {
      if (!adapter || typeof adapter.removeUser !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式请用 RCAuthStore' });
      }
      return adapter.removeUser(id);
    },

    resetUserPassword: function (id, newPassword) {
      if (!adapter || typeof adapter.resetUserPassword !== 'function') {
        return Promise.resolve({ ok: false, msg: '本机模式请用 RCAuthStore' });
      }
      return adapter.resetUserPassword(id, newPassword);
    },

    /**
     * 从服务端重拉班级与名单（覆盖内存缓存）。
     * 本地模式无服务端，直接返回 ok —— 调用方本来就在本地读写。
     */
    reload: function () {
      assertReady();
      if (!adapter || typeof adapter.reload !== 'function') return Promise.resolve({ ok: true });
      return adapter.reload();
    },

    /* ---------- 与旧 RCStorage 同名同签名的读接口 ---------- */

    loadRoster: function () { assertReady(); return adapter.getRoster(); },
    loadClasses: function () { assertReady(); return adapter.getClasses(); },
    loadScores: function (cls) { assertReady(); return adapter.getScores(cls); },
    loadSettings: function () { assertReady(); return adapter.getSettings(); },
    loadState: function () { assertReady(); return adapter.getState(); },
    loadHistory: function () { assertReady(); return adapter.getHistory(); },
    listScoreClasses: function () { assertReady(); return adapter.listScoreClasses(); },
    /**
     * 从服务端拉某班加分记录进缓存（远程模式）。
     * 本机模式数据本来就在本地，直接返回当前记录即可。
     */
    loadScoresFor: function (cls) {
      assertReady();
      if (typeof adapter.loadScoresFor === 'function') return adapter.loadScoresFor(cls);
      return Promise.resolve({ ok: true, records: adapter.getScores(cls).records });
    },

    /* ---------- 写接口 ---------- */

    saveRoster: function (list, opt) { assertReady(); return adapter.setRoster(list, opt); },
    saveClasses: function (c, opt) { assertReady(); return adapter.setClasses(c, opt); },
    saveScores: function (cls, recs, opt) { assertReady(); return adapter.setScores(cls, recs, opt); },
    saveSettings: function (s) { assertReady(); return adapter.setSettings(s); },
    saveState: function (s) { assertReady(); return adapter.setState(s); },
    saveHistory: function (list) { assertReady(); return adapter.setHistory(list); },
    removeScores: function (cls) { assertReady(); return adapter.removeScores(cls); },
    wipe: function () { assertReady(); return adapter.wipe(); },

    /* ---------- 离线队列 ---------- */

    flush: function () {
      if (!adapter || typeof adapter.flush !== 'function') return Promise.resolve({ sent: 0, failed: 0, pending: 0 });
      return adapter.flush();
    },
    queueSize: function () {
      if (!adapter || typeof adapter.queueSize !== 'function') return 0;
      return adapter.queueSize();
    },

    /** 调试用：拿到真实适配器对象 */
    _adapter: function () { return adapter; }
  };

  global.RCData = RCData;
})(window);
