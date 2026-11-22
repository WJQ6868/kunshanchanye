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
  var cloneRecords = C.cloneRecords;
  var newRequestId = C.newRequestId;

  var QUEUE_KEY = 'rollcall.queue.v1';
  var CACHE_KEY = 'rollcall.cache.v1';
  var QUEUE_MAX = 2000;
  /* 同一条队列项连续失败几次就熔断丢弃。
     整班快照一旦超过服务端 5MB 上限，重试多少次都不会成功，
     留在队头会把后面所有加分全堵死（性能测试 P0-1）。 */
  var MAX_ATTEMPTS = 3;

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
    // 本次会话里「确认从服务端拉到过」的班级集合。
    // 只有在这里面的班级，才允许在列表里缺记录的情况下提交加分
    // （否则对账式 PUT 会把服务端历史分全部冲正）。
    var scoresLoaded = Object.create(null);

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
          /* 任何接口回 401 = 服务端判定会话已失效（Cookie 到期 / 满 2 小时被吊销）。
             统一在这里通知会话层走「过期 → 回登录页」，
             避免各个调用点各自处理、有的只弹提示却不跳转。
             未登录（登录页输错密码）时 expireNow 会因为 current 为空直接返回 false。 */
          try {
            if (global.RCSession && typeof global.RCSession.expireNow === 'function') {
              global.RCSession.expireNow('unauthorized');
            }
          } catch (e) {}
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
      /* 写失败必须上抛：以前这里只 console.warn，结果是
         「UI 提示加分成功、数据其实没进队列、刷新就没了」（性能测试 P0-1）。
         配额满时宁可在按钮上直接报错，也不能假装成功。 */
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)));
        return true;
      } catch (e) {
        console.error('[RCData.remote] 队列写入失败（localStorage 配额已满）', e);
        var full = new Error('本机存储已满，这条记录没能保存。请检查网络后刷新页面重试。');
        full.status = 507;
        full.code = 'QUOTA_EXCEEDED';
        throw full;
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
      // 本次补传里被熔断丢弃的坏项（连续失败 MAX_ATTEMPTS 次）。
      // 单独攒起来随 flush 事件上报，不能静默吞掉——老师得知道哪条没存上。
      var poisoned = [];
      // 被服务端以 4xx 明确拒绝的项（数据本身有问题，重试无意义）。
      // 同样必须上报：以前这里只有 console.warn，界面照旧提示保存成功。
      var rejected = [];

      function step(i) {
        if (i >= q.length) {
          writeQueue(rest);
          flushing = false;
          online = failed === 0;
          emit({
            type: 'flush', sent: sent, failed: failed, pending: rest.length,
            poisoned: poisoned.slice(), rejected: rejected.slice()
          });
          return Promise.resolve({ sent: sent, failed: failed, pending: rest.length });
        }
        var item = q[i];
        return request(item.method, item.path, item.body, {
          'Idempotency-Key': item.clientRequestId
        }).then(function () {
          sent++;
          return step(i + 1);
        }).catch(function (err) {
          // 4xx 是「这条数据本身有问题」，重试无意义 → 丢弃并上报
          // 5xx / 网络错误 → 保留，下次再试
          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 401) {
            console.error('[RCData.remote] 队列项被服务端拒绝，已丢弃', item.path, err.message);
            rejected.push({
              path: item.path,
              status: err.status,
              code: err.code || '',
              error: String(err.message || err)
            });
            failed++;
            return step(i + 1);
          }
          /* 同一条反复失败就熔断：以前「整班快照超 5MB」这类毒丸会永远堵在队头，
             后面所有加分都发不出去（性能测试 P0-1）。尝试 MAX_ATTEMPTS 次后丢弃，
             并把这个坏项单独报出来，不能静默吞掉。 */
          item.attempts = (item.attempts || 0) + 1;
          item.lastError = String(err.message || err);
          if (item.attempts >= MAX_ATTEMPTS) {
            console.error('[RCData.remote] 队列项连续失败，已丢弃', item.path, item.lastError);
            poisoned.push({ path: item.path, error: item.lastError, attempts: item.attempts });
            failed++;
            return step(i + 1);
          }
          rest = rest.concat(q.slice(i)); // 后续全部保留，保序
          writeQueue(rest);
          flushing = false;
          online = false;
          emit({
            type: 'flush', sent: sent, failed: failed + (q.length - i), pending: rest.length,
            poisoned: poisoned.slice(), rejected: rejected.slice()
          });
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
          history: cache.history,
          /* state 里放的是「界面位置 + 抽过谁」。它也必须进缓存：
             之前漏了这一项，远程模式刷新后 loadState() 永远拿到空对象，
             于是每次刷新都跳回首页排行榜，且「不重复抽取」的已抽名单被清空
             （本地模式没这问题，因为 adapter-local 直接存 RCStorage）。 */
          state: cache.state
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
        cache.state = v.state || null;
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
      if (!cache.scores[k]) return { records: [], updatedAt: 0 };
      var s = cache.scores[k];
      /* 用 cloneRecords 而不是 clone：记录是扁平对象，逐条浅拷贝比 JSON
         往返快约 20 倍（8 万条 105.6ms → 5.0ms），见 adapter-interface.js */
      return { records: cloneRecords(s.records), updatedAt: s.updatedAt };
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

    /**
     * 加分记录的写守卫，和 roster/classes 同源问题。
     *
     * 服务端的 PUT /classes/:name/scores 是**对账式**写入：
     * payload 里没有、但库里还活着的记录会被一条条冲正（revoked_at）。
     * 所以只要本次会话没成功把该班的记录拉下来（cache.scores[k] 不存在、
     * 也没在本会话里 loadScoresFor 过），此时提交「只有一条新记录」的列表，
     * 就会把该班历史分全部冲正掉 —— 和名单被清空是同一类事故。
     *
     * 新建班级例外：它本来就没有历史，基线确实是空的。
     */
    function canWriteScores(className, recs) {
      var k = String(className == null ? '' : className);
      if (!Array.isArray(recs) || !recs.length) return true; // 空列表另有 confirm 保护
      if (scoresLoaded[k]) return true;
      if (cache.scores[k]) return true; // 本地有一份基线（这个会话写过或从缓存恢复）
      return false;
    }

    function canWriteRoster(next, opt) {
      var cleared = Array.isArray(next) && next.length === 0;
      if (!cleared) return true;
      // 本次启动根本没拿到过服务端名单 —— 无论有没有确认，都不许用未知状态覆盖
      if (cache.roster === null) return false;
      // 服务端明明有数据、这次却要写空：必须由用户显式确认
      if (cache.roster.length > 0) return !!(opt && opt.confirmClear);
      // 服务端本来就是空的，写空是幂等的
      return true;
    }

    function setRoster(list, opt) {
      if (!canWriteRoster(list, opt)) {
        console.error('[RCData.remote] 拒绝写入名单：本次启动尚未从服务端取到名单，'
          + '此时提交空名单会清空服务器数据。请刷新页面重试。');
        emit({ type: 'rosterRejected' });
        return false;
      }
      cache.roster = Array.isArray(list) ? clone(list) : [];
      persistCache();
      var path = '/roster';
      if (Array.isArray(list) && list.length === 0) path += '?confirm=clear';
      enqueue({ method: 'PUT', path: path, body: cache.roster });
      emit({ type: 'roster' });
      return true;
    }

    function setClasses(c, opt) {
      var nextList = (c && Array.isArray(c.list)) ? c.list : [];
      if (nextList.length === 0) {
        // 同 setRoster：没拿到过服务端班级列表就不许写空
        if (cache.classes === null) {
          console.error('[RCData.remote] 拒绝写入班级：本次启动尚未从服务端取到班级列表，'
            + '此时提交空列表会归档服务器上的全部班级。请刷新页面重试。');
          emit({ type: 'classesRejected' });
          return false;
        }
        var known = Array.isArray(cache.classes.list) ? cache.classes.list.length : 0;
        if (known > 0 && !(opt && opt.confirmClear)) {
          console.error('[RCData.remote] 拒绝写入班级：现有 ' + known + ' 个班级，'
            + '提交空列表会把它们全部归档。需显式确认。');
          emit({ type: 'classesRejected' });
          return false;
        }
      }
      cache.classes = {
        current: (c && c.current) || '',
        list: clone(nextList)
      };
      persistCache();
      var path = '/classes';
      if (nextList.length === 0) path += '?confirm=clear';
      enqueue({ method: 'PUT', path: path, body: cache.classes });
      emit({ type: 'classes' });
      return true;
    }

    function setScores(className, records, opt) {
      var k = String(className == null ? '' : className);
      var recs = Array.isArray(records) ? cloneRecords(records) : [];
      // 注意：必须在写 scoresLoaded 之前记住基线状态
      var hadBaseline = !!(scoresLoaded[k] || cache.scores[k]);
      // 提交前的服务端基线（本机上一次确认过的记录），用来算「这次删了哪些」
      var prev = cache.scores[k];
      if (!canWriteScores(k, recs)) {
        console.error('[RCData.remote] 拒绝写入加分记录：本次启动尚未从服务端取到「'
          + k + '」的记录，此时提交会按对账语义把该班历史分全部冲正。请刷新页面重试。');
        emit({ type: 'scoresRejected', cls: k });
        return false;
      }
      cache.scores[k] = { records: recs, updatedAt: Date.now() };
      scoresLoaded[k] = true;
      persistCache();
      var path = '/classes/' + encodeURIComponent(k) + '/scores';
      // 空列表 = 把该班记录全部冲正。只有「之前确认拿到过基线」或调用方
      // 明确确认过，才带上服务端需要的 confirm 标记；否则不带，让服务端拒绝。
      if (!recs.length && (hadBaseline || (opt && opt.confirmClear))) {
        path += '?confirm=clear';
      }
      /* 告诉服务端「这次要删掉哪些」，而不是让它拿 payload 做全量对账。
         全量对账的后果（性能测试 P0-2）：另一个标签页基于旧快照提交时，
         它没见过的记录会被当成「已删除」全部冲正，而它返回 200，没人知道。
         这里用「提交前基线 − 本次提交」算出真正被删的 id：
         撤销一步只会删那一条，别人新加的记录不在本机基线里，永远不会被误删。 */
      var baseline = (prev && Array.isArray(prev.records)) ? prev.records : null;
      var removed = null;
      if (baseline) {
        var still = Object.create(null);
        for (var i = 0; i < recs.length; i++) {
          if (recs[i] && recs[i].id) still[String(recs[i].id)] = true;
        }
        removed = [];
        for (var j = 0; j < baseline.length; j++) {
          var bid = baseline[j] && baseline[j].id ? String(baseline[j].id) : '';
          if (bid && !still[bid]) removed.push(bid);
        }
      }
      enqueue({
        method: 'PUT',
        path: path,
        body: removed ? { records: recs, removed: removed } : { records: recs }
      });
      emit({ type: 'scores', cls: k });
      return true;
    }

    /** 从服务端拉某班记录，写进缓存。成功后才把该班标记为「基线已知」。 */
    function loadScoresFor(className) {
      var k = String(className == null ? '' : className);
      if (!k) return Promise.resolve({ ok: false, msg: '班级为空' });
      return request('GET', '/classes/' + encodeURIComponent(k) + '/scores').then(function (r) {
        var recs = (r && Array.isArray(r.records)) ? r.records : [];
        cache.scores[k] = { records: recs, updatedAt: Date.now() };
        scoresLoaded[k] = true;
        persistCache();
        emit({ type: 'scores', cls: k, loaded: true });
        return { ok: true, records: cloneRecords(recs) };
      }).catch(function (e) {
        online = false;
        return { ok: false, msg: (e && e.message) || String(e) };
      });
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
      /* 一定要落盘：state 里有界面位置（view/homeTab）和「抽过谁」。
         不写缓存的话刷新一次就全丢，回到首页排行榜。 */
      persistCache();
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
      delete scoresLoaded[k];
      persistCache();
      enqueue({ method: 'DELETE', path: '/classes/' + encodeURIComponent(k) + '/scores' });
      emit({ type: 'scores', cls: k, removed: true });
      return true;
    }

    function wipe() {
      // 只清本地。注意：把 roster/classes 置回 null 而不是 []，
      // 这样「清空之后、还没重新拉到服务端数据」这段时间里，
      // 写守卫会把它当作「基线未知」，不会因为本地是空的就往服务端写空。
      cache.roster = null;
      cache.classes = null;
      cache.scores = Object.create(null);
      scoresLoaded = Object.create(null);
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

    /* ---------- 人员管理（P4） ----------
       服务端 /users 系列接口。返回值统一成 {ok, data|msg}，
       让上层的 RCUserStore 在本地/远程两种模式下有同一套调用形状。
       403 单独翻译成人话：说明是权限不足，而不是「网络错误」。 */

    function listUsers() {
      return request('GET', '/users').then(function (r) {
        return { ok: true, list: Array.isArray(r) ? r : [] };
      }).catch(function (e) {
        if (e && e.status === 403) return { ok: false, msg: '当前账号没有人员管理权限' };
        if (e && e.status === 401) return { ok: false, msg: '登录已过期，请重新登录' };
        return { ok: false, msg: '读取账号列表失败：' + ((e && e.message) || e) };
      });
    }

    function createUser(input) {
      return request('POST', '/users', input).then(function (r) {
        return { ok: true, user: r };
      }).catch(function (e) {
        if (e && e.status === 403) return { ok: false, msg: '当前账号没有新增人员的权限' };
        return { ok: false, msg: pickMsg(e, '新增失败') };
      });
    }

    function updateUser(id, patch) {
      return request('PATCH', '/users/' + encodeURIComponent(id), patch).then(function (r) {
        return { ok: true, user: r };
      }).catch(function (e) {
        if (e && e.status === 403) return { ok: false, msg: '当前账号没有修改人员的权限' };
        return { ok: false, msg: pickMsg(e, '保存失败') };
      });
    }

    function removeUser(id) {
      return request('DELETE', '/users/' + encodeURIComponent(id)).then(function () {
        return { ok: true };
      }).catch(function (e) {
        if (e && e.status === 403) return { ok: false, msg: '当前账号没有删除人员的权限' };
        return { ok: false, msg: pickMsg(e, '删除失败') };
      });
    }

    function resetUserPassword(id, newPassword) {
      var body = newPassword ? { newPassword: newPassword } : {};
      return request('POST', '/users/' + encodeURIComponent(id) + '/password', body).then(function () {
        return { ok: true };
      }).catch(function (e) {
        if (e && e.status === 403) return { ok: false, msg: '当前账号没有重置密码的权限' };
        return { ok: false, msg: pickMsg(e, '重置失败') };
      });
    }

    /** 服务端把错误原因放在 message 字段里，取出比整段 HTTP 文本好用 */
    function pickMsg(e, fallback) {
      var raw = (e && e.message) || '';
      var m = /"message"\s*:\s*"([^"]+)"/.exec(raw);
      if (m) return m[1];
      if (e && e.status === 401) return '登录已过期，请重新登录';
      return fallback + '：' + raw;
    }

    /* ---------- 生命周期 ---------- */

    /**
     * 从服务端重新拉一次班级、名单与加分记录，覆盖本地缓存。
     *
     * 为什么需要它：getClasses()/getRoster()/getScores() 读的是 cache，
     * 而 cache 只在 init 时填过。教务同步、管理员在别的浏览器改名单
     * 这类「服务端数据变了但本页没动过」的情况，必须显式重拉，
     * 否则界面还停在旧快照上（曾导致同步成功但首页 0 个班）。
     *
     * 加分记录也在这一步拉：服务端的 PUT 是对账语义，本地没有基线就提交，
     * 会把该班历史分全部冲正。所以「拉到基线」是允许写分的前提。
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
        // 逐个班级拉加分记录。失败不影响整体（该班就保持「基线未知」，写分的守卫会拦住）
        var names = (cache.classes && Array.isArray(cache.classes.list))
          ? cache.classes.list.map(function (c) { return c && c.name; }).filter(Boolean)
          : [];
        return Promise.all(names.map(function (n) {
          return loadScoresFor(n).catch(function () { return { ok: false }; });
        }));
      }).then(function () {
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
          }
        }).catch(function () { /* 用缓存 */ }),
        request('GET', '/settings').then(function (r) {
          if (r && typeof r === 'object') cache.settings = r;
        }).catch(function () { /* 用默认 */ }),
        // 名单必须在这里就拉。缺了这一步，换电脑、清缓存、隐私窗口这些
        // 「本地没有 rollcall.cache.v1」的场景下 getRoster() 会静默返回空数组，
        // 首页显示「还没有学生」，而用户此时做任何一次导入/改班名/删班，
        // 都会把空名单 PUT 到服务端，把全班学生软删掉（2026-11-21 事故）。
        request('GET', '/roster').then(function (r) {
          if (Array.isArray(r)) cache.roster = r;
          else if (r && Array.isArray(r.list)) cache.roster = r.list;
        }).catch(function () { /* 保持 null，写操作会被守卫拦住 */ }),
        // 加分记录同理。**绝对不能在这里「先塞一个空 records 占位」**：
        // 服务端 PUT 是对账语义，空基线 + 一条新记录 = 把该班历史分全部冲正。
        // 拉不到就一直保持「基线未知」，让写守卫拦住，等登录后的 reload() 再补。
        request('GET', '/classes').then(function (r) {
          var names = (r && Array.isArray(r.list))
            ? r.list.map(function (c) { return c && c.name; }).filter(Boolean)
            : [];
          return Promise.all(names.map(function (n) {
            return loadScoresFor(n).catch(function () { return { ok: false }; });
          }));
        }).catch(function () { /* 保持未加载状态 */ })
      ]).then(function () {
        persistCache();
        return {
          mode: 'remote',
          reason: '已连接服务端',
          rosterLoaded: cache.roster !== null,
          scoresLoaded: Object.keys(scoresLoaded).length
        };
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
      loadScoresFor: loadScoresFor,
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
      eduSync: eduSync,
      /* 人员管理（P4） */
      listUsers: listUsers,
      createUser: createUser,
      updateUser: updateUser,
      removeUser: removeUser,
      resetUserPassword: resetUserPassword
    };
  }

  global.RCDataRemote = { create: createRemoteAdapter };
})(window);
