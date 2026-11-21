/* ============================================================
   edu-ui.js — 「一键读取教务名单」的界面层
   ------------------------------------------------------------
   职责边界（重要）：
     · 本文件只管「按钮状态 + 弹窗 + 结果展示」
     · 真正的拉取与落库在服务端（routes/edu.ts + domain/edu.ts）
     · 前端不解析教务报文，也不做 upsert —— 否则两边逻辑会漂移

   两种模式的行为差异：
     · 服务器模式：GET /edu/status 判断是否配置；配置了才允许点同步
     · 本机模式：没有服务端，按钮置灰并说明原因（不弹错误框，
       因为这不是用户操作失误，是环境限制）
   ============================================================ */
(function (global) {
  'use strict';

  var els = {};
  var syncing = false;
  var lastStatus = null;

  function $(id) { return document.getElementById(id); }

  function cache() {
    els.btn = $('btnEduSync');
    els.modal = $('eduModal');
    els.state = $('eduState');
    els.detail = $('eduDetail');
    els.runs = $('eduRuns');
    els.btnRun = $('btnEduRun');
    els.btnClose = $('btnEduClose');
    els.err = $('eduErr');
    els.spinner = $('eduSpinner');
  }

  function isRemote() {
    return !!(global.RCSession && global.RCSession.isRemote && global.RCSession.isRemote());
  }

  function toast(msg, kind) {
    if (global.RC && typeof global.RC.toast === 'function') global.RC.toast(msg, kind);
  }

  function showErr(msg) {
    if (!els.err) return;
    if (!msg) { els.err.textContent = ''; els.err.classList.add('hidden'); return; }
    els.err.textContent = msg;
    els.err.classList.remove('hidden');
  }

  function busy(on) {
    syncing = on;
    if (els.btnRun) {
      els.btnRun.disabled = on;
      els.btnRun.textContent = on ? '读取中…' : '开始读取';
    }
    if (els.spinner) els.spinner.classList.toggle('hidden', !on);
    if (els.btn) els.btn.disabled = on;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- 状态渲染 ---------- */

  function renderStatus(st) {
    lastStatus = st;
    if (!els.state) return;

    if (!st) {
      els.state.textContent = '未连接服务器';
      els.state.className = 'edu-state is-off';
      if (els.btnRun) els.btnRun.disabled = true;
      return;
    }

    if (st.configured) {
      els.state.textContent = '已配置 · ' + (st.baseUrl || '');
      els.state.className = 'edu-state is-on';
      if (els.btnRun) els.btnRun.disabled = syncing;
    } else {
      els.state.textContent = '未配置教务系统地址';
      els.state.className = 'edu-state is-off';
      if (els.btnRun) els.btnRun.disabled = true;
    }

    if (els.detail) {
      var rows = [
        ['接口地址', st.baseUrl || '（未设置 EDU_BASE_URL）'],
        ['访问令牌', st.hasToken ? '已设置' : '（未设置 EDU_TOKEN）'],
        ['身份字段', st.idField === 'studentno' ? '学号' : '身份证号（只存摘要）'],
        ['超时', (st.timeoutMs || 0) + ' ms']
      ];
      els.detail.innerHTML = rows.map(function (r) {
        return '<div class="edu-kv"><span>' + r[0] + '</span><b>' + escapeHtml(r[1]) + '</b></div>';
      }).join('');
    }

    renderRuns(st.runs || []);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderRuns(runs) {
    if (!els.runs) return;
    if (!runs.length) {
      els.runs.innerHTML = '<div class="edu-run-empty">还没有同步记录</div>';
      return;
    }
    els.runs.innerHTML = runs.map(function (r) {
      var ok = r.status === 'ok';
      var cls = ok ? 'is-ok' : (r.status === 'running' ? 'is-running' : 'is-fail');
      var label = ok ? '成功' : (r.status === 'running' ? '进行中' : '失败');
      var meta = ok
        ? '班级 ' + (r.classCount || 0) + ' · 学生 ' + (r.studentCount || 0) + ' · 讲师 ' + (r.teacherCount || 0)
        : (r.message || '—');
      return '<div class="edu-run ' + cls + '">' +
        '<span class="edu-run-badge">' + label + '</span>' +
        '<span class="edu-run-time">' + fmtTime(r.startedAt || r.createdAt) + '</span>' +
        '<span class="edu-run-meta">' + escapeHtml(meta) + '</span>' +
        '</div>';
    }).join('');
  }

  /* ---------- 打开弹窗 ---------- */

  function open() {
    if (!els.modal) return;
    showErr('');
    if (!isRemote()) {
      renderStatus(null);
      if (els.detail) {
        els.detail.innerHTML = '<div class="edu-kv"><span>当前模式</span><b>本机模式</b></div>' +
          '<div class="edu-hint">本机模式没有服务端，无法连接教务系统。' +
          '请用服务器模式打开（例如 http://服务器地址:3210/）后再使用此功能。</div>';
      }
      if (els.runs) els.runs.innerHTML = '';
    } else {
      RCData.eduStatus().then(function (r) {
        if (r.ok) renderStatus(r.status);
        else { renderStatus(null); showErr(r.msg || '读取状态失败'); }
      });
    }
    els.modal.classList.add('show');
  }

  function close() {
    if (els.modal) els.modal.classList.remove('show');
  }

  /* ---------- 执行同步 ---------- */

  function run() {
    if (syncing) return;
    if (!isRemote()) { showErr('本机模式无法读取教务名单'); return; }
    if (lastStatus && !lastStatus.configured) {
      showErr('服务端还没有配置教务系统地址（EDU_BASE_URL），请联系管理员');
      return;
    }

    showErr('');
    busy(true);

    RCData.eduSync().then(function (r) {
      busy(false);
      if (!r.ok) {
        showErr(r.msg || '同步失败');
        toast(r.msg || '同步失败', 'warn');
        return;
      }
      var d = r.result || {};
      // 服务端返回的是 classCount / studentCount，不是 classes / students
      var nc = d.classCount || d.classes || 0;
      var ns = d.studentCount || d.students || 0;
      var nt = d.teacherCount || d.teachers || 0;
      toast('已读取 ' + nc + ' 个班级、' + ns + ' 名学生' + (nt ? '、' + nt + ' 名讲师' : ''), 'ok');
      close();
      // 名单变了 → 让 app 重新从适配器拉一遍并重绘
      if (global.RC && typeof global.RC.reloadAfterEduSync === 'function') {
        global.RC.reloadAfterEduSync();
      }
    }).catch(function (e) {
      busy(false);
      showErr('同步出错：' + ((e && e.message) || e));
    });
  }

  /* ---------- 启动 ---------- */

  function start() {
    cache();
    if (!els.btn) return;

    els.btn.addEventListener('click', open);
    if (els.btnClose) els.btnClose.addEventListener('click', close);
    if (els.btnRun) els.btnRun.addEventListener('click', run);
    if (els.modal) {
      els.modal.addEventListener('click', function (e) {
        if (e.target === els.modal) close();
      });
    }

    // 本机模式下按钮置灰但保留（hover 有说明），
    // 直接隐藏会让人以为「这个功能不存在」
    if (!isRemote()) {
      els.btn.classList.add('is-off');
      els.btn.title = '本机模式无法连接教务系统，请用服务器模式打开';
    }
  }

  global.RCEduUI = {
    start: start,
    open: open,
    close: close,
    run: run,
    renderStatus: renderStatus,
    isRemote: isRemote
  };
})(window);
