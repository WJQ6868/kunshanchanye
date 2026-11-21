/* ============================================================
   login.js —— 登录页逻辑
   ------------------------------------------------------------
   职责只有三件：
     1. 决定显示哪个 pane（登录 / 强制改密）
     2. 把三种登录方式（账号密码 / 教务一键登录 / 访客登录）的提交转成 RCSession 调用
     3. 登录成功后把 #loginScreen 收起来、#app 放出来

   它不碰任何业务逻辑，也不碰 localStorage 的原始键——
   存储全在 auth-store.js / session.js 里。
   ============================================================ */
(function (global) {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var els = {};
  var onDone = null;
  var bound = false;      // 登录成功后的回调（由 app.js 传入）
  var lastPw = '';        // 刚登录时输入的密码：远程模式强制改密要用它作「原密码」
  var pendingMe = null;   // 等用户点「进入系统」的那个登录态

  function cache() {
    els.screen = $('#loginScreen');
    els.app = $('#app');
    els.modeTag = $('#loginModeTag');

    els.loginPane = $('#loginPane');
    els.forcePane = $('#forcePane');

    /* 三种登录方式：并列的选择器 + 三个内容面板 */
    els.loginMethods = $('#loginMethods');
    els.bodyPwd = $('#bodyPwd');
    els.bodySso = $('#bodySso');
    els.bodyGuest = $('#bodyGuest');
    els.ssoErr = $('#ssoErr');
    els.btnSso = $('#btnSso');
    els.ssoNote = $('#ssoNote');
    els.guestErr = $('#guestErr');
    els.btnGuest = $('#btnGuest');

    els.loginForm = $('#loginForm');
    els.loginUser = $('#loginUser');
    els.loginPass = $('#loginPass');
    els.loginErr = $('#loginErr');
    els.btnLogin = $('#btnLogin');
    els.btnEye = $('#btnEye');
    els.loginSub = $('#loginSub');
    els.chkRemember = $('#chkRemember');

    els.forceForm = $('#forceForm');
    els.forcePass = $('#forcePass');
    els.forcePass2 = $('#forcePass2');
    els.forceErr = $('#forceErr');
    els.btnForce = $('#btnForce');
    els.forceMeter = $('#forceMeter');

    /* 「准备就绪」面板：验证通过后停在这里，等用户点按钮才进 */
    els.enterPane = $('#enterPane');
    els.enterSub = $('#enterSub');
    els.enterWho = $('#enterWho');
    els.btnEnter = $('#btnEnter');
    els.btnEnterSignOut = $('#btnEnterSignOut');

    /* 改密页的逃生口：刷新后原密码丢失时改密必然失败，没有它人就卡死 */
    els.btnForceSignOut = $('#btnForceSignOut');
    els.forceOldWrap = $('#forceOldWrap');
    els.forceOld = $('#forceOld');
  }

  /* ---------------- 小工具 ---------------- */

  function showErr(el, msg) {
    if (!el) return;
    if (!msg) { el.textContent = ''; el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function busy(btn, on, text) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = text || '请稍候…';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  /** 密码强度条 */
  function meter(el, pw) {
    if (!el) return;
    var bar = el.querySelector('span');
    if (!pw) { el.classList.add('hidden'); return; }
    var chk = global.RCCrypto.checkPassword(pw);
    el.classList.remove('hidden');
    el.dataset.score = chk.score;
    if (bar) bar.style.width = (chk.score / 4 * 100) + '%';
    el.title = chk.msg;
  }

  function pane(which) {
    els.loginPane.classList.toggle('hidden', which !== 'login');
    els.forcePane.classList.toggle('hidden', which !== 'force');
    if (els.enterPane) els.enterPane.classList.toggle('hidden', which !== 'enter');
    if (which === 'login') setTimeout(function () { els.loginUser && els.loginUser.focus(); }, 60);
    if (which === 'force') setTimeout(function () { els.forcePass && els.forcePass.focus(); }, 60);
    if (which === 'enter') setTimeout(function () { els.btnEnter && els.btnEnter.focus(); }, 60);
  }

  /**
   * 切换登录方式（pwd / sso / guest）。
   * 三个按钮并列显示，内容面板互斥；不改 URL、不发请求。
   */
  function method(which) {
    var m = which === 'sso' || which === 'guest' ? which : 'pwd';

    if (els.bodyPwd) els.bodyPwd.classList.toggle('hidden', m !== 'pwd');
    if (els.bodySso) els.bodySso.classList.toggle('hidden', m !== 'sso');
    if (els.bodyGuest) els.bodyGuest.classList.toggle('hidden', m !== 'guest');

    $$('.login-method', els.loginMethods).forEach(function (b) {
      var on = b.dataset.method === m;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // 切过去后清掉上一次的错误提示，避免「切走了还挂着红字」
    if (m === 'pwd') { showErr(els.loginErr, ''); setTimeout(function () { els.loginUser && els.loginUser.focus(); }, 40); }
    if (m === 'sso') { showErr(els.ssoErr, ''); setTimeout(function () { els.btnSso && els.btnSso.focus(); }, 40); }
    if (m === 'guest') { showErr(els.guestErr, ''); setTimeout(function () { els.btnGuest && els.btnGuest.focus(); }, 40); }
  }

  /* ---------------- 记住账号密码 ---------------- */

  /**
   * 只存「本机浏览器」的便利性数据，和账号体系无关：
   *   rollcall.login.remember.v1 = { on: true, u: '账号', p: '密码' }
   * 说明：base64 只是避免明文直读，**不是加密**。
   * 这是纯前端课堂工具，密码本来就在本机 localStorage 里做哈希校验；
   * 若将来接真实教务账号，这里必须改成「只记账号、不记密码」。
   */
  var REMEMBER_KEY = 'rollcall.login.remember.v1';

  function readRemember() {
    try {
      var raw = global.localStorage.getItem(REMEMBER_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return null;
      return {
        on: d.on !== false,
        u: d.u ? global.atob(d.u) : '',
        p: d.p ? global.atob(d.p) : ''
      };
    } catch (e) {
      return null;
    }
  }

  function writeRemember(on, u, p) {
    try {
      if (!on) {
        // 取消勾选：连账号一起清掉，避免「关了还留着」
        global.localStorage.removeItem(REMEMBER_KEY);
        return;
      }
      global.localStorage.setItem(REMEMBER_KEY, JSON.stringify({
        on: true,
        u: u ? global.btoa(u) : '',
        p: p ? global.btoa(p) : ''
      }));
    } catch (e) { /* 隐私模式下写不进去就算了，不打断登录 */ }
  }

  /* ---------------- 本标签页「已进过主界面」标记 ---------------- */

  /**
   * 为什么需要这个标记：
   *   用户要求「必须点按钮才进入，不要自动跳转」，所以刷新页面恢复会话时
   *   不能直接 enterApp()。但「同一标签页内按 F5」和「关掉标签页重新打开」
   *   在需求上是两件事：前者人不该被反复拦在「准备就绪」，后者要保守。
   *
   *   能天然区分这两者的存储只有 sessionStorage —— 它在同一标签页（含刷新）内
   *   一直存在，标签页一关就没了。localStorage 活得比标签页久（会变成自动跳转），
   *   内存变量又活不过刷新（等于没修），都不合适。
   *
   * 写入时机：只有 enterApp()（用户真的点了「进入系统」）才写。
   * 清除时机：signOut()、以及任何一次走到 showGateway()（人又站回门口了）时清，
   *          这样「退出登录 / 换个账号登录」之后绝不会残留旧标记。
   */
  var ENTERED_KEY = 'rollcall.entered.v1';

  function readEntered() {
    try {
      var d = JSON.parse(global.sessionStorage.getItem(ENTERED_KEY) || 'null');
      if (!d || typeof d !== 'object') return null;
      return d;
    } catch (e) { return null; }
  }

  function markEntered(me) {
    try {
      global.sessionStorage.setItem(ENTERED_KEY, JSON.stringify({
        id: (me && me.user && me.user.id) || '',
        at: Date.now()
      }));
    } catch (e) { /* 写不进去就退化成「每次刷新都停在准备就绪」，不影响正确性 */ }
  }

  function clearEntered() {
    try { global.sessionStorage.removeItem(ENTERED_KEY); } catch (e) {}
  }

  /**
   * 本次页面加载是否可以直接进主界面（= 同一标签页内的刷新）。
   * 三个条件全满足才放行，任意一个不满足都退回家门口：
   *   ① 本标签页里有「已进入」标记；
   *   ② 标记里的用户 id 与当前恢复出来的登录态一致（防「换个人登录后残留」）；
   *   ③ 当前账号不需要强制改密（改密没完成的人不能绕过改密页）。
   */
  function canAutoEnter(me) {
    if (!me || !me.user || me.user.mustChange) return false;
    var d = readEntered();
    if (!d) return false;
    return String(d.id || '') === String(me.user.id || '');
  }

  /** 进登录页时回填：勾选状态 + 账号 + 密码 */
  function restoreRemember() {
    var d = readRemember();
    var on = d ? d.on : true;          // 默认勾上
    if (els.chkRemember) els.chkRemember.checked = on;
    if (!d || !on) return;
    if (d.u && els.loginUser) els.loginUser.value = d.u;
    if (d.p && els.loginPass) els.loginPass.value = d.p;
  }

  /* ---------------- 进入应用 ---------------- */

  /**
   * 真正进入应用（把登录层收起来、把 #app 放出来）。
   *
   * 这是**唯一**会切换界面的地方，只能由用户点击「进入系统」按钮触发。
   * 任何认证成功（登录 / 访客 / 改密 / 会话恢复）都先走 gateway()，
   * 由用户自己点按钮再进来 —— 不再有「登录成功就自动跳转」。
   */
  function enterApp(me) {
    // 兜底：万一还有漏网的 mustChange 走到这里，先拦回去改密
    if (me && me.user && me.user.mustChange) {
      showGateway(me, '首次登录需要先设置自己的密码');
      return;
    }
    if (els.screen) {
      els.screen.classList.add('leaving');
      setTimeout(function () { els.screen.classList.add('hidden'); }, 260);
    }
    if (els.app) els.app.hidden = false;
    document.documentElement.classList.add('logged-in');
    /* 记下「这个标签页里人已经真的进过主界面」—— 下次同标签页刷新直接放行。
       必须写在 enterApp 里（而不是登录成功处），因为只有它代表用户点了按钮。 */
    markEntered(me);
    if (typeof onDone === 'function') {
      try { onDone(me); } catch (e) { console.error('[RCLogin] 登录后回调异常', e); }
    }
  }

  /**
   * 验证通过后的停靠点：算出该停在哪一屏，但**不自动进入**。
   *
   * @param {Object} me       登录态快照
   * @param {string} [note]   显示在「准备就绪」面板上的补充说明
   */
  function showGateway(me, note) {
    if (!me || !me.user) { pane('login'); return; }
    pendingMe = me;

    /* 人又站回门口了（冷启动 / 刚登录 / 换账号 / 改密未完成）：
       清掉「已进入」标记，保证下一次刷新仍要重新点按钮，不会被这个标记放行。 */
    clearEntered();

    // 首次登录必须改密，改完也要再点一次按钮才进
    if (me.user.mustChange) {
      if (els.enterSub) els.enterSub.textContent = '已通过验证，点击下方按钮进入';
      pane('force');

      /* 远程模式下改密要带原密码，而原密码只存在于「本次登录手输过」这个变量里。
         刷新页面后会话被恢复，lastPw 就没了 —— 这时不让用户白输一遍新密码才
         看到报错，而是直接多给一个「当前密码」输入框，补输一次即可。 */
      if (global.RCSession.isRemote() && !lastPw) {
        if (els.forceOldWrap) els.forceOldWrap.classList.remove('hidden');
        if (els.forceOld) els.forceOld.value = '';
        if (els.forceOld) setTimeout(function () { els.forceOld.focus(); }, 80);
      } else if (els.forceOldWrap) {
        els.forceOldWrap.classList.add('hidden');
      }
      return;
    }

    if (els.enterSub) els.enterSub.textContent = note || '已通过验证，点击下方按钮进入';
    if (els.enterWho) {
      var name = me.user.displayName || me.user.login || '';
      /* /me 只回 role 这个 key（admin/teacher/viewer），没有 roleLabel；
         拿 RCPerm.ROLES 翻成中文，翻不出来就不显示括号。 */
      var role = '';
      try {
        var r = global.RCPerm && global.RCPerm.ROLES && global.RCPerm.ROLES[me.user.role];
        role = (r && r.label) || '';
      } catch (e) { role = ''; }
      els.enterWho.textContent = name
        ? ('当前账号：' + name + (role ? '（' + role + '）' : ''))
        : '';
    }
    if (els.btnEnter) els.btnEnter.disabled = false;
    pane('enter');
  }

  /* ---------------- 三个表单 ---------------- */

  function bindLogin() {
    els.loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      showErr(els.loginErr, '');
      var u = els.loginUser.value.trim();
      var p = els.loginPass.value;
      if (!u || !p) { showErr(els.loginErr, '请输入登录名和密码'); return; }

      busy(els.btnLogin, true, '登录中…');
      lastPw = p;
      global.RCSession.signIn(u, p).then(function (r) {
        busy(els.btnLogin, false);
        if (!r.ok) {
          showErr(els.loginErr, r.msg);
          els.loginPass.select();
          // 记住的密码已经不对了（比如刚改过密码）：只保留账号，清掉密码，
          // 否则下次打开又自动填一个错误密码，每次都白撞一次。
          if (els.chkRemember && els.chkRemember.checked) writeRemember(true, u, '');
          return;
        }
        // 登录成功才写「记住我」：失败的密码不该被记下来
        writeRemember(!!(els.chkRemember && els.chkRemember.checked), u, p);
        els.loginPass.value = '';
        showGateway(r.me);
      }).catch(function (err) {
        busy(els.btnLogin, false);
        showErr(els.loginErr, '登录出错：' + (err && err.message || err));
      });
    });

    // 显示/隐藏密码
    els.btnEye.addEventListener('click', function () {
      var show = els.loginPass.type === 'password';
      els.loginPass.type = show ? 'text' : 'password';
      els.btnEye.textContent = show ? '🙈' : '👁';
      els.btnEye.title = show ? '隐藏密码' : '显示密码';
      els.loginPass.focus();
    });

    // 取消勾选立刻清掉已存的账号密码；重新勾上则把当前输入存下来
    if (els.chkRemember) {
      els.chkRemember.addEventListener('change', function () {
        if (els.chkRemember.checked) {
          writeRemember(true, els.loginUser.value.trim(), els.loginPass.value);
        } else {
          writeRemember(false);
        }
      });
    }
  }

  /* ---------------- 三种登录方式 ---------------- */

  function bindMethods() {
    // 顶部三个并列按钮
    if (els.loginMethods) {
      $$('.login-method', els.loginMethods).forEach(function (b) {
        b.addEventListener('click', function () { method(b.dataset.method); });
      });
    }

    /* 「进入系统」按钮：整站唯一切换界面的入口 */
    if (els.btnEnter) {
      els.btnEnter.addEventListener('click', function () {
        var me = pendingMe || global.RCSession.me();
        if (!me || !me.user) {
          if (els.enterSub) els.enterSub.textContent = '登录状态已失效，请重新登录';
          pendingMe = null;
          pane('login');
          return;
        }
        pendingMe = null;
        enterApp(me);
      });
    }

    /* 「换个账号登录」（准备就绪页）：清会话回登录页。
       停在这里时人是「已登录但还没进界面」，想换个人用必须能退出来。 */
    if (els.btnEnterSignOut) {
      els.btnEnterSignOut.addEventListener('click', function () {
        signOut();
      });
    }

    /* 教务一键登录：P3 才真正接入 IdP，现在如实告知「还没接」，
       不假装成功、也不把用户卡在一个假按钮上。 */
    if (els.btnSso) {
      els.btnSso.addEventListener('click', function () {
        showErr(els.ssoErr, '');
        busy(els.btnSso, true, '正在连接…');
        global.RCSession.signInWithProvider('sso').then(function (r) {
          busy(els.btnSso, false);
          if (r && r.ok) { showGateway(r.me); return; }
          showErr(els.ssoErr, (r && r.msg) || '教务单点登录暂不可用');
        }).catch(function (err) {
          busy(els.btnSso, false);
          showErr(els.ssoErr, '连接出错：' + (err && err.message || err));
        });
      });
    }

    /* 访客登录：不需要任何输入，直接换一个只读会话 */
    if (els.btnGuest) {
      els.btnGuest.addEventListener('click', function () {
        showErr(els.guestErr, '');
        busy(els.btnGuest, true, '进入中…');
        global.RCSession.signInAsGuest().then(function (r) {
          busy(els.btnGuest, false);
          if (!r || !r.ok) { showErr(els.guestErr, (r && r.msg) || '访客登录失败'); return; }
          showGateway(r.me);
        }).catch(function (err) {
          busy(els.btnGuest, false);
          showErr(els.guestErr, '进入出错：' + (err && err.message || err));
        });
      });
    }
  }

  function bindForce() {
    els.forcePass.addEventListener('input', function () { meter(els.forceMeter, els.forcePass.value); });

    els.forceForm.addEventListener('submit', function (e) {
      e.preventDefault();
      showErr(els.forceErr, '');
      var p1 = els.forcePass.value;
      var p2 = els.forcePass2.value;
      if (p1 !== p2) { showErr(els.forceErr, '两次输入的密码不一致'); return; }

      var chk = global.RCCrypto.checkPassword(p1);
      if (!chk.ok) { showErr(els.forceErr, chk.msg); return; }

      var me = global.RCSession.me();
      if (!me) { showErr(els.forceErr, '登录状态已失效，请重新登录'); pane('login'); return; }

      busy(els.btnForce, true, '保存中…');

      /* 远程模式：改密必须带原密码。
         优先用刚登录时输的那个（lastPw）；刷新页面后它丢了，就用手输的「当前密码」。 */
      if (global.RCSession.isRemote()) {
        var oldPw = lastPw || (els.forceOld && els.forceOld.value) || '';
        if (!oldPw) {
          // 理论上进不来（showGateway 已经把手输框显示出来了），兜一层
          if (els.forceOldWrap) els.forceOldWrap.classList.remove('hidden');
          showErr(els.forceErr, '请输入当前密码');
          busy(els.btnForce, false);
          return;
        }
        global.RCSession.changePassword(oldPw, p1).then(function (r) {
          busy(els.btnForce, false);
          if (!r.ok) { showErr(els.forceErr, r.msg); return; }
          els.forcePass.value = '';
          els.forcePass2.value = '';
          if (els.forceOld) els.forceOld.value = '';
          if (els.forceOldWrap) els.forceOldWrap.classList.add('hidden');
          global.RCSession.refresh();
          // 改完不自动进，落在「准备就绪」，由用户点按钮
          showGateway(global.RCSession.me(), '密码已更新，点击下方按钮进入');
        });
        return;
      }

      global.RCCrypto.derive(p1).then(function (pw) {
        var r = global.RCAuthStore.update(me.user.id, { pw: pw, mustChange: false });
        if (!r.ok) throw new Error(r.msg);
        global.RCSession.refresh();
        return { ok: true, me: global.RCSession.me() };
      }).then(function (r) {
        busy(els.btnForce, false);
        els.forcePass.value = '';
        els.forcePass2.value = '';
        showGateway(r.me, '密码已更新，点击下方按钮进入');
      }).catch(function (err) {
        busy(els.btnForce, false);
        showErr(els.forceErr, err && err.message || String(err));
      });
    });

    /* 改密页的逃生口。
       场景：新账号（must_change=1）登录后刷新页面 —— 会话还在、仍停在改密页，
       但 lastPw 已经丢了，服务端必然以「原密码不正确」拒绝；
       而这一屏本来没有任何出口，人就彻底卡死（既进不去也退不出）。
       点这里清会话回登录页，重新手输一次密码就能正常改。 */
    if (els.btnForceSignOut) {
      els.btnForceSignOut.addEventListener('click', function () {
        els.forcePass.value = '';
        els.forcePass2.value = '';
        if (els.forceOld) els.forceOld.value = '';
        showErr(els.forceErr, '');
        signOut();
        showErr(els.loginErr, '请重新输入密码登录，然后再设置新密码');
      });
    }
  }

  /* ---------------- 入口 ---------------- */

  /**
   * 启动登录页。
   * @param {Object} opt
   *   opt.onSuccess(me)  已登录（会话恢复或刚登录成功）时回调
   *   opt.mode           'local' | 'remote'，只用于左下角标签文案
   */
  function start(opt) {
    opt = opt || {};
    onDone = opt.onSuccess || null;
    cache();

    /* 先定模式：session.js 的 restore/signIn 都按它分流，
       必须在任何认证动作之前调用。 */
    global.RCSession.setMode(opt.mode);

    // 左下角模式标签：让用户知道数据存在哪
    if (els.modeTag) {
      var isRemote = opt.mode === 'remote';
      els.modeTag.textContent = isRemote ? '服务器模式' : '本机模式';
      els.modeTag.title = isRemote
        ? '数据保存在服务器上，换电脑登录即可看到同一份数据'
        : '数据只保存在这台电脑的浏览器里，换电脑看不到';
      els.modeTag.classList.toggle('is-remote', isRemote);
    }

    // 表单事件必须先绑：已登录时会提前 return，若不绑，
    // 退出登录后再点「登录」就会走浏览器原生 submit 导致整页刷新。
    if (!bound) {
      bindLogin();
      bindMethods();
      bindForce();
      bound = true;
    }

    // 会话还在（没退出、没过期）→ 分两种情况：
    //   ① 同一标签页内刷新（sessionStorage 里有「已进入」标记，且是同一个人）
    //      → 直接进主界面，不再拦在「准备就绪」。人已经点过按钮了，刷新
    //        只是把页面重画一遍，再拦一次纯属骚扰。
    //   ② 冷启动 / 关掉标签页后重新打开 / 换了账号
    //      → 保守处理，仍停在「准备就绪」等用户点按钮（用户明确要求不自动跳转）。
    var me = global.RCSession.restore();
    if (me) {
      if (canAutoEnter(me)) {
        pendingMe = null;
        enterApp(me);
        return;
      }
      showGateway(me, '检测到上次的登录状态，点击下方按钮继续');
      return;
    }

    // 三种方式并列：账号密码是默认页，教务一键登录与访客登录各占一个并列入口。
    // 系统内置管理员由 auth-store / 服务端 seed 保证存在，不再有「首次使用创建管理员」面板。
    pane('login');
    method('pwd');
    // 回填上次的账号密码（勾了「记住我」才有）
    restoreRemember();
    var lf = global.RCSession.lockedFor();
    if (lf > 0) showErr(els.loginErr, '尝试次数过多，请 ' + Math.ceil(lf / 1000) + ' 秒后再试');
  }

  /** 登出：清会话 + 回到登录页（不刷新页面，避免动画状态丢失提示不友好） */
  function signOut() {
    global.RCSession.signOut();
    pendingMe = null;
    lastPw = '';
    /* 退出登录必须连「本标签页已进入」标记一起清掉：
       否则退出后重新登录（同一个 id）再刷新，会被误判成「同一标签页刷新」而自动跳进去，
       绕过了「必须点按钮」的约定。 */
    clearEntered();
    if (els.app) els.app.hidden = true;
    if (els.screen) {
      els.screen.classList.remove('hidden', 'leaving');
    }
    document.documentElement.classList.remove('logged-in');
    showErr(els.loginErr, '');
    showErr(els.ssoErr, '');
    showErr(els.guestErr, '');
    if (els.loginPass) els.loginPass.value = '';
    pane('login');
    method('pwd');
    // 退出后如果勾了「记住我」，把账号密码填回去，方便下一节课直接登
    restoreRemember();
  }

  global.RCLogin = { start: start, signOut: signOut, enterApp: enterApp, showGateway: showGateway };
})(window);
