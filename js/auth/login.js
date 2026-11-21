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
    if (which === 'login') setTimeout(function () { els.loginUser && els.loginUser.focus(); }, 60);
    if (which === 'force') setTimeout(function () { els.forcePass && els.forcePass.focus(); }, 60);
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

  function enterApp(me) {
    // 首次登录强制改密：先不让进
    if (me && me.user && me.user.mustChange) {
      pane('force');
      return;
    }
    if (els.screen) {
      els.screen.classList.add('leaving');
      setTimeout(function () { els.screen.classList.add('hidden'); }, 260);
    }
    if (els.app) els.app.hidden = false;
    document.documentElement.classList.add('logged-in');
    if (typeof onDone === 'function') {
      try { onDone(me); } catch (e) { console.error('[RCLogin] 登录后回调异常', e); }
    }
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
        enterApp(r.me);
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

    /* 教务一键登录：P3 才真正接入 IdP，现在如实告知「还没接」，
       不假装成功、也不把用户卡在一个假按钮上。 */
    if (els.btnSso) {
      els.btnSso.addEventListener('click', function () {
        showErr(els.ssoErr, '');
        busy(els.btnSso, true, '正在连接…');
        global.RCSession.signInWithProvider('sso').then(function (r) {
          busy(els.btnSso, false);
          if (r && r.ok) { enterApp(r.me); return; }
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
          enterApp(r.me);
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

      /* 远程模式：改密必须带原密码，用刚才登录时输入的那个 */
      if (global.RCSession.isRemote()) {
        /* 原密码只在「本次登录时手输过」才拿得到。若是刷新页面后被会话恢复到
           改密页（lastPw 为空），服务端会以「原密码不正确」拒绝 —— 与其让人
           在这里白撞，不如明确要求重新登录一次。 */
        if (!lastPw) {
          showErr(els.forceErr, '为验证身份，请退出后重新登录再修改密码');
          busy(els.btnForce, false);
          return;
        }
        global.RCSession.changePassword(lastPw, p1).then(function (r) {
          busy(els.btnForce, false);
          if (!r.ok) { showErr(els.forceErr, r.msg); return; }
          els.forcePass.value = '';
          els.forcePass2.value = '';
          global.RCSession.refresh();
          enterApp(global.RCSession.me());
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
        enterApp(r.me);
      }).catch(function (err) {
        busy(els.btnForce, false);
        showErr(els.forceErr, err && err.message || String(err));
      });
    });
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

    // 已登录（会话未过期）→ 直接进
    var me = global.RCSession.restore();
    if (me) { enterApp(me); return; }

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

  global.RCLogin = { start: start, signOut: signOut, enterApp: enterApp };
})(window);
