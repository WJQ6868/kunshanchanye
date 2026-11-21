/* ============================================================
   user-ui.js —— 账号 UI：顶栏用户菜单、人员管理、修改密码
   ------------------------------------------------------------
   职责边界：
     - 本文件只负责「界面」与「调用存储层」，不做权限判定。
       权限判定在 perm.js（规则）与 session.js（当前用户）里。
     - 真正的强制校验在服务端（P1 第 4 项）；这里的灰化只防误操作。

   本地/服务器两种模式：
     - 账号存储差异由 user-store.js 收口，本文件只调 RCUserStore，
       不再直接碰 RCAuthStore（那是纯同步的 localStorage 实现）。
     - local（本机用户，没有登录）→ 等同管理员，界面不显示人员管理入口。
     - admin  → 全部功能，可管理讲师/访客、可改权限。
     - teacher→ 只能进被授权的班级，加分/扣分/点名可用，其余按授权。
     - viewer → 只读，用于大屏展示。
   ============================================================ */
(function (global) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var els = {};
  var hooks = { toast: function () {}, onSignOut: null, onMe: null };
  var editingId = '';        // '' = 新增，否则是编辑中的用户 id
  var menuOpen = false;
  var bound = false;         // 事件只绑一次，start() 可能被多次调用

  function cache() {
    els.chipHome = $('#userChipHome');
    els.chipClass = $('#userChip');
    els.avatarHome = $('#userAvatarHome');
    els.avatar = $('#userAvatar');
    els.nameHome = $('#userNameHome');
    els.name = $('#userName');
    els.menu = $('#userMenu');
    els.menuName = $('#userMenuName');
    els.menuRole = $('#userMenuRole');
    els.menuScope = $('#userMenuScope');
    els.menuPwd = $('#userMenuPwd');
    els.menuUsers = $('#userMenuUsers');
    els.menuOut = $('#userMenuOut');
    els.usersModal = $('#usersModal');
    els.usersHint = $('#usersHint');
    els.userList = $('#userList');
    els.userForm = $('#userForm');
    els.userFormTitle = $('#userFormTitle');
    els.btnUserAdd = $('#btnUserAdd');
    els.btnUserSave = $('#btnUserSave');
    els.btnUserCancel = $('#btnUserCancel');
    els.ufLogin = $('#ufLogin');
    els.ufName = $('#ufName');
    els.ufRole = $('#ufRole');
    els.ufEmp = $('#ufEmp');
    els.ufPw = $('#ufPw');
    els.ufPwField = $('#ufPwField');
    els.ufScopes = $('#ufScopes');
    els.ufPerms = $('#ufPerms');
    els.ufPermsWrap = $('#ufPermsWrap');
    els.ufErr = $('#ufErr');
    els.pwdModal = $('#pwdModal');
    els.pwdOld = $('#pwdOld');
    els.pwdNew = $('#pwdNew');
    els.pwdNew2 = $('#pwdNew2');
    els.pwdMeter = $('#pwdMeter');
    els.pwdErr = $('#pwdErr');
    els.btnPwdSave = $('#btnPwdSave');
  }

  /* -------------------- 工具 -------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initial(name) {
    var s = String(name || '').trim();
    return s ? s.slice(0, 1) : '?';
  }

  function roleLabel(role) {
    var r = global.RCPerm.ROLES[role];
    return r ? r.label : role;
  }

  function showErr(el, msg) {
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function me() {
    return global.RCSession ? global.RCSession.me() : null;
  }

  function isLocalMode() {
    var m = me();
    return !m || m.user.role === 'local';
  }

  /* -------------------- 顶栏芯片 -------------------- */

  function paintChip() {
    var m = me();
    var name = m ? m.user.displayName : '本机用户';
    var role = m ? m.user.role : 'local';

    [[els.chipHome, els.avatarHome, els.nameHome], [els.chipClass, els.avatar, els.name]].forEach(function (t) {
      var chip = t[0], av = t[1], nm = t[2];
      if (!chip) return;
      chip.dataset.role = role;
      if (av && !av.querySelector('.avatar-niu')) av.textContent = initial(name);
      if (nm) nm.textContent = name;
      chip.title = name + ' · ' + roleLabel(role) + '（点击查看账号）';
    });

    if (els.menuName) els.menuName.textContent = name;
    if (els.menuRole) {
      els.menuRole.textContent = roleLabel(role);
      els.menuRole.dataset.role = role;
    }
    if (els.menuScope) {
      var m2 = me();
      var sc = m2 && m2.classScopes;
      var canViewAll = !!(m2 && m2.permissions && m2.permissions['class.view_all']);
      var canScore = !!(m2 && m2.permissions && m2.permissions['score.add']);
      var editable = !canScore
        ? '只读，不能加减分'
        : ((!sc || !sc.length)
          ? '全部班级可加减分'
          : ('可加减分 ' + sc.length + ' 个班：' + sc.join('、')));
      els.menuScope.textContent = canViewAll ? ('全部班级可见 · ' + editable) : editable;
    }
    // 人员管理只给管理员；两种模式都有账号体系（本机 localStorage / 服务端数据库），
    // 存储差异由 user-store.js 收口，这里不再按模式隐藏入口。
    var canUsers = !!m && m.user.role === 'admin' && global.RCSession.can('user.manage');
    if (els.menuUsers) els.menuUsers.classList.toggle('hidden', !canUsers);
    if (els.menuPwd) els.menuPwd.classList.toggle('hidden', !m || m.user.role === 'local');
    if (els.menuOut) els.menuOut.classList.toggle('hidden', !m || m.user.role === 'local');
  }

  function openMenu(anchor) {
    if (!els.menu || !anchor) return;
    paintChip();
    els.menu.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    var w = 226;
    var left = Math.max(8, Math.min(r.right - w, global.innerWidth - w - 8));
    els.menu.style.left = left + 'px';
    els.menu.style.top = (r.bottom + 8) + 'px';
    anchor.classList.add('open');
    menuOpen = true;
    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
    }, 0);
  }

  function closeMenu() {
    if (!els.menu) return;
    els.menu.classList.add('hidden');
    if (els.chipHome) els.chipHome.classList.remove('open');
    if (els.chipClass) els.chipClass.classList.remove('open');
    menuOpen = false;
    document.removeEventListener('click', onDocClick, true);
  }

  function onDocClick(e) {
    if (!menuOpen) return;
    if (els.menu && els.menu.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.user-chip')) return;
    closeMenu();
  }

  /* -------------------- 人员管理：列表 -------------------- */

  function renderUsers() {
    if (!els.userList) return;
    if (!global.RCUserStore) {
      els.userList.innerHTML = '<div class="rank-empty">账号存储未就绪</div>';
      return;
    }
    els.userList.innerHTML = '<div class="rank-empty">正在读取账号…</div>';
    global.RCUserStore.list().then(function (r) {
      if (!r.ok) {
        els.userList.innerHTML = '<div class="rank-empty">' + esc(r.msg) + '</div>';
        if (els.usersHint) els.usersHint.textContent = '读取失败';
        return;
      }
      paintUsers(r.list || []);
    }).catch(function (e) {
      els.userList.innerHTML = '<div class="rank-empty">读取账号失败：' + esc(e && e.message || e) + '</div>';
    });
  }

  function paintUsers(all) {
    if (!els.userList) return;
    var cur = me();
    if (els.usersHint) {
      var off = all.filter(function (u) { return u.disabled; }).length;
      els.usersHint.textContent = all.length + ' 个账号' + (off ? '（' + off + ' 个已停用）' : '');
    }

    if (!all.length) {
      els.userList.innerHTML = '<div class="rank-empty">还没有账号</div>';
      return;
    }

    var html = [];
    all.forEach(function (u) {
      var isMe = cur && cur.user.id === u.id;
      var cls = 'user-row' + (isMe ? ' is-me' : '') + (u.disabled ? ' is-off' : '');
      var sc = u.classScopes;
      var scopeTxt = (!sc || !sc.length) ? '全部班级' : (sc.length + ' 个班级');
      var sub = '登录名 ' + u.login + ' · ' + scopeTxt + (u.employeeNo ? ' · 工号 ' + u.employeeNo : '');
      // 内置最高管理员不允许停用/删除（服务端也会拦，这里先不给出按钮，少一次失败）
      var acts = '<button class="icon-btn" data-u-act="edit" title="编辑">✎</button>' +
        '<button class="icon-btn" data-u-act="reset" title="重置密码为 ' + DEFAULT_PW + '">⟲</button>';
      if (!u.builtin) {
        acts += '<button class="icon-btn" data-u-act="toggle" title="' + (u.disabled ? '启用' : '停用') + '">' +
          (u.disabled ? '▶' : '⏸') + '</button>' +
          '<button class="icon-btn" data-u-act="del" title="删除">✕</button>';
      }
      html.push(
        '<div class="' + cls + '" data-role="' + esc(u.role) + '" data-id="' + esc(u.id) + '">' +
          '<div class="user-row-avatar"><img class="avatar-niu" src="assets/brand/niu-avatar.png" alt=""></div>' +
          '<div class="user-row-main"><b>' + esc(u.displayName) +
            (isMe ? ' <span class="user-role-tag">当前</span>' : '') +
            (u.disabled ? ' <span class="user-role-tag">已停用</span>' : '') +
            (u.builtin ? ' <span class="user-role-tag">内置</span>' : '') +
          '</b><span>' + esc(sub) + '</span></div>' +
          '<span class="user-row-role">' + esc(roleLabel(u.role)) + '</span>' +
          '<div class="user-row-acts">' + acts + '</div>' +
        '</div>'
      );
    });
    els.userList.innerHTML = html.join('');

    $$('#userList .user-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-u-act]') : null;
        if (!b) return;
        var act = b.dataset.uAct;
        var id = row.dataset.id;
        if (act === 'edit') openForm(id);
        else if (act === 'reset') resetPassword(id);
        else if (act === 'toggle') toggleUser(id, row.dataset.role === 'admin');
        else if (act === 'del') removeUser(id);
      });
    });
  }

  function findUser(id) {
    return global.RCUserStore.list().then(function (r) {
      if (!r.ok) return null;
      var hit = null;
      (r.list || []).forEach(function (u) { if (u.id === id) hit = u; });
      return hit;
    });
  }

  function toggleUser(id) {
    findUser(id).then(function (u) {
      if (!u) { hooks.toast('账号不存在或已被删除', 'warn'); return; }
      global.RCUserStore.update(id, { disabled: !u.disabled }).then(function (r) {
        if (!r.ok) { hooks.toast(r.msg, 'warn'); return; }
        hooks.toast(u.disabled ? '已启用「' + u.displayName + '」' : '已停用「' + u.displayName + '」');
        renderUsers();
        refreshSession();
      });
    });
  }

  /* -------------------- 人员管理：重置密码 -------------------- */

  var DEFAULT_PW = '123456';

  function resetPassword(id) {
    findUser(id).then(function (u) {
      if (!u) { hooks.toast('账号不存在或已被删除', 'warn'); return; }
      if (!global.confirm('把「' + u.displayName + '」的密码重置为 ' + DEFAULT_PW + '？\n该账号下次登录后需要自己改密码。')) return;
      global.RCUserStore.resetPassword(id, DEFAULT_PW).then(function (r) {
        if (!r.ok) { hooks.toast(r.msg, 'warn'); return; }
        hooks.toast('已把「' + u.displayName + '」的密码重置为 ' + DEFAULT_PW);
        renderUsers();
      }).catch(function (e) {
        hooks.toast('重置失败：' + (e && e.message || e), 'warn');
      });
    });
  }

  function removeUser(id) {
    findUser(id).then(function (u) {
      if (!u) { hooks.toast('账号不存在或已被删除', 'warn'); return; }
      var cur = me();
      if (cur && cur.user.id === id) { hooks.toast('不能删除当前登录的账号', 'warn'); return; }
      if (!global.confirm('删除账号「' + u.displayName + '」？该账号的加分记录会保留，但不能再登录。')) return;
      global.RCUserStore.remove(id).then(function (r) {
        if (!r.ok) { hooks.toast(r.msg, 'warn'); return; }
        hooks.toast('已删除账号');
        renderUsers();
      });
    });
  }

  /* -------------------- 人员管理：表单 -------------------- */

  function openForm(id) {
    editingId = id || '';
    showErr(els.ufErr, '');

    if (!editingId) {
      fillForm(null);
      return;
    }
    findUser(editingId).then(function (u) {
      if (!u) { hooks.toast('账号不存在或已被删除', 'warn'); closeForm(); return; }
      fillForm(u);
    });
  }

  function fillForm(u) {
    if (els.userFormTitle) els.userFormTitle.textContent = u ? ('编辑「' + u.displayName + '」') : '新增用户';

    if (els.ufLogin) { els.ufLogin.value = u ? u.login : ''; els.ufLogin.disabled = !!u; }
    if (els.ufName) els.ufName.value = u ? u.displayName : '';
    if (els.ufRole) els.ufRole.value = u ? u.role : 'teacher';
    if (els.ufEmp) els.ufEmp.value = u ? (u.employeeNo || '') : '';
    if (els.ufPw) els.ufPw.value = '';
    if (els.ufPwField) els.ufPwField.classList.toggle('hidden', !!u); // 编辑时改密走「重置密码」
    if (els.ufPw) els.ufPw.placeholder = u ? '' : ('留空 = ' + DEFAULT_PW);

    renderScopes(u ? u.classScopes : null);
    renderPerms(u ? u.role : 'teacher', u ? u.perms : {});
    if (els.ufPermsWrap) els.ufPermsWrap.open = false;

    els.userForm.classList.remove('hidden');
    setTimeout(function () { if (els.ufName) els.ufName.focus(); }, 60);
  }

  function closeForm() {
    editingId = '';
    if (els.userForm) els.userForm.classList.add('hidden');
    showErr(els.ufErr, '');
  }

  function allClassNames() {
    var names = [];
    try {
      var rc = global.RC;
      if (rc && rc.state && Array.isArray(rc.state.classes)) {
        rc.state.classes.forEach(function (c) { if (c && c.name) names.push(c.name); });
      }
    } catch (e) { /* ignore */ }
    return names;
  }

  function renderScopes(selected) {
    if (!els.ufScopes) return;
    var names = allClassNames();
    // 空授权在存储层等价于「全部班级」（collectScopes 会把空/全选都归一成 null），
    // 所以新增和编辑「全部班级」的账号都默认全部勾选（m14674）
    var sel = (selected && selected.length) ? selected : names;
    if (!names.length) {
      els.ufScopes.innerHTML = '<span class="hint">还没有班级，先创建班级再授权</span>';
      return;
    }
    els.ufScopes.innerHTML = names.map(function (n) {
      var on = sel.indexOf(n) >= 0;
      return '<label class="uf-scope' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" value="' + esc(n) + '"' + (on ? ' checked' : '') + '>' +
        esc(n) + '</label>';
    }).join('');
    $$('#ufScopes .uf-scope input').forEach(function (cb) {
      cb.addEventListener('change', function () {
        cb.closest('.uf-scope').classList.toggle('on', cb.checked);
      });
    });
  }

  function renderPerms(role, overrides) {
    if (!els.ufPerms) return;
    var eff = global.RCPerm.effective(role, overrides || {});
    var groups = global.RCPerm.grouped();
    els.ufPerms.innerHTML = groups.map(function (g) {
      var items = g.items.map(function (p) {
        var locked = p.n && role !== 'admin';
        var on = locked ? false : !!eff[p.key];
        return '<label class="uf-perm' + (locked ? ' locked' : '') + '" title="' +
          esc(locked ? '仅管理员可用' : (p.s ? '敏感操作，需谨慎授予' : p.label)) + '">' +
          '<input type="checkbox" data-pk="' + esc(p.key) + '"' + (on ? ' checked' : '') +
          (locked ? ' disabled' : '') + '>' + esc(p.label) + '</label>';
      }).join('');
      return '<div class="uf-perm-group"><b>' + esc(g.group) + '</b><div class="uf-perm-items">' + items + '</div></div>';
    }).join('');
  }

  function collectPerms(role) {
    var out = {};
    $$('#ufPerms input[data-pk]').forEach(function (cb) {
      var key = cb.dataset.pk;
      var p = global.RCPerm.BY_KEY[key];
      if (!p) return;
      var dflt = !!global.RCPerm.defaultsFor(role)[key];
      // 只记录与角色默认值不同的项，存的是「覆盖」而不是全量
      if (cb.checked !== dflt) out[key] = cb.checked;
    });
    return out;
  }

  function collectScopes() {
    var arr = [];
    $$('#ufScopes input:checked').forEach(function (cb) { arr.push(cb.value); });
    // 全选等价于「不限」：存 null 而不是班级名数组，
    // 这样以后新建班级会自动纳入授权范围（m14674 默认全勾后必须这么处理）
    var all = allClassNames();
    if (!arr.length || (all.length && arr.length >= all.length)) return null;
    return arr;
  }

  function saveUser() {
    if (!els.userForm || els.userForm.classList.contains('hidden')) return;
    showErr(els.ufErr, '');

    var login = els.ufLogin ? els.ufLogin.value : '';
    var name = els.ufName ? els.ufName.value : '';
    var role = els.ufRole ? els.ufRole.value : 'teacher';
    var emp = els.ufEmp ? els.ufEmp.value : '';
    var pw = els.ufPw ? els.ufPw.value : '';
    if (!pw) pw = DEFAULT_PW;  // 新增时留空 = 用默认密码 123456（m14674）
    var perms = collectPerms(role);
    var scopes = collectScopes();

    var btn = els.btnUserSave;
    if (btn) btn.disabled = true;

    function done(errMsg) {
      if (btn) btn.disabled = false;
      if (errMsg) { showErr(els.ufErr, errMsg); return; }
      closeForm();
      renderUsers();
      paintChip();
      if (hooks.onMe) hooks.onMe(me());
    }

    if (editingId) {
      global.RCUserStore.update(editingId, {
        displayName: name, role: role, employeeNo: emp,
        perms: perms, classScopes: scopes
      }).then(function (r) {
        if (!r.ok) { done(r.msg); return; }
        hooks.toast('已保存');
        done('');
      }).catch(function (e) {
        done('保存失败：' + (e && e.message || e));
      });
      return;
    }

    global.RCUserStore.create({
      login: login, displayName: name, role: role, employeeNo: emp,
      password: pw, perms: perms, classScopes: scopes
    }).then(function (r) {
      if (!r.ok) { done(r.msg); return; }
      var dn = (r.user && r.user.displayName) || name;
      hooks.toast('已新增「' + dn + '」，首次登录需改密码');
      done('');
    }).catch(function (e) {
      done('新增失败：' + (e && e.message || e));
    });
  }

  /* -------------------- 修改密码 -------------------- */

  function openPwd() {
    var m = me();
    if (!m || m.user.role === 'local') { hooks.toast('本机模式没有账号密码', 'warn'); return; }
    if (els.pwdOld) els.pwdOld.value = '';
    if (els.pwdNew) els.pwdNew.value = '';
    if (els.pwdNew2) els.pwdNew2.value = '';
    showErr(els.pwdErr, '');
    paintMeter('');
    els.pwdModal.classList.add('show');
    setTimeout(function () { if (els.pwdOld) els.pwdOld.focus(); }, 80);
  }

  function paintMeter(pw) {
    if (!els.pwdMeter) return;
    if (!pw) { els.pwdMeter.classList.add('hidden'); return; }
    els.pwdMeter.classList.remove('hidden');
    var r = global.RCCrypto.checkPassword(pw);
    els.pwdMeter.dataset.score = String(r.score || 1);
    var bar = els.pwdMeter.querySelector('span');
    if (bar) bar.style.width = (Math.max(1, r.score) / 4 * 100) + '%';
  }

  function savePwd() {
    var m = me();
    if (!m) return;
    var oldPw = els.pwdOld ? els.pwdOld.value : '';
    var p1 = els.pwdNew ? els.pwdNew.value : '';
    var p2 = els.pwdNew2 ? els.pwdNew2.value : '';

    if (!oldPw) { showErr(els.pwdErr, '请输入当前密码'); return; }
    if (p1 !== p2) { showErr(els.pwdErr, '两次输入的新密码不一致'); return; }
    var chk = global.RCCrypto.checkPassword(p1);
    if (!chk.ok) { showErr(els.pwdErr, chk.msg); return; }

    var btn = els.btnPwdSave;
    if (btn) btn.disabled = true;
    global.RCSession.changePassword(oldPw, p1).then(function (r) {
      if (btn) btn.disabled = false;
      if (!r.ok) { showErr(els.pwdErr, r.msg); return; }
      els.pwdModal.classList.remove('show');
      hooks.toast('密码已更新');
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      showErr(els.pwdErr, '修改失败：' + (e && e.message || e));
    });
  }

  /* -------------------- 会话刷新 -------------------- */

  function refreshSession() {
    var m = global.RCSession ? global.RCSession.refresh() : null;
    paintChip();
    if (hooks.onMe) hooks.onMe(m);
    return m;
  }

  /* -------------------- 绑定 -------------------- */

  function bind() {
    [els.chipHome, els.chipClass].forEach(function (chip) {
      if (!chip) return;
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menuOpen) closeMenu();
        else openMenu(chip);
      });
    });

    if (els.menuPwd) els.menuPwd.addEventListener('click', function () { closeMenu(); openPwd(); });
    if (els.menuUsers) els.menuUsers.addEventListener('click', function () { closeMenu(); openUsers(); });
    if (els.menuOut) els.menuOut.addEventListener('click', function () {
      closeMenu();
      if (!global.confirm('退出登录？')) return;
      if (hooks.onSignOut) hooks.onSignOut();
    });

    if (els.btnUserAdd) els.btnUserAdd.addEventListener('click', function () { openForm(''); });
    if (els.btnUserSave) els.btnUserSave.addEventListener('click', saveUser);
    if (els.btnUserCancel) els.btnUserCancel.addEventListener('click', closeForm);

    if (els.ufRole) els.ufRole.addEventListener('change', function () {
      // 换角色后默认权限变了，重画勾选（保留用户手动改过的覆盖项）
      var overrides = collectPerms(els.ufRole.value);
      renderPerms(els.ufRole.value, overrides);
    });

    if (els.ufPerms) els.ufPerms.addEventListener('click', function (e) {
      if (e.target.tagName === 'SUMMARY') return;
    });

    if (els.pwdNew) els.pwdNew.addEventListener('input', function () { paintMeter(els.pwdNew.value); });
    if (els.btnPwdSave) els.btnPwdSave.addEventListener('click', savePwd);
    if (els.pwdNew2) els.pwdNew2.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); savePwd(); }
    });

    global.addEventListener('resize', function () { if (menuOpen) closeMenu(); });
    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuOpen) closeMenu();
    });
  }

  function openUsers() {
    var m = me();
    if (!m || !global.RCSession.can('user.manage')) { hooks.toast('没有人员管理权限', 'warn'); return; }
    closeForm();
    renderUsers();
    els.usersModal.classList.add('show');
  }

  /**
   * 启动账号 UI。
   * @param {{toast:Function, onSignOut:Function, onMe:Function}} opt
   */
  function start(opt) {
    opt = opt || {};
    if (opt.toast) hooks.toast = opt.toast;
    if (opt.onSignOut) hooks.onSignOut = opt.onSignOut;
    if (opt.onMe) hooks.onMe = opt.onMe;
    cache();
    /* start() 可能被调用多次（登录成功后、刷新会话后）。事件只能绑一次，
       否则同一个点击被处理两遍——用户菜单会「打开又立刻关闭」。 */
    if (!bound) { bind(); bound = true; }
    paintChip();
  }

  global.RCUserUI = {
    start: start,
    refresh: function () { cache(); paintChip(); },
    openUsers: openUsers,
    openPwd: openPwd,
    paintChip: paintChip
  };
})(window);
