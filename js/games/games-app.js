/* ============================================================
   课堂小游戏 —— 页面渲染与游戏面板
   依赖：games-data.js（window.GAMES / window.CATS / window.RENDERERS）
   本文件同时为 renderers.js 提供全局 toast / tone / burst
   ============================================================ */
(function (global) {
  'use strict';

  var CAT_ICON = {
    warm: '🔥', mind: '🧠', create: '✨',
    observe: '👀', pass: '🎯', body: '🤸'
  };

  var els = {};
  var activeCleanup = [];
  var lastTrigger = null;
  var currentFilter = 'all';

  function $(sel, root) { return (root || document).querySelector(sel); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* -------------------- 全局能力桥接 -------------------- */

  /** renderers.js 直接调用裸 toast()，这里桥到主应用的 RC.toast */
  function gtoast(msg, kind) {
    if (global.RC && typeof global.RC.toast === 'function') {
      global.RC.toast(msg, kind || '');
      return;
    }
    var box = document.getElementById('toast');
    if (!box) return;
    box.textContent = msg;
    box.className = 'toast show' + (kind ? ' ' + kind : '');
    setTimeout(function () { box.className = 'toast' + (kind ? ' ' + kind : ''); }, 2000);
  }

  var audioCtx = null;
  function gtone(freq, dur, type, vol) {
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = typeof freq === 'number' ? freq : 660;
      gain.gain.value = typeof vol === 'number' ? vol : 0.05;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (dur || 0.12));
      osc.stop(audioCtx.currentTime + (dur || 0.12));
    } catch (e) { /* 静默失败 */ }
  }

  var CONFETTI = ['#2563eb', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#a855f7'];
  function gburst(host, count) {
    if (!host) return;
    var n = typeof count === 'number' ? count : 46;
    for (var i = 0; i < n; i++) {
      var s = document.createElement('i');
      s.className = 'confetti';
      s.style.left = Math.random() * 100 + '%';
      s.style.background = CONFETTI[i % CONFETTI.length];
      s.style.width = (5 + Math.random() * 5) + 'px';
      s.style.height = (8 + Math.random() * 8) + 'px';
      s.style.animationDuration = (1.4 + Math.random() * 1.2) + 's';
      s.style.animationDelay = (Math.random() * 0.35) + 's';
      s.style.setProperty('--dx', (Math.random() * 240 - 120) + 'px');
      s.style.setProperty('--rot', (Math.random() * 760 - 380) + 'deg');
      host.appendChild(s);
      (function (node) { setTimeout(function () { node.remove(); }, 3200); })(s);
    }
  }

  global.toast = gtoast;
  global.tone = gtone;
  global.burst = gburst;

  /* -------------------- 卡片网格 -------------------- */

  function cardHTML(g, i) {
    var cat = (global.CATS && global.CATS[g.cat]) || { label: g.cat };
    var tier = (global.TIER_LABEL && global.TIER_LABEL[g.tier]) || g.tier;
    var icon = CAT_ICON[g.cat] || '🎲';
    var playable = !!global.RENDERERS[g.id];
    return '' +
      '<button class="game-card' + (playable ? '' : ' is-card-only') + '" type="button" ' +
        'data-open="' + esc(g.id) + '" style="--i:' + i + '" ' +
        'aria-label="打开「' + esc(g.name) + '」">' +
        '<span class="gc-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="gc-main">' +
          '<span class="gc-title">' + esc(g.name) +
            '<em class="gc-badge">' + esc(tier) + '</em>' +
          '</span>' +
          '<span class="gc-desc">' + esc(g.desc) + '</span>' +
          '<span class="gc-meta">' +
            '<span class="gc-meta-item">' + esc(cat.label) + '</span>' +
            '<span class="gc-meta-item">' + (playable ? '可现场操作' : '投影规则卡') + '</span>' +
          '</span>' +
        '</span>' +
        '<span class="gc-play" aria-hidden="true">' + (playable ? '开始' : '查看') + '</span>' +
      '</button>';
  }

  function renderCards() {
    var grid = els.grid;
    if (!grid) return;
    var list = (global.GAMES || []).filter(function (g) {
      return currentFilter === 'all' || g.cat === currentFilter;
    });
    if (!list.length) {
      grid.innerHTML = '<div class="game-empty">这个分类下还没有玩法</div>';
    } else {
      grid.innerHTML = list.map(cardHTML).join('');
    }
    if (els.count) els.count.textContent = list.length + ' 个玩法';
  }

  function renderFilters() {
    var box = els.filters;
    if (!box) return;
    var order = global.CAT_ORDER || [];
    var cats = global.CATS || {};
    var items = [{ key: 'all', label: '全部' }].concat(order.map(function (k) {
      return { key: k, label: (cats[k] && cats[k].label) || k };
    }));
    box.innerHTML = items.map(function (it) {
      return '<button class="game-filter' + (it.key === currentFilter ? ' active' : '') + '" ' +
        'type="button" role="tab" data-filter="' + esc(it.key) + '" ' +
        'aria-selected="' + (it.key === currentFilter) + '">' + esc(it.label) + '</button>';
    }).join('');
  }

  /* -------------------- 游戏面板 -------------------- */

  function projectionHTML(g) {
    var cat = (global.CATS && global.CATS[g.cat]) || { label: g.cat };
    var tier = (global.TIER_LABEL && global.TIER_LABEL[g.tier]) || g.tier;
    var note = g.tier === 'card'
      ? '这个玩法依赖真实教室、身体动作与现场互动，网页版提供投影规则卡，游戏照常在教室里进行。'
      : '这是辅助工具，网页版提供规则卡投影讲解。';
    return '' +
      '<div class="stage">' +
        '<div class="projection">' +
          '<div class="projection-top">' +
            '<p class="kicker">' + esc(cat.label) + ' · ' + esc(g.no) + ' · ' + esc(tier) + '</p>' +
            '<h3>' + esc(g.name) + '</h3>' +
          '</div>' +
          '<div class="projection-body">' +
            '<ol>' + g.rules.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol>' +
            '<p class="projection-mats"><b>物料</b> · ' + esc(g.mats) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="notice' + (g.tier === 'card' ? ' ink' : '') + '">' + note + '</div>' +
      '</div>';
  }

  function runCleanup() {
    activeCleanup.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略 */ } });
    activeCleanup = [];
  }

  function openSheet(id) {
    var games = global.GAMES || [];
    var g = null;
    for (var i = 0; i < games.length; i++) { if (games[i].id === id) { g = games[i]; break; } }
    if (!g) return;

    if (typeof global.stopVoiceInput === 'function') global.stopVoiceInput();

    var sheetEl = els.sheet;
    var rulesEl = els.rules;
    var stageEl = els.stage;
    if (!sheetEl || !rulesEl || !stageEl) return;

    lastTrigger = document.activeElement;

    var cat = (global.CATS && global.CATS[g.cat]) || { label: g.cat };
    els.kicker.textContent = cat.label + ' · ' + g.no;
    els.title.textContent = g.name;

    rulesEl.innerHTML = '' +
      '<div class="rules-block">' +
        '<h3>玩法规则</h3>' +
        '<ol class="rules-list">' + g.rules.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol>' +
      '</div>' +
      '<div class="rules-block">' +
        '<h3>物料</h3>' +
        '<p class="mats">' + esc(g.mats) + '</p>' +
        '<ul class="tips-list">' + g.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
      '</div>';

    runCleanup();
    stageEl.innerHTML = '';
    stageEl.scrollTop = 0;

    var api = {
      cleanup: function (fn) { if (typeof fn === 'function') activeCleanup.push(fn); },
      toast: gtoast,
      tone: gtone,
      burst: function (count) {
        gburst(sheetEl.querySelector('.sheet-panel'), typeof count === 'number' ? count : 46);
      }
    };

    var renderer = global.RENDERERS && global.RENDERERS[g.id];
    try {
      if (typeof renderer === 'function') renderer(stageEl, api);
      else stageEl.innerHTML = projectionHTML(g);
    } catch (err) {
      if (global.console) console.error('[RCGames]', err);
      stageEl.innerHTML = '<div class="notice">这个玩法加载出错了，关闭后重试。</div>';
    }

    if (typeof global.enhanceVoiceInputs === 'function') global.enhanceVoiceInputs(sheetEl);

    sheetEl.classList.add('open');
    sheetEl.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      var panel = sheetEl.querySelector('.sheet-panel');
      if (panel) { try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); } }
    }, 60);
  }

  function closeSheet() {
    var sheetEl = els.sheet;
    if (!sheetEl || !sheetEl.classList.contains('open')) return;
    if (typeof global.stopVoiceInput === 'function') global.stopVoiceInput();
    runCleanup();
    sheetEl.classList.remove('open');
    sheetEl.setAttribute('aria-hidden', 'true');
    if (lastTrigger && typeof lastTrigger.focus === 'function') {
      try { lastTrigger.focus({ preventScroll: true }); } catch (e) { lastTrigger.focus(); }
    }
  }

  function isOpen() {
    return !!(els.sheet && els.sheet.classList.contains('open'));
  }

  /* -------------------- 初始化 -------------------- */

  function cache() {
    els.screen = document.getElementById('screenGames');
    els.grid = document.getElementById('gameGrid');
    els.filters = document.getElementById('gameFilters');
    els.count = document.getElementById('gamesCount');
    els.sheet = document.getElementById('sheet');
    els.kicker = document.getElementById('sheetKicker');
    els.title = document.getElementById('sheetTitle');
    els.rules = document.getElementById('sheetRules');
    els.stage = document.getElementById('sheetStage');
  }

  function bind() {
    if (els.filters) {
      els.filters.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-filter]');
        if (!btn) return;
        currentFilter = btn.dataset.filter;
        renderFilters();
        renderCards();
      });
    }
    if (els.grid) {
      els.grid.addEventListener('click', function (e) {
        var opener = e.target.closest('[data-open]');
        if (!opener) return;
        openSheet(opener.dataset.open);
      });
    }
    if (els.sheet) {
      els.sheet.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) closeSheet();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!isOpen()) return;
      e.stopPropagation();
      closeSheet();
    }, true);
  }

  function start() {
    cache();
    if (!els.grid) return;
    renderFilters();
    renderCards();
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.RCGames = {
    render: function () { renderFilters(); renderCards(); },
    open: openSheet,
    close: closeSheet,
    isOpen: isOpen
  };

})(window);
