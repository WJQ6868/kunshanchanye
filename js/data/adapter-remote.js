/* ============================================================
   adapter-remote.js — 远程模式适配器（服务端 API）
   ------------------------------------------------------------
   与本地适配器的差别：
   · 数据真源在服务端，本地只做「内存缓存 + 持久缓存」
   · 写操作先写缓存并立即返回（课堂不能等网络），
     同时入「待同步队列」；网络恢复后按序补传，服务端靠
     Idempotency-Key 去重（见 docs/项目计划书 §7、§9.6）
   · 失败不静默丢：队列持久化在 localStorage，刷新页面仍在

   端点约定（与计划书 §7 一一对应）：
     GET  /api/v1/me
     GET  /api/v1/classes
     GET  /api/v1/classes/{id}/students
     GET  /api/v1/classes/{id}/scores
     GET  /api/v1/settings            （个人偏好，服务端可选存）
     GET  /api/v1/state
     GET  /api/v1/history
     POST /api/v1/classes/{id}/scores （批量加分，核心）
     POST /api/v1/scores/{id}/revoke
     PUT  /api/v1/classes/{id}/students
     ...
   注意：P1 阶段只保证「结构可用 + 离线不丢」，具体端点
   在 P2/P3 落地后逐条对齐，未实现的端点会走降级分支。
   ============================================================ */
(function (global) {
  'use strict';

  var C = global.RCDataContract;
  var clone = C.clone;
  var newRequestId = C.newRequestId;

  var QUEUE_KEY = 'rollcall.queue.v1';
  var CACHE_KEY = 'rollcall.cache.v1';
  var QUEUE_MAX = 2000;

  function createRemoteAdapter(opts) {
    opts = opts || {};
    var base = (opts.baseUrl || '/api/v1').replace(/\/+$/, '');
    var cache = {
      me: null,
      roster: null,
      classes: null,
      scores: Object.create(null),
      settings: null,
      state: null,
      history: null
    };
    var listeners = [];
    var online = true;
    var flushing = false;

    function emit(evt) {
      listeners.forEach(function (cb) {
        try { cb(evt); } catch (e) { console.warn('[RCData.remote] listener failed', e); }
      });
    }

    /* ---------- CSRF：双提交，从 cookie 读 ---------- */

    function readCookie(name) {
      try {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
      } catch (e) { return ''; }
    }

    /* ---------- 底层请求 ---------- */

    function request(method, path, body, extraHeaders) {
      var headers = { 'Accept': 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      var csrf = readCookie('rc_csrf');
      if (csrf && method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf;
      if (extraHeaders) {
        Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
      }
      var init = {
        method: method,
        headers: headers,
        credentials: 'include',
        cache: 'no-store'
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      return fetch(base + path, init).then(function (res) {
        if (res.status === 401) {
          var e401 = new Error('UNAUTHORIZED');
          e401.status = 401;
          throw e401;
        }
        if (!res.ok) {
          return res.text().then(function (t) {
            var err = new Error('HTTP ' + res.status + ' ' + (t || '').slice(0, 200));
            err.status = res.status;
            throw err;
          });
        }
        if (res.status === 204) return null;
        return res.json().catch(function () { return null; });
      });
    }

    /* ---------- 待同步队列（持久化，防刷新丢失） ---------- */

    function readQueue() {
      try {
        var raw = localStorage.getItem(QUEUE_KEY);
        var v = raw ? JSON.parse(raw) : [];
        return Array.isArray(v) ? v : [];
      } catch (e) { return []; }
    }

    function writeQueue(q) {
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)));
      } catch (e) {
        console.warn('[RCData.remote] 队列写入失败（可能超配额）', e);
      }
    }

    /**
     * 入队后自动触发补传（防抖 600ms）。
     *
     * 必须在这里主动 flush：init() 里那次「启动后 800ms 补传」发生在登录之前，
     * 那时请求会被 401 拒绝并回退进队列；之后无论加分还是改名单都只入队不发送，
     * 数据就永远停在浏览器里。这里把「入队」和「发出去」绑在一起，登录态下即时落库。
     */
    var flushTimer = 0;
    function scheduleFlush(delay) {
      if (flushTimer) return;
      var wait = typeof delay === 'number' ? delay : 600;
      // 正在补传时不能直接调 flush（会被 flushing 守卫吞掉），等这一轮结束再来
      if (flushing) wait = Math.max(wait, 400);
      flushTimer = setTimeout(function () {
        flushTimer = 0;
        flush();
      }, wait);
    }

    function enqueue(item) {
      var q = readQueue();
      item.clientRequestId = item.clientRequestId || newRequestId();
      item.queuedAt = Date.now();
      item.attempts = item.attempts || 0;
      q.push(item);
      writeQueue(q);
      emit({ type: 'queue', size: q.length });
      scheduleFlush();
      return item;
    }

    function queueSize() {
      return readQueue().length;
    }

    /* ---------- 补传 ---------- */

    function flush() {
      if (flushing) return Promise.resolve({ sent: 0, failed: 0, pending: queueSize() });
      var q = readQueue();
      if (!q.length) return Promise.resolve({ sent: 0, failed: 0, pending: 0 });
      flushing = true;
      var sent = 0, failed = 0;
      var rest = [];

      function step(i) {
        if (i >= q.length) {
          writeQueue(rest);
          flushing = false;
          online = failed === 0;
          emit({ type: 'flush', sent: sent, failed: failed, pending: rest.length });
          return Promise.resolve({ sent: sent, failed: failed, pending: rest.length });
        }
        var item = q[i];
        return request(item.method, item.path, item.body, {
          'Idempotency-Key': item.clientRequestId
        }).then(function () {
          sent++;
          return step(i + 1);
        }).catch(function (err) {
          // 4xx 是「这条数据本身有问题」，重试无意义 → 丢弃并记录
          // 5xx / 网络错误 → 保留，下次再试
          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 401) {
            console.warn('[RCData.remote] 队列项被服务端拒绝，已丢弃', item.path, err.message);
            failed++;
            return step(i + 1);
          }
          item.attempts++;
          item.lastError = String(err.message || err);
          rest = rest.concat(q.slice(i)); // 后续全部保留，保序
          writeQueue(rest);
          flushing = false;
          online = false;
          emit({ type: 'flush', sent: sent, failed: failed + (q.length - i), pending: rest.length });
          return Promise.resolve({ sent: sent, failed: failed + (q.length - i), pending: rest.length });
        });
      }

      return step(0);
    }

    /* ---------- 本地缓存持久化（离线冷启动可读上次数据） ---------- */

    function persistCache() {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          at: Date.now(),
          roster: cache.roster,
          classes: cache.classes,
          scores: cache.scores,
          settings: cache.settings,
          history: cache.history
        }));
      } catch (e) { /* 超配额忽略：缓存不是真源 */ }
    }

    function restoreCache() {
      try {
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return;
        var v = JSON.parse(raw);
        if (!v) return;
        cache.roster = v.roster || null;
        cache.classes = v.classes || null;
        cache.scores = v.scores || Object.create(null);
        cache.settings = v.settings || null;
        cache.history = v.history || null;
      } catch (e) { /* ignore */ }
    }

    /* ---------- 读（先缓存，缓存空再拉） ---------- */

    function getRoster() {
      if (cache.roster !== null) return clone(cache.roster);
      return clone([]);
    }

    function getClasses() {
      if (cache.classes !== null) return clone(cache.classes);
      return clone({ current: '', list: [] });
    }

    function getScores(className) {
      var k = String(className == null ? '' : className);
      if (!cache.scores[k]) return clone({ records: [], updatedAt: 0 });
      return clone(cache.scores[k]);
    }

    function getSettings() {
      if (cache.settings === null) {
        return { anim: 'spotlight', theme: 'white', fast: false, sound: true, autoClose: false, repeat: false, panel: true };
      }
      return clone(cache.settings);
    }

    function getState() {
      if (cache.state === null) return { picked: [], pickedByClass: {} };
      return clone(cache.state);
    }

    function getHistory() {
      if (cache.history === null) return [];
      return clone(cache.history);
    }

    function listScoreClasses() {
      return Object.keys(cache.scores).filter(function (k) {
        return cache.scores[k] && cache.scores[k].records && cache.scores[k].records.length;
      });
    }

    /* ---------- 写（同步写缓存 + 入队，立即返回） ---------- */

    function setRoster(list) {
      cache.roster = Array.isArray(list) ? clone(list) : [];
      persistCache();
      enqueue({ method: 'PUT', path: '/roster', body: cache.roster });
      emit({ type: 'roster' });
      return true;
    }

    function setClasses(c) {
      cache.classes = {
        current: (c && c.current) || '',
        list: (c && Array.isArray(c.list)) ? clone(c.list) : []
      };
      persistCache();
      enqueue({ method: 'PUT', path: '/classes', body: cache.classes });
      emit({ type: 'classes' });
      return true;
    }

    function setScores(className, records) {
      var k = String(className == null ? '' : className);
      var recs = Array.isArray(records) ? clone(records) : [];
      cache.scores[k] = { records: recs, updatedAt: Date.now() };
      persistCache();
      enqueue({ method: 'PUT', path: '/classes/' + encodeURIComponent(k) + '/scores', body: { records: recs } });
      emit({ type: 'scores', cls: k });
      return true;
    }

    function setSettings(s) {
      cache.settings = clone(s) || {};
      persistCache();
      enqueue({ method: 'PUT', path: '/settings', body: cache.settings });
      emit({ type: 'settings' });
      return true;
    }

    function setState(s) {
      cache.state = clone(s) || {};
      emit({ type: 'state' });
      return true;
    }

    function setHistory(list) {
      cache.history = Array.isArray(list) ? clone(list) : [];
      persistCache();
      emit({ type: 'history' });
      return true;
    }

    function removeScores(className) {
      var k = String(className == null ? '' : className);
      delete cache.scores[k];
      persistCache();
      enqueue({ method: 'DELETE', path: '/classes/' + encodeURIComponent(k) + '/scores' });
      emit({ type: 'scores', cls: k, removed: true });
      return true;
    }

    function wipe() {
      cache.roster = [];
      cache.classes = { current: '', list: [] };
      cache.scores = Object.create(null);
      cache.settings = null;
      cache.state = { picked: [], pickedByClass: {} };
      cache.history = [];
      try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
      emit({ type: 'wipe' });
      return true;
    }

    function me() {
      return clone(cache.me);
    }

    /* ---------- 认证（远程模式由服务端裁决身份） ---------- */

    /**
     * 账号密码登录。成功后服务端下发 HttpOnly 会话 Cookie + CSRF Cookie，
     * 同时把 /me 的返回结构缓存到 cache.me，供同步的 me() 读取。
     * @returns {Promise<{ok:boolean, msg?:string, me?:Object}>}
     */
    function login(loginName, password) {
      return request('POST', '/auth/login', { login: loginName, password: password })
        .then(function (r) {
          cache.me = r || null;
          persistCache();
          online = true;
          // 登录前积压的写请求此时才有合法会话，立刻补传
          scheduleFlush(0);
          return { ok: true, me: r };
        })
        .catch(function (e) {
          online = false;
          if (e && e.status === 429) {
            return { ok: false, msg: '尝试次数过多，请稍后再试' };
          }
          if (e && e.status === 403) {
            return { ok: false, msg: '该账号已被停用，请联系管理员' };
          }
          if (e && e.status === 401) {
            return { ok: false, msg: '登录名或密码不正确' };
          }
          return { ok: false, msg: '无法连接服务器（' + (e && e.message || e) + '）' };
        });
    }

    /** 登出：让服务端吊销会话并清 Cookie */
    function logout() {
      cache.me = null;
      persistCache();
      return request('POST', '/auth/logout').then(function () {
        return { ok: true };
      }).catch(function () {
        // 网络失败也要让本地退出，否则用户被卡在已登录界面
        return { ok: true };
      });
    }

    /** 拉取当前登录用户（会话 Cookie 仍有效时） */
    function refreshMe() {
      return request('GET', '/me').then(function (r) {
        cache.me = r || null;
        persistCache();
        online = true;
        return { ok: true, me: r };
      }).catch(function (e) {
        if (e && e.status === 401) {
          cache.me = null;
          persistCache();
          return { ok: false, msg: '未登录' };
        }
        online = false;
        return { ok: false, msg: '无法连接服务器' };
      });
    }

    /**
     * 访客登录：服务端只会下发内置的 guest 账号（role=viewer，无密码）。
     * 前端不传任何账号信息，避免变成「随便造一个只读账号」。
     */
    function guestLogin() {
      return request('POST', '/auth/guest', {})
        .then(function (r) {
          cache.me = r || null;
          persistCache();
          online = true;
          // 访客只读，队列里的写请求会在服务端被拒；仍走一次补传让它们明确失败并清掉
          scheduleFlush(0);
          return { ok: true, me: r };
        })
        .catch(function (e) {
          if (e && e.status === 403) {
            return { ok: false, msg: '访客登录已关闭，请联系管理员' };
          }
          online = false;
          return { ok: false, msg: '无法连接服务器（' + ((e && e.message) || e) + '）' };
        });
    }

    /* ---------- 教务对接 ---------- */

    /**
     * 教务系统对接状态。用于「一键读取」按钮判断是否可用：
     * configured=false 时点下去只会得到 400，不如直接把按钮置灰并说明原因。
     */
    function eduStatus() {
      return request('GET', '/edu/status').then(function (r) {
        return { ok: true, status: r };
      }).catch(function (e) {
        return { ok: false, msg: (e && e.message) || String(e) };
      });
    }

    /**
     * 从教务系统拉一次名单并落库（服务端负责 upsert + 讲师自动建号）。
     * 成功后本地缓存是脏的（班级/学生都变了），必须让调用方 reload。
     */
    function eduSync() {
      return request('POST', '/edu/sync', {}).then(function (r) {
        return { ok: true, result: r };
      }).catch(function (e) {
        if (e && e.status === 400) return { ok: false, msg: (e && e.message) || '教务系统未配置' };
        if (e && e.status === 403) return { ok: false, msg: '当前账号没有同步教务名单的权限' };
        return { ok: false, msg: '同步失败：' + ((e && e.message) || e) };
      });
    }

    /* ---------- 生命周期 ---------- */

    /**
     * 从服务端重新拉一次班级与名单，覆盖本地缓存。
     *
     * 为什么需要它：getClasses()/getRoster() 读的是 cache，
     * 而 cache 只在 init 时填过。教务同步、管理员在别的浏览器改名单
     * 这类「服务端数据变了但本页没动过」的情况，必须显式重拉，
     * 否则界面还停在旧快照上（曾导致同步成功但首页 0 个班）。
     */
    function reload() {
      return Promise.all([
        request('GET', '/classes').then(function (r) {
          if (r && Array.isArray(r.list)) {
            cache.classes = { current: r.current || '', list: r.list };
          }
          return r;
        }),
        request('GET', '/roster').then(function (r) {
          // 服务端可能直接返回数组，也可能包一层 {list}
          if (Array.isArray(r)) cache.roster = r;
          else if (r && Array.isArray(r.list)) cache.roster = r.list;
          return r;
        })
      ]).then(function () {
        persistCache();
        online = true;
        emit({ type: 'reload' });
        return { ok: true };
      }).catch(function (e) {
        online = false;
        return { ok: false, msg: (e && e.message) || String(e) };
      });
    }

    function bootstrap() {
      restoreCache();
      return Promise.all([
        request('GET', '/me').then(function (r) { cache.me = r; }).catch(function () { /* 401 由登录页处理 */ }),
        request('GET', '/classes').then(function (r) {
          if (r && Array.isArray(r.list)) {
            cache.classes = { current: r.current || '', list: r.list };
            (r.list || []).forEach(function (c) {
              if (c && c.id && Array.isArray(c.students)) {
                cache.scores[c.name] = cache.scores[c.name] || { records: [], updatedAt: 0 };
              }
            });
          }
        }).catch(function () { /* 用缓存 */ }),
        request('GET', '/settings').then(function (r) {
          if (r && typeof r === 'object') cache.settings = r;
        }).catch(function () { /* 用默认 */ })
      ]).then(function () {
        persistCache();
        return { mode: 'remote', reason: '已连接服务端' };
      });
    }

    function init() {
      var timeout = opts.timeout || 4000;
      return Promise.race([
        bootstrap(),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('TIMEOUT')); }, timeout);
        })
      ]).catch(function (err) {
        online = false;
        return { mode: 'remote', reason: '服务端不可用（' + (err.message || err) + '），进入离线模式', offline: true };
      }).then(function (r) {
        // 启动后尝试补传积压队列
        setTimeout(function () { flush(); }, 800);
        // 网络恢复时自动补传
        try {
          global.addEventListener('online', function () { flush(); });
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) flush();
          });
        } catch (e) { /* ignore */ }
        return r;
      });
    }

    function onModeChange(cb) {
      if (typeof cb === 'function') listeners.push(cb);
    }

    function dispose() {
      listeners.length = 0;
    }

    return {
      mode: 'remote',
      me: me,
      getRoster: getRoster,
      getClasses: getClasses,
      getScores: getScores,
      getSettings: getSettings,
      getState: getState,
      getHistory: getHistory,
      listScoreClasses: listScoreClasses,
      setRoster: setRoster,
      setClasses: setClasses,
      setScores: setScores,
      setSettings: setSettings,
      setState: setState,
      setHistory: setHistory,
      removeScores: removeScores,
      wipe: wipe,
      init: init,
      flush: flush,
      onModeChange: onModeChange,
      dispose: dispose,
      /* 远程模式独有 */
      queueSize: queueSize,
      isOnline: function () { return online; },
      request: request,
      login: login,
      guestLogin: guestLogin,
      logout: logout,
      refreshMe: refreshMe,
      reload: reload,
      eduStatus: eduStatus,
      eduSync: eduSync
    };
  }

  global.RCDataRemote = { create: createRemoteAdapter };
})(window);
