/* ============================================================
   app.js — 入口：状态管理、事件绑定、流程编排
   ------------------------------------------------------------
   数据模型
     state.students      全部学生 [{name,id,group}]（group=班级）
     state.currentClass  当前班级（''=未分班）
     state.pickedByClass {班级: [studentKey]} 每班独立的「本轮已抽」
     state.scores        当前班级的加分记录 {records:[{id,t,name,sid,delta,reason}]}
     state.selected      {studentKey: 1} 面板里的多选集合
   持久化
     rollcall.roster.v1 / history.v1 / settings.v1 / state.v1 / classes.v1
     rollcall.scores.v1.<班级>  每班一个键
   ============================================================ */

(function (global) {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* -------------------- 状态 -------------------- */

  var state = {
    students: [],          // [{name,id,group}] 全部班级
    classes: [],           // [{name,createdAt}] 班级元数据（含空班级）
    view: 'home',          // 'home' | 'class' | 'games'
    gamesFrom: 'home',     // 小游戏页的来处：'home' | 'class'
    currentClass: '',      // 当前班级名
    pickedByClass: {},     // {班级: [key]}
    scores: { records: [] },// 当前班级加分记录
    selected: {},          // {key:1} 多选集合
    selectMode: false,
    history: [],           // [{t, name, id, group, anim}]
    settings: {
      anim: 'spotlight',
      theme: 'gold',
      fast: false,
      sound: true,
      autoClose: false,
      repeat: false,
      panel: true
    },
    busy: false,
    lastDraw: null,        // {student, prevPicked, historyLen}
    pendingImport: [],     // 预览中的学生
    importTarget: null,    // 从班级卡片进来时指定归属班级（null=弹窗里选）
    nameMode: 'new',       // 'new' | 'rename'
    nameTarget: '',        // 重命名的原班级名
    focusKey: '',          // 右侧面板「当前学生」（替代原详情弹窗）
    homeTab: 'rank',       // 首页标签页：'rank'（排行榜）| 'classes'（所有班级）
    stuPeriod: 'week',     // 本周之星周期：'week' | 'all' | 'custom'
    clsPeriod: 'all',      // 班级总分排名周期：'week' | 'month' | 'all' | 'custom'
    stuRange: { from: '', to: '' },  // 学生榜自定义期限（'YYYY-MM-DD'，空=不限）
    clsRange: { from: '', to: '' },  // 班级榜自定义期限
    rankMode: 'class',     // 导出时用的榜单类型：'class' | 'student'
    pendingView: '',       // 刷新后要恢复的页面：init() 记下，登录态就绪后由 afterMeChanged() 消费
    dataMode: 'local',     // 数据源：'local' | 'remote'
    dataReason: '',        // 数据源判定原因（用于角标与设置页展示）
    me: null               // 当前用户与权限（远程模式有值）
  };

  /** 撤销栈：每步存 {cls, records, label}，最多 MAX_UNDO 步 */
  var undoStack = [];
  var MAX_UNDO = 40;

  var els = {};
  var toastTimer = 0;
  var resultTimer = 0;
  var resultShowTimer = 0;

  /* -------------------- 初始化 -------------------- */

  function cacheEls() {
    els = {
      app: $('#app'),
      screenHome: $('#screenHome'),
      screenClass: $('#screenClass'),
      screenGames: $('#screenGames'),
      homeSummary: $('#homeSummary'),
      homeCount: $('#homeCount'),
      homeSearch: $('#homeSearch'),
      classGrid: $('#classGrid'),
      homeEmpty: $('#homeEmpty'),
      wbTitle: $('#wbTitle'),
      nameModal: $('#nameModal'),
      nameModalTitle: $('#nameModalTitle'),
      nameInput: $('#nameInput'),
      nameHint: $('#nameHint'),
      importAssign: $('#importAssign'),
      importNewName: $('#importNewName'),
      importAssignTip: $('#importAssignTip'),
      className: $('#className'),
      classBar: $('.class-bar'),
      classSelect: $('#classSelect'),
      workspace: $('#workspace'),
      scorePanel: $('#scorePanel'),
      stage: $('#stage'),
      emptyState: $('#emptyState'),
      cardGrid: $('#cardGrid'),
      spotGlow: $('#spotGlow'),
      rollerTop: $('#rollerTop'),
      rollerMain: $('#rollerMain'),
      rollerName: $('#rollerName'),
      rollerBottom: $('#rollerBottom'),
      wheelCanvas: $('#wheelCanvas'),
      confettiCanvas: $('#confettiCanvas'),
      wheelHubText: $('#wheelHubText'),
      resultOverlay: $('#resultOverlay'),
      resultName: $('#resultName'),
      resultMeta: $('#resultMeta'),
      resultScore: $('#resultScore'),
      statPicked: $('#statPicked'),
      statLeft: $('#statLeft'),
      statTotal: $('#statTotal'),
      homeTop3: $('#homeTop3'),
      mClasses: $('#mClasses'),
      mStudents: $('#mStudents'),
      mTotal: $('#mTotal'),
      wbTotalNum: $('#wbTotalNum'),
      wbTop3: $('#wbTop3'),
      // 首页标签页与排行榜界面（原弹窗已改独立界面）
      homeTabs: $('#homeTabs'),
      paneRank: $('#paneRank'),
      paneClasses: $('#paneClasses'),
      classesTools: $('#classesTools'),
      stuPodium: $('#stuPodium'),
      stuList: $('#stuList'),
      stuPeriod: $('#stuPeriod'),
      stuTitle: $('#stuTitle'),
      stuHint: $('#stuHint'),
      clsPodium: $('#clsPodium'),
      clsList: $('#clsList'),
      clsPeriod: $('#clsPeriod'),
      clsHint: $('#clsHint'),
      stuRange: $('#stuRange'),
      stuFrom: $('#stuFrom'),
      stuTo: $('#stuTo'),
      clsRange: $('#clsRange'),
      clsFrom: $('#clsFrom'),
      clsTo: $('#clsTo'),
      // 平均分榜：与总分榜共享周期，所以不需要自己的 period/range 控件
      avgPodium: $('#avgPodium'),
      avgList: $('#avgList'),
      avgHint: $('#avgHint'),
      btnUndoOp: $('#btnUndoOp'),
      btnDraw: $('#btnDraw'),
      drawText: $('.draw-btn-text'),
      modeRepeat: $('#modeRepeat'),
      toast: $('#toast'),
      importModal: $('#importModal'),
      importPick: $('#importPick'),
      importPreview: $('#importPreview'),
      previewList: $('#previewList'),
      previewSummary: $('#previewSummary'),
      previewDetect: $('#previewDetect'),
      fileInput: $('#fileInput'),
      manualInput: $('#manualInput'),
      historyModal: $('#historyModal'),
      historyList: $('#historyList'),
      settingsModal: $('#settingsModal'),
      exportModal: $('#exportModal'),
      // 面板
      panelClassLabel: $('#panelClassLabel'),
      panelSelCount: $('#panelSelCount'),
      panelTotalNum: $('#panelTotalNum'),
      panelRecCount: $('#panelRecCount'),
      selChips: $('#selChips'),
      quickRow: $('#quickRow'),
      customScore: $('#customScore'),
      scoreReason: $('#scoreReason'),
      scoreReasonOther: $('#scoreReasonOther'),
      btnApplyScore: $('#btnApplyScore'),
      applyOpHint: $('#applyOpHint'),
      scoreLog: $('#scoreLog'),
      panelSum: $('#panelSum'),
      exportList: $('#exportList'),
      exportHint: $('#exportHint'),
      // 当前学生（面板内联，替代原详情弹窗）
      focusCard: $('#focusCard'),
      focusName: $('#focusName'),
      focusTotal: $('#focusTotal'),
      focusToday: $('#focusToday'),
      focusMeta: $('#focusMeta'),
      btnFocusPick: $('#btnFocusPick'),
      btnFocusClear: $('#btnFocusClear'),
      btnFocusClose: $('#btnFocusClose')
    };
  }

  function init() {
    cacheEls();

    // 读缓存
    state.students = RCData.loadRoster();
    var st = RCData.loadState();
    state.history = RCData.loadHistory();
    state.settings = RCData.loadSettings();
    state.pickedByClass = st.pickedByClass || {};

    // 迁移旧版本：旧版只有一个全局 picked 列表
    if (st.picked && st.picked.length && !Object.keys(state.pickedByClass).length) {
      var first = RCScore.groupsOf(state.students)[0] || '';
      state.pickedByClass[first] = st.picked.slice();
      savePicked();
    }

    // 当前班级：存的班级还存在就用它，否则用名单里的第一个
    var cls = RCData.loadClasses();
    var saved = cls.current;
    state.classes = RCClasses.ensure(cls.list, state.students);
    var names = state.classes.map(function (c) { return c.name; });
    state.currentClass = names.indexOf(saved) >= 0 ? saved : (names[0] || '');

    loadClassScores();
    // 界面位置优先用上次保存的，没有才退回设置里的默认值
    state.clsPeriod = st.clsPeriod || state.settings.rankPeriod || 'all';
    state.stuPeriod = st.stuPeriod || 'week';
    state.stuRange = st.stuRange || { from: '', to: '' };
    state.clsRange = st.clsRange || { from: '', to: '' };
    state.homeTab = st.homeTab === 'classes' ? 'classes' : 'rank';
    syncUndoBtn();

    // 应用设置
    applyTheme(state.settings.theme);
    syncThemePills();
    RCAudio.setEnabled(state.settings.sound);
    els.modeRepeat.checked = !!state.settings.repeat;
    $('#optFast').checked = !!state.settings.fast;
    $('#optSound').checked = !!state.settings.sound;
    $('#optAutoClose').checked = !!state.settings.autoClose;
    applyPanelVisible(state.settings.panel !== false);

    // 动画模块挂载
    AnimSpotlight.mount(els.cardGrid, els.spotGlow);
    AnimRoller.mount(els.rollerName, els.rollerTop, els.rollerBottom, $('#rollerLabel'));
    AnimWheel.setup(els.wheelCanvas, els.confettiCanvas, els.wheelHubText);
    AnimWheel.setTheme(state.settings.theme);

    bindEvents();

    // 首次渲染
    switchAnim(state.settings.anim, true);
    applyPerms();
    refreshAll();
    renderHome();
    switchHomeTab(state.homeTab);
    /* 刷新后要回到上次所在的页面。此刻登录态还没恢复（RCLogin 在 init() 之后才跑），
       canSeeClass()/isViewer() 判断不可靠，所以这里只记下意图，交给 afterMeChanged() 消费。 */
    state.pendingView = st.view === 'class' || st.view === 'games' ? st.view : '';
    showScreen('home');

    global.addEventListener('resize', debounce(function () {
      AnimWheel.resize();
      syncResultReserve();
      AnimSpotlight.fitGrid();
    }, 180));
  }

  /* -------------------- 界面切换（首页 / 班级工作台） -------------------- */

  function showScreen(name) {
    state.view = name === 'class' ? 'class' : (name === 'games' ? 'games' : 'home');
    if (els.screenHome) els.screenHome.classList.toggle('active', state.view === 'home');
    if (els.screenClass) els.screenClass.classList.toggle('active', state.view === 'class');
    if (els.screenGames) els.screenGames.classList.toggle('active', state.view === 'games');
    document.body.dataset.screen = state.view;
    if (state.view === 'class') {
      // 切进工作台后舞台才有尺寸，下一帧重算网格与画布
      requestAnimationFrame(function () {
        syncResultReserve();
        AnimSpotlight.fitGrid();
        AnimWheel.resize();
      });
    }
  }

  /* -------------------- 课堂小游戏页 -------------------- */

  /**
   * 打开小游戏页。gamesFrom 记住来处，返回时回到原页面而不是固定回首页。
   */
  function openGames() {
    if (state.busy) { toast('抽取动画进行中，稍后再进入小游戏', 'warn'); return; }
    state.gamesFrom = state.view === 'class' ? 'class' : 'home';
    hideResult();
    if (global.RCGames && typeof global.RCGames.render === 'function') global.RCGames.render();
    showScreen('games');
    saveView();
  }

  function closeGames() {
    if (global.RCGames && typeof global.RCGames.close === 'function') global.RCGames.close();
    if (state.gamesFrom === 'class' && state.currentClass) {
      showScreen('class');
      saveView();
      requestAnimationFrame(function () {
        syncResultReserve();
        AnimSpotlight.fitGrid();
        AnimWheel.resize();
      });
    } else {
      renderHome();
      showScreen('home');
      saveView();
    }
  }

  function enterClass(name) {
    var n = String(name == null ? '' : name);
    /* 访客纯只读：首页看班级列表/总分/前三名/排行榜，不进入工作台，也不做任何跳转 */
    if (isViewer()) return;
    if (n && !canSeeClass(n)) {
      toast('当前账号没有「' + RCScore.classLabel(n) + '」的访问权限', 'warn');
      return;
    }
    state.currentClass = n;
    state.selected = {};
    state.selectMode = false;
    state.lastDraw = null;
    RCData.saveClasses({ current: n, list: state.classes });
    loadClassScores();
    loadClassScoresFromServer();
    syncUndoBtn();

    AnimSpotlight.clearWinner();
    AnimRoller.reset();
    AnimWheel.reset();
    hideResult();

    refreshAll();
    showScreen('class');
    saveView();
    if (els.wbTitle) els.wbTitle.textContent = RCScore.classLabel(n);
  }

  function backHome() {
    if (state.busy) { toast('抽取动画进行中，稍后再返回', 'warn'); return; }
    hideResult();
    renderHome();
    renderRank();
    showScreen('home');
    saveView();
  }

  /* -------------------- 首页：班级列表 -------------------- */

  function classStats(name) {
    var recs = RCData.loadScores(name).records;
    return RCClasses.statsOf(name, state.students, recs);
  }

  /* -------------------- 前三名 -------------------- */

  /**
   * 排行榜周期起点（毫秒时间戳）：总榜返回 0，周榜返回本周一 00:00，月榜返回本月 1 日 00:00
   */
  function periodStart(period) {
    var d = new Date();
    if (period === 'week') {
      var day = (d.getDay() + 6) % 7; // 周一 = 0
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - day);
      return d.getTime();
    }
    if (period === 'month') {
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      return d.getTime();
    }
    return 0;
  }

  function periodLabel(period, range) {
    if (period === 'week') return '本周';
    if (period === 'month') return '本月';
    if (period === 'custom') {
      var a = (range && range.from) || '';
      var b = (range && range.to) || '';
      if (a && b) return a.slice(5) + '~' + b.slice(5);
      if (a) return a.slice(5) + '起';
      if (b) return '截至' + b.slice(5);
      return '自定义期限';
    }
    return '全部';
  }

  /** Date → 'YYYY-MM-DD'（本地时区，date input 的 value 格式） */
  function fmtDay(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /** 'YYYY-MM-DD' → 当天 00:00 毫秒；无效/空返回 0 */
  function rangeDayStart(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return 0;
    var d = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
    var t = d.getTime();
    return isNaN(t) ? 0 : t;
  }

  /**
   * 周期 → 区间 {start, end}，end 为排他上界（0 = 不限）。
   * period='custom' 时用 range {from,to}（'YYYY-MM-DD'，含结束日当天）。
   */
  function periodRange(period, range) {
    if (period === 'custom') {
      var from = rangeDayStart(range && range.from);
      var to = rangeDayStart(range && range.to);
      // 起止填反了就自动交换，省得用户一头雾水
      if (from && to && from > to) { var tmp = from; from = to; to = tmp; }
      return { start: from, end: to ? to + 86400000 : 0 };
    }
    return { start: periodStart(period), end: 0 };
  }

  /** 按周期筛选加分记录（period='custom' 时按 range 的自定义区间） */
  function filterByPeriod(records, period, range) {
    var r = periodRange(period, range);
    if (!r.start && !r.end) return records;
    return records.filter(function (x) {
      var t = x.t || 0;
      if (r.start && t < r.start) return false;
      if (r.end && t >= r.end) return false;
      return true;
    });
  }

  /** 某个班级里总分最高的前 n 名学生（只取有正分的） */
  function classTopN(name, n, period, range) {
    var students = RCClasses.studentsOf(name, state.students);
    var map = RCScore.totals(filterByPeriod(RCData.loadScores(name).records, period, range));
    return students.map(function (s) {
      return { name: s.name, id: s.id, total: map[RCScore.studentKey(s)] || 0 };
    }).filter(function (s) {
      return s.total > 0;
    }).sort(function (a, b) {
      return b.total - a.total;
    }).slice(0, n);
  }

  /** 全名单（所有班级）里总分最高的前 n 名 */
  function allTopN(n, period, range) {
    var map = RCScore.totals(allRecords(period, range));
    // 同一名学生若同时出现在多个班级（同名同学号），totals 已按 name+sid 合并，
    // 但这里遍历的是名单行，会产出多条同分记录 → 按 studentKey 去重，只保留第一次出现。
    var seen = {};
    return state.students.map(function (s) {
      return {
        name: s.name,
        id: s.id,
        group: s.group || '',
        key: RCScore.studentKey(s),
        total: map[RCScore.studentKey(s)] || 0
      };
    }).filter(function (s) {
      if (s.total <= 0) return false;
      if (seen[s.key]) return false;
      seen[s.key] = 1;
      return true;
    }).sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    }).slice(0, n);
  }

  /** 汇总所有班级的加分记录（排行榜用），period 可选 */
  function allRecords(period, range) {
    var out = [];
    var seen = {};
    var names = state.classes.map(function (c) { return c.name; });
    RCData.listScoreClasses().forEach(function (c) {
      if (names.indexOf(c) < 0) names.push(c);
    });
    names.forEach(function (c) {
      if (seen[c]) return;
      seen[c] = 1;
      RCData.loadScores(c).records.forEach(function (r) { out.push(r); });
    });
    return period ? filterByPeriod(out, period, range) : out;
  }

  /** 渲染前三名徽章列表 */
  function renderTop3(el, list, emptyText) {
    if (!el) return;
    el.innerHTML = '';
    if (!list || !list.length) {
      el.innerHTML = '<span class="top3-empty">' + (emptyText || '还没有加分') + '</span>';
      return;
    }
    var medals = ['①', '②', '③'];
    var frag = document.createDocumentFragment();
    list.forEach(function (s, i) {
      var chip = document.createElement('span');
      chip.className = 'top3-chip rank-' + (i + 1);
      chip.title = (s.group ? s.group + ' · ' : '') + s.name + (s.id ? ' · ' + s.id : '');
      chip.innerHTML = '<i>' + medals[i] + '</i><b></b><em></em>';
      chip.querySelector('b').textContent = s.name;
      chip.querySelector('em').textContent = RCScore.fmtDelta(s.total).replace('+', '');
      frag.appendChild(chip);
    });
    el.appendChild(frag);
  }

  /** 渲染班级卡片内的「本班前三」三行（小标题也在这里建，避免被 innerHTML 清空） */
  /**
   * 班级卡片里的「本班前三」。
   * 每行底部有一条相对榜首的比例条：宽度 = 该生分数 / 本班第一名分数。
   * 这样卡片下半原本空着的那块被三条长度不同的蓝条填满，
   * 一眼能看出 4 分和 3 分差多少，而不只是三个数字。
   */
  function renderMiniTop(el, list) {
    if (!el) return;
    el.innerHTML = '';
    var hd = document.createElement('div');
    hd.className = 'cc-top-hd';
    hd.textContent = '本班前三';
    el.appendChild(hd);
    if (!list || !list.length) {
      // 空态时不要 space-between，否则「还没有加分」会被推到卡片最底部
      el.classList.add('is-empty');
      var empty = document.createElement('div');
      empty.className = 'cc-top-empty';
      empty.textContent = '还没有加分';
      el.appendChild(empty);
      return;
    }
    el.classList.remove('is-empty');
    // 不足 3 人时补占位行，保证卡片高度稳定、切班不跳动
    var rows = list.slice(0, 3);
    while (rows.length < 3) rows.push(null);
    var best = Number(list[0].total) || 0;
    rows.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'cc-top-row rank-' + (i + 1);
      if (!s) {
        row.classList.add('is-hole');
        row.innerHTML = '<i>' + (i + 1) + '</i><b>—</b><em></em>';
        el.appendChild(row);
        return;
      }
      row.title = s.name + (s.id ? ' · ' + s.id : '');
      row.innerHTML = '<i>' + (i + 1) + '</i><b></b><em></em>';
      row.querySelector('b').textContent = s.name;
      row.querySelector('em').textContent = RCScore.fmtDelta(s.total).replace('+', '');
      // 比例条：只给有正分的行画，避免负数把条压成 0 反而看不出差距
      var v = Number(s.total) || 0;
      if (best > 0 && v > 0) {
        var bar = document.createElement('span');
        bar.className = 'cc-top-bar';
        bar.style.width = Math.max(4, Math.round(v / best * 100)) + '%';
        row.appendChild(bar);
      }
      el.appendChild(row);
    });
  }

  /**
   * 首页数据刷新：班级卡片 + 排行榜。
   * 排行榜改成独立界面后，加分/导入等改动也要同步刷新榜单，
   * 所以统一从这里入口，避免 17 个调用点各写一遍。
   */
  function renderHome() {
    renderHomeInner();
    if (state.homeTab === 'rank') renderRank();
  }

  function renderHomeInner() {
    if (!els.classGrid) return;

    // 元数据与名单对齐：名单里出现但元数据没有的班级补进来
    state.classes = RCClasses.ensure(state.classes, state.students);

    var kw = (els.homeSearch && els.homeSearch.value || '').trim().toLowerCase();
    var list = state.classes.filter(function (c) {
      if (!canSeeClass(c.name)) return false;
      return !kw || c.name.toLowerCase().indexOf(kw) >= 0;
    });
    var visible = state.classes.filter(function (c) { return canSeeClass(c.name); });

    if (els.homeCount) {
      els.homeCount.textContent = visible.length
        ? ('共 ' + visible.length + ' 个班级' + (kw ? ' · 匹配 ' + list.length : ''))
        : '';
    }
    if (els.homeSummary) {
      var people = state.students.length;
      var total = 0;
      state.classes.forEach(function (c) { total += classStats(c.name).total; });
      els.homeSummary.textContent = visible.length
        ? (visible.length + ' 个班级 · ' + people + ' 名学生 · 累计 ' + RCScore.fmtNum(total) + ' 分')
        : '还没有班级';
      if (els.mClasses) els.mClasses.textContent = visible.length;
      if (els.mStudents) els.mStudents.textContent = people;
      if (els.mTotal) els.mTotal.textContent = RCScore.fmtNum(total);
    }

    els.classGrid.innerHTML = '';
    var empty = !state.classes.length;
    if (els.homeEmpty) els.homeEmpty.classList.toggle('hidden', !empty);

    if (!list.length) {
      if (!empty) {
        els.classGrid.innerHTML = '<div class="home-no-match">没有匹配的班级</div>';
      }
      return;
    }

    var frag = document.createDocumentFragment();
    list.forEach(function (c) {
      frag.appendChild(classCard(c));
    });
    els.classGrid.appendChild(frag);
  }

  function classCard(c) {
    var st = classStats(c.name);
    var writable = canEditClass(c.name);
    var viewer = isViewer();
    var card = document.createElement('div');
    card.className = 'class-card' + (writable ? '' : ' is-readonly') + (viewer ? ' is-viewer' : '');
    card.dataset.cls = c.name;
    card.tabIndex = viewer ? -1 : 0;

    var head = document.createElement('div');
    head.className = 'cc-head';
    var nm = document.createElement('h3');
    nm.className = 'cc-name';
    nm.textContent = RCScore.classLabel(c.name);
    head.appendChild(nm);
    if (!writable) {
      var bd = document.createElement('span');
      bd.className = 'cc-badge';
      bd.textContent = '只读';
      bd.title = '不在你的任教范围内，可以查看但不能加减分';
      head.appendChild(bd);
    }

    var menu = document.createElement('div');
    menu.className = 'cc-menu';
    var acts = '';
    if (writable) {
      if (canDo('class.rename')) acts += '<button class="cc-act" data-act="rename" title="重命名">✎</button>';
      if (canDo('roster.import')) acts += '<button class="cc-act" data-act="import" title="导入名单到本班">⬆</button>';
      if (canDo('class.delete')) acts += '<button class="cc-act danger" data-act="delete" title="删除班级">✕</button>';
    }
    if (!acts) menu.classList.add('hidden');
    menu.innerHTML = acts;
    head.appendChild(menu);
    card.appendChild(head);

    var nums = document.createElement('div');
    nums.className = 'cc-stats';
    nums.innerHTML =
      '<div class="cc-stat"><b>' + st.count + '</b><span>人数</span></div>' +
      '<div class="cc-stat"><b class="' + (st.total > 0 ? 'pos' : (st.total < 0 ? 'neg' : '')) + '">' +
      RCScore.fmtNum(st.total) + '</b><span>总分</span></div>' +
      // 平均分 = 班级总分 / 班级人数（statsOf 已算好，这里只负责展示）
      '<div class="cc-stat"><b class="' + (st.avg > 0 ? 'pos' : (st.avg < 0 ? 'neg' : '')) + '">' +
      RCScore.fmtNum(st.avg) + '</b><span>平均分</span></div>';
    card.appendChild(nums);

    // 本班前三：原来在首页顶栏，现在下沉到卡片里
    var top = document.createElement('div');
    top.className = 'cc-top';
    renderMiniTop(top, classTopN(c.name, 3));
    card.appendChild(top);

    var foot = document.createElement('div');
    foot.className = 'cc-foot';
    var last = st.last ? ('最近加分 ' + RCScore.fmtDateTime(st.last).slice(5, 16)) : '还没有加分记录';
    foot.innerHTML = '<span class="cc-last">' + last + '</span>' +
      '<span class="cc-rec">' + st.records + ' 条</span>';
    card.appendChild(foot);

    card.addEventListener('click', function (e) {
      if (viewer) return;
      var act = e.target.closest ? e.target.closest('.cc-act') : null;
      if (act) {
        e.stopPropagation();
        var a = act.dataset.act;
        if (a === 'rename') openNameModal('rename', c.name);
        else if (a === 'import') { state.importTarget = c.name; openImport(); }
        else if (a === 'delete') deleteClass(c.name);
        return;
      }
      enterClass(c.name);
    });
    card.addEventListener('keydown', function (e) {
      if (viewer) return;
      if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); enterClass(c.name); }
    });

    return card;
  }

  /* -------------------- 班级增删改 -------------------- */

  function openNameModal(mode, clsName) {
    if (!guard(mode === 'rename' ? 'class.rename' : 'class.create', '当前账号没有创建或重命名班级的权限')) return;
    state.nameMode = mode;
    state.nameTarget = clsName || '';
    if (els.nameModalTitle) {
      els.nameModalTitle.textContent = mode === 'rename' ? '重命名班级' : '新建班级';
    }
    if (els.nameInput) {
      els.nameInput.value = mode === 'rename' ? clsName : '';
      els.nameInput.placeholder = mode === 'rename' ? '新班级名' : '例如：一班 / 2024级计算机1班';
    }
    if (els.nameHint) {
      els.nameHint.textContent = '最多 ' + RCClasses.MAX_NAME + ' 个字，班级名不可重复';
      els.nameHint.classList.remove('warn');
    }
    showModal(els.nameModal);
    setTimeout(function () { if (els.nameInput) els.nameInput.focus(); }, 260);
  }

  function submitNameModal() {
    if (!els.nameInput) return;
    var val = els.nameInput.value;
    var mode = state.nameMode || 'new';
    var target = state.nameTarget || '';

    if (mode === 'rename') {
      var next = RCClasses.rename(state.classes, target, val);
      if (!next) {
        if (els.nameHint) {
          els.nameHint.textContent = RCClasses.has(state.classes, RCClasses.normName(val))
            ? '已有同名班级' : '请输入有效的班级名';
          els.nameHint.classList.add('warn');
        }
        return;
      }
      state.classes = next;

      // 名单里该班学生的 group 一起改，否则学生会掉出这个班
      state.students.forEach(function (s) {
        if (RCScore.classKey(s) === target) s.group = RCClasses.normName(val);
      });
      RCData.saveRoster(state.students);

      // 加分记录跟着班级走：换到新键下
      var recs = RCData.loadScores(target).records;
      if (recs.length) {
        RCData.saveScores(RCClasses.normName(val), recs);
        RCData.removeScores(target);
      }
      // 本轮已抽记录也跟着走
      var pk = state.pickedByClass[target];
      if (pk) {
        state.pickedByClass[RCClasses.normName(val)] = pk;
        delete state.pickedByClass[target];
        savePicked();
      }
      if (state.currentClass === target) state.currentClass = RCClasses.normName(val);

      RCData.saveClasses({ current: state.currentClass, list: state.classes });
      hideModal(els.nameModal);
      renderHome();
      refreshAll();
      toast('已重命名为「' + RCClasses.normName(val) + '」', 'ok');
      return;
    }

    var added = RCClasses.add(state.classes, val);
    if (!added) {
      if (els.nameHint) {
        els.nameHint.textContent = RCClasses.has(state.classes, RCClasses.normName(val))
          ? '已有同名班级' : '请输入有效的班级名';
        els.nameHint.classList.add('warn');
      }
      return;
    }
    state.classes = added;
    RCData.saveClasses({ current: state.currentClass, list: state.classes });
    hideModal(els.nameModal);
    renderHome();
    toast('已新建「' + RCClasses.normName(val) + '」', 'ok');
  }

  function deleteClass(name) {
    if (!guard('class.delete', '当前账号没有删除班级的权限')) return;
    var st = classStats(name);
    var msg = '删除班级「' + RCScore.classLabel(name) + '」？';
    if (st.count) msg += '\n该班 ' + st.count + ' 名学生的名单会一并移除。';
    if (st.records) msg += '\n该班 ' + st.records + ' 条加分记录会一并删除。';
    if (!confirm(msg)) return;

    state.classes = RCClasses.remove(state.classes, name);
    state.students = state.students.filter(function (s) {
      return RCScore.classKey(s) !== name;
    });
    RCData.saveRoster(state.students, { confirmClear: true });
    RCData.removeScores(name);
    delete state.pickedByClass[name];
    savePicked();
    if (state.currentClass === name) {
      state.currentClass = state.classes.length ? state.classes[0].name : '';
      loadClassScores();
    }
    // 用户已经在上面的 confirm() 里确认过：删到空班级 / 空名单是预期结果
    RCData.saveClasses({ current: state.currentClass, list: state.classes }, { confirmClear: true });
    renderHome();
    refreshAll();
    toast('已删除班级', 'ok');
  }

  /* -------------------- 班级与持久化 -------------------- */

  function currentStudents() {
    if (!state.students.length) return [];
    return state.students.filter(function (s) {
      return RCScore.classKey(s) === state.currentClass;
    });
  }

  function pickedKeys() {
    var k = state.currentClass;
    if (!state.pickedByClass[k]) state.pickedByClass[k] = [];
    return state.pickedByClass[k];
  }

  /**
   * 把「抽过谁」和「界面位置」一起落盘。
   * 合并写：先读出已有 state 再覆盖字段，否则整对象覆盖会把界面位置抹掉
   * （refresh 后会跳回首页）。
   */
  function saveState() {
    var s = RCData.loadState();
    s.pickedByClass = state.pickedByClass;
    s.picked = [];
    s.view = state.view;
    s.homeTab = state.homeTab;
    s.stuPeriod = state.stuPeriod;
    s.clsPeriod = state.clsPeriod;
    s.stuRange = state.stuRange || { from: '', to: '' };
    s.clsRange = state.clsRange || { from: '', to: '' };
    RCData.saveState(s);
  }

  function savePicked() {
    saveState();
  }

  /** 只记界面位置（切页/切标签/切周期时调用） */
  function saveView() {
    saveState();
  }

  function loadClassScores() {
    var d = RCData.loadScores(state.currentClass);
    state.scores = { records: Array.isArray(d.records) ? d.records : [] };
  }

  /**
   * 从服务端拉当前班级的加分记录（远程模式）。
   *
   * 为什么必须在进班级时拉：服务端的 PUT 是对账语义，本地没有基线就提交，
   * 会把该班历史分全部冲正。拉成功后再 refreshAll，界面分数才是真的。
   */
  function loadClassScoresFromServer() {
    var cls = state.currentClass;
    if (!cls || !RCData || typeof RCData.loadScoresFor !== 'function') return;
    if (state.dataMode !== 'remote') return;
    RCData.loadScoresFor(cls).then(function (r) {
      if (!r || !r.ok) return;
      if (state.currentClass !== cls) return; // 期间切了班，丢弃
      loadClassScores();
      refreshAll();
    }).catch(function () { /* 离线时用缓存 */ });
  }

  function saveScores() {
    if (RCData.saveScores(state.currentClass, state.scores.records) === false) {
      toast('加分记录没能保存到服务器：本页还没取到该班的记录，请刷新页面后重试', 'warn');
      return;
    }
  }

  /* -------------------- 多步撤销 -------------------- */

  /**
   * 在修改当前班级记录前调用，把改动前的快照压栈。
   * @param {String} label 这一步做了什么（撤销时提示用）
   */
  function pushUndo(label) {
    if (!state.currentClass) return;
    undoStack.push({
      cls: state.currentClass,
      records: state.scores.records.slice(),
      label: label || '操作'
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    syncUndoBtn();
  }

  /** 撤销栈里有当前班级的步骤时才可用 */
  function undoDepthFor(cls) {
    var n = 0;
    for (var i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].cls === cls) n++;
    }
    return n;
  }

  function syncUndoBtn() {
    if (!els.btnUndoOp) return;
    var n = undoDepthFor(state.currentClass);
    var writable = canEditClass(state.currentClass);
    els.btnUndoOp.disabled = n === 0 || !writable;
    els.btnUndoOp.title = !writable
      ? '只读班级不能撤销'
      : (n ? '撤销上一步（Ctrl+Z）· 还可撤销 ' + n + ' 步' : '没有可撤销的操作');
  }

  /** 撤销一步：还原该班级的记录快照 */
  function undoStep() {
    if (state.busy) return;
    if (!guard('score.void', '当前账号没有撤销权限')) return;
    if (!canEditClass(state.currentClass)) { toast(readOnlyTip(), 'warn'); return; }
    var idx = -1;
    for (var i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].cls === state.currentClass) { idx = i; break; }
    }
    if (idx < 0) { toast('没有可撤销的操作', 'warn'); return; }

    var snap = undoStack.splice(idx, 1)[0];
    state.scores = { records: snap.records.slice() };
    saveScores();

    refreshCardScores();
    renderPanel();
    refreshStats();
    renderWbSummary();
    renderHome();
    if (state.focusKey) renderFocus();

    // 结果条上的累计分同步
    if (state.lastDraw && els.resultOverlay.classList.contains('show')) {
      var t = RCScore.totalOf(state.scores.records, RCScore.studentKey(state.lastDraw.student));
      els.resultScore.textContent = RCScore.fmtNum(t);
    }

    syncUndoBtn();
    toast('已撤销：' + snap.label, 'ok');
  }

  function totalMap() {
    return RCScore.totals(state.scores.records);
  }

  /** 当天（0 点起）得分表：学生键 → 当天累计分 */
  function todayMap() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var start = d.getTime();
    var recs = state.scores.records.filter(function (r) { return (r.t || 0) >= start; });
    return RCScore.totals(recs);
  }

  function syncClassBar() {
    var classes = state.classes.filter(function (c) { return canSeeClass(c.name); })
      .map(function (c) { return c.name; });
    var sel = els.classSelect;
    if (!sel) return;
    sel.innerHTML = '';
    if (!classes.length) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '未分班';
      sel.appendChild(o0);
      sel.disabled = true;
      return;
    }

    classes.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = RCScore.classLabel(c);
      sel.appendChild(o);
    });
    sel.value = state.currentClass;
    // 只有一个「未分班」时没必要显示下拉
    sel.disabled = classes.length <= 1 && !classes[0];
    if (els.classBar) {
      els.classBar.classList.toggle('is-single', classes.length <= 1);
    }
  }

  function switchClass(cls) {
    if (cls === state.currentClass) return;
    if (state.busy) { toast('抽取动画进行中，稍后再切换班级', 'warn'); return; }

    state.currentClass = cls;
    RCData.saveClasses({ current: cls, list: state.classes });
    loadClassScores();
    state.selected = {};
    state.lastDraw = null;

    // 清掉动画残留
    AnimSpotlight.clearWinner();
    AnimRoller.reset();
    AnimWheel.reset();
    hideResult();

    refreshAll();
    toast('已切换到 ' + RCScore.classLabel(cls), 'ok');
  }

  /* -------------------- 事件绑定 -------------------- */

  function bindEvents() {
    /* ---------- 首页 ---------- */

    $('#btnNewClass').addEventListener('click', function () { openNameModal('new'); });
    $('#btnNewClass2').addEventListener('click', function () { openNameModal('new'); });
    $('#btnNameOk').addEventListener('click', submitNameModal);
    els.nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitNameModal(); }
    });

    $('#btnImportHome').addEventListener('click', function () { state.importTarget = null; openImport(); });
    $('#btnImportHome2').addEventListener('click', function () { state.importTarget = null; openImport(); });
    $('#btnHome').addEventListener('click', backHome);

    els.homeSearch.addEventListener('input', debounce(renderHome, 120));

    $('#btnThemeHome').addEventListener('click', cycleTheme);
    $('#btnSettingsHome').addEventListener('click', function () { showModal(els.settingsModal); });

    // 课堂小游戏
    ['#btnGamesHome', '#btnGamesClass'].forEach(function (sel) {
      var b = $(sel);
      if (b) b.addEventListener('click', openGames);
    });
    var gBack = $('#btnGamesBack');
    if (gBack) gBack.addEventListener('click', closeGames);

    // 首页标签页：排行榜 / 所有班级
    $$('#homeTabs .tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchHomeTab(b.dataset.tab); saveView(); });
    });
    // 学生榜周期：本周榜 / 总榜 / 自定义
    $$('#stuPeriod .pill').forEach(function (b) {
      b.addEventListener('click', function () {
        state.stuPeriod = b.dataset.period || 'week';
        renderStuRank();
        saveView();
      });
    });
    // 班级榜周期：周 / 月 / 总排名 / 自定义
    $$('#clsPeriod .pill').forEach(function (b) {
      b.addEventListener('click', function () {
        state.clsPeriod = b.dataset.period || 'all';
        state.settings.rankPeriod = state.clsPeriod;
        RCData.saveSettings(state.settings);
        renderClsRank();
        saveView();
      });
    });
    // 自定义期限：日期变化 / 快捷天数 / 清除
    ['stu', 'cls'].forEach(function (board) {
      var fromEl = board === 'stu' ? els.stuFrom : els.clsFrom;
      var toEl = board === 'stu' ? els.stuTo : els.clsTo;
      [fromEl, toEl].forEach(function (el) {
        if (!el) return;
        el.addEventListener('change', function () { applyRange(board); });
      });
      var box = board === 'stu' ? els.stuRange : els.clsRange;
      if (!box) return;
      Array.prototype.slice.call(box.querySelectorAll('[data-range-preset]')).forEach(function (btn) {
        if (btn.dataset.rangeBoard !== board) return;
        btn.addEventListener('click', function () {
          var days = parseInt(btn.dataset.rangePreset, 10) || 7;
          var end = new Date();
          var start = new Date();
          start.setDate(end.getDate() - (days - 1));
          if (fromEl) fromEl.value = fmtDay(start);
          if (toEl) toEl.value = fmtDay(end);
          applyRange(board);
        });
      });
      Array.prototype.slice.call(box.querySelectorAll('[data-range-clear]')).forEach(function (btn) {
        if (btn.dataset.rangeClear !== board) return;
        btn.addEventListener('click', function () {
          if (fromEl) fromEl.value = '';
          if (toEl) toEl.value = '';
          applyRange(board);
        });
      });
    });
    var rx = $('#btnRankExport');
    if (rx) rx.addEventListener('click', function () { exportRank('student'); });
    var rc = $('#btnRankExportCls');
    if (rc) rc.addEventListener('click', function () { exportRank('class'); });
    var ra = $('#btnRankExportAvg');
    if (ra) ra.addEventListener('click', function () { exportRank('avg'); });

    // 导出本班表格
    $('#btnClassSheet').addEventListener('click', function () {
      if (!state.currentClass) { toast('先选一个班级', 'warn'); return; }
      exportClassSheet(state.currentClass);
    });
    $('#btnExportAllClasses').addEventListener('click', function () {
      var names = state.classes.map(function (c) { return c.name; });
      RCData.listScoreClasses().forEach(function (c) {
        if (names.indexOf(c) < 0) names.push(c);
      });
      exportScoresFor(names);
    });

    // 抽取
    els.btnDraw.addEventListener('click', draw);

    // 班级切换（顶栏下拉已移除，切班走首页班级卡片）
    if (els.classSelect) {
      els.classSelect.addEventListener('change', function () {
        switchClass(this.value);
      });
    }

    // 动画切换
    $$('#animSwitch .pill').forEach(function (b) {
      b.addEventListener('click', function () {
        switchAnim(b.dataset.anim);
        state.settings.anim = b.dataset.anim;
        RCData.saveSettings(state.settings);
      });
    });

    // 主题
    $('#btnTheme').addEventListener('click', cycleTheme);
    $$('#themeSwitch .pill').forEach(function (b) {
      b.addEventListener('click', function () {
        applyTheme(b.dataset.theme);
        state.settings.theme = b.dataset.theme;
        RCData.saveSettings(state.settings);
        syncThemePills();
      });
    });

    // 弹窗开关
    $('#btnImport').addEventListener('click', function () { openImport(); });
    $('#btnImport2').addEventListener('click', function () { openImport(); });
    $('#btnManual').addEventListener('click', function () { openImport(true); });
    $('#btnSettings').addEventListener('click', function () { showModal(els.settingsModal); });
    $('#btnHistory').addEventListener('click', openHistory);
    $$('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.closest('.modal');
        if (m) hideModal(m);
      });
    });
    $$('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) hideModal(m);
      });
    });

    // 导入：选择文件
    var dz = $('#dropzone');
    dz.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files && els.fileInput.files[0]) {
        handleFile(els.fileInput.files[0]);
      }
      els.fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        dz.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        dz.classList.remove('dragover');
      });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    // 整页拖拽
    var dragDepth = 0;
    var dropOverlay = $('#dropOverlay');

    function showDropOverlay(on) {
      if (dropOverlay) dropOverlay.classList.toggle('on', on);
    }

    document.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      if (dragDepth === 1) showDropOverlay(true);
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('dragleave', function (e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) showDropOverlay(false);
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      showDropOverlay(false);
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!els.importModal.classList.contains('show')) openImport();
      handleFile(f);
    });

    // 手动录入
    $('#btnManualOk').addEventListener('click', function () {
      var txt = els.manualInput.value;
      if (!txt.trim()) { toast('请输入内容', 'warn'); return; }
      var res = RCImporter.parseManual(txt);
      if (!res.students.length) { toast('没有解析到有效姓名', 'warn'); return; }
      showPreview(res.students, res.meta);
    });

    // 预览
    $('#btnBackPick').addEventListener('click', function () {
      els.importPreview.classList.add('hidden');
      els.importPick.classList.remove('hidden');
      $('#importTitle').textContent = '导入名单';
    });
    els.importAssign.addEventListener('change', syncAssignNew);
    $('#btnConfirmImport').addEventListener('click', confirmImport);

    // 结果浮层
    $('#btnAgain').addEventListener('click', function () {
      hideResult();
      setTimeout(draw, 120);
    });
    $('#btnUndo').addEventListener('click', undoLast);
    $('#btnCloseResult').addEventListener('click', hideResult);
    $('#btnResultPlus1').addEventListener('click', function () {
      if (!state.lastDraw) return;
      // 随机点名的快捷加分默认原因固定为「答疑加分」，省掉每次选原因的步骤
      addScore([state.lastDraw.student], 1, '答疑加分');
    });
    $('#btnResultScore').addEventListener('click', function () {
      if (!state.lastDraw) return;
      state.selected = {};
      state.selected[RCScore.studentKey(state.lastDraw.student)] = 1;
      if (state.settings.panel === false) setPanelVisible(true);
      hideResult();
      renderPanel();
      if (els.customScore) {
        els.customScore.focus();
        els.customScore.select();
      }
      toast('已选中 ' + state.lastDraw.student.name + '，输入分数后点「给选中学生加分」', 'ok');
    });

    // 底部工具
    els.modeRepeat.addEventListener('change', function () {
      state.settings.repeat = els.modeRepeat.checked;
      RCData.saveSettings(state.settings);
      refreshStats();
      refreshClassName();
    });
    $('#btnReset').addEventListener('click', resetRound);
    if (els.btnUndoOp) els.btnUndoOp.addEventListener('click', undoStep);
    $('#btnExport').addEventListener('click', exportCSV);
    $('#btnExport2').addEventListener('click', exportCSV);
    $('#btnClearHistory').addEventListener('click', function () {
      if (!state.history.length) { toast('没有记录'); return; }
      state.history = [];
      RCData.saveHistory([]);
      renderHistory();
      toast('记录已清空', 'ok');
    });

    // 设置
    $('#optFast').addEventListener('change', function () {
      state.settings.fast = this.checked;
      RCData.saveSettings(state.settings);
    });
    $('#optSound').addEventListener('change', function () {
      state.settings.sound = this.checked;
      RCAudio.setEnabled(this.checked);
      RCData.saveSettings(state.settings);
    });
    $('#optAutoClose').addEventListener('change', function () {
      state.settings.autoClose = this.checked;
      RCData.saveSettings(state.settings);
    });
    $('#btnWipe').addEventListener('click', function () {
      if (!confirm('确定清空本机保存的名单、抽取记录与全部班级的加分记录？此操作不可撤销。')) return;
      RCData.wipe();
      state.students = [];
      state.classes = [];
      state.pickedByClass = {};
      state.history = [];
      state.scores = { records: [] };
      state.selected = {};
      state.currentClass = '';
      renderHome();
      refreshAll();
      hideModal(els.settingsModal);
      toast('已清空', 'ok');
    });

    /* ---------- 加分面板 ---------- */

    els.quickRow.addEventListener('click', function (e) {
      var b = e.target.closest('.score-btn');
      if (!b) return;
      var d = parseFloat(b.dataset.delta);
      if (!isFinite(d)) return;
      applyToSelected(d);
    });

    $('#btnApplyScore').addEventListener('click', function () {
      var v = parseFloat(els.customScore.value);
      if (!isFinite(v) || v === 0) { toast('请输入有效分数（可为负数）', 'warn'); return; }
      applyToSelected(v);
    });

    els.customScore.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btnApplyScore').click(); }
    });
    if (els.scoreReason) {
      els.scoreReason.addEventListener('change', function () { syncReasonUI(); });
    }
    if (els.scoreReasonOther) {
      els.scoreReasonOther.addEventListener('input', function () { syncReasonUI(); });
      els.scoreReasonOther.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#btnApplyScore').click(); }
      });
    }

    $('#btnSelectMode').addEventListener('click', function () {
      state.selectMode = !state.selectMode;
      this.classList.toggle('active', state.selectMode);
      AnimSpotlight.setSelectMode(state.selectMode);
      renderSelection();
      toast(state.selectMode ? '多选模式：点击卡片勾选学生' : '已退出多选模式');
    });

    $('#btnSelectAll').addEventListener('click', function () {
      var list = currentStudents();
      if (!list.length) { toast('当前班级没有学生', 'warn'); return; }
      state.selected = {};
      list.forEach(function (s) { state.selected[RCScore.studentKey(s)] = 1; });
      state.selectMode = true;
      $('#btnSelectMode').classList.add('active');
      renderSelection();
      toast('已选中 ' + list.length + ' 人', 'ok');
    });

    $('#btnClearSel').addEventListener('click', function () {
      state.selected = {};
      renderSelection();
    });

    els.selChips.addEventListener('click', function (e) {
      var b = e.target.closest('.chip-x');
      if (!b) return;
      var k = b.dataset.key;
      if (k) { delete state.selected[k]; renderSelection(); }
    });

    els.scoreLog.addEventListener('click', function (e) {
      var b = e.target.closest('.log-del');
      if (!b) return;
      if (!canEditClass(state.currentClass)) { toast(readOnlyTip(), 'warn'); return; }
      var id = b.dataset.id;
      if (!id) return;
      pushUndo('删除一条加分记录');
      state.scores.records = RCScore.removeById(state.scores.records, id);
      saveScores();
      renderPanel();
      refreshCardScores();
      renderWbSummary();
      renderHome();
      toast('已删除一条加分记录', 'ok');
    });

    $('#btnExportScores').addEventListener('click', function () {
      if (!state.currentClass) { toast('先选一个班级', 'warn'); return; }
      exportRecordsFor([state.currentClass]);
    });

    /* ---------- 右侧「当前学生」卡片（替代原详情弹窗） ---------- */

    if (els.btnFocusPick) {
      els.btnFocusPick.addEventListener('click', function () {
        var s = focusStudent();
        if (!s) return;
        state.selected[RCScore.studentKey(s)] = 1;
        state.focusKey = '';
        renderFocus();
        renderSelection();
        renderPanel();
        toast('已加入选中', 'ok');
      });
    }
    if (els.btnFocusClear) {
      els.btnFocusClear.addEventListener('click', function () {
        var s = focusStudent();
        if (!s) return;
        if (!canEditClass(state.currentClass)) { toast(readOnlyTip(), 'warn'); return; }
        if (!guard('score.clear_student', '当前账号没有清空学生记录的权限')) return;
        if (!confirm('清空 ' + s.name + ' 的全部加分记录？')) return;
        var k = RCScore.studentKey(s);
        pushUndo('清空 ' + s.name + ' 的记录');
        state.scores.records = RCScore.removeOfStudent(state.scores.records, k);
        saveScores();
        renderFocus();
        renderPanel();
        refreshCardScores();
        refreshStats();
        renderWbSummary();
        renderHome();
        toast('已清空该生记录', 'ok');
      });
    }
    if (els.btnFocusClose) {
      els.btnFocusClose.addEventListener('click', function () {
        state.focusKey = '';
        renderFocus();
        renderPanel();
      });
    }
    if (els.focusCard) {
      els.focusCard.addEventListener('click', function (e) {
        if (e.target.closest('.focus-tools')) return;
        var s = focusStudent();
        if (s) { els.customScore.focus(); els.customScore.select(); }
      });
    }

    /* ---------- 导出弹窗 ---------- */

    $('#btnExportAll').addEventListener('click', function () {
      var names = state.classes.map(function (c) { return c.name; });
      RCData.listScoreClasses().forEach(function (c) {
        if (names.indexOf(c) < 0) names.push(c);
      });
      exportScoresFor(names);
    });
    els.exportList.addEventListener('click', function (e) {
      var b = e.target.closest('.export-one');
      if (!b) return;
      exportScoresFor([b.dataset.cls === '\u0000' ? '' : b.dataset.cls]);
    });

    // 键盘
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.code === 'Escape') {
        if (anyModalOpen()) { $$('.modal.show').forEach(hideModal); return; }
        if (els.resultOverlay.classList.contains('show')) { hideResult(); return; }
        if (state.view === 'games') { closeGames(); return; }
        if (state.view === 'class') backHome();
        return;
      }

      // 首页只响应 Esc，其余快捷键都在工作台里生效
      if (state.view !== 'class') return;

      // Ctrl/Cmd + Z：多步撤销
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (anyModalOpen()) return;
        undoStep();
        return;
      }

      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        if (els.resultOverlay.classList.contains('show')) { hideResult(); return; }
        if (anyModalOpen()) return;
        draw();
      } else if (e.key === 'r' || e.key === 'R') {
        if (anyModalOpen()) return;
        resetRound();
      } else if (e.key === '1' || e.key === '2' || e.key === '3') {
        var map = { '1': 'spotlight', '2': 'roller', '3': 'wheel' };
        switchAnim(map[e.key]);
        state.settings.anim = map[e.key];
        RCData.saveSettings(state.settings);
      } else if (e.key === '+' || e.key === '=') {
        if (anyModalOpen()) return;
        if (!Object.keys(state.selected).length) return;
        applyToSelected(1);
      } else if (e.key === '-' || e.key === '_') {
        if (anyModalOpen()) return;
        if (!Object.keys(state.selected).length) return;
        applyToSelected(-1);
      }
    });
  }

  /* -------------------- 视图与渲染 -------------------- */

  function switchAnim(anim, silent) {
    if (!anim) anim = 'spotlight';
    state.settings.anim = anim;

    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    var view = $('#view-' + anim);
    if (view) view.classList.add('active');

    $$('#animSwitch .pill').forEach(function (b) {
      b.classList.toggle('active', b.dataset.anim === anim);
    });

    if (anim === 'wheel') {
      // canvas 尺寸依赖布局，切换后重绘
      requestAnimationFrame(function () { AnimWheel.resize(); });
    }
    if (anim === 'spotlight') {
      // 视图刚激活，网格才有真实尺寸，下一帧重算列数
      requestAnimationFrame(function () { AnimSpotlight.fitGrid(); });
    }
    AnimSpotlight.clearWinner();
    AnimRoller.reset();
  }

  function refreshClassName() {
    var list = currentStudents();
    var all = state.students.length;
    if (!all) {
      els.className.textContent = '未导入名单';
      return;
    }
    var parts = [];
    parts.push(RCScore.classLabel(state.currentClass));
    parts.push('共 ' + list.length + ' 人');
    if (state.classes.length > 1) parts.push('全名单 ' + all + ' 人');
    if (state.settings.repeat) parts.push('可重复');
    els.className.textContent = parts.join(' · ');
  }

  function refreshAll() {
    var all = state.students.length;
    var has = all > 0;

    // 名单可能新增了班级（导入），元数据同步补齐
    state.classes = RCClasses.ensure(state.classes, state.students);
    if (!state.classes.some(function (c) { return c.name === state.currentClass; })) {
      state.currentClass = state.classes.length ? state.classes[0].name : '';
    }

    var list = currentStudents();

    // 当前班级被清空（比如重新导入了名单）时回退到第一个班级
    if (has && !list.length && state.classes.length) {
      state.currentClass = state.classes[0].name;
      loadClassScores();
      list = currentStudents();
    }

    syncClassBar();
    if (els.emptyState) els.emptyState.classList.toggle('hidden', list.length > 0);
    refreshClassName();
    if (els.wbTitle) els.wbTitle.textContent = RCScore.classLabel(state.currentClass);

    if (has) {
      renderCards(list);
      AnimWheel.setStudents(list);
    } else {
      AnimSpotlight.render([]);
      AnimWheel.setStudents([]);
      AnimRoller.reset();
    }

    refreshStats();
    updateDrawBtn();
    renderPanel();
    renderFocus();
    syncResultReserve();
    renderWbSummary();
    applyReadOnly();
    /* 首屏与切班后也要把「先选原因」的提示态同步一次：
       否则原因是空的、提交按钮已禁用，但分值按钮看起来还是可点的。 */
    syncReasonUI();
  }

  /**
   * 当前班级是否只读 → 面板控件置灰 + 顶部提示条。
   * 只影响「改」，不影响「看」：名单、总分、记录、点名、导出都照常。
   */
  function applyReadOnly() {
    var writable = canEditClass(state.currentClass);
    var bar = document.getElementById('readonlyBar');
    var txt = document.getElementById('readonlyText');
    if (bar) bar.classList.toggle('hidden', writable);
    if (txt && !writable) {
      txt.textContent = '只读班级 · 可以查看名单、总分与加分记录，但加减分与撤销只在你的任教班级可用';
    }
    if (els.scorePanel) els.scorePanel.classList.toggle('is-readonly', !writable);
    syncUndoBtn();
  }

  /** 工作台顶部：本班总分 + 本班前三名 */
  function renderWbSummary() {
    if (els.wbTotalNum) {
      var sum = RCScore.sumOf(state.scores.records);
      els.wbTotalNum.textContent = RCScore.fmtNum(sum);
      els.wbTotalNum.classList.toggle('neg', sum < 0);
    }
    renderTop3(els.wbTop3, classTopN(state.currentClass, 3), '本班还没有加分');
  }

  /**
   * 让卡片网格底部为结果条预留的空间刚好等于结果条实际高度。
   * 结果条高度随视口/字号变化（1264 宽约 86px、1920 宽约 112px），
   * 用固定 clamp 值会在大屏多留出几十像素空白，所以这里实测后写进 CSS 变量。
   */
  function syncResultReserve() {
    if (!els.resultOverlay || !els.stage) return;
    var card = els.resultOverlay.querySelector('.result-card');
    if (!card) return;
    var ovStyle = getComputedStyle(els.resultOverlay);
    var padBottom = parseFloat(ovStyle.paddingBottom) || 0;
    // 结果条隐藏时 visibility:hidden 仍占布局，可以直接量到高度
    var h = card.getBoundingClientRect().height;
    if (!h) return;
    els.stage.style.setProperty('--result-reserve', Math.ceil(h + padBottom + 8) + 'px');
  }

  function renderCards(list) {
    AnimSpotlight.render(list, {
      totals: totalMap(),
      today: todayMap(),
      selected: state.selected,
      selectMode: state.selectMode,
      onCardClick: onCardClick
    });
  }

  /** 只刷新卡片上的总分与当天分，不重建 DOM */
  function refreshCardScores() {
    AnimSpotlight.setTotals(totalMap(), todayMap());
    AnimSpotlight.setSelected(state.selected);
  }

  function onCardClick(s, i, card) {
    /* 访客纯只读：点学生卡片不弹窗、不勾选、没有任何反应 */
    if (isViewer()) return;
    if (state.selectMode) {
      var k = RCScore.studentKey(s);
      if (state.selected[k]) delete state.selected[k];
      else state.selected[k] = 1;
      renderSelection();
      return;
    }
    setFocus(s);
  }

  function refreshStats() {
    var list = currentStudents();
    var total = list.length;
    var picked = pickedKeys().length;
    var left = state.settings.repeat ? total : Math.max(0, total - picked);

    els.statPicked.textContent = picked;
    els.statLeft.textContent = state.settings.repeat ? total : left;
    els.statTotal.textContent = total;

    // 可重复模式下「已抽」无意义，改成显示抽取次数
    if (state.settings.repeat) {
      els.statPicked.textContent = state.history.length;
    }
  }

  function updateDrawBtn() {
    var total = currentStudents().length;
    var exhausted = !state.settings.repeat && total > 0 && pickedKeys().length >= total;
    var disabled = !total || exhausted || state.busy;
    els.btnDraw.disabled = disabled;

    if (!total) {
      els.drawText.textContent = state.students.length ? '本班没有学生' : '先导入名单';
    } else if (exhausted) {
      els.drawText.textContent = '本轮已抽完';
    } else if (state.busy) {
      els.drawText.textContent = '抽取中…';
    } else {
      els.drawText.textContent = '随机点名';
    }
  }

  /* -------------------- 加分面板 -------------------- */

  function setPanelVisible(on) {
    state.settings.panel = !!on;
    RCData.saveSettings(state.settings);
    applyPanelVisible(!!on);
    // 面板宽度变化会改变舞台尺寸，重算网格
    setTimeout(function () {
      AnimSpotlight.fitGrid();
      AnimWheel.resize();
    }, 60);
  }

  function applyPanelVisible(on) {
    if (!els.workspace) return;
    els.workspace.classList.toggle('no-panel', !on);
  }

  function selectedStudents() {
    var map = state.selected;
    return currentStudents().filter(function (s) {
      return map[RCScore.studentKey(s)];
    });
  }

  function renderPanel() {
    if (!els.scorePanel) return;

    els.panelClassLabel.textContent = RCScore.classLabel(state.currentClass) +
      ' · ' + currentStudents().length + ' 人';

    var sel = selectedStudents();
    els.panelSelCount.textContent = sel.length ? ('已选 ' + sel.length + ' 人') : '未选择';
    els.panelSelCount.classList.toggle('on', sel.length > 0);

    renderSelection();

    // 记录列表（最新在上）
    var recs = state.scores.records.slice().sort(function (a, b) { return b.t - a.t; });
    var sum = RCScore.sumOf(state.scores.records);
    els.panelSum.textContent = '合计 ' + RCScore.fmtDelta(sum).replace('+', '') + ' 分 · ' + recs.length + ' 条';
    els.panelSum.classList.toggle('pos', sum > 0);
    els.panelSum.classList.toggle('neg', sum < 0);

    // 面板头部：班级总分 + 记录条数
    if (els.panelTotalNum) {
      els.panelTotalNum.textContent = RCScore.fmtNum(sum);
      els.panelTotalNum.classList.toggle('neg', sum < 0);
    }
    if (els.panelRecCount) {
      els.panelRecCount.textContent = recs.length + ' 条';
    }

    if (!recs.length) {
      els.scoreLog.innerHTML = '<div class="preview-empty">本班还没有加分记录</div>';
      return;
    }

    var frag = document.createDocumentFragment();
    recs.slice(0, 200).forEach(function (r) {
      frag.appendChild(logRow(r));
    });
    els.scoreLog.innerHTML = '';
    els.scoreLog.appendChild(frag);
  }

  function logRow(r) {
    var row = document.createElement('div');
    row.className = 'log-row';

    var nm = document.createElement('span');
    nm.className = 'log-name';
    nm.textContent = r.name;

    var dl = document.createElement('span');
    var d = RCScore.round2(r.delta);
    dl.className = 'log-delta ' + (d > 0 ? 'pos' : 'neg');
    dl.textContent = RCScore.fmtDelta(d);

    var rs = document.createElement('span');
    rs.className = 'log-reason';
    rs.textContent = r.reason || '';

    var op = document.createElement('span');
    op.className = 'log-op';
    op.textContent = r.op || '—';
    op.title = r.op ? ('操作人：' + r.op) : '这条记录没有操作人（旧数据）';

    var tm = document.createElement('span');
    tm.className = 'log-time';
    tm.textContent = RCScore.fmtDateTime(r.t).slice(5, 16);

    var del = document.createElement('button');
    del.className = 'log-del';
    del.dataset.id = r.id;
    del.title = '删除这条记录';
    del.textContent = '✕';

    row.appendChild(nm);
    row.appendChild(dl);
    row.appendChild(rs);
    row.appendChild(op);
    row.appendChild(tm);
    row.appendChild(del);
    return row;
  }

  function renderSelection() {
    var sel = selectedStudents();
    els.panelSelCount.textContent = sel.length ? ('已选 ' + sel.length + ' 人') : '未选择';
    els.panelSelCount.classList.toggle('on', sel.length > 0);
    AnimSpotlight.setSelected(state.selected);

    // 空选且未开勾选模式时，整块收成一行，别占面板高度
    var block = els.selChips.closest ? els.selChips.closest('.sel-block') : null;
    if (block) block.classList.toggle('is-idle', !sel.length && !state.selectMode);

    if (!sel.length) {
      els.selChips.innerHTML = '<span class="sel-empty">未选择学生 · 打开「勾选模式」后点卡片可批量勾选</span>';
      return;
    }

    var frag = document.createDocumentFragment();
    sel.slice(0, 60).forEach(function (s) {
      var chip = document.createElement('span');
      chip.className = 'sel-chip';
      var t = document.createElement('span');
      t.textContent = s.name;
      var x = document.createElement('button');
      x.className = 'chip-x';
      x.dataset.key = RCScore.studentKey(s);
      x.title = '移除';
      x.textContent = '✕';
      chip.appendChild(t);
      chip.appendChild(x);
      frag.appendChild(chip);
    });
    if (sel.length > 60) {
      var more = document.createElement('span');
      more.className = 'sel-chip more';
      more.textContent = '等 ' + sel.length + ' 人';
      frag.appendChild(more);
    }
    els.selChips.innerHTML = '';
    els.selChips.appendChild(frag);
  }

  /* -------------------- 加分原因（必选） -------------------- */

  /**
   * 读取当前选中的原因
   * @returns {{ok:boolean, reason:string, msg:string}}
   * 选「其他」时必须填补充说明，否则视为未选
   */
  function readReason() {
    var selEl = els.scoreReason;
    var otherEl = els.scoreReasonOther;
    if (!selEl) return { ok: false, reason: '', msg: '请选择加分原因' };

    var v = selEl.value || '';
    if (!v) return { ok: false, reason: '', msg: '请选择加分原因' };

    if (v === '其他') {
      var extra = (otherEl && otherEl.value || '').trim();
      if (!extra) return { ok: false, reason: '', msg: '选「其他」时请补充说明' };
      return { ok: true, reason: '其他 · ' + extra, msg: '' };
    }
    return { ok: true, reason: v, msg: '' };
  }

  /** 根据当前选择显示/隐藏补充说明框，并同步提交按钮的禁用态 */
  function syncReasonUI() {
    var selEl = els.scoreReason;
    var otherEl = els.scoreReasonOther;
    if (!selEl) return;

    var isOther = selEl.value === '其他';
    if (otherEl) {
      otherEl.classList.toggle('hidden', !isOther);
      if (!isOther) otherEl.value = '';
    }
    var ok = readReason().ok;
    if (els.btnApplyScore) els.btnApplyScore.disabled = !ok;
    // 原因没选时把分值按钮压暗，提示「先选原因，再点分值」
    if (els.quickRow) els.quickRow.classList.toggle('needs-reason', !ok);
    syncApplyLabel();
  }

  /** 提交按钮文案与操作人提示随当前对象变化 */
  function syncApplyLabel() {
    if (els.btnApplyScore) {
      els.btnApplyScore.textContent = focusStudent() ? '给当前学生加分' : '给选中学生加分';
    }
    if (els.applyOpHint) {
      var who = operatorName();
      els.applyOpHint.textContent = '操作人：' + (who || '—');
    }
  }

  /**
   * 面板快捷按钮：有「当前学生」就只加给他，否则加给勾选集合
   * @param {Number} delta
   */
  function applyToSelected(delta) {
    var focus = focusStudent();
    var sel = focus ? [focus] : selectedStudents();
    if (!sel.length) {
      toast('先点左侧名单里的学生，或打开「勾选模式」多选', 'warn');
      return;
    }
    var r = readReason();
    if (!r.ok) { toast(r.msg, 'warn'); syncReasonUI(); return; }
    addScore(sel, delta, r.reason);
  }

  /**
   * 加分核心：写入当前班级的记录
   * @param {Array} targets 学生数组
   * @param {Number} delta 分值
   * @param {String} reason 原因
   */
  function addScore(targets, delta, reason) {
    if (!targets || !targets.length) return;
    if (!state.students.length) { toast('先导入名单', 'warn'); return; }
    if (!canEditClass(state.currentClass)) { toast(readOnlyTip(), 'warn'); return; }
    var d0g = RCScore.round2(delta);
    if (d0g > 0 && !guard('score.add', '当前账号没有加分权限')) return;
    if (d0g < 0 && !guard('score.subtract', '当前账号没有扣分权限')) return;

    var recs = RCScore.makeRecords(targets, delta, reason, operatorName());
    if (!recs.length) { toast('分数不能为 0', 'warn'); return; }

    var d0 = RCScore.round2(delta);
    pushUndo((targets.length === 1 ? targets[0].name : targets.length + ' 人') + ' ' + RCScore.fmtDelta(d0) + ' 分');

    state.scores.records = state.scores.records.concat(recs);
    saveScores();

    // 轻量反馈
    try { if (state.settings.sound) RCAudio.blip(1200); } catch (e) {}

    refreshCardScores();
    renderPanel();
    renderFocus();
    refreshStats();
    renderWbSummary();
    renderHome();

    // 结果条上的累计分同步
    if (state.lastDraw && els.resultOverlay.classList.contains('show')) {
      var t = RCScore.totalOf(state.scores.records, RCScore.studentKey(state.lastDraw.student));
      els.resultScore.textContent = RCScore.fmtNum(t);
    }

    var d = RCScore.round2(delta);
    if (targets.length === 1) {
      toast(targets[0].name + ' ' + RCScore.fmtDelta(d) + ' 分', 'ok');
    } else {
      toast('已给 ' + targets.length + ' 人各 ' + RCScore.fmtDelta(d) + ' 分', 'ok');
    }
  }

  /* -------------------- 右侧「当前学生」 -------------------- */

  function studentByKey(k) {
    if (!k) return null;
    var list = currentStudents();
    for (var i = 0; i < list.length; i++) {
      if (RCScore.studentKey(list[i]) === k) return list[i];
    }
    return null;
  }

  /** 当前面板里正在显示的学生（可能为 null） */
  function focusStudent() {
    return studentByKey(state.focusKey);
  }

  /** 点左侧卡片：不弹窗，只在右侧面板显示该生 */
  function setFocus(s) {
    if (!s) return;
    state.focusKey = RCScore.studentKey(s);
    if (state.settings.panel === false) setPanelVisible(true);
    renderFocus();
    renderPanel();
  }

  function clearFocus() {
    state.focusKey = '';
    renderFocus();
  }

  /** 渲染右侧「当前学生」卡片：姓名、总分、今日分、学号与记录条数 */
  function renderFocus() {
    if (!els.focusCard) return;
    var s = focusStudent();
    var empty = !s;
    els.focusCard.classList.toggle('is-empty', empty);

    if (empty) {
      els.focusName.textContent = '未选学生';
      els.focusTotal.textContent = '0';
      els.focusToday.textContent = '0';
      els.focusMeta.textContent = '点左侧名单里的卡片查看分数';
      syncApplyLabel();
      return;
    }

    var k = RCScore.studentKey(s);
    els.focusName.textContent = s.name;

    var total = RCScore.totalOf(state.scores.records, k);
    els.focusTotal.textContent = RCScore.fmtNum(total);
    els.focusTotal.classList.toggle('pos', total > 0);
    els.focusTotal.classList.toggle('neg', total < 0);

    var today = todayMap()[k] || 0;
    els.focusToday.textContent = RCScore.fmtNum(RCScore.round2(today));
    els.focusToday.classList.toggle('pos', today > 0);
    els.focusToday.classList.toggle('neg', today < 0);

    var n = RCScore.ofStudent(state.scores.records, k).length;
    var meta = [];
    if (s.id) meta.push('学号 ' + s.id);
    meta.push(RCScore.classLabel(state.currentClass));
    meta.push('共 ' + n + ' 条记录');
    els.focusMeta.textContent = meta.join(' · ');
    syncApplyLabel();
  }

  /* -------------------- 抽取主流程 -------------------- */

  function draw() {
    if (state.busy) return;
    if (!guard('draw.random', '当前账号没有抽取权限')) return;
    var list = currentStudents();
    var total = list.length;
    if (!total) {
      if (!state.students.length) {
        toast('先导入学生名单', 'warn');
        openImport();
      } else {
        toast('当前班级没有学生，换一个班级试试', 'warn');
      }
      return;
    }

    RCAudio.unlock();

    var allowRepeat = !!state.settings.repeat;
    var res = RCPicker.pick(list, pickedKeys(), allowRepeat);

    if (res.exhausted) {
      toast('本轮已抽完，按 R 或点 ↺ 重置', 'warn');
      updateDrawBtn();
      return;
    }

    var winner = res.student;
    var winnerIndex = list.findIndex(function (s) {
      return RCPicker.studentKey(s) === RCPicker.studentKey(winner);
    });

    state.busy = true;
    updateDrawBtn();
    hideResult();

    var anim = state.settings.anim;
    var opt = {
      pool: res.pool,
      winner: winner,
      winnerIndex: winnerIndex,
      fast: !!state.settings.fast,
      sound: !!state.settings.sound
    };

    var promise;
    if (anim === 'roller') promise = AnimRoller.play(opt);
    else if (anim === 'wheel') promise = AnimWheel.play(opt);
    else promise = AnimSpotlight.play(opt);

    // 记录撤销所需的现场
    state.lastDraw = {
      student: winner,
      prevPicked: pickedKeys().slice(),
      historyLen: state.history.length
    };

    promise.then(function () {
      // 动画结束后再落账
      if (!allowRepeat) {
        var k = RCPicker.studentKey(winner);
        var pk = pickedKeys();
        if (pk.indexOf(k) < 0) pk.push(k);
        savePicked();
      }

      state.history.push({
        t: Date.now(),
        name: winner.name,
        id: winner.id || '',
        group: RCScore.classKey(winner),
        anim: anim
      });
      RCData.saveHistory(state.history);

      state.busy = false;
      refreshStats();
      updateDrawBtn();
      showResult(winner);
    }).catch(function (e) {
      console.error(e);
      state.busy = false;
      updateDrawBtn();
      toast('抽取出错：' + e.message, 'warn');
    });
  }

  function showResult(s) {
    els.resultName.textContent = s.name;
    var meta = [];
    if (s.id) meta.push('学号 ' + s.id);
    meta.push(RCScore.classLabel(state.currentClass));
    els.resultMeta.textContent = meta.join(' · ');
    els.resultScore.textContent = RCScore.fmtNum(
      RCScore.totalOf(state.scores.records, RCScore.studentKey(s))
    );

    // 先让动画定格结果露个脸，再弹浮层，避免一上来就盖住舞台
    clearTimeout(resultShowTimer);
    clearTimeout(resultTimer);
    var delay = state.settings.fast ? 500 : 950;
    resultShowTimer = setTimeout(function () {
      els.resultOverlay.classList.add('show');
      els.stage.classList.add('has-result');
      if (state.settings.autoClose) {
        resultTimer = setTimeout(hideResult, 2200);
      }
    }, delay);
  }

  function hideResult() {
    clearTimeout(resultTimer);
    clearTimeout(resultShowTimer);
    els.resultOverlay.classList.remove('show');
    els.stage.classList.remove('has-result');
    /* 结果条收起时把命中定格一起清掉。
       否则「只有命中卡可点」这条规则会让整个名单一直冻住：
       模糊还在、其余卡片全都 pointer-events:none，老师想点别的学生点不动。
       抽中记录已经在右侧面板和历史里，视觉上的定格不必留到下一轮。 */
    AnimSpotlight.clearWinner();
  }

  function undoLast() {
    var last = state.lastDraw;
    if (!last) { toast('没有可撤销的抽取'); return; }

    // 恢复已抽列表（只影响当前班级）
    var pk = pickedKeys();
    state.pickedByClass[state.currentClass] = last.prevPicked.slice();
    savePicked();

    // 回退历史
    state.history = state.history.slice(0, last.historyLen);
    RCData.saveHistory(state.history);

    // 清理动画残留
    AnimSpotlight.clearWinner();
    AnimRoller.reset();
    AnimWheel.reset();

    state.lastDraw = null;
    hideResult();
    refreshStats();
    updateDrawBtn();
    toast('已撤销上一次抽取', 'ok');
  }

  function resetRound() {
    if (state.busy) return;
    if (!guard('draw.reset', '当前账号没有重置轮次的权限')) return;
    var pk = pickedKeys();
    if (!pk.length && !state.settings.repeat) {
      toast('本轮还没有抽过');
      return;
    }
    state.pickedByClass[state.currentClass] = [];
    savePicked();
    AnimSpotlight.clearWinner();
    AnimRoller.reset();
    AnimWheel.reset();
    refreshStats();
    updateDrawBtn();
    toast('本轮已重置，' + RCScore.classLabel(state.currentClass) + ' 所有人重新进入抽取池', 'ok');
  }

  /* -------------------- 导入流程 -------------------- */

  function openImport(focusManual) {
    if (!guard('roster.import', '当前账号没有导入名单的权限')) return;
    els.importPick.classList.remove('hidden');
    els.importPreview.classList.add('hidden');
    $('#importTitle').textContent = '导入名单';
    syncAssignOptions();
    showModal(els.importModal);
    if (focusManual) setTimeout(function () { els.manualInput.focus(); }, 260);
  }

  /** 导入归属下拉：自动拆分 / 未分班 / 每个已有班级 / 新建 */
  function syncAssignOptions() {
    var sel = els.importAssign;
    if (!sel) return;
    sel.innerHTML = '';

    function opt(v, t) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    }

    opt('__auto', '按「班级」列自动拆分');
    opt('__blank', '未分班');
    state.classes.forEach(function (c) {
      opt(c.name, '归到「' + RCScore.classLabel(c.name) + '」');
    });
    opt('__new', '新建班级…');

    // 从班级卡片的「导入」按钮进来时，默认归到那个班
    if (state.importTarget != null && state.importTarget !== '') {
      sel.value = state.importTarget;
    } else {
      sel.value = '__auto';
    }
    syncAssignNew();
  }

  /** 从文件名推断默认班级名：去扩展名、去「(1)」这类副本后缀、压缩空白 */
  function classFromFileName(fileName) {
    var base = String(fileName || '');
    base = base.replace(/\.[^.]+$/, '');
    base = base.replace(/[\s_-]*[(（]\d+[)）]\s*$/, '');
    base = base.replace(/\s+/g, ' ').trim();
    return RCClasses.normName(base);
  }

  function syncAssignNew() {
    if (!els.importNewName) return;
    var isNew = els.importAssign && els.importAssign.value === '__new';
    els.importNewName.classList.toggle('hidden', !isNew);
    if (isNew) els.importNewName.focus();
  }

  function handleFile(file) {
    var ok = /\.(xlsx|xls|csv|txt)$/i.test(file.name);
    if (!ok) { toast('只支持 xlsx / xls / csv', 'warn'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('文件太大了（>8MB）', 'warn'); return; }

    toast('正在解析 ' + file.name + ' …');
    RCImporter.readFile(file).then(function (res) {
      if (!res.students.length) {
        toast('没解析到学生姓名，检查表头或改用「姓名」列', 'warn');
        return;
      }
      showPreview(res.students, res.meta, file.name);
    }).catch(function (e) {
      console.error(e);
      toast('解析失败：' + e.message, 'warn');
    });
  }

  function showPreview(students, meta, fileName) {
    state.pendingImport = students.slice();
    els.importPick.classList.add('hidden');
    els.importPreview.classList.remove('hidden');
    $('#importTitle').textContent = fileName ? '预览 · ' + fileName : '预览 · 手动录入';

    var detect = [];
    if (meta) {
      detect.push(meta.headerFound ? '已识别表头' : '未识别表头，按第一列取姓名');
      if (meta.cols && meta.cols.id >= 0) detect.push('学号列：第 ' + (meta.cols.id + 1) + ' 列');
      if (meta.cols && meta.cols.group >= 0) detect.push('班级列：第 ' + (meta.cols.group + 1) + ' 列');
      if (meta.skipped) detect.push('跳过 ' + meta.skipped + ' 行');
      if (meta.sheetName) detect.push('工作表：' + meta.sheetName);
    }
    els.previewDetect.textContent = detect.join(' · ');

    // 默认班级名：优先取导入的表格文件名（可改）；多班级名单仍走自动拆分
    if (fileName && (state.importTarget == null || state.importTarget === '')) {
      var groups = RCScore.groupsOf(state.pendingImport).filter(function (g) { return !!g; });
      var guess = classFromFileName(fileName);
      if (guess && groups.length === 0) {
        els.importAssign.value = '__new';
        if (els.importNewName) els.importNewName.value = guess;
        syncAssignNew();
      }
    }

    renderPreview();
  }

  function renderPreview() {
    var list = state.pendingImport;
    var clsCount = RCScore.groupsOf(list).length;
    els.previewSummary.textContent = '共 ' + list.length + ' 人' +
      (clsCount > 1 ? ' · ' + clsCount + ' 个班级' : '');
    els.previewList.innerHTML = '';

    if (!list.length) {
      els.previewList.innerHTML = '<div class="preview-empty">没有数据</div>';
      return;
    }

    var frag = document.createDocumentFragment();
    list.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'preview-row';
      row.innerHTML =
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="nm"></span>' +
        '<span class="sub"></span>' +
        '<button class="del" title="删除">✕</button>';
      row.querySelector('.nm').textContent = s.name;
      row.querySelector('.sub').textContent = [s.id, s.group].filter(Boolean).join(' · ');
      row.querySelector('.del').addEventListener('click', function () {
        state.pendingImport.splice(i, 1);
        renderPreview();
      });
      frag.appendChild(row);
    });
    els.previewList.appendChild(frag);
  }

  /**
   * 确认导入：把预览里的学生按「归属」写入名单
   *   按班级列自动拆分 → 用每行的 group
   *   未分班 / 指定班级 / 新建班级 → 整份名单归到该班
   * 目标班级的原有学生会被替换，其他班级不受影响。
   */
  function confirmImport() {
    var list = state.pendingImport;
    if (!list.length) { toast('名单为空', 'warn'); return; }

    var mode = els.importAssign ? els.importAssign.value : '__auto';
    var target = '';
    var newName = '';

    if (mode === '__new') {
      newName = RCClasses.normName(els.importNewName ? els.importNewName.value : '');
      if (!newName) {
        toast('请输入新班级名', 'warn');
        if (els.importNewName) els.importNewName.focus();
        return;
      }
      if (RCClasses.has(state.classes, newName)) {
        toast('已有同名班级「' + newName + '」，请直接选它', 'warn');
        return;
      }
      target = newName;
    } else if (mode === '__auto') {
      target = null;   // 按每行 group
    } else if (mode === '__blank') {
      target = '';
    } else {
      target = mode;
    }

    // 1) 生成待写入的学生，确定涉及哪些班级
    var incoming = list.map(function (s) {
      return {
        name: s.name,
        id: s.id || '',
        group: target === null ? (s.group || '') : target
      };
    });

    var incomingClasses = [];
    incoming.forEach(function (s) {
      var k = RCScore.classKey(s);
      if (incomingClasses.indexOf(k) < 0) incomingClasses.push(k);
    });

    // 2) 用新名单替换这些班级的旧学生，其他班级原样保留
    var kept = state.students.filter(function (s) {
      return incomingClasses.indexOf(RCScore.classKey(s)) < 0;
    });
    state.students = kept.concat(incoming);

    // 3) 班级元数据：新建班级要建出来
    if (mode === '__new') {
      var added = RCClasses.add(state.classes, newName);
      if (added) state.classes = added;
    }
    state.classes = RCClasses.ensure(state.classes, state.students);

    // 4) 被替换的班级，本轮已抽记录一并清掉
    incomingClasses.forEach(function (c) {
      delete state.pickedByClass[c];
    });
    state.selected = {};
    state.lastDraw = null;

    // 5) 落到第一个导入的班级
    state.currentClass = incomingClasses[0] || (state.classes[0] ? state.classes[0].name : '');
    loadClassScores();

    // 导入是「用户点按钮 + 看到结果」的显式动作，允许它改写名单（含删到空的情况）
    RCData.saveRoster(state.students, { confirmClear: true });
    RCData.saveClasses({ current: state.currentClass, list: state.classes });
    savePicked();

    hideModal(els.importModal);
    if (els.importNewName) els.importNewName.value = '';
    state.importTarget = null;
    els.manualInput.value = '';

    renderHome();
    refreshAll();
    enterClass(state.currentClass);

    var msg = '已导入 ' + incoming.length + ' 人';
    if (incomingClasses.length > 1) msg += '，拆成 ' + incomingClasses.length + ' 个班级';
    else msg += '，归到「' + RCScore.classLabel(state.currentClass) + '」';
    toast(msg, 'ok');
  }

  /* -------------------- 抽取历史与导出 -------------------- */

  function openHistory() {
    renderHistory();
    showModal(els.historyModal);
  }

  function renderHistory() {
    var list = state.history.slice().reverse();
    els.historyList.innerHTML = '';
    if (!list.length) {
      els.historyList.innerHTML = '<div class="preview-empty">还没有抽取记录</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    list.slice(0, 300).forEach(function (h, i) {
      var row = document.createElement('div');
      row.className = 'preview-row history-row';
      row.innerHTML =
        '<span class="idx">' + (list.length - i) + '</span>' +
        '<span class="nm"></span>' +
        '<span class="sub"></span>' +
        '<span class="sub" style="text-align:right"></span>';
      row.querySelector('.nm').textContent = h.name;
      row.querySelectorAll('.sub')[0].textContent = [h.id, h.group].filter(Boolean).join(' · ');
      row.querySelectorAll('.sub')[1].textContent = fmtTime(h.t);
      frag.appendChild(row);
    });
    els.historyList.appendChild(frag);
  }

  function exportCSV() {
    if (!guard('record.view_class', '当前账号没有导出记录的权限')) return;
    if (!state.history.length) { toast('没有可导出的记录', 'warn'); return; }

    var rows = [['序号', '姓名', '学号', '班级/分组', '时间', '动画']];
    state.history.forEach(function (h, i) {
      rows.push([
        i + 1,
        h.name,
        h.id || '',
        h.group || '',
        fmtTime(h.t, true),
        ({ spotlight: '聚光灯', roller: '滚屏', wheel: '转盘' })[h.anim] || ''
      ]);
    });

    var csv = rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');

    // 加 BOM 让 Excel 正确识别 UTF-8
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    a.href = url;
    a.download = '点名记录_' + d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '_' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出 ' + state.history.length + ' 条记录', 'ok');
  }

  /* -------------------- 加分记录导出 -------------------- */

  function openExport() {
    var classes = state.classes.map(function (c) { return c.name; });
    // 也把历史里存过记录、但名单里已经没有的班级列出来
    RCData.listScoreClasses().forEach(function (c) {
      if (classes.indexOf(c) < 0) classes.push(c);
    });

    // 全部班级都列出来：没加过分的学生同样要能导出（标 0 分）
    var rows = classes.map(function (c) {
      var students = RCClasses.studentsOf(c, state.students);
      return { cls: c, count: RCData.loadScores(c).records.length, people: students.length };
    }).filter(function (r) { return r.people > 0 || r.count > 0; });

    els.exportList.innerHTML = '';
    if (!rows.length) {
      els.exportList.innerHTML = '<div class="preview-empty">还没有任何班级名单</div>';
      els.exportHint.textContent = '';
      els.exportHint.dataset.cls = '';
      showModal(els.exportModal);
      return;
    }

    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'preview-row export-row';
      row.innerHTML =
        '<span class="idx">·</span>' +
        '<span class="nm"></span>' +
        '<span class="sub"></span>' +
        '<button class="btn btn-ghost btn-mini export-one">导出</button>';
      row.querySelector('.nm').textContent = RCScore.classLabel(r.cls);
      row.querySelector('.sub').textContent = r.people + ' 人 · ' + r.count + ' 条';
      row.querySelector('.export-one').dataset.cls = r.cls === '' ? '\u0000' : r.cls;
      frag.appendChild(row);
    });
    els.exportList.appendChild(frag);

    var totalPeople = rows.reduce(function (a, b) { return a + b.people; }, 0);
    els.exportHint.textContent = rows.length + ' 个班级 · ' + totalPeople + ' 名学生';
    showModal(els.exportModal);
  }

  /** 组一个班级的导出任务（全班学生，含未加分者） */
  function sheetJobFor(className) {
    return {
      className: className,
      students: RCClasses.studentsOf(className, state.students),
      records: RCData.loadScores(className).records
    };
  }

  /**
   * 导出学生分数表（Excel）。
   * 单个班级 → 一个文件一个 sheet；多个班级 → 一个文件每班一个 sheet。
   */
  function exportScoresFor(classList) {
    if (!guard('export.class', '当前账号没有导出班级表格的权限')) return;
    if (!global.RCExportSheet) { toast('导出组件未加载，请刷新页面', 'warn'); return; }
    if (!classList || !classList.length) {
      toast('没有可导出的班级', 'warn');
      return;
    }

    var jobs = classList.map(sheetJobFor).filter(function (j) { return j.students.length > 0; });
    if (!jobs.length) {
      toast('这些班级还没有学生名单', 'warn');
      return;
    }

    var out = RCExportSheet.buildWorkbook(jobs);
    if (!out) { toast('没有可导出的学生', 'warn'); return; }

    RCExportSheet.download(out.bytes, out.filename);
    hideModal(els.exportModal);
    toast('已导出 ' + out.filename + '（' + out.sheetCount + ' 个班）', 'ok');
  }

  /** 组一个班级的「分数详情记录」导出任务（一行 = 一次操作） */
  function recordsJobFor(className) {
    return {
      className: className,
      records: RCData.loadScores(className).records
    };
  }

  /**
   * 导出「分数详情记录表」（Excel）。
   * 与 exportScoresFor 的分工：那个是每人一行的汇总，这个是一次操作一行的流水。
   * 列：时间 / 操作人 / 学生 / 班级 / 分值 / 原因
   */
  function exportRecordsFor(classList) {
    if (!guard('export.class', '当前账号没有导出班级表格的权限')) return;
    if (!global.RCExportSheet) { toast('导出组件未加载，请刷新页面', 'warn'); return; }
    if (!classList || !classList.length) { toast('没有可导出的班级', 'warn'); return; }

    var jobs = classList.map(recordsJobFor).filter(function (j) { return j.records.length > 0; });
    if (!jobs.length) { toast('这些班级还没有加分记录', 'warn'); return; }

    var out = RCExportSheet.buildRecordsWorkbook(jobs);
    if (!out) { toast('没有可导出的记录', 'warn'); return; }

    RCExportSheet.download(out.bytes, out.filename);
    hideModal(els.exportModal);
    toast('已导出 ' + out.filename + '（' + out.sheetCount + ' 个班）', 'ok');
  }

  /* -------------------- 小工具 -------------------- */

  function fmtTime(ts, full) {
    var d = new Date(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    var time = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    return full ? date + ' ' + time : time;
  }

  /* -------------------- 排行榜（独立界面） -------------------- */

  /** 切换首页标签页：'rank' 排行榜 / 'classes' 所有班级 */
  function switchHomeTab(tab) {
    var t = tab === 'classes' ? 'classes' : 'rank';
    // 没有查看排行榜权限（如被单独收回）时不允许停在排行榜页
    if (t === 'rank' && !canDo('export.rank')) t = 'classes';
    state.homeTab = t;
    $$('#homeTabs .tab-btn').forEach(function (b) {
      var on = b.dataset.tab === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (els.paneRank) els.paneRank.classList.toggle('hidden', t !== 'rank');
    if (els.paneClasses) els.paneClasses.classList.toggle('hidden', t !== 'classes');
    // 搜索与导出只在「所有班级」页有意义
    if (els.classesTools) els.classesTools.classList.toggle('hidden', t !== 'classes');
    if (els.homeCount) els.homeCount.classList.toggle('hidden', t !== 'classes');
    if (t === 'rank') renderRank();
    else renderHome();
  }

  /** 排行榜界面渲染（两个板块：本周之星 / 班级总分排名） */
  function renderRank() {
    // 权限在切页时已处理，这里静默返回，避免每次刷新都弹提示
    if (!canDo('export.rank')) return;
    renderStuRank();
    renderClsRank();
    renderAvgRank();
  }

  /** 学生榜：本周之星（前三名领奖台 + 其余 4–15 名列表） */
  function renderStuRank() {
    if (!els.stuPodium) return;
    var period = state.stuPeriod || 'week';
    var range = state.stuRange || { from: '', to: '' };
    $$('#stuPeriod .pill').forEach(function (b) {
      b.classList.toggle('active', b.dataset.period === period);
    });
    syncRangeUI('stu', period === 'custom', range);
    var label = periodLabel(period, range);
    var list = allTopN(15, period, range);
    els.stuPodium.innerHTML = '';
    els.stuList.innerHTML = '';
    if (!list.length) {
      els.stuPodium.innerHTML = '<div class="podium-empty">' + (period === 'all'
        ? '还没有加分记录，先去班里加几分吧'
        : label + '还没有加分记录') + '</div>';
    } else {
      els.stuPodium.appendChild(podium(list.slice(0, 3), 'student'));
      var rest = list.slice(3);
      if (rest.length) {
        var frag = document.createDocumentFragment();
        rest.forEach(function (r, i) { frag.appendChild(rankRow(i + 4, r, false)); });
        els.stuList.appendChild(frag);
      }
    }
    if (els.stuHint) {
      els.stuHint.textContent = label + ' · ' + list.length + ' 名学生上榜';
    }
    // 标题随周期变化：切到总榜还写「本周之星」会自相矛盾
    if (els.stuTitle) {
      els.stuTitle.textContent = period === 'week' ? '本周之星'
        : (period === 'custom' ? '限定期之星' : '总分之星');
    }
  }

  /** 班级榜：班级总分排名（前三名领奖台 + 其余班级列表，含 0 分班级） */
  function renderClsRank() {
    if (!els.clsPodium) return;
    var period = state.clsPeriod || 'all';
    var range = state.clsRange || { from: '', to: '' };
    $$('#clsPeriod .pill').forEach(function (b) {
      b.classList.toggle('active', b.dataset.period === period);
    });
    syncRangeUI('cls', period === 'custom', range);
    var label = periodLabel(period, range);
    var list = rankClasses(period, range);
    els.clsPodium.innerHTML = '';
    els.clsList.innerHTML = '';
    if (!list.length) {
      els.clsPodium.innerHTML = '<div class="podium-empty">还没有班级，先去新建或导入一个班吧</div>';
    } else {
      // 领奖台只放真正有分数的班级：0 分班挂铜牌会让「暂无数据」看起来像荣誉
      var withData = list.filter(function (r) { return r.hasData; });
      var pods = withData.slice(0, 3);
      if (pods.length) {
        els.clsPodium.appendChild(podium(pods, 'class'));
      } else {
        els.clsPodium.innerHTML = '<div class="podium-empty">' + label + '还没有任何班级加分</div>';
      }
      var rest = list.filter(function (r) { return pods.indexOf(r) < 0; });
      if (rest.length) {
        var frag = document.createDocumentFragment();
        rest.forEach(function (r, i) { frag.appendChild(rankRow(pods.length + i + 1, r, true)); });
        els.clsList.appendChild(frag);
      }
    }
    if (els.clsHint) {
      var scored = list.filter(function (r) { return r.hasData; }).length;
      els.clsHint.textContent = label + ' · 共 ' + list.length + ' 个班级' +
        (scored < list.length ? '（' + (list.length - scored) + ' 个暂无数据）' : '');
    }
  }

  /**
   * 自定义期限那一行的显隐 + 两个日期框的值。
   * board: 'stu' | 'cls'
   */
  function syncRangeUI(board, show, range) {
    var box = board === 'stu' ? els.stuRange : els.clsRange;
    var fromEl = board === 'stu' ? els.stuFrom : els.clsFrom;
    var toEl = board === 'stu' ? els.stuTo : els.clsTo;
    if (box) box.classList.toggle('hidden', !show);
    if (fromEl) fromEl.value = (range && range.from) || '';
    if (toEl) toEl.value = (range && range.to) || '';
  }

  /**
   * 自定义期限变化后重算榜单。
   * board: 'stu' | 'cls'
   */
  function applyRange(board) {
    var fromEl = board === 'stu' ? els.stuFrom : els.clsFrom;
    var toEl = board === 'stu' ? els.stuTo : els.clsTo;
    var from = (fromEl && fromEl.value) || '';
    var to = (toEl && toEl.value) || '';
    // 起止填反了就当场换回来（否则标签显示「11-21~11-01」很怪）
    if (from && to && from > to) {
      var tmp = from; from = to; to = tmp;
      if (fromEl) fromEl.value = from;
      if (toEl) toEl.value = to;
    }
    var range = { from: from, to: to };
    if (board === 'stu') {
      state.stuRange = range;
      state.stuPeriod = 'custom';
      renderStuRank();
    } else {
      state.clsRange = range;
      state.clsPeriod = 'custom';
      state.settings.rankPeriod = state.clsPeriod;
      RCData.saveSettings(state.settings);
      renderClsRank();
    }
    saveView();
  }

  /**
   * 班级平均分榜。
   * 分母固定用「全班人数」而不是「本周期有加分的人数」——
   * 否则「近 7 天」的班平均会被分母缩小而虚高，跟总分榜对不上。
   */
  function rankAvgClasses(period, range) {
    return rankClasses(period, range).map(function (r) {
      return {
        name: r.name,
        count: r.count,
        total: r.total,
        hasData: r.hasData,
        // 分母固定为全班人数，不随周期变化
        avg: r.count ? RCScore.round2(r.total / r.count) : 0
      };
    }).sort(function (a, b) {
      if (b.avg !== a.avg) return b.avg - a.avg;
      if (b.total !== a.total) return b.total - a.total;
      return b.count - a.count;
    });
  }

  /** 平均分榜：前三领奖台 + 其余列表，周期跟总分榜一致 */
  function renderAvgRank() {
    if (!els.avgPodium) return;
    var period = state.clsPeriod || 'all';
    var range = state.clsRange || { from: '', to: '' };
    var label = periodLabel(period, range);
    var list = rankAvgClasses(period, range);
    els.avgPodium.innerHTML = '';
    els.avgList.innerHTML = '';
    if (!list.length) {
      els.avgPodium.innerHTML = '<div class="podium-empty">还没有班级，先去新建或导入一个班吧</div>';
    } else {
      var withData = list.filter(function (r) { return r.hasData; });
      var pods = withData.slice(0, 3);
      if (pods.length) {
        els.avgPodium.appendChild(podium(pods, 'avgclass'));
      } else {
        els.avgPodium.innerHTML = '<div class="podium-empty">' + label + '还没有任何班级加分</div>';
      }
      var rest = list.filter(function (r) { return pods.indexOf(r) < 0; });
      if (rest.length) {
        var frag = document.createDocumentFragment();
        rest.forEach(function (r, i) { frag.appendChild(rankAvgRow(pods.length + i + 1, r)); });
        els.avgList.appendChild(frag);
      }
    }
    if (els.avgHint) {
      var scored = list.filter(function (r) { return r.hasData; }).length;
      els.avgHint.textContent = label + ' · 共 ' + list.length + ' 个班级' +
        (scored < list.length ? '（' + (list.length - scored) + ' 个暂无数据）' : '');
    }
  }

  /** 平均分榜的一行：主数字是平均分，副标题带人数与总分 */
  function rankAvgRow(rank, r) {
    var row = document.createElement('div');
    var empty = !r.hasData;
    row.className = 'rank-row' + (rank <= 3 && !empty ? ' top' + rank : '') + (empty ? ' is-empty' : '');
    row.innerHTML =
      '<span class="rank-no"></span>' +
      '<span class="rank-name"><b></b><span class="rank-sub"></span></span>' +
      '<span class="rank-score"></span>';
    row.querySelector('.rank-no').textContent = rank;
    row.querySelector('.rank-name b').textContent = RCScore.classLabel(r.name);
    row.querySelector('.rank-sub').textContent = r.count + ' 人 · 总分 ' + RCScore.fmtNum(r.total);
    var scoreEl = row.querySelector('.rank-score');
    if (empty) {
      scoreEl.textContent = '暂无数据';
      scoreEl.classList.add('is-empty');
    } else {
      scoreEl.textContent = RCScore.fmtNum(r.avg);
      var unit = document.createElement('em');
      unit.className = 'rank-unit';
      unit.textContent = '分';
      scoreEl.appendChild(unit);
    }
    return row;
  }

  /**
   * 领奖台：2-1-3 排列（冠军居中且最高）。
   * kind: 'student' | 'class' | 'avgclass'
   */
  function podium(top3, kind) {
    var wrap = document.createElement('div');
    wrap.className = 'podium-inner';
    var order = [1, 0, 2]; // 索引：亚军、冠军、季军
    order.forEach(function (idx) {
      var r = top3[idx];
      if (!r) {
        // 不足 3 个时补一个占位，保证冠军始终居中、三列宽度不塌
        var hole = document.createElement('div');
        hole.className = 'pod pod-hole';
        hole.setAttribute('aria-hidden', 'true');
        wrap.appendChild(hole);
        return;
      }
      var rank = idx + 1;
      var isClassKind = (kind === 'class' || kind === 'avgclass');
      var col = document.createElement('div');
      col.className = 'pod pod-' + rank;
      if (!(isClassKind && !r.hasData)) col.classList.add('pod-filled');

      var who = document.createElement('div');
      who.className = 'pod-who';
      var nameEl = document.createElement('b');
      nameEl.className = 'pod-name';
      nameEl.textContent = isClassKind ? RCScore.classLabel(r.name) : r.name;
      nameEl.title = nameEl.textContent;
      who.appendChild(nameEl);
      var subEl = document.createElement('span');
      subEl.className = 'pod-sub';
      subEl.textContent = kind === 'avgclass'
        ? (r.count + ' 人 · 总分 ' + RCScore.fmtNum(r.total))
        : (isClassKind
          ? (r.count + ' 人')
          : ((r.group ? r.group : '未分班') + (r.id ? ' · ' + r.id : '')));
      who.appendChild(subEl);

      var scoreEl = document.createElement('div');
      scoreEl.className = 'pod-score';
      var empty = isClassKind && !r.hasData;
      if (empty) {
        scoreEl.textContent = '暂无数据';
        scoreEl.classList.add('is-empty');
      } else {
        scoreEl.textContent = RCScore.fmtNum(kind === 'avgclass' ? r.avg : r.total);
        var unit = document.createElement('em');
        unit.textContent = '分';
        scoreEl.appendChild(unit);
      }

      var base = document.createElement('div');
      base.className = 'pod-base';
      var medal = document.createElement('span');
      medal.className = 'pod-medal';
      medal.textContent = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : '🥉');
      var no = document.createElement('b');
      no.textContent = rank;
      base.appendChild(medal);
      base.appendChild(no);

      // 学生榜前三名各站一只不同的牛，尺寸按名次递减（m13831）
      var niu = null;
      if (kind === 'student') {
        niu = document.createElement('img');
        niu.className = 'pod-niu';
        niu.src = 'assets/brand/niu-rank' + rank + '.png';
        niu.alt = '';
        niu.setAttribute('aria-hidden', 'true');
      }

      col.appendChild(who);
      col.appendChild(scoreEl);
      if (niu) col.appendChild(niu);
      col.appendChild(base);
      wrap.appendChild(col);
    });
    return wrap;
  }

  /**
   * 班级总分榜。
   * m09056：列出**全部班级**，0 分的班也要上榜（排在最后）。
   * hasData 用来区分「一条记录都没有」和「有记录但正负抵消成 0」：
   * 前者显示「暂无数据」，后者如实显示 0。
   */
  function rankClasses(period, range) {
    var names = state.classes.map(function (c) { return c.name; });
    RCData.listScoreClasses().forEach(function (c) {
      if (names.indexOf(c) < 0) names.push(c);
    });
    return names.map(function (name) {
      var st = classStats(name);
      var recs = filterByPeriod(RCData.loadScores(name).records, period, range);
      return {
        name: name,
        count: st.count,
        total: RCScore.round2(RCScore.sumOf(recs)),
        hasData: recs.length > 0
      };
    }).sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return b.count - a.count;
    });
  }

  function rankRow(rank, r, isClass) {
    var row = document.createElement('div');
    var empty = isClass && !r.hasData;
    row.className = 'rank-row' + (rank <= 3 && !empty ? ' top' + rank : '') + (empty ? ' is-empty' : '');
    row.innerHTML =
      '<span class="rank-no"></span>' +
      '<span class="rank-name"><b></b><span class="rank-sub"></span></span>' +
      '<span class="rank-score"></span>';
    row.querySelector('.rank-no').textContent = rank;
    row.querySelector('.rank-name b').textContent =
      isClass ? RCScore.classLabel(r.name) : r.name;
    row.querySelector('.rank-sub').textContent = isClass
      ? (r.count + ' 人')
      : ((r.group ? r.group : '未分班') + (r.id ? ' · ' + r.id : ''));
    // m09056：没有分数的班级不显示 0，显示「暂无数据」，避免和「正负抵消成 0」混淆
    var scoreEl = row.querySelector('.rank-score');
    if (empty) {
      scoreEl.textContent = '暂无数据';
      scoreEl.classList.add('is-empty');
    } else {
      scoreEl.textContent = RCScore.fmtNum(r.total);
    }
    return row;
  }

  function exportRank(mode) {
    if (isViewer()) { toast('访客只能查看，不能导出文件', 'warn'); return; }
    if (!guard('export.rank', '当前账号没有导出排行榜的权限')) return;
    var isAvg = mode === 'avg';
    var isClass = isAvg || (mode || state.rankMode || 'class') === 'class';
    var period = isClass ? (state.clsPeriod || 'all') : (state.stuPeriod || 'week');
    var range = isClass ? (state.clsRange || {}) : (state.stuRange || {});
    var label = periodLabel(period, range);
    // 文件名里不能出现 ~ / 空格等，统一换成安全字符
    var tag = period === 'week' ? '周榜'
      : period === 'month' ? '月榜'
        : period === 'custom' ? (label.replace(/[^\d]/g, '').length >= 8
          ? (range.from || '').slice(2).replace(/-/g, '') + '-' + (range.to || '').slice(2).replace(/-/g, '')
          : '自定义')
          : '总榜';
    var rows, file;
    if (isAvg) {
      var avg = rankAvgClasses(period, range);
      if (!avg.length) { toast('还没有可导出的排行数据', 'warn'); return; }
      rows = [['排名', '班级', '人数', '平均分', '班级总分']];
      avg.forEach(function (r, i) {
        rows.push([i + 1, RCScore.classLabel(r.name), r.count,
          r.hasData ? RCScore.fmtNum(r.avg) : 0, RCScore.fmtNum(r.total)]);
      });
      file = '班级平均分' + tag + '_' + RCScore.fmtDate(Date.now()) + '.csv';
    } else if (isClass) {
      var cls = rankClasses(period, range);
      if (!cls.length) { toast('还没有可导出的排行数据', 'warn'); return; }
      rows = [['排名', '班级', '人数', '班级总分']];
      cls.forEach(function (r, i) {
        rows.push([i + 1, RCScore.classLabel(r.name), r.count, RCScore.fmtNum(r.total)]);
      });
      file = '班级总分' + tag + '_' + RCScore.fmtDate(Date.now()) + '.csv';
    } else {
      var stu = allTopN(15, period, range);
      if (!stu.length) { toast('还没有可导出的排行数据', 'warn'); return; }
      rows = [['排名', '姓名', '学号', '班级', '总分']];
      stu.forEach(function (r, i) {
        rows.push([i + 1, r.name, r.id || '', r.group || '', RCScore.fmtNum(r.total)]);
      });
      file = '学生总分' + tag + 'TOP15_' + RCScore.fmtDate(Date.now()) + '.csv';
    }
    download(rowsToCSV(rows), file);
    toast('已导出 ' + file, 'ok');
  }

  /* -------------------- 导出本班表格 -------------------- */

  /** 本班学生分数表（Excel）：序号 / 姓名 / 学号 / 班级 / 加分次数 / 总分 */
  function exportClassSheet(name) {
    if (!guard('export.class', '当前账号没有导出班级表格的权限')) return;
    exportScoresFor([name]);
  }

  /** 二维数组 → CSV 文本（带 BOM） */
  function rowsToCSV(rows) {
    var body = rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    return '\uFEFF' + body;
  }

  /** 触发浏览器下载 */
  function download(text, filename) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var THEME_ORDER = ['white', 'gold', 'blue'];

  function applyTheme(theme) {
    var t = THEME_ORDER.indexOf(theme) >= 0 ? theme : 'white';
    document.documentElement.dataset.theme = t;
    // 转盘 canvas 用 JS 绘制，需要同步主题配色
    if (global.AnimWheel && global.AnimWheel.setTheme) global.AnimWheel.setTheme(t);
  }

  /** 主题三态循环：暗夜金 → 学院蓝 → 白色 → 暗夜金 */
  function cycleTheme() {
    if (!guard('theme.switch', '当前账号没有切换主题的权限')) return;
    var i = THEME_ORDER.indexOf(state.settings.theme);
    var next = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    applyTheme(next);
    state.settings.theme = next;
    RCData.saveSettings(state.settings);
    syncThemePills();
    toast('已切换到' + ({ gold: '暗夜金', blue: '学院蓝', white: '白色' })[next] + '主题');
  }

  function syncThemePills() {
    $$('#themeSwitch .pill').forEach(function (b) {
      b.classList.toggle('active', b.dataset.theme === state.settings.theme);
    });
  }

  function showModal(m) {
    m.classList.add('show');
  }

  function hideModal(m) {
    m.classList.remove('show');
  }

  function anyModalOpen() {
    return !!document.querySelector('.modal.show');
  }

  function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.className = 'toast' + (kind ? ' ' + kind : '');
    }, 2200);
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      clearTimeout(t);
      var args = arguments, self = this;
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* -------------------- 权限与角色 -------------------- */

  /** 当前账号是否有某个权限。未登录（本机模式）一律放行，避免本地把功能锁死 */
  function canDo(key) {
    if (!global.RCSession || !global.RCSession.isIn()) return true;
    return global.RCSession.can(key);
  }

  /** 权限拦截：没有权限时给提示并返回 false，调用处直接 return */
  function guard(key, msg) {
    if (canDo(key)) return true;
    toast(msg || '当前账号没有这个操作权限', 'warn');
    return false;
  }

  /**
   * 当前是不是「访客」。
   * 访客（viewer）是纯只读角色：能看首页、能进班级看名单与总分，
   * 但不能点名、不能点学生弹窗、不能加减分、不能进入任何编辑流程。
   */
  function isViewer() {
    var m = global.RCSession ? global.RCSession.me() : null;
    return !!m && m.user.role === 'viewer';
  }

  /**
   * 当前操作人姓名：讲师/管理员用真名（displayName），没有真名再退回登录名。
   * 写在每条加分记录上，记录列表与导出都能看到「谁加的分」。
   */
  function operatorName() {
    var m = global.RCSession ? global.RCSession.me() : null;
    if (!m || !m.user) return '';
    var u = m.user;
    return String(u.displayName || u.login || '').trim().slice(0, 24);
  }

  /** 可查看范围：null 表示不限，数组表示只能看这些班（讲师默认看全部） */
  function scopeOf() {
    if (!global.RCSession || !global.RCSession.isIn()) return null;
    return global.RCSession.viewScopes();
  }

  /** 可写范围（任教班级）：null 表示不限 */
  function editScopeOf() {
    if (!global.RCSession || !global.RCSession.isIn()) return null;
    return global.RCSession.classScopes();
  }

  function canSeeClass(name) {
    var sc = scopeOf();
    return sc === null || sc.indexOf(name) >= 0;
  }

  /** 当前班级是否可写（能加分/扣分/撤销/清空）。非任教班级只读 */
  function canEditClass(name) {
    var n = name == null ? state.currentClass : name;
    if (!n) return false;
    var sc = editScopeOf();
    return sc === null || sc.indexOf(n) >= 0;
  }

  /** 当前班级只读时的统一提示语 */
  function readOnlyTip() {
    return '「' + RCScore.classLabel(state.currentClass) + '」不在你的任教范围内，只能查看';
  }

  /**
   * 静态按钮 → 权限映射。
   * 第三项 off=没有权限时置灰不可点，hide=没有权限时直接隐藏。
   * 只改样式，不改 disabled —— 抽取按钮的 disabled 由 updateDrawBtn() 管，别抢。
   */
  var PERM_UI = [
    ['#btnNewClass', 'class.create', 'hide'],
    ['#btnNewClass2', 'class.create', 'hide'],
    ['#btnImportHome', 'roster.import', 'hide'],
    ['#btnImportHome2', 'roster.import', 'hide'],
    ['#btnImport', 'roster.import', 'off'],
    ['#btnImport2', 'roster.import', 'off'],
    ['#btnEduSync', 'roster.sync', 'hide'],
    ['#btnManual', 'roster.import', 'off'],
    ['#btnSettingsHome', 'settings.open', 'off'],
    ['#btnSettings', 'settings.open', 'off'],
    ['#btnThemeHome', 'theme.switch', 'off'],
    ['#btnTheme', 'theme.switch', 'off'],
    ['#btnRankExport', 'export.rank', 'off'],
    ['#btnRankExportCls', 'export.rank', 'off'],
    ['#btnRankExportAvg', 'export.rank', 'off'],
    ['#homeTabs [data-tab="rank"]', 'export.rank', 'hide'],
    ['#btnClassSheet', 'export.class', 'off'],
    ['#btnExportAllClasses', 'export.school', 'hide'],
    ['#btnExportScores', 'export.class', 'off'],
    ['#btnExport', 'record.view_class', 'off'],
    ['#btnReset', 'draw.reset', 'off'],
    ['#btnUndoOp', 'score.void', 'off'],
    ['#btnDraw', 'draw.random', 'off'],
    ['#btnWipe', 'settings.wipe', 'hide'],
    ['#animSwitch', 'draw.mode_switch', 'off'],
    ['#quickRow .score-btn.minus', 'score.subtract', 'off'],
    ['#quickRow .score-btn.plus', 'score.add', 'off'],
    ['#btnFocusClear', 'score.clear_student', 'off'],
    ['#btnApplyScore', 'score.add', 'off'],
    ['#btnFocusPick', 'score.add', 'off']
  ];

  /** 按当前权限刷新界面：置灰 / 隐藏 + 角色横幅 */
  function applyPerms() {
    PERM_UI.forEach(function (row) {
      var ok = canDo(row[1]);
      var hide = row[2] === 'hide';
      $$(row[0]).forEach(function (el) {
        el.classList.toggle('perm-off', !ok && !hide);
        el.classList.toggle('perm-hide', !ok && hide);
      });
    });
    applyVisitorLocks();
    applyRoleBanner();
  }

  /**
   * 访客纯只读的额外收口（m08570）：
   * 排行榜可以看，但导出会落文件、算「操作」，访客一律置灰。
   * 这里单独处理，是因为导出排行榜的权限键 export.rank 访客是有的（不然连榜单都打不开）。
   */
  function applyVisitorLocks() {
    var viewer = isViewer();
    ['#btnRankExport', '#btnRankExportCls', '#btnRankExportAvg', '#btnClassSheet', '#btnExportScores', '#btnExportAllClasses', '#btnExport'].forEach(function (sel) {
      $$(sel).forEach(function (el) {
        el.classList.toggle('perm-off', viewer);
      });
    });
  }

  /** 访客模式在顶部挂一条只读说明 */
  function applyRoleBanner() {
    var b = document.getElementById('roleBanner');
    if (!b) return;
    var me = global.RCSession ? global.RCSession.me() : null;
    var viewer = !!me && me.user.role === 'viewer';
    b.classList.toggle('hidden', !viewer);
    if (viewer) b.textContent = '访客模式 · 纯只读：可以查看班级名单、总分、前三名与排行榜；不能点名、不能点开学生、不能加减分或做任何修改';
  }

  /* -------------------- 启动 -------------------- */

  /**
   * 引导：先确定数据源（本地 / 远程），再跑 init()。
   * 这样 app.js 里的同步读写全部走 RCData 门面，UI 不需要 async 化。
   */
  /**
   * 登录态到期（满 2 小时 / 服务端判失效）时的统一收尾。
   * 由 RCSession 的到期巡检或任意接口 401 触发，唯一职责是：
   * 清掉界面上的登录痕迹 → 收回登录页并说明原因。
   * 注意不能刷新页面：老师可能正在填分，刷新会丢掉未提交的输入。
   */
  function onSessionExpired(reason) {
    try {
      state.me = null;
      state.selected = {};
      state.busy = false;
      hideResult();
      $$('.modal.show').forEach(function (m) { hideModal(m); });
    } catch (e) { console.warn('[RC] 会话到期清理失败', e); }
    if (global.RCLogin && typeof global.RCLogin.signOut === 'function') {
      global.RCLogin.signOut({ expired: true, reason: reason || 'timeout' });
    }
  }

  function boot() {
    var info = { mode: 'local', reason: '未初始化' };
    var started = false;

    function start(inf) {
      if (started) return;
      started = true;
      info = inf || info;
      state.dataMode = info.mode;
      state.dataReason = info.reason || '';
      try { init(); } catch (e) {
        console.error('[RC] 初始化失败', e);
        showBootError(e);
      }
      applyDataModeBadge(info);
      watchDataEvents();

      // 本机模式的账号存在浏览器里：先确保内置最高管理员在位，
      // 再交给登录页。远程模式的账号在服务端，由 seed 保证，这里不能碰。
      if (info.mode !== 'remote' && global.RCAuthStore &&
          typeof global.RCAuthStore.ensureDefaultAdmin === 'function') {
        try { global.RCAuthStore.ensureDefaultAdmin(); }
        catch (e) { console.warn('[RC] 内置管理员初始化失败', e); }
      }

      // 登录门禁：两种模式都要先登录，区别只在于账号从哪来。
      if (global.RCLogin && typeof global.RCLogin.start === 'function') {
        /* 注册「登录态到期」回调：满 2 小时或服务端判会话失效时，
           RCSession 只负责清自己的状态，界面收尾交给这里（清弹窗、收回到登录页）。 */
        if (global.RCSession && typeof global.RCSession.onExpire === 'function') {
          try { global.RCSession.onExpire(onSessionExpired); }
          catch (e) { console.warn('[RC] 注册会话到期回调失败', e); }
        }
        global.RCLogin.start({
          mode: info.mode,
          onSuccess: function (me) { onSignedIn(me); }
        });
      } else {
        onSignedIn(null);
      }
    }

    // 兜底：2.5s 内没完成就先用本地模式把界面撑起来，避免白屏
    var guard = setTimeout(function () {
      if (!started) {
        console.warn('[RC] 数据源初始化超时，先以本地模式启动');
        start({ mode: 'local', reason: '数据源初始化超时，已用本地模式启动', offline: true });
      }
    }, 2500);

    RCData.init({ baseUrl: '/api/v1' }).then(function (inf) {
      clearTimeout(guard);
      start(inf);
    }).catch(function (err) {
      clearTimeout(guard);
      start({ mode: 'local', reason: '数据源初始化异常：' + (err && err.message || err), offline: true });
    });
  }

  /** 登录成功后：记录当前用户、装用户菜单、刷新权限与可见班级 */
  function onSignedIn(me) {
    state.me = me || null;

    if (global.RCUserUI && typeof global.RCUserUI.start === 'function') {
      global.RCUserUI.start({
        toast: toast,
        onSignOut: function () {
          state.me = null;
          state.selected = {};
          state.busy = false;
          hideResult();
          $$('.modal.show').forEach(function (m) { hideModal(m); });
          if (global.RCLogin && global.RCLogin.signOut) global.RCLogin.signOut();
        },
        onMe: function (m) {
          state.me = m || null;
          afterMeChanged();
        }
      });
    }

    afterMeChanged();

    /* 登录成功后再从服务端重拉一次名单与班级。
       启动时的 bootstrap() 可能是在未登录状态下跑的（那时 /roster 会被 401 拒绝），
       也可能拿到的是上一次的缓存；这里补一次，确保进到首页看到的是服务端的真实数据。
       失败不影响使用：适配器会退回缓存，写守卫也会阻止把空名单提交上去。 */
    try {
      if (RCData && typeof RCData.reload === 'function') {
        RCData.reload().then(function (r) {
          if (!r || !r.ok) return;
          try {
            syncFromAdapter();
            renderHome();
            refreshAll();
          } catch (e) { console.warn('[RC] 登录后重载失败', e); }
        }).catch(function () { /* 离线时忽略 */ });
      }
    } catch (e) { console.warn('[RC] 登录后重拉数据失败', e); }

    // 教务名单读取入口：只有服务器模式才有意义（本机模式没有服务端）
    if (global.RCEduUI && typeof global.RCEduUI.start === 'function') {
      global.RCEduUI.start();
    }
  }

  /**
   * 从适配器重读名单与班级，重建首页状态。
   * reloadAfterEduSync() 与「登录成功后重拉」共用这一段。
   */
  function syncFromAdapter() {
    state.students = RCData.loadRoster();
    var cls = RCData.loadClasses();
    state.classes = RCClasses.ensure(cls.list, state.students);
    var names = state.classes.map(function (c) { return c.name; });
    if (names.indexOf(state.currentClass) < 0) {
      state.currentClass = names[0] || '';
    }
    loadClassScores();
    state.selected = {};
    state.lastDraw = null;
    hideResult();
  }

  /**
   * 教务同步完成后重新装载数据。
   * 不能只 refreshAll() —— 班级和学生都变了，必须从适配器重读一遍，
   * 否则首页还是同步前的班级列表。
   */
  function reloadAfterEduSync() {
    // 先让适配器从服务端重拉一次，否则 loadRoster/loadClasses 读到的
    // 还是同步前那份内存缓存（曾导致「已读取 2 个班级」但首页 0 个班）。
    var done = function () {
      try {
        syncFromAdapter();
        renderHome();
        refreshAll();
        if (state.view === 'class' && state.currentClass) enterClass(state.currentClass);
      } catch (e) {
        console.warn('[RC] 同步后重载失败', e);
      }
    };
    try {
      if (RCData && typeof RCData.reload === 'function') {
        RCData.reload().then(done).catch(done);
      } else {
        done();
      }
    } catch (e) {
      console.warn('[RC] 重拉数据失败', e);
      done();
    }
  }

  /** 当前用户/权限变了以后要重算的东西 */
  function afterMeChanged() {
    applyPerms();
    renderHome();
    // 访客不进工作台：如果上一个身份停在班级页，回到首页
    if (isViewer() && state.view === 'class') backHome();
    // 当前班不在授权范围内就退回授权范围内的第一个班
    if (!isViewer() && state.currentClass && !canSeeClass(state.currentClass)) {
      var sc = scopeOf();
      var first = sc && sc.length ? sc[0] : '';
      if (first) {
        enterClass(first);
        state.pendingView = '';
        return;
      }
    }
    // 刷新后恢复上次所在的页面（只有登录态就绪、权限确认后才敢跳）
    restorePendingView();
    refreshAll();
    // init() 跑的时候 #app 还是 hidden，舞台量不到尺寸，登录后必须补一次
    requestAnimationFrame(function () {
      syncResultReserve();
      AnimSpotlight.fitGrid();
      AnimWheel.resize();
    });
  }

  /**
   * 消费 init() 记下的 pendingView：回到刷新前的页面。
   * 访客、无当前班、无权限时一律留在首页。
   */
  function restorePendingView() {
    var want = state.pendingView;
    state.pendingView = '';
    if (!want) return;
    if (want === 'class') {
      if (isViewer() || !state.currentClass || !canSeeClass(state.currentClass)) return;
      enterClass(state.currentClass);
      return;
    }
    if (want === 'games') {
      state.gamesFrom = 'home';
      if (global.RCGames && typeof global.RCGames.render === 'function') global.RCGames.render();
      showScreen('games');
    }
  }

  /** 启动失败时给出可读提示，而不是白屏 */
  function showBootError(err) {
    try {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
        'background:#f5f7fb;color:#0f172a;font:15px/1.7 system-ui,sans-serif;padding:32px;text-align:center;';
      box.innerHTML = '<div><h2 style="margin:0 0 12px;font-size:20px">页面启动失败</h2>' +
        '<p style="margin:0 0 8px;color:#475569">' + String(err && err.message || err) + '</p>' +
        '<p style="margin:0;color:#8494a8;font-size:13px">请刷新页面重试；若反复出现，请清空浏览器缓存后再打开。</p></div>';
      document.body.appendChild(box);
    } catch (e) { /* ignore */ }
  }

  /**
   * 数据模式角标：本地模式给个小提示，远程模式不打扰。
   * 只在「本地模式 + http(s) 访问」时提示，因为这时用户可能以为数据在服务器上。
   */
  /**
   * 订阅数据源事件，把「没存上的记录」明确告诉老师。
   *
   * 性能测试 P0-1 的教训：离线队列写满或补传连续失败时，旧代码只 console.warn，
   * 界面照样提示「已加分」，刷新后数据就没了。现在一律冒泡成红色提示，
   * 并说明有几条没保存，让老师知道要重做。
   */
  function watchDataEvents() {
    if (!RCData || typeof RCData.onEvent !== 'function') return;
    try {
      RCData.onEvent(function (evt) {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'flush') {
          var poisoned = evt.poisoned || [];
          var rejected = evt.rejected || [];
          if (poisoned.length) {
            toast('有 ' + poisoned.length + ' 条记录连续保存失败，已放弃重试。请刷新页面后重新录入。', 'warn');
            console.error('[RC] 被放弃的队列项', poisoned);
          } else if (rejected.length) {
            // 服务端明确拒绝（4xx）：重试无意义，但必须让老师知道这条没存上
            var first = rejected[0];
            var why = first.code === 'PAYLOAD_TOO_LARGE' ? '数据太大' : (first.error || '服务端拒绝');
            toast('有 ' + rejected.length + ' 条记录没能保存（' + why + '），请刷新页面后重试', 'warn');
            console.error('[RC] 被服务端拒绝的队列项', rejected);
          } else if (evt.failed > 0) {
            toast('有 ' + evt.failed + ' 条记录还没保存上，网络恢复后会自动重试', 'warn');
          }
          return;
        }
        if (evt.type === 'scoresRejected') {
          toast('加分记录没能保存：请刷新页面后重试', 'warn');
          return;
        }
        if (evt.type === 'rosterRejected' || evt.type === 'classesRejected') {
          toast('名单没能保存到服务器，请刷新页面后重试', 'warn');
        }
      });
    } catch (e) { console.warn('[RC] 订阅数据事件失败', e); }
  }

  function applyDataModeBadge(info) {
    try {
      var isFile = global.location.protocol === 'file:';
      if (info.mode !== 'local') return;
      if (isFile) return; // 双击打开本来就是本地版，不用提示
      var bar = document.createElement('div');
      bar.id = 'dataModeBar';
      bar.textContent = '本地模式 · 数据只保存在这台电脑的浏览器里' + (info.reason ? '（' + info.reason + '）' : '');
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9000;padding:7px 14px;' +
        'background:rgba(217,119,6,.94);color:#fff;font:12.5px/1.5 system-ui,sans-serif;text-align:center;';
      document.body.appendChild(bar);
      document.body.style.paddingBottom = '30px';
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露给调试
  global.RC = {
    state: state,
    draw: draw,
    refreshAll: refreshAll,
    addScore: addScore,
    switchClass: switchClass,
    currentStudents: currentStudents,
    enterClass: enterClass,
    backHome: backHome,
    renderHome: renderHome,
    openRank: renderRank,
    renderRank: renderRank,
    switchHomeTab: switchHomeTab,
    renderStuRank: renderStuRank,
    renderClsRank: renderClsRank,
    exportClassSheet: exportClassSheet,
    exportRank: exportRank,
    cycleTheme: cycleTheme,
    classTopN: classTopN,
    allTopN: allTopN,
    allRecords: allRecords,
    reloadAfterEduSync: reloadAfterEduSync,
    openGames: openGames,
    closeGames: closeGames,
    showScreen: showScreen,
    toast: toast
  };
})(window);
