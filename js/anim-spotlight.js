/* ============================================================
   anim-spotlight.js — 聚光灯点名
   全班名字铺成网格，高亮框快速跳转 → 减速 → 定格命中卡片
   卡片额外承载：累计总分徽标、多选勾选状态、点击回调
   ============================================================ */

(function (global) {
  'use strict';

  var gridEl, glowEl;
  var cards = [];      // DOM 节点，与 students 索引对应
  var students = [];
  var raf = 0;
  var running = false;

  var opts = {
    totals: null,       // {studentKey: number} 累计总分
    today: null,        // {studentKey: number} 当天得分
    selected: null,     // {studentKey: 1}
    selectMode: false,
    onCardClick: null
  };

  function keyOf(s) {
    return (s && s.name ? String(s.name) : '') + '\u0000' + (s && s.id ? String(s.id) : '');
  }

  function mount(grid, glow) {
    gridEl = grid;
    glowEl = glow;
    if (!gridEl) return;
    // 事件委托：卡片会被整体重建，绑在容器上就不用每次重新挂
    gridEl.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.name-card') : null;
      if (!card || !gridEl.contains(card)) return;
      // 已定格命中时，只有命中卡可交互；其余被模糊的卡片一律不响应。
      // CSS 已用 pointer-events:none 拦住，这里再兜一层：避免键盘触发、
      // 或在 pointer-events 被主题样式覆盖时仍然点开别班学生。
      if (gridEl.classList.contains('has-winner') && !card.classList.contains('winner')) return;
      var i = parseInt(card.dataset.index, 10);
      if (isNaN(i) || !students[i]) return;
      if (opts.onCardClick) opts.onCardClick(students[i], i, card);
    });
  }

  function fmtTotal(n) {
    var v = Math.round((Number(n) || 0) * 100) / 100;
    if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
    return String(v);
  }

  /** 角标内容：小字标签 + 大字分值（「总分 8」「今日得分 3」） */
  function setBadge(el, label, val) {
    if (!el) return;
    el.textContent = '';
    var i = document.createElement('i');
    i.textContent = label;
    var b = document.createElement('b');
    b.textContent = fmtTotal(val || 0);
    el.appendChild(i);
    el.appendChild(b);
  }

  /** 重建卡片网格 */
  function render(list, o) {
    students = list || [];
    cards = [];
    if (o) {
      if ('totals' in o) opts.totals = o.totals;
      if ('today' in o) opts.today = o.today;
      if ('selected' in o) opts.selected = o.selected;
      if ('selectMode' in o) opts.selectMode = !!o.selectMode;
      if ('onCardClick' in o) opts.onCardClick = o.onCardClick;
    }
    if (!gridEl) return;
    gridEl.innerHTML = '';
    gridEl.classList.remove('has-winner');
    gridEl.classList.toggle('select-mode', !!opts.selectMode);

    var frag = document.createDocumentFragment();
    students.forEach(function (s, i) {
      var k = keyOf(s);
      var d = document.createElement('div');
      d.className = 'name-card';
      d.dataset.index = String(i);
      d.dataset.key = k;
      if (opts.selected && opts.selected[k]) d.classList.add('picked');

      var name = document.createElement('span');
      name.className = 'card-name';
      name.textContent = s.name;
      d.appendChild(name);

      // 左下角：总分（蓝色系）
      var score = document.createElement('span');
      score.className = 'card-score';
      var tot = opts.totals && opts.totals[k];
      setBadge(score, '总分', tot);
      score.classList.add(tot > 0 ? 'pos' : (tot < 0 ? 'neg' : 'zero'));
      score.title = '累计总分';
      d.appendChild(score);

      // 右下角：今日得分（绿色系），为 0 时淡灰显示，保持左右两角布局稳定
      var today = document.createElement('span');
      today.className = 'card-today';
      var td = opts.today && opts.today[k];
      setBadge(today, '今日得分', td);
      today.classList.add(td ? (td > 0 ? 'pos' : 'neg') : 'zero');
      today.title = '当天得分';
      d.appendChild(today);

      var tick = document.createElement('span');
      tick.className = 'card-tick';
      tick.textContent = '✓';
      d.appendChild(tick);

      frag.appendChild(d);
      cards.push(d);
    });
    gridEl.appendChild(frag);

    fitGrid();
    fitNames();

    if (glowEl) { glowEl.classList.remove('on'); }
  }

  /** 只更新总分与当天分徽标，不重建 DOM（加分时用，避免动画被打断） */
  function setTotals(map, todayMap) {
    opts.totals = map || null;
    if (todayMap !== undefined) opts.today = todayMap || null;
    cards.forEach(function (c) {
      var k = c.dataset.key;

      var el = c.querySelector('.card-score');
      if (el) {
        var tot = opts.totals && opts.totals[k];
        el.classList.remove('pos', 'neg', 'zero');
        setBadge(el, '总分', tot);
        el.classList.add(tot > 0 ? 'pos' : (tot < 0 ? 'neg' : 'zero'));
      }

      var td = c.querySelector('.card-today');
      if (td) {
        var v = opts.today && opts.today[k];
        td.classList.remove('pos', 'neg', 'zero');
        setBadge(td, '今日得分', v);
        td.classList.add(v ? (v > 0 ? 'pos' : 'neg') : 'zero');
      }
    });
  }

  /** 只更新勾选状态 */
  function setSelected(map) {
    opts.selected = map || null;
    cards.forEach(function (c) {
      c.classList.toggle('picked', !!(opts.selected && opts.selected[c.dataset.key]));
    });
  }

  function setSelectMode(on) {
    opts.selectMode = !!on;
    if (gridEl) gridEl.classList.toggle('select-mode', !!on);
  }

  /**
   * 按人数与容器尺寸算列数，让人少时卡片不会被拉成长条
   * 目标：卡片宽高比接近 1.5 : 1，且铺满容器
   */
  function fitGrid() {
    if (!gridEl) return;
    var n = cards.length;
    if (!n) return;

    var rect = gridEl.getBoundingClientRect();
    var W = rect.width, H = rect.height;
    if (W < 40 || H < 40) {
      // 视图未激活时尺寸为 0，等下一帧再算
      requestAnimationFrame(fitGrid);
      return;
    }

    var cs = getComputedStyle(gridEl);
    var gap = parseFloat(cs.gap) || 8;
    var padX = parseFloat(cs.paddingLeft) || 8;
    // 结果条出现时 padding-bottom 会变大，必须按上下实际 padding 计算，否则底部卡片被压住
    var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var availW = W - padX * 2;
    var availH = H - padY;
    var MAX_W = 288;   // 单卡最大宽度，人少时别把一张卡撑满整屏

    var best = null;
    for (var cols = 1; cols <= n; cols++) {
      var rows = Math.ceil(n / cols);
      var cw = (availW - gap * (cols - 1)) / cols;
      var ch = (availH - gap * (rows - 1)) / rows;
      if (cw <= 0 || ch <= 0) continue;

      cw = Math.min(cw, MAX_W);          // 先按上限收窄，评分用真实尺寸
      var ratio = cw / ch;
      if (ratio < 0.62) continue;        // 太瘦长的卡不美观，直接排除

      // 评分 = 比例偏离 + 空格子 + 未铺满
      var score = Math.abs(Math.log(ratio / 1.45));
      score += (cols * rows - n) * 0.30;
      var coverage = (cw * cols * ch * rows) / (availW * availH);
      score += (1 - coverage) * 0.50;
      if (cw < 116 || ch < 56) score += 1.4;
      if (!best || score < best.score) best = { cols: cols, rows: rows, score: score, cw: cw, ch: ch };
    }
    if (!best) return;

    gridEl.style.gridTemplateColumns = 'repeat(' + best.cols + ', ' + Math.round(best.cw) + 'px)';
    gridEl.style.gridAutoRows = Math.round(best.ch) + 'px';
    // 列方向居中、行方向居中，卡片严格保持算出来的比例（不被拉伸成瘦长条）
    gridEl.style.alignContent = 'center';
    gridEl.style.justifyContent = 'center';

    // 字号跟随卡片尺寸：人少时卡片大、字也大，投影时后排也看得清
    var fs = Math.max(15, Math.min(best.ch * 0.30, best.cw * 0.185, 40));
    // 两个角标：左下累计分、右下当天分，都要比原来的学号大
    var badge = Math.max(13, Math.min(best.ch * 0.155, best.cw * 0.115, 24));
    gridEl.style.setProperty('--card-fs', Math.round(fs) + 'px');
    gridEl.style.setProperty('--card-sub', Math.round(Math.max(11, badge * 0.8)) + 'px');
    gridEl.style.setProperty('--card-badge', Math.round(badge) + 'px');

    fitNames();
  }

  /**
   * 长名字按「可用宽度 / 实际文字宽度」等比缩小字号。
   * 不能用 transform: scale()——transform 不改变布局盒，文字会先被
   * text-overflow: ellipsis 截断成「一班学…」，缩小后依然是省略号。
   * 这里改成真正改字号，让文字重新排版，名字完整显示。
   */
  function fitNames() {
    if (!gridEl || !cards.length) return;
    var base = parseFloat(getComputedStyle(gridEl).getPropertyValue('--card-fs')) || 20;

    cards.forEach(function (c) {
      var t = c.querySelector('.card-name');
      if (!t) return;
      t.style.fontSize = '';
      var avail = t.clientWidth;
      var need = t.scrollWidth;
      if (!avail || !need || need <= avail) return;
      var fs = base * (avail / need) * 0.97;
      t.style.fontSize = Math.max(11, Math.floor(fs * 10) / 10) + 'px';
    });
  }

  function clearHot() {
    cards.forEach(function (c) { c.classList.remove('hot'); });
  }

  function moveGlow(card) {
    if (!glowEl || !card || !gridEl) return;
    var gr = gridEl.getBoundingClientRect();
    var cr = card.getBoundingClientRect();
    glowEl.style.left = (cr.left - gr.left + cr.width / 2) + 'px';
    glowEl.style.top = (cr.top - gr.top + cr.height / 2) + 'px';
  }

  /**
   * 播放动画
   * @param {Object} opt {pool:Array<student>, winner:student, fast:boolean, sound:boolean}
   * @returns {Promise<void>}
   */
  function play(opt) {
    var pool = opt.pool || students;
    var winner = opt.winner;
    var fast = !!opt.fast;
    var sound = opt.sound !== false && global.RCAudio;

    return new Promise(function (resolve) {
      if (!cards.length || !winner) { resolve(); return; }

      // 候选卡片索引
      var poolIdx = [];
      var poolSet = Object.create(null);
      pool.forEach(function (s) { poolSet[RCPicker.studentKey(s)] = 1; });
      students.forEach(function (s, i) {
        if (poolSet[RCPicker.studentKey(s)]) poolIdx.push(i);
      });
      if (!poolIdx.length) poolIdx = students.map(function (_, i) { return i; });

      var winnerIdx = students.findIndex(function (s) {
        return RCPicker.studentKey(s) === RCPicker.studentKey(winner);
      });
      if (winnerIdx < 0) winnerIdx = poolIdx[0];

      gridEl.classList.remove('has-winner');
      clearHot();
      clearWinner();          // 清掉上一轮的命中定格，避免多张卡片同时发光
      if (glowEl) glowEl.classList.add('on');

      running = true;
      var t0 = performance.now();
      var totalMs = fast ? 900 : 2600;
      var tickMs = fast ? 30 : 55;

      var lastIdx = -1;
      var ticks = 0;

      function step(now) {
        if (!running) { resolve(); return; }
        var elapsed = now - t0;
        var p = Math.min(1, elapsed / totalMs);
        // easeOutQuint：先快后慢
        var eased = 1 - Math.pow(1 - p, 5);

        // 目标 tick 数随缓动增长
        var targetTicks = Math.floor(eased * (totalMs / tickMs));

        while (ticks <= targetTicks && p < 1) {
          ticks++;
          var idx;
          do {
            idx = poolIdx[RCPicker.randInt(poolIdx.length)];
          } while (idx === lastIdx && poolIdx.length > 1);
          lastIdx = idx;

          clearHot();
          var card = cards[idx];
          if (card) {
            card.classList.add('hot');
            moveGlow(card);
          }
          if (sound && ticks % 2 === 0) {
            try { RCAudio.blip(ticks); } catch (e) {}
          }
          // 每帧只允许有限次跳转，避免卡顿时补跳过多
          if (ticks - targetTicks < -1) break;
        }

        if (p < 1) {
          raf = requestAnimationFrame(step);
        } else {
          finish(winnerIdx);
          resolve();
        }
      }

      function finish(idx) {
        running = false;
        clearHot();
        var card = cards[idx];
        if (card) {
          card.classList.add('winner');
          moveGlow(card);
          // 注意：不要用 scrollIntoView —— 网格已经一屏铺满，滚动反而会把卡片顶出可视区
        }
        gridEl.classList.add('has-winner');
        if (glowEl) glowEl.classList.remove('on');
        if (sound) { try { RCAudio.fanfare(); } catch (e) {} }
      }

      raf = requestAnimationFrame(step);
    });
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    clearHot();
  }

  function clearWinner() {
    cards.forEach(function (c) { c.classList.remove('winner', 'hot'); });
    if (gridEl) gridEl.classList.remove('has-winner');
  }

  /** 把某个学生卡片标记成命中（用于「给 TA 加分」等外部触发） */
  function highlight(s) {
    if (!s) return;
    var k = keyOf(s);
    cards.forEach(function (c) {
      c.classList.toggle('winner', c.dataset.key === k);
    });
    if (gridEl) gridEl.classList.add('has-winner');
  }

  global.AnimSpotlight = {
    mount: mount,
    render: render,
    play: play,
    stop: stop,
    clearWinner: clearWinner,
    highlight: highlight,
    fitGrid: fitGrid,
    setTotals: setTotals,
    setSelected: setSelected,
    setSelectMode: setSelectMode,
    count: function () { return cards.length; }
  };
})(window);
