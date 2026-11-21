/* ============================================================
   课堂破冰 · 14 个网页互动游戏
   ============================================================ */
(function () {
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const RENDERERS = window.RENDERERS;

  function countdown(api, seconds, onTick, onEnd) {
    const total = seconds * 1000;
    const t0 = performance.now();
    let stopped = false;
    let raf = 0;
    const frame = now => {
      if (stopped) return;
      const left = Math.max(0, total - (now - t0));
      onTick(left, total);
      if (left <= 0) {
        stopped = true;
        onEnd && onEnd();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const handle = { stop() { stopped = true; cancelAnimationFrame(raf); } };
    api.cleanup(handle.stop);
    return handle;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选中'));
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选中'); }
    ta.remove();
  }

  /* ============================================================
     02 逢 7 过
     ============================================================ */
  RENDERERS.g02 = function (stage, api) {
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已通过</span><b id="f7s">0</b></div>
          <div class="hud"><span class="hud-k">本轮数字</span><b id="f7n">1</b></div>
          <div class="hud"><span class="hud-k">倒计时</span><b id="f7t">3.4s</b></div>
        </div>
        <div class="meter"><i id="f7bar"></i></div>
        <div class="big-box" id="f7box">
          <span class="big-num" id="f7num">1</span>
          <span class="big-sub" id="f7sub">轮到你：这个数该<b>报数</b>，还是<b>拍手跳过</b>？</span>
        </div>
        <div class="btn-row">
          <button class="btn btn-ink" type="button" id="f7say">报数</button>
          <button class="btn btn-accent" type="button" id="f7clap">拍手跳过</button>
        </div>
        <p class="msg" id="f7msg">含 7 或是 7 的倍数，不能报出来，要拍一下手跳过。</p>
        <div id="f7end"></div>
      </div>`;

    const nEl = q('#f7n', stage), numEl = q('#f7num', stage), sEl = q('#f7s', stage);
    const tEl = q('#f7t', stage), barEl = q('#f7bar', stage), msgEl = q('#f7msg', stage);
    const endEl = q('#f7end', stage), boxEl = q('#f7box', stage);

    let n = 1, score = 0, over = false, raf = 0, stopTurn = null;

    const shouldSkip = value => value % 7 === 0 || String(value).includes('7');
    const limitSec = () => Math.max(1.6, 3.4 - score * 0.07);

    function beginTurn() {
      if (stopTurn) stopTurn();
      nEl.textContent = n;
      numEl.textContent = n;
      msgEl.className = 'msg';
      msgEl.textContent = shouldSkip(n) ? '这个数……你要怎么处理？' : '轮到你了，直接报出来。';
      const limit = limitSec() * 1000;
      const t0 = performance.now();
      const tick = now => {
        const left = Math.max(0, limit - (now - t0));
        tEl.textContent = (left / 1000).toFixed(1) + 's';
        barEl.style.width = (left / limit * 100) + '%';
        if (left <= 0) { stopTurn = null; fail('节奏断了 —— 超时'); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stopTurn = () => { cancelAnimationFrame(raf); };
    }

    function fail(reason) {
      if (over) return;
      over = true;
      if (stopTurn) { stopTurn(); stopTurn = null; }
      tEl.textContent = '0.0s';
      barEl.style.width = '0%';
      boxEl.classList.add('shake');
      tone(180, 0.24, 'square');
      endEl.innerHTML = `
        <div class="result bad">
          <h3>出局了</h3>
          <p>${reason}。本轮已经通过 <b>${score}</b> 个数字。</p>
          <div><button class="btn btn-accent btn-sm" type="button" id="f7again">再来一局</button></div>
        </div>`;
    }

    function answer(skip) {
      if (over) return;
      const need = shouldSkip(n);
      if (skip === need) {
        score++;
        n++;
        sEl.textContent = score;
        tone(760, 0.08);
        msgEl.className = 'msg ok';
        msgEl.textContent = skip ? '拍得对，跳过。' : '报得对，继续。';
        boxEl.classList.remove('shake');
        beginTurn();
      } else {
        fail(skip ? `数字 ${n} 不需要拍手，应该直接报出来` : `数字 ${n} 要拍手跳过`);
      }
    }

    q('#f7say', stage).addEventListener('click', () => answer(false));
    q('#f7clap', stage).addEventListener('click', () => answer(true));
    endEl.addEventListener('click', e => {
      if (!e.target.closest('#f7again')) return;
      n = 1; score = 0; over = false;
      sEl.textContent = '0';
      endEl.innerHTML = '';
      boxEl.classList.remove('shake');
      beginTurn();
    });

    api.cleanup(() => { if (stopTurn) stopTurn(); });
    beginTurn();
  };

  /* ============================================================
     03 数字炸弹
     ============================================================ */
  RENDERERS.g03 = function (stage, api) {
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">当前出题</span><b id="zbTeam">第 1 组</b></div>
          <div class="hud"><span class="hud-k">已猜</span><b id="zbCount">0</b></div>
          <div class="hud"><span class="hud-k">范围</span><b id="zbRange">1 – 100</b></div>
        </div>
        <div class="bomb-range">
          <span class="bomb-range-label">自定义范围</span>
          <input class="ipt" id="zbMin" type="number" value="1" aria-label="最小值">
          <span class="bomb-range-dash">—</span>
          <input class="ipt" id="zbMax" type="number" value="100" aria-label="最大值">
          <span class="bomb-range-label" style="margin-left:8px">分组</span>
          <input class="ipt" id="zbTeams" type="number" value="6" min="1" max="12" aria-label="分组数">
          <button class="btn btn-line btn-sm" type="button" id="zbApply">应用并重开</button>
        </div>
        <div class="big-box zb-box" id="zbBox">
          <span class="zb-thermo" id="zbThermo" aria-hidden="true">🌡️</span>
          <span class="zb-temp" id="zbTemp">待猜</span>
          <span class="big-sub" id="zbMsg">炸弹埋在 1–100 之间。每次只告诉你冷热，不给方向。</span>
        </div>
        <form class="input-row" id="zbForm" autocomplete="off">
          <input class="ipt" id="zbInput" type="number" inputmode="numeric" placeholder="输入一个 1–100 的数字" aria-label="猜一个数字">
          <button class="btn btn-accent" type="submit">猜</button>
        </form>
        <p class="msg" id="zbHint">温度只有五档：冰 → 凉 → 温 → 热 → 烫。二分法在这里不管用。</p>
        <div class="chips" id="zbHist"></div>
        <div id="zbEnd"></div>
      </div>`;

    const formEl = q('#zbForm', stage), inputEl = q('#zbInput', stage);
    const minInputEl = q('#zbMin', stage), maxInputEl = q('#zbMax', stage);
    const teamsInputEl = q('#zbTeams', stage), applyEl = q('#zbApply', stage);
    const rangeEl = q('#zbRange', stage), countEl = q('#zbCount', stage), teamEl = q('#zbTeam', stage);
    const boxEl = q('#zbBox', stage), thermoEl = q('#zbThermo', stage), tempEl = q('#zbTemp', stage);
    const msgEl = q('#zbMsg', stage), hintEl = q('#zbHint', stage);
    const histEl = q('#zbHist', stage), endEl = q('#zbEnd', stage);

    const PENALTY = ['唱一句歌', '学三种动物叫', '回答一个课堂小问题', '说出三位同学的优点', '做一个搞怪表情'];

    // 五档温度：按「距离 / 范围」的比例划分。
    // 上界刻意设得宽，让"温"和"凉"覆盖大半范围 —— 这样即使学生用二分法，
    // 也至少要 5~6 次才能从"凉"推进到"烫"，且每次都可能误判。
    const LEVELS = [
      { key: 'boil', label: '烫', icon: '🔥', max: 0.03, tip: '就差一点点了！手别抖。' },
      { key: 'hot', label: '热', icon: '🌶️', max: 0.09, tip: '非常接近了，再收一收。' },
      { key: 'warm', label: '温', icon: '🌤️', max: 0.18, tip: '有点感觉了，继续逼近。' },
      { key: 'cool', label: '凉', icon: '🌥️', max: 0.34, tip: '还在外围，方向得再想想。' },
      { key: 'cold', label: '冰', icon: '❄️', max: 1, tip: '离得很远，重新估算一下。' }
    ];

    let min = 1, max = 100;
    let teams = 6;
    let bomb = 0, count = 0, over = false;

    const size = () => max - min + 1;

    function levelOf(value) {
      const ratio = Math.abs(value - bomb) / Math.max(1, size());
      for (let i = 0; i < LEVELS.length; i++) if (ratio <= LEVELS[i].max) return LEVELS[i];
      return LEVELS[LEVELS.length - 1];
    }

    function paint(level) {
      boxEl.setAttribute('data-level', level.key);
      thermoEl.textContent = level.icon;
      tempEl.textContent = level.label;
      tempEl.setAttribute('data-level', level.key);
    }

    function start(nextMin = min, nextMax = max, nextTeams = teams) {
      min = nextMin;
      max = nextMax;
      teams = nextTeams;
      bomb = rnd(min, max);
      count = 0;
      over = false;
      minInputEl.value = min;
      maxInputEl.value = max;
      teamsInputEl.value = teams;
      inputEl.min = String(min);
      inputEl.max = String(max);
      inputEl.placeholder = `输入一个 ${min}–${max} 的数字`;
      rangeEl.textContent = `${min} – ${max}`;
      countEl.textContent = '0';
      teamEl.textContent = '第 1 组';
      boxEl.removeAttribute('data-level');
      thermoEl.textContent = '🌡️';
      tempEl.textContent = '待猜';
      tempEl.removeAttribute('data-level');
      msgEl.textContent = `炸弹埋在 ${min}–${max} 之间。每次只告诉你冷热，不给方向。`;
      hintEl.className = 'msg';
      hintEl.textContent = '温度只有五档：冰 → 凉 → 温 → 热 → 烫。二分法在这里不管用。';
      histEl.innerHTML = '';
      endEl.innerHTML = '';
      inputEl.disabled = false;
      formEl.querySelector('button').disabled = false;
      inputEl.value = '';
      inputEl.focus();
    }

    function win(value) {
      over = true;
      inputEl.disabled = true;
      formEl.querySelector('button').disabled = true;
      paint(LEVELS[0]);
      thermoEl.textContent = '💥';
      tempEl.textContent = '引爆';
      tempEl.setAttribute('data-level', 'boom');
      msgEl.textContent = `炸弹就在 ${value} 上。`;
      hintEl.className = 'msg bad';
      hintEl.textContent = `猜中！共用了 ${count} 次。`;
      tone(120, 0.35, 'sawtooth');
      api.burst(60);
      endEl.innerHTML = `
        <div class="result bad">
          <h3>BOOM · 炸弹引爆</h3>
          <p>猜中炸弹的小组接受一个惩罚：</p>
          <p class="draw">${pick(PENALTY)}</p>
          <div><button class="btn btn-accent btn-sm" type="button" id="zbAgain">换一颗炸弹</button></div>
        </div>`;
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      if (over) return;
      const value = Number(inputEl.value);
      if (!Number.isInteger(value) || value < min || value > max) {
        hintEl.className = 'msg bad';
        hintEl.textContent = `请输入 ${min} 到 ${max} 之间的整数。`;
        return;
      }
      count++;
      countEl.textContent = count;
      inputEl.value = '';

      if (value === bomb) {
        histEl.insertAdjacentHTML('afterbegin', `<span class="chip bad">${value} · BOOM</span>`);
        win(value);
        return;
      }

      const level = levelOf(value);
      paint(level);
      msgEl.textContent = level.tip;
      hintEl.className = 'msg';
      hintEl.textContent = `${value} —— ${level.label}。`;
      histEl.insertAdjacentHTML(
        'afterbegin',
        `<span class="chip zb-chip" data-level="${level.key}">${level.icon} ${value}</span>`
      );
      // 温度越高，音调越高 —— 让全班不看屏幕也能听出接近程度
      const tones = { boil: 880, hot: 720, warm: 600, cool: 480, cold: 360 };
      tone(tones[level.key] || 500, 0.08);

      // 分组接力：每猜一次换下一组
      if (teams > 1) teamEl.textContent = '第 ' + ((count % teams) + 1) + ' 组';
      inputEl.focus();
    });

    applyEl.addEventListener('click', () => {
      const a = Number(minInputEl.value.trim());
      const b = Number(maxInputEl.value.trim());
      const t = Number(teamsInputEl.value.trim());
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        hintEl.className = 'msg bad';
        hintEl.textContent = '范围要是整数。';
        return;
      }
      if (a >= b) {
        hintEl.className = 'msg bad';
        hintEl.textContent = '最小值要小于最大值。';
        return;
      }
      if (!Number.isInteger(t) || t < 1 || t > 12) {
        hintEl.className = 'msg bad';
        hintEl.textContent = '分组数填 1 到 12。';
        return;
      }
      start(a, b, t);
      hintEl.className = 'msg ok';
      hintEl.textContent = `已切换到 ${a}–${b}，${t} 组接力，重新埋了一颗炸弹。`;
    });

    [minInputEl, maxInputEl, teamsInputEl].forEach(el => {
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); applyEl.click(); }
      });
    });

    endEl.addEventListener('click', e => {
      if (e.target.closest('#zbAgain')) start();
    });

    start();
  };

  /* ============================================================
     05 成语接龙
     ============================================================ */
  RENDERERS.g05 = function (stage, api) {
    const IDIOMS = [
      '一帆风顺', '顺理成章', '章台杨柳', '柳暗花明', '明察秋毫', '春暖花开', '开门见山',
      '山高水长', '长驱直入', '入木三分', '胸有成竹', '竹报平安', '安步当车', '车水马龙',
      '龙马精神', '神清气爽', '爽心悦目', '目不转睛', '画蛇添足', '对牛弹琴', '守株待兔',
      '狐假虎威', '井底之蛙', '杯弓蛇影', '闻鸡起舞', '卧薪尝胆', '破釜沉舟', '纸上谈兵',
      '负荆请罪', '四面楚歌', '一石二鸟', '画龙点睛', '掩耳盗铃', '刻舟求剑', '马到成功',
      '功成名就', '就事论事', '事半功倍', '倍道而进', '进退两难', '难能可贵', '贵人多忘',
      '忘乎所以', '以逸待劳', '劳苦功高', '高瞻远瞩', '心花怒放', '放虎归山', '山穷水尽',
      '尽心尽力', '力争上游', '游刃有余', '余音绕梁', '梁上君子', '子虚乌有', '有备无患',
      '患得患失', '失而复得', '得心应手', '手到擒来', '来日方长', '长治久安', '安然无恙',
      '关门大吉', '吉祥如意', '意气风发', '发扬光大', '大器晚成', '成千上万', '万无一失',
      '万紫千红', '红红火火', '火树银花', '花好月圆', '圆满成功', '功亏一篑', '全力以赴',
      '赴汤蹈火', '火烧眉毛', '毛遂自荐', '举一反三', '三心二意', '意味深长'
    ];
    const DICT = new Set(IDIOMS);
    const GOOD_FIRST = IDIOMS.filter(w => {
      const last = w[w.length - 1];
      return IDIOMS.some(x => x[0] === last && x !== w);
    });

    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已接</span><b id="cyScore">0</b></div>
          <div class="hud"><span class="hud-k">本轮限时</span><b id="cyTime">10.0s</b></div>
          <div class="hud"><span class="hud-k">求助</span><b id="cyHelp">2</b></div>
        </div>
        <div class="meter"><i id="cyBar"></i></div>
        <div class="chain-scroll"><ol class="chain" id="cyChain"></ol></div>
        <div class="chain-sentence">
          下一个成语，要以「<b id="cyChar">马</b>」开头
        </div>
        <form class="input-row" id="cyForm" autocomplete="off">
          <input class="ipt" id="cyInput" placeholder="输入一个成语" aria-label="输入成语">
          <button class="btn btn-accent" type="submit">接上</button>
        </form>
        <div class="btn-row">
          <button class="btn btn-line btn-sm" type="button" id="cyHint">求助：给我三个</button>
        </div>
        <label class="stage-note" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="cyStrict"> 严格校验内置词库（默认宽松：以该字开头即可）
        </label>
        <p class="msg" id="cyMsg">接不上可以求助一次，超时或接错就淘汰。</p>
        <div class="chips" id="cyHints"></div>
        <div id="cyEnd"></div>
      </div>`;

    const chainEl = q('#cyChain', stage), charEl = q('#cyChar', stage), inputEl = q('#cyInput', stage);
    const scoreEl = q('#cyScore', stage), timeEl = q('#cyTime', stage), barEl = q('#cyBar', stage);
    const msgEl = q('#cyMsg', stage), hintEl = q('#cyHints', stage), endEl = q('#cyEnd', stage);
    const helpEl = q('#cyHelp', stage), formEl = q('#cyForm', stage);

    let used = new Set();
    let need = '';
    let score = 0;
    let helpLeft = 2;
    let over = false;
    let timer = null;

    function candidates() {
      return IDIOMS.filter(w => w[0] === need && !used.has(w));
    }

    function startTurn() {
      if (timer) timer.stop();
      timeEl.textContent = '10.0s';
      barEl.style.width = '100%';
      timer = countdown(api, 10,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => fail('10 秒到了，没接上'));
    }

    function renderChain() {
      chainEl.innerHTML = Array.from(used).map(w => `<li>${w}</li>`).join('');
      chainEl.lastElementChild?.classList.add('head');
    }

    function fail(reason) {
      if (over) return;
      over = true;
      if (timer) timer.stop();
      tone(180, 0.24, 'square');
      endEl.innerHTML = `
        <div class="result bad">
          <h3>接龙断了</h3>
          <p>${reason}。这一轮一共接了 <b>${score}</b> 个成语。</p>
          <div><button class="btn btn-accent btn-sm" type="button" id="cyAgain">重新开一局</button></div>
        </div>`;
      inputEl.disabled = true;
    }

    function finish() {
      over = true;
      if (timer) timer.stop();
      api.burst(50);
      endEl.innerHTML = `
        <div class="result ok">
          <h3>词库里的路走到头了</h3>
          <p>内置词库没有以「${need}」开头的新成语，这一轮算通关，接了 <b>${score}</b> 个。</p>
          <div><button class="btn btn-accent btn-sm" type="button" id="cyAgain">再来一局</button></div>
        </div>`;
      inputEl.disabled = true;
    }

    function startGame() {
      used = new Set();
      score = 0;
      helpLeft = 2;
      over = false;
      endEl.innerHTML = '';
      hintEl.innerHTML = '';
      inputEl.disabled = false;
      inputEl.value = '';
      const first = pick(GOOD_FIRST.length ? GOOD_FIRST : IDIOMS);
      used.add(first);
      need = first[first.length - 1];
      scoreEl.textContent = '0';
      helpEl.textContent = '2';
      charEl.textContent = need;
      renderChain();
      msgEl.className = 'msg';
      msgEl.textContent = '接不上可以求助一次，超时或接错就淘汰。';
      startTurn();
      inputEl.focus();
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      if (over) return;
      const raw = inputEl.value.trim().replace(/\s+/g, '');
      if (!raw) return;
      const strict = q('#cyStrict', stage).checked;

      if (raw.length < 3) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '成语至少三个字，再想想。';
        return;
      }
      if (used.has(raw)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '这个成语已经用过了。';
        return;
      }
      if (raw[0] !== need) {
        msgEl.className = 'msg bad';
        msgEl.textContent = `要以「${need}」开头。`;
        return;
      }
      if (strict && !DICT.has(raw)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '内置词库里没有这个词，可以关掉严格校验再试。';
        return;
      }

      used.add(raw);
      score++;
      scoreEl.textContent = score;
      need = raw[raw.length - 1];
      charEl.textContent = need;
      renderChain();
      inputEl.value = '';
      hintEl.innerHTML = '';
      msgEl.className = 'msg ok';
      msgEl.textContent = `接上了：${raw}`;
      tone(720, 0.08);

      if (q('#cyStrict', stage).checked && candidates().length === 0) {
        finish();
        return;
      }
      startTurn();
    });

    q('#cyHint', stage).addEventListener('click', () => {
      if (over) return;
      if (helpLeft <= 0) { toast('本局求助次数用完了'); return; }
      const list = candidates();
      if (!list.length) {
        hintEl.innerHTML = `<span class="chip">词库里没有以「${need}」开头的新成语</span>`;
        msgEl.className = 'msg';
        msgEl.textContent = '内置词库到此为止，可以关掉严格校验，说一个你知道的。';
        return;
      }
      helpLeft--;
      helpEl.textContent = helpLeft;
      hintEl.innerHTML = list.slice(0, 3).map(w => `<span class="chip">${w}</span>`).join('');
    });

    endEl.addEventListener('click', e => {
      if (e.target.closest('#cyAgain')) startGame();
    });

    api.cleanup(() => { if (timer) timer.stop(); });
    startGame();
  };

  /* ============================================================
     06 姓名接龙
     ============================================================ */
  RENDERERS.g06 = function (stage, api) {
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已加入</span><b id="nlCount">0</b></div>
          <div class="hud"><span class="hud-k">本轮限时</span><b id="nlTime">20.0s</b></div>
        </div>
        <div class="meter"><i id="nlBar"></i></div>
        <div class="chain-sentence" id="nlSent">还没有人加入。<br>从第一位同学开始：「我是 A。」</div>
        <form class="input-row" id="nlForm" autocomplete="off">
          <input class="ipt" id="nlInput" placeholder="输入同学的名字（或名字 + 爱好）" aria-label="输入名字">
          <button class="btn btn-accent" type="submit">加入队列</button>
        </form>
        <div class="btn-row">
          <button class="btn btn-ink btn-sm" type="button" id="nlPass">说对了，下一位</button>
          <button class="btn btn-line btn-sm" type="button" id="nlFail">卡壳了</button>
          <button class="btn btn-line btn-sm" type="button" id="nlUndo">撤掉最后一位</button>
        </div>
        <p class="msg" id="nlMsg">每人把整句念出来，念错顺序或叫错名字，重新自我介绍一次。</p>
        <div id="nlEnd"></div>
      </div>`;

    const sentEl = q('#nlSent', stage), inputEl = q('#nlInput', stage), formEl = q('#nlForm', stage);
    const countEl = q('#nlCount', stage), timeEl = q('#nlTime', stage), barEl = q('#nlBar', stage);
    const msgEl = q('#nlMsg', stage), endEl = q('#nlEnd', stage);

    let names = [];
    let timer = null;
    let passCount = 0;

    function sentence() {
      if (!names.length) return '';
      return '我是' + names.join('旁边的');
    }

    function render() {
      countEl.textContent = names.length;
      if (!names.length) {
        sentEl.innerHTML = '还没有人加入。<br>从第一位同学开始：「我是 A。」';
        return;
      }
      const full = sentence();
      sentEl.innerHTML = `${esc(full)}<span class="dot">。</span>`;
    }

    function startTimer() {
      if (timer) timer.stop();
      timer = countdown(api, 20,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => {
          timeEl.textContent = '0.0s';
          barEl.style.width = '0%';
          msgEl.className = 'msg bad';
          msgEl.textContent = '时间到。可以让本人重来一次，也可以小组一起帮他想。';
        });
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      const name = inputEl.value.trim();
      if (!name) return;
      if (names.length >= 30) { toast('队列太长了，先玩一轮吧'); return; }
      names.push(name);
      inputEl.value = '';
      render();
      startTimer();
      msgEl.className = 'msg';
      msgEl.textContent = `第 ${names.length} 位请说：${sentence()}。`;
      tone(660, 0.07);
    });

    q('#nlPass', stage).addEventListener('click', () => {
      if (!names.length) { toast('先加入一位同学'); return; }
      passCount++;
      msgEl.className = 'msg ok';
      msgEl.textContent = `第 ${passCount} 位通过，下一位继续加名字。`;
      tone(760, 0.08);
      inputEl.focus();
    });

    q('#nlFail', stage).addEventListener('click', () => {
      if (!names.length) return;
      msgEl.className = 'msg bad';
      msgEl.textContent = '卡壳了：重新自我介绍一次，或者小组一起帮他想。';
      endEl.innerHTML = `
        <div class="result bad">
          <h3>卡在这里了</h3>
          <p>先别急着淘汰，提示一下前三位：${esc(names.slice(0, 3).join(' → '))}</p>
          <div class="btn-row">
            <button class="btn btn-line btn-sm" type="button" id="nlKeep">宽松继续</button>
            <button class="btn btn-accent btn-sm" type="button" id="nlReset">重新开始</button>
          </div>
        </div>`;
    });

    endEl.addEventListener('click', e => {
      if (e.target.closest('#nlKeep')) { endEl.innerHTML = ''; msgEl.className = 'msg'; msgEl.textContent = '继续。'; }
      if (e.target.closest('#nlReset')) {
        names = []; passCount = 0;
        render();
        endEl.innerHTML = '';
        msgEl.className = 'msg';
        msgEl.textContent = '重新开始，从第一位同学开始。';
        timeEl.textContent = '20.0s';
        barEl.style.width = '100%';
        if (timer) timer.stop();
        inputEl.focus();
      }
    });

    q('#nlUndo', stage).addEventListener('click', () => {
      if (!names.length) return;
      names.pop();
      render();
      msgEl.className = 'msg';
      msgEl.textContent = '已撤掉最后一位。';
    });

    api.cleanup(() => { if (timer) timer.stop(); });
  };

  /* ============================================================
     09 单词大比拼
     ============================================================ */
  RENDERERS.g09 = function (stage, api) {
    const BANKS = {
      classroom: {
        label: '教室物品',
        words: ['pen', 'pencil', 'ruler', 'eraser', 'book', 'desk', 'chair', 'bag', 'board', 'marker',
          'notebook', 'sharpener', 'crayon', 'glue', 'scissors', 'computer', 'clock', 'window', 'door',
          'map', 'light', 'screen', 'projector', 'keyboard']
      },
      animals: {
        label: '动物',
        words: ['cat', 'dog', 'bird', 'fish', 'tiger', 'lion', 'monkey', 'elephant', 'rabbit', 'panda',
          'horse', 'sheep', 'duck', 'pig', 'snake', 'bear', 'wolf', 'fox', 'giraffe', 'zebra',
          'dolphin', 'whale', 'frog', 'mouse', 'chicken', 'cow', 'kangaroo', 'penguin', 'turtle', 'spider']
      },
      fruits: {
        label: '水果',
        words: ['apple', 'banana', 'orange', 'pear', 'grape', 'mango', 'peach', 'watermelon', 'strawberry',
          'lemon', 'cherry', 'pineapple', 'coconut', 'kiwi', 'blueberry', 'melon', 'papaya', 'plum', 'lychee']
      }
    };

    stage.innerHTML = `
      <div class="stage">
        <div class="seg" id="wdThemes"></div>
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已写出</span><b id="wdCount">0</b></div>
          <div class="hud"><span class="hud-k">剩余时间</span><b id="wdTime">60.0s</b></div>
          <div class="hud"><span class="hud-k">主题</span><b id="wdTheme">教室物品</b></div>
        </div>
        <div class="meter"><i id="wdBar"></i></div>
        <form class="input-row" id="wdForm" autocomplete="off">
          <input class="ipt" id="wdInput" placeholder="输入英文单词，回车提交" aria-label="输入英文单词" autocapitalize="off" autocomplete="off" spellcheck="false" data-voice-lang="en-US">
          <button class="btn btn-accent" type="submit">提交</button>
        </form>
        <div class="chips" id="wdList"></div>
        <p class="msg" id="wdMsg">第一次提交会自动开始 60 秒计时。</p>
        <div id="wdEnd"></div>
      </div>`;

    const themeSeg = q('#wdThemes', stage);
    const listEl = q('#wdList', stage), countEl = q('#wdCount', stage), timeEl = q('#wdTime', stage);
    const barEl = q('#wdBar', stage), themeEl = q('#wdTheme', stage), msgEl = q('#wdMsg', stage);
    const inputEl = q('#wdInput', stage), formEl = q('#wdForm', stage), endEl = q('#wdEnd', stage);

    let theme = 'classroom';
    let found = [];
    let over = false;
    let timer = null;

    function bank() { return BANKS[theme].words.map(w => w.toLowerCase()); }

    function renderThemes() {
      themeSeg.innerHTML = Object.keys(BANKS).map(k => `
        <button type="button" data-theme="${k}" aria-pressed="${k === theme}">${BANKS[k].label}</button>`).join('');
    }

    function reset() {
      found = [];
      over = false;
      listEl.innerHTML = '';
      endEl.innerHTML = '';
      countEl.textContent = '0';
      timeEl.textContent = '60.0s';
      barEl.style.width = '100%';
      msgEl.className = 'msg';
      msgEl.textContent = '第一次提交会自动开始 60 秒计时。';
      inputEl.disabled = false;
      inputEl.value = '';
      formEl.querySelector('button').disabled = false;
      if (timer) { timer.stop(); timer = null; }
      inputEl.focus();
    }

    function ensureTimer() {
      if (timer) return;
      timer = countdown(api, 60,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => {
          timeEl.textContent = '0.0s';
          barEl.style.width = '0%';
          end();
        });
    }

    function end() {
      over = true;
      inputEl.disabled = true;
      formEl.querySelector('button').disabled = true;
      const missing = bank().filter(w => !found.includes(w));
      tone(200, 0.2, 'square');
      endEl.innerHTML = `
        <div class="result">
          <h3>时间到：写出 ${found.length} 个</h3>
          <p>没写出来的词，顺便复习一遍：</p>
          <div class="chips">${missing.slice(0, 18).map(w => `<span class="chip miss">${w}</span>`).join('')}</div>
          <div><button class="btn btn-accent btn-sm" type="button" id="wdAgain">再来一轮</button></div>
        </div>`;
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      if (over) return;
      ensureTimer();
      const raw = inputEl.value.trim().toLowerCase();
      if (!raw) return;
      if (!/^[a-z][a-z\- ]*$/.test(raw)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '只输入英文单词。';
        return;
      }
      if (found.includes(raw)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = `「${raw}」已经写过了。`;
        return;
      }
      if (!bank().includes(raw)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = `「${raw}」不在「${BANKS[theme].label}」主题词库里，换一个。`;
        return;
      }
      found.push(raw);
      countEl.textContent = found.length;
      listEl.insertAdjacentHTML('beforeend', `<span class="chip ok">${raw}</span>`);
      inputEl.value = '';
      msgEl.className = 'msg';
      msgEl.textContent = '有效，继续。';
      tone(700, 0.06);
    });

    themeSeg.addEventListener('click', e => {
      const btn = e.target.closest('[data-theme]');
      if (!btn || btn.dataset.theme === theme) return;
      theme = btn.dataset.theme;
      themeEl.textContent = BANKS[theme].label;
      renderThemes();
      reset();
    });

    endEl.addEventListener('click', e => {
      if (e.target.closest('#wdAgain')) reset();
    });

    api.cleanup(() => { if (timer) timer.stop(); });
    renderThemes();
  };

  /* ============================================================
     15 趣味扩句
     ============================================================ */
  RENDERERS.g15 = function (stage, api) {
    const BASES = ['我爱画画', '我爱吃饭', '他去上学', '今天下雨'];

    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已扩</span><b id="exRound">0</b></div>
          <div class="hud"><span class="hud-k">当前字数</span><b id="exLen">4</b></div>
        </div>
        <div class="seg" id="exBases"></div>
        <ol class="expand-list" id="exList"></ol>
        <form class="input-row" id="exForm" autocomplete="off">
          <input class="ipt" id="exInput" placeholder="把上一句扩得更长，原句的字要保留" aria-label="扩句">
          <button class="btn btn-accent" type="submit">扩一句</button>
        </form>
        <form class="input-row" id="exBaseForm" autocomplete="off">
          <input class="ipt" id="exBaseInput" placeholder="也可以自己写一个开头" aria-label="自定义开头">
          <button class="btn btn-line btn-sm" type="submit">设为开头</button>
        </form>
        <div class="btn-row">
          <button class="btn btn-line btn-sm" type="button" id="exUndo">撤回一句</button>
          <button class="btn btn-line btn-sm" type="button" id="exCopy">复制句子链</button>
        </div>
        <p class="msg" id="exMsg">规则：保留上一句的字和顺序，再加形容词或状语。</p>
      </div>`;

    const baseSeg = q('#exBases', stage), listEl = q('#exList', stage);
    const inputEl = q('#exInput', stage), formEl = q('#exForm', stage);
    const roundEl = q('#exRound', stage), lenEl = q('#exLen', stage), msgEl = q('#exMsg', stage);

    let base = pick(BASES);
    let chain = [base];
    let round = 0;

    const isSubsequence = (sub, whole) => {
      let i = 0;
      for (const ch of whole) {
        if (ch === sub[i]) i++;
        if (i >= sub.length) return true;
      }
      return sub.length === 0;
    };

    function renderBases() {
      baseSeg.innerHTML = BASES.map(b => `
        <button type="button" data-base="${b}" aria-pressed="${b === base}">${b}</button>`).join('');
    }

    function render() {
      listEl.innerHTML = chain.map((text, i) => `
        <li class="${i === chain.length - 1 ? 'current' : ''}">
          <span class="ex-idx">${pad2(i + 1)}</span>
          <span class="ex-text">${esc(text)}</span>
          <span class="ex-len">${text.length} 字</span>
        </li>`).join('');
      roundEl.textContent = round;
      lenEl.textContent = chain[chain.length - 1].length;
      listEl.scrollTop = listEl.scrollHeight;
    }

    function reset(nextBase) {
      base = nextBase || pick(BASES);
      chain = [base];
      round = 0;
      msgEl.className = 'msg';
      msgEl.textContent = '规则：保留上一句的字和顺序，再加形容词或状语。';
      renderBases();
      render();
      inputEl.value = '';
      inputEl.focus();
    }

    baseSeg.addEventListener('click', e => {
      const btn = e.target.closest('[data-base]');
      if (!btn) return;
      reset(btn.dataset.base);
    });

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      const next = inputEl.value.trim().replace(/\s+/g, '');
      const prev = chain[chain.length - 1];
      if (!next) return;
      if (next.length <= prev.length) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '要比上一句更长，至少加一处。';
        return;
      }
      if (!isSubsequence(prev, next)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '上一句的字和顺序要保留，只能插入新内容。';
        return;
      }
      chain.push(next);
      round++;
      inputEl.value = '';
      msgEl.className = 'msg ok';
      msgEl.textContent = `扩到 ${next.length} 个字，比上一句多 ${next.length - prev.length} 个字。`;
      tone(680, 0.06);
      render();
      inputEl.focus();
    });

    q('#exUndo', stage).addEventListener('click', () => {
      if (chain.length <= 1) { toast('已经回到开头了'); return; }
      chain.pop();
      round = Math.max(0, round - 1);
      msgEl.className = 'msg';
      msgEl.textContent = '撤回一句。';
      render();
    });

    q('#exCopy', stage).addEventListener('click', () => copyText(chain.join(' → ')));

    q('#exBaseForm', stage).addEventListener('submit', e => {
      e.preventDefault();
      const custom = q('#exBaseInput', stage).value.trim();
      if (!custom) return;
      q('#exBaseInput', stage).value = '';
      reset(custom);
    });

    reset();
  };

  /* ============================================================
     16 笑掉大牙
     ============================================================ */
  RENDERERS.g16 = function (stage, api) {
    const DATA = {
      time: ['昨天半夜', '公元 3000 年', '上课中', '凌晨三点', '考试前一晚', '大扫除的时候', '暑假第一天', '停电的晚上'],
      person: ['小明', '班主任', '奥特曼', '我奶奶', '校长', '外卖小哥', '孙悟空', '隔壁班同学'],
      place: ['月球上', '食堂里', '马桶上', '操场上', '电梯里', '校长室', '火锅店', '被窝里'],
      event: ['吃火锅', '考试', '跑步', '唱卡拉 OK', '开班会', '遛狗', '做 PPT', '抢红包']
    };
    const KEYS = ['time', 'person', 'place', 'event'];
    const LABELS = { time: '时间', person: '人物', place: '地点', event: '事件' };

    stage.innerHTML = `
      <div class="stage">
        <div class="reels">
          ${KEYS.map(k => `
            <div class="reel" data-key="${k}">
              <span class="reel-k">${LABELS[k]}</span>
              <div class="reel-v">${pick(DATA[k])}</div>
            </div>`).join('')}
        </div>
        <div class="joke-sentence empty" id="jkResult">点「抽一句」，看看今天能拼出什么。</div>
        <div class="btn-row">
          <button class="btn btn-accent" type="button" id="jkSpin">抽一句</button>
          <button class="btn btn-line" type="button" id="jkCopy">复制这句</button>
        </div>
        <p class="msg" id="jkMsg">四类纸条随机组合，越离谱越好笑。</p>
        <div class="chips" id="jkHist"></div>
      </div>`;

    const reels = qa('.reel', stage);
    const resultEl = q('#jkResult', stage), msgEl = q('#jkMsg', stage), histEl = q('#jkHist', stage);
    let spinning = false;
    let resultText = '';
    let spinTimer = null;
    let settleTimer = null;
    const history = [];

    function spin() {
      if (spinning) return;
      spinning = true;
      resultEl.classList.add('empty');
      resultEl.textContent = '……正在抽纸条';
      reels.forEach(r => r.classList.add('spinning'));
      clearInterval(spinTimer);
      spinTimer = setInterval(() => {
        reels.forEach(r => { q('.reel-v', r).textContent = pick(DATA[r.dataset.key]); });
      }, 70);

      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        clearInterval(spinTimer);
        const values = {};
        reels.forEach(r => {
          const k = r.dataset.key;
          values[k] = pick(DATA[k]);
          q('.reel-v', r).textContent = values[k];
          r.classList.remove('spinning');
        });
        resultText = `${values.time}，${values.person}在${values.place}${values.event}。`;
        resultEl.classList.remove('empty');
        resultEl.textContent = resultText;
        msgEl.className = 'msg';
        msgEl.textContent = '够离谱就贴到白板上，做成班级梗图。';
        history.unshift(resultText);
        if (history.length > 8) history.pop();
        histEl.innerHTML = history.map(t => `<span class="chip">${esc(t)}</span>`).join('');
        tone(620, 0.08);
        spinning = false;
      }, 950);
    }

    q('#jkSpin', stage).addEventListener('click', spin);
    q('#jkCopy', stage).addEventListener('click', () => {
      if (!resultText) { toast('先抽一句'); return; }
      copyText(resultText);
    });

    api.cleanup(() => { clearInterval(spinTimer); clearTimeout(settleTimer); });
  };

  /* ============================================================
     17 加字游戏
     ============================================================ */
  RENDERERS.g17 = function (stage, api) {
    const STARTERS = ['大', '人', '山', '花', '天', '猫', '风'];

    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">当前字数</span><b id="adLen">1</b></div>
          <div class="hud"><span class="hud-k">已加</span><b id="adRound">0</b></div>
        </div>
        <div class="big-box">
          <div class="charline" id="adWord"></div>
          <span class="big-sub" id="adSub">每次只加一个字，还得保持通顺。</span>
        </div>
        <form class="input-row" id="adForm" autocomplete="off">
          <input class="ipt" id="adInput" placeholder="在任意位置加一个字，写出完整的新词句" aria-label="加一个字">
          <button class="btn btn-accent" type="submit">加进去</button>
        </form>
        <div class="btn-row">
          <button class="btn btn-line btn-sm" type="button" id="adUndo">撤回</button>
          <button class="btn btn-line btn-sm" type="button" id="adNew">换一题</button>
          <button class="btn btn-line btn-sm" type="button" id="adCopy">复制词句链</button>
        </div>
        <p class="msg" id="adMsg">只能多一个字，位置不限，但读起来要通顺。</p>
        <ol class="expand-list" id="adList"></ol>
      </div>`;

    const wordEl = q('#adWord', stage), inputEl = q('#adInput', stage), formEl = q('#adForm', stage);
    const lenEl = q('#adLen', stage), roundEl = q('#adRound', stage), msgEl = q('#adMsg', stage);
    const listEl = q('#adList', stage);

    let current = '';
    let chain = [];
    let addedIndex = -1;

    function renderWord() {
      wordEl.innerHTML = Array.from(current).map((ch, i) =>
        i === addedIndex ? `<em>${esc(ch)}</em>` : `<span>${esc(ch)}</span>`).join('');
      lenEl.textContent = current.length;
      listEl.innerHTML = chain.map((w, i) => `<li><span class="ex-idx">${pad2(i + 1)}</span><span class="ex-text">${esc(w)}</span></li>`).join('');
    }

    function setWord(word) {
      current = word;
      chain = [word];
      addedIndex = -1;
      renderWord();
    }

    function reset(word) {
      setWord(word || pick(STARTERS));
      roundEl.textContent = '0';
      msgEl.className = 'msg';
      msgEl.textContent = '只能多一个字，位置不限，但读起来要通顺。';
      inputEl.value = '';
      inputEl.focus();
    }

    function findInserted(prev, next) {
      if (next.length !== prev.length + 1) return -1;
      for (let i = 0; i < next.length; i++) {
        if (next.slice(0, i) + next.slice(i + 1) === prev) return i;
      }
      return -1;
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      const next = inputEl.value.trim().replace(/\s+/g, '');
      if (!next) return;
      const idx = findInserted(current, next);
      if (idx === -1) {
        msgEl.className = 'msg bad';
        msgEl.textContent = next.length === current.length
          ? '字数没变，要加一个字。'
          : '只能比上一句多一个字，而且原来的字顺序不能变。';
        return;
      }
      const added = next[idx];
      chain.push(next);
      current = next;
      addedIndex = idx;
      roundEl.textContent = chain.length - 1;
      msgEl.className = 'msg ok';
      msgEl.textContent = `加了一个「${added}」，现在 ${next.length} 个字。`;
      tone(700, 0.07);
      inputEl.value = '';
      renderWord();
      inputEl.focus();
    });

    q('#adUndo', stage).addEventListener('click', () => {
      if (chain.length <= 1) { toast('已经回到起点了'); return; }
      chain.pop();
      current = chain[chain.length - 1];
      addedIndex = -1;
      roundEl.textContent = chain.length - 1;
      msgEl.className = 'msg';
      msgEl.textContent = '撤回一个字。';
      renderWord();
    });

    q('#adNew', stage).addEventListener('click', () => reset());
    q('#adCopy', stage).addEventListener('click', () => copyText(chain.join(' → ')));

    reset();
  };

  /* ============================================================
     18 三词造句
     ============================================================ */
  RENDERERS.g18 = function (stage, api) {
    const POOLS = {
      people: ['林黛玉', '孙悟空', '班主任', '外卖小哥', '宇航员', '我奶奶', '校长', '蒙娜丽莎'],
      places: ['食堂', '月球', '地铁', '浴室', '考场', '菜市场', '直播间', '冰箱里'],
      things: ['相对论', '红烧肉', '作业本', '冰箱', '流星', '扫地机器人', '广场舞', '数学卷子']
    };
    const POOL_KEYS = Object.keys(POOLS);

    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">倒计时</span><b id="w3Time">未开始</b></div>
          <div class="hud"><span class="hud-k">候选句</span><b id="w3Count">0</b></div>
        </div>
        <div class="meter"><i id="w3Bar" style="width:0"></i></div>
        <div class="words3" id="w3Words"></div>
        <div class="btn-row">
          <button class="btn btn-line btn-sm" type="button" id="w3New">换一组词</button>
          <button class="btn btn-ink btn-sm" type="button" id="w3Start">开始 60 秒</button>
        </div>
        <form class="input-row" id="w3Form" autocomplete="off">
          <input class="ipt" id="w3Input" placeholder="用这三个词造一个通顺的句子" aria-label="造句">
          <button class="btn btn-accent" type="submit">交一句</button>
        </form>
        <p class="msg" id="w3Msg">三个词都要出现，句子得通顺、有逻辑。</p>
        <div class="vote-list" id="w3List"></div>
        <div id="w3End"></div>
      </div>`;

    const wordsEl = q('#w3Words', stage), formEl = q('#w3Form', stage), inputEl = q('#w3Input', stage);
    const timeEl = q('#w3Time', stage), barEl = q('#w3Bar', stage), countEl = q('#w3Count', stage);
    const msgEl = q('#w3Msg', stage), listEl = q('#w3List', stage), endEl = q('#w3End', stage);

    let words = [];
    let entries = [];
    let timer = null;
    let seq = 0;
    let closed = false;

    function newWords() {
      words = POOL_KEYS.map(k => pick(POOLS[k]));
      wordsEl.innerHTML = words.map(w => `<span class="word-pill">${esc(w)}</span>`).join('');
      msgEl.className = 'msg';
      msgEl.textContent = '三个词都要出现，句子得通顺、有逻辑。';
    }

    function renderList() {
      const sorted = entries.slice().sort((a, b) => b.votes - a.votes || b.id - a.id);
      countEl.textContent = entries.length;
      listEl.innerHTML = sorted.map(item => `
        <div class="vote-row">
          <p>${esc(item.text)}</p>
          <div class="vote-actions">
            <span class="tag">${item.votes} 票</span>
            <button class="btn btn-line btn-sm" type="button" data-vote="${item.id}">投票</button>
          </div>
        </div>`).join('');
    }

    function startTimer() {
      if (timer) timer.stop();
      closed = false;
      timer = countdown(api, 60,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => {
          timeEl.textContent = '0.0s';
          barEl.style.width = '0%';
          closed = true;
          msgEl.className = 'msg bad';
          msgEl.textContent = '时间到，投票选出「最佳造句」。';
          tone(200, 0.25, 'square');
          if (!entries.length) {
            endEl.innerHTML = `<div class="result"><h3>这一轮没人交卷</h3><p>换一组词，再来一次。</p></div>`;
          }
        });
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      if (closed) { toast('这一轮已经结束了'); return; }
      const text = inputEl.value.trim();
      if (!text) return;
      if (!words.every(w => text.includes(w))) {
        const missing = words.filter(w => !text.includes(w));
        msgEl.className = 'msg bad';
        msgEl.textContent = `还缺：${missing.join('、')}。三个词都要用上。`;
        return;
      }
      if (text.length < 8) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '句子太短了，再编长一点。';
        return;
      }
      if (timer === null) startTimer();
      entries.push({ id: ++seq, text, votes: 0 });
      inputEl.value = '';
      msgEl.className = 'msg ok';
      msgEl.textContent = '收到，等全班投票。';
      tone(700, 0.07);
      api.burst(18);
      renderList();
      inputEl.focus();
    });

    q('#w3New', stage).addEventListener('click', () => {
      newWords();
      entries = [];
      seq = 0;
      endEl.innerHTML = '';
      if (timer) timer.stop();
      timer = null;
      timeEl.textContent = '未开始';
      barEl.style.width = '0%';
      closed = false;
      renderList();
      inputEl.value = '';
    });

    q('#w3Start', stage).addEventListener('click', () => {
      if (timer) timer.stop();
      timer = null;
      startTimer();
      msgEl.className = 'msg';
      msgEl.textContent = '开始计时，60 秒内造句。';
    });

    listEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-vote]');
      if (!btn) return;
      const item = entries.find(x => x.id === Number(btn.dataset.vote));
      if (!item) return;
      item.votes++;
      renderList();
      tone(780, 0.06);
    });

    api.cleanup(() => { if (timer) timer.stop(); });
    newWords();
    renderList();
  };

  /* ============================================================
     19 物品追踪
     ============================================================ */
  RENDERERS.g19 = function (stage, api) {
    const ITEMS = [
      { n: '回形针', i: 'clip' }, { n: '橡皮', i: 'eraser' }, { n: '圆珠笔', i: 'pen' },
      { n: '纸片', i: 'paper' }, { n: '钥匙', i: 'key' }, { n: '糖果', i: 'candy' },
      { n: '翻页笔', i: 'clicker' }, { n: '铅笔', i: 'pencil' }, { n: '鼠标', i: 'mouse' },
      { n: '耳机', i: 'headphone' }, { n: '鼠标垫', i: 'pad' }, { n: '订书机', i: 'stapler' },
      { n: '便利贴', i: 'note' }, { n: '胶带', i: 'tape' }, { n: '尺子', i: 'ruler' }
    ];
    const GLYPH = {
      clip: '<path d="M8 6v9a4 4 0 0 0 8 0V6a2.5 2.5 0 0 0-5 0v9"/>',
      eraser: '<rect x="4" y="8" width="16" height="8" rx="2" transform="rotate(-20 12 12)"/>',
      pen: '<path d="M6 18l2-6 8-8 2 2-8 8-4 4z"/><path d="M14 6l2 2"/>',
      paper: '<path d="M7 4h7l3 3v13H7z"/><path d="M14 4v3h3"/>',
      key: '<circle cx="8" cy="8" r="3"/><path d="M10.2 10.2L18 18M15 15l2-2"/>',
      candy: '<circle cx="12" cy="12" r="4"/><path d="M8 12L4 9v6zM16 12l4-3v6z"/>',
      clicker: '<rect x="8" y="3" width="8" height="18" rx="4"/><path d="M12 8v4"/>',
      pencil: '<path d="M5 19l1-4 9-9 3 3-9 9z"/><path d="M6 15l3 3"/>',
      mouse: '<rect x="8" y="3" width="8" height="18" rx="4"/><path d="M12 7v5"/>',
      headphone: '<path d="M5 15v-3a7 7 0 0 1 14 0v3"/><rect x="4" y="14" width="4" height="6" rx="2"/><rect x="16" y="14" width="4" height="6" rx="2"/>',
      pad: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 18v2h8v-2"/>',
      stapler: '<path d="M4 16h14l2 3H6z"/><path d="M7 16V9h10l3 4"/>',
      note: '<path d="M5 5h14v10l-4 4H5z"/><path d="M15 19v-4h4"/>',
      tape: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
      ruler: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9v3M11 9v2M15 9v3M19 9v2"/>'
    };

    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">倒计时</span><b id="trTime">60.0s</b></div>
          <div class="hud"><span class="hud-k">已记起</span><b id="trFound">0</b></div>
          <div class="seg" id="trDurations">
            <button type="button" data-sec="30" aria-pressed="false">30 秒</button>
            <button type="button" data-sec="45" aria-pressed="false">45 秒</button>
            <button type="button" data-sec="60" aria-pressed="true">60 秒</button>
          </div>
        </div>
        <div class="meter"><i id="trBar"></i></div>
        <div class="tray" id="trTray"></div>
        <div class="btn-row" id="trStageBtns">
          <button class="btn btn-accent" type="button" id="trStart">开始展示</button>
        </div>
        <form class="input-row" id="trForm" autocomplete="off" hidden>
          <input class="ipt" id="trInput" placeholder="写下你记住的物件，回车添加" aria-label="回忆物件">
          <button class="btn btn-line" type="submit">添加</button>
        </form>
        <div class="chips" id="trList"></div>
        <div class="btn-row" id="trRecallBtns" hidden>
          <button class="btn btn-accent" type="button" id="trSubmit">交卷</button>
        </div>
        <p class="msg" id="trMsg">先记 60 秒，托盘盖起来后，把记住的物件写下来。</p>
        <div id="trEnd"></div>
      </div>`;

    const trayEl = q('#trTray', stage), timeEl = q('#trTime', stage), barEl = q('#trBar', stage);
    const foundEl = q('#trFound', stage), msgEl = q('#trMsg', stage), formEl = q('#trForm', stage);
    const inputEl = q('#trInput', stage), listEl = q('#trList', stage), endEl = q('#trEnd', stage);
    const recallBtns = q('#trRecallBtns', stage), stageBtns = q('#trStageBtns', stage);
    const durationSeg = q('#trDurations', stage);

    let duration = 60;
    let phase = 'idle';
    let timer = null;
    let recalled = [];

    function renderTray() {
      trayEl.innerHTML = ITEMS.map((item, idx) => `
        <div class="tray-item" style="animation-delay:${idx * 25}ms">
          <svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[item.i]}</svg>
          <span>${item.n}</span>
        </div>`).join('');
    }

    function reset() {
      phase = 'idle';
      recalled = [];
      if (timer) { timer.stop(); timer = null; }
      trayEl.classList.remove('covered');
      listEl.innerHTML = '';
      foundEl.textContent = '0';
      timeEl.textContent = duration + '.0s';
      barEl.style.width = '100%';
      formEl.hidden = true;
      recallBtns.hidden = true;
      stageBtns.hidden = false;
      q('#trStart', stage).disabled = false;
      q('#trStart', stage).textContent = '开始展示';
      msgEl.className = 'msg';
      msgEl.textContent = `先记 ${duration} 秒，托盘盖起来后，把记住的物件写下来。`;
      endEl.innerHTML = '';
      renderTray();
    }

    function startMemorize() {
      phase = 'memorize';
      trayEl.classList.remove('covered');
      endEl.innerHTML = '';
      listEl.innerHTML = '';
      recalled = [];
      foundEl.textContent = '0';
      q('#trStart', stage).disabled = true;
      q('#trStart', stage).textContent = '展示中…';
      msgEl.className = 'msg';
      msgEl.textContent = '努力记住每一件小物件的名字。';
      timer = countdown(api, duration,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => startRecall());
    }

    function startRecall() {
      phase = 'recall';
      if (timer) timer.stop();
      trayEl.classList.add('covered');
      stageBtns.hidden = true;
      formEl.hidden = false;
      recallBtns.hidden = false;
      q('#trStart', stage).disabled = false;
      q('#trStart', stage).textContent = '再来一次';
      msgEl.className = 'msg';
      msgEl.textContent = '托盘盖起来了，2 分钟内写下你记住的物件。';
      inputEl.value = '';
      inputEl.focus();
      timeEl.textContent = '120.0s';
      barEl.style.width = '100%';
      timer = countdown(api, 120,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => judge());
    }

    function judge() {
      if (phase === 'result') return;
      phase = 'result';
      if (timer) timer.stop();
      formEl.hidden = true;
      recallBtns.hidden = true;
      stageBtns.hidden = false;
      q('#trStart', stage).textContent = '再玩一次';
      const total = ITEMS.length;
      const hit = recalled.length;
      const missing = ITEMS.filter(it => !recalled.includes(it.n));
      barEl.style.width = '0%';
      timeEl.textContent = '0.0s';
      tone(hit >= total / 2 ? 760 : 300, 0.18, hit >= total / 2 ? 'sine' : 'square');
      if (hit >= total / 2) api.burst(36);
      endEl.innerHTML = `
        <div class="result ${hit >= total / 2 ? 'ok' : ''}">
          <h3>记住 ${hit} / ${total} 件</h3>
          <p>${hit >= total ? '全对，观察力满分。' : '漏掉的这些，下次可以再看仔细一点：'}</p>
          <div class="chips">${missing.map(it => `<span class="chip miss">${it.n}</span>`).join('')}</div>
        </div>`;
    }

    formEl.addEventListener('submit', e => {
      e.preventDefault();
      if (phase !== 'recall') return;
      const name = inputEl.value.trim();
      if (!name) return;
      const hit = ITEMS.find(it => it.n === name);
      if (!hit) {
        msgEl.className = 'msg bad';
        msgEl.textContent = `「${name}」不在托盘里，再想想。`;
        return;
      }
      if (recalled.includes(hit.n)) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '这个已经写过了。';
        return;
      }
      recalled.push(hit.n);
      foundEl.textContent = recalled.length;
      listEl.insertAdjacentHTML('beforeend', `<span class="chip ok">${hit.n}</span>`);
      inputEl.value = '';
      msgEl.className = 'msg';
      msgEl.textContent = '记对了，继续。';
      tone(680, 0.06);
      inputEl.focus();
    });

    q('#trStart', stage).addEventListener('click', () => {
      if (phase === 'idle') startMemorize();
      else reset();
    });
    q('#trSubmit', stage).addEventListener('click', () => { if (phase === 'recall') judge(); });

    durationSeg.addEventListener('click', e => {
      const btn = e.target.closest('[data-sec]');
      if (!btn) return;
      duration = Number(btn.dataset.sec);
      qa('[data-sec]', durationSeg).forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      if (phase === 'idle') reset();
    });

    api.cleanup(() => { if (timer) timer.stop(); });
    reset();
  };

  /* ============================================================
     22 青蛙落水
     ============================================================ */
  RENDERERS.g22 = function (stage, api) {
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">第几位</span><b id="fgIdx">1</b></div>
          <div class="hud"><span class="hud-k">倒计时</span><b id="fgTime">12.0s</b></div>
          <div class="hud"><span class="hud-k">已通过</span><b id="fgScore">0</b></div>
        </div>
        <div class="meter"><i id="fgBar"></i></div>
        <div class="chant" id="fgChant"></div>
        <div class="quiz3">
          <label>几张嘴<input class="ipt" id="fgMouth" type="number" inputmode="numeric" min="1" aria-label="几张嘴"></label>
          <label>几只眼睛<input class="ipt" id="fgEye" type="number" inputmode="numeric" min="2" aria-label="几只眼睛"></label>
          <label>几条腿<input class="ipt" id="fgLeg" type="number" inputmode="numeric" min="4" aria-label="几条腿"></label>
        </div>
        <div class="btn-row">
          <button class="btn btn-accent" type="button" id="fgSubmit">交卷</button>
          <button class="btn btn-line btn-sm" type="button" id="fgHint">看公式</button>
        </div>
        <p class="msg" id="fgMsg">腿数 = 青蛙数 × 4，眼睛 = 青蛙数 × 2。</p>
        <div id="fgEnd"></div>
      </div>`;

    const idxEl = q('#fgIdx', stage), timeEl = q('#fgTime', stage), barEl = q('#fgBar', stage);
    const scoreEl = q('#fgScore', stage), chantEl = q('#fgChant', stage), msgEl = q('#fgMsg', stage);
    const mouthEl = q('#fgMouth', stage), eyeEl = q('#fgEye', stage), legEl = q('#fgLeg', stage);
    const endEl = q('#fgEnd', stage);

    let n = 1, score = 0, over = false, timer = null, nextTimer = null;

    function chantFor(k) {
      return `${k} 只青蛙 ${k} 张嘴，${k * 2} 只眼睛 ${k * 4} 条腿，${'扑通'.repeat(k)}跳下水，${'呱'.repeat(k)}。`;
    }

    function limitFor(k) {
      return Math.max(6, 12 - (k - 1) * 0.8);
    }

    function begin() {
      if (timer) timer.stop();
      idxEl.textContent = n;
      scoreEl.textContent = score;
      chantEl.innerHTML = `<b>${n}</b> 只青蛙 <b>${n}</b> 张嘴，<b>?</b> 只眼睛 <b>?</b> 条腿，${'扑通'.repeat(n)}跳下水，${'呱'.repeat(n)}。`;
      mouthEl.value = ''; eyeEl.value = ''; legEl.value = '';
      mouthEl.disabled = false; eyeEl.disabled = false; legEl.disabled = false;
      msgEl.className = 'msg';
      msgEl.textContent = '把嘴、眼睛、腿的数量填对，就能进入下一只青蛙。';
      const limit = limitFor(n) * 1000;
      const t0 = performance.now();
      let raf = 0;
      const tick = now => {
        const left = Math.max(0, limit - (now - t0));
        timeEl.textContent = (left / 1000).toFixed(1) + 's';
        barEl.style.width = (left / limit * 100) + '%';
        if (left <= 0) { fail('时间到，节奏断了'); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      timer = { stop() { cancelAnimationFrame(raf); } };
      api.cleanup(timer.stop);
      mouthEl.focus();
    }

    function fail(reason) {
      if (over) return;
      over = true;
      if (timer) timer.stop();
      mouthEl.disabled = true; eyeEl.disabled = true; legEl.disabled = true;
      tone(180, 0.25, 'square');
      endEl.innerHTML = `
        <div class="result bad">
          <h3>出局了</h3>
          <p>${reason}。正确答案是：嘴 <b>${n}</b>、眼睛 <b>${n * 2}</b>、腿 <b>${n * 4}</b>。</p>
          <p>这一轮数到了第 ${n} 只青蛙。</p>
          <div><button class="btn btn-accent btn-sm" type="button" id="fgAgain">重新开始</button></div>
        </div>`;
      msgEl.className = 'msg bad';
      msgEl.textContent = '从头再来，节奏要快。';
    }

    function submit() {
      if (over) return;
      const mouth = Number(mouthEl.value), eye = Number(eyeEl.value), leg = Number(legEl.value);
      if (!mouthEl.value || !eyeEl.value || !legEl.value) {
        msgEl.className = 'msg bad';
        msgEl.textContent = '三个空都要填。';
        return;
      }
      if (mouth === n && eye === n * 2 && leg === n * 4) {
        score++;
        scoreEl.textContent = score;
        tone(760, 0.09);
        msgEl.className = 'msg ok';
        msgEl.textContent = `全对：${n} 只青蛙 ${n} 张嘴，${n * 2} 只眼睛 ${n * 4} 条腿。`;
        chantEl.innerHTML = chantFor(n);
        n++;
        if (timer) timer.stop();
        mouthEl.disabled = true; eyeEl.disabled = true; legEl.disabled = true;
        nextTimer = setTimeout(() => { if (!over) begin(); }, 420);
      } else {
        const wrong = [];
        if (mouth !== n) wrong.push(`嘴应该是 ${n}`);
        if (eye !== n * 2) wrong.push(`眼睛应该是 ${n * 2}`);
        if (leg !== n * 4) wrong.push(`腿应该是 ${n * 4}`);
        fail(wrong.join('，'));
      }
    }

    q('#fgSubmit', stage).addEventListener('click', submit);
    [mouthEl, eyeEl, legEl].forEach(inp => inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }));

    q('#fgHint', stage).addEventListener('click', () => {
      msgEl.className = 'msg';
      msgEl.textContent = `公式：嘴 = ${n}，眼睛 = ${n} × 2 = ${n * 2}，腿 = ${n} × 4 = ${n * 4}。`;
    });

    endEl.addEventListener('click', e => {
      if (!e.target.closest('#fgAgain')) return;
      n = 1; score = 0; over = false;
      endEl.innerHTML = '';
      begin();
    });

    api.cleanup(() => { if (timer) timer.stop(); clearTimeout(nextTimer); });
    begin();
  };

  /* ============================================================
     23 两真一假
     ============================================================ */
  RENDERERS.g23 = function (stage, api) {
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">第 <b id="tfRound">1</b> 位</span></div>
          <div class="hud"><span class="hud-k">本轮票数</span><b id="tfVotes">0</b></div>
        </div>

        <div id="tfSetup">
          <div class="input-row">
            <input class="ipt" id="tfName" maxlength="12" placeholder="出题同学的名字（可选）" aria-label="出题同学的名字">
          </div>
          <div class="tf-rows">
            ${[0, 1, 2].map(i => `
              <label class="tf-row">
                <span class="tf-letter">${'ABC'[i]}</span>
                <input class="ipt tf-statement" data-i="${i}" maxlength="40" placeholder="第 ${i + 1} 句，越像真的越好">
              </label>`).join('')}
          </div>
          <div class="tf-lie">
            <span>哪一句是假话？</span>
            <div class="seg tf-lie-seg" id="tfLieSeg">
              <button type="button" data-lie="0">A</button>
              <button type="button" data-lie="1">B</button>
              <button type="button" data-lie="2">C</button>
            </div>
          </div>
          <p class="stage-note">录入时请让本人背对屏幕，或老师代为输入；投票页不会显示答案。</p>
          <p class="msg" id="tfMsg">三句话里，两句真、一句假。</p>
          <button class="btn btn-accent" type="button" id="tfBegin">封存，开始投票</button>
        </div>

        <div id="tfPlay" hidden>
          <p class="tf-player" id="tfPlayer">这位同学的三句话</p>
          <div class="tf-cards" id="tfCards"></div>
          <div class="btn-row">
            <button class="btn btn-line btn-sm" type="button" id="tfClear">清空票数</button>
            <button class="btn btn-accent" type="button" id="tfReveal">揭晓答案</button>
          </div>
          <p class="msg" id="tfPlayMsg">全班举手投票，老师点句子下方的 +1 计票。</p>
        </div>

        <div id="tfEnd"></div>
      </div>`;

    const setupEl = q('#tfSetup', stage), playEl = q('#tfPlay', stage), endEl = q('#tfEnd', stage);
    const nameEl = q('#tfName', stage), msgEl = q('#tfMsg', stage), playMsgEl = q('#tfPlayMsg', stage);
    const cardsEl = q('#tfCards', stage), playerEl = q('#tfPlayer', stage);
    const roundEl = q('#tfRound', stage), totalEl = q('#tfVotes', stage);
    const lieSeg = q('#tfLieSeg', stage);
    const stmtEls = qa('.tf-statement', stage);

    let statements = ['', '', ''];
    let lie = -1;
    let votes = [0, 0, 0];
    let round = 1;
    let phase = 'setup';

    function setMsg(text, kind = '') {
      msgEl.className = 'msg' + (kind ? ' ' + kind : '');
      msgEl.textContent = text;
    }

    function updateTotal() {
      totalEl.textContent = votes.reduce((a, b) => a + b, 0);
    }

    lieSeg.addEventListener('click', e => {
      const btn = e.target.closest('[data-lie]');
      if (!btn) return;
      lie = Number(btn.dataset.lie);
      qa('button', lieSeg).forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      setMsg(`已标记 ${'ABC'[lie]} 为假话。开始投票后，这个标记会隐藏。`, 'ok');
    });

    function begin() {
      if (phase !== 'setup') return;
      statements = stmtEls.map(el => el.value.trim());
      if (statements.some(s => !s)) { setMsg('三句话都要填。', 'bad'); return; }
      if (lie < 0) { setMsg('先选出哪一句是假话。', 'bad'); return; }

      votes = [0, 0, 0];
      phase = 'play';
      setupEl.hidden = true;
      playEl.hidden = false;
      endEl.innerHTML = '';
      const name = nameEl.value.trim();
      playerEl.textContent = `${name || '这位同学'} 的三句话`;
      cardsEl.innerHTML = statements.map((s, i) => `
        <div class="tf-card" data-card="${i}">
          <span class="tf-card-letter">${'ABC'[i]}</span>
          <p class="tf-card-text">${esc(s)}</p>
          <div class="tf-card-foot">
            <span class="tf-vote-count" data-count="${i}">0 票</span>
            <button class="btn btn-line btn-sm" type="button" data-vote="${i}">+1 票</button>
          </div>
        </div>`).join('');
      updateTotal();
      playMsgEl.className = 'msg';
      playMsgEl.textContent = '全班举手投票，老师点句子下方的 +1 计票。';
      q('#tfReveal', stage).disabled = false;
      q('#tfClear', stage).disabled = false;
    }

    cardsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-vote]');
      if (!btn || phase !== 'play') return;
      const i = Number(btn.dataset.vote);
      votes[i]++;
      const countEl = q(`[data-count="${i}"]`, cardsEl);
      if (countEl) countEl.textContent = votes[i] + ' 票';
      updateTotal();
      tone(680, 0.05);
    });

    q('#tfClear', stage).addEventListener('click', () => {
      if (phase !== 'play') return;
      votes = [0, 0, 0];
      qa('[data-count]', cardsEl).forEach(el => { el.textContent = '0 票'; });
      updateTotal();
      playMsgEl.className = 'msg';
      playMsgEl.textContent = '票数已清空，重新投票。';
    });

    q('#tfReveal', stage).addEventListener('click', () => {
      if (phase !== 'play') return;
      phase = 'revealed';
      qa('.tf-card', cardsEl).forEach((card, i) => {
        card.classList.add(i === lie ? 'lie' : 'true');
        const btn = q('[data-vote]', card);
        if (btn) btn.disabled = true;
      });
      q('#tfReveal', stage).disabled = true;
      q('#tfClear', stage).disabled = true;

      const total = votes.reduce((a, b) => a + b, 0);
      const correct = votes[lie];
      playMsgEl.className = 'msg';
      playMsgEl.textContent = `假话是 ${'ABC'[lie]}；本轮 ${total} 票，${correct} 人猜对。`;
      endEl.innerHTML = `
        <div class="result ${correct > 0 ? 'ok' : ''}">
          <h3>假话是 ${'ABC'[lie]}</h3>
          <p>「${esc(statements[lie])}」</p>
          <p>本轮共 ${total} 票，其中 ${correct} 人猜对。</p>
          <div><button class="btn btn-accent btn-sm" type="button" id="tfNext">下一位</button></div>
        </div>`;
      q('#tfNext', endEl).addEventListener('click', next);
      if (correct > 0) api.burst(36);
      tone(correct > 0 ? 760 : 320, 0.16, correct > 0 ? 'sine' : 'square');
    });

    function next() {
      phase = 'setup';
      round++;
      roundEl.textContent = round;
      statements = ['', '', ''];
      lie = -1;
      votes = [0, 0, 0];
      stmtEls.forEach(el => { el.value = ''; });
      nameEl.value = '';
      qa('button', lieSeg).forEach(b => b.setAttribute('aria-pressed', 'false'));
      updateTotal();
      endEl.innerHTML = '';
      playEl.hidden = true;
      setupEl.hidden = false;
      setMsg('三句话里，两句真、一句假。');
      q('#tfBegin', stage).disabled = false;
      stmtEls[0].focus();
    }

    q('#tfBegin', stage).addEventListener('click', begin);
    api.cleanup(() => { /* 本游戏无计时器 */ });
  };

  /* ============================================================
     24 热座
     ============================================================ */
  RENDERERS.g24 = function (stage, api) {
    const BANKS = {
      classroom: {
        label: '课堂术语',
        words: ['课代表', '作业', '考试', '投影仪', '错题本', '班规', '点名', '开班会', '复习', '预习',
          '笔记', '提问', '分组', '下课铃', '班主任', '校服', '黑板', '粉笔', '课间操', '家长会']
      },
      animals: {
        label: '动物',
        words: ['熊猫', '长颈鹿', '企鹅', '螃蟹', '考拉', '袋鼠', '章鱼', '孔雀', '刺猬', '海豚',
          '猫头鹰', '蜗牛', '老虎', '兔子', '猴子', '大象', '鲨鱼', '蜜蜂', '青蛙', '乌龟']
      },
      objects: {
        label: '生活物品',
        words: ['雨伞', '牙刷', '充电宝', '耳机', '拖鞋', '洗衣机', '微波炉', '钥匙', '眼镜', '口罩',
          '水杯', '行李箱', '遥控器', '吹风机', '指甲刀', '创可贴', '日历', '闹钟', '垃圾桶', '晾衣架']
      },
      idioms: {
        label: '成语',
        words: ['画蛇添足', '守株待兔', '掩耳盗铃', '井底之蛙', '对牛弹琴', '狐假虎威', '刻舟求剑', '亡羊补牢',
          '拔苗助长', '南辕北辙', '自相矛盾', '滥竽充数', '叶公好龙', '杯弓蛇影', '望梅止渴', '塞翁失马',
          '愚公移山', '精卫填海', '夸父逐日', '女娲补天']
      }
    };
    const CAT_KEYS = Object.keys(BANKS);
    const shuffleArr = arr => arr.slice().sort(() => Math.random() - 0.5);

    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">倒计时</span><b id="hsTime">60.0s</b></div>
          <div class="hud"><span class="hud-k">猜对</span><b id="hsScore">0</b></div>
          <div class="hud"><span class="hud-k">跳过</span><b id="hsSkip">0</b></div>
        </div>
        <div class="meter"><i id="hsBar"></i></div>
        <div class="seg" id="hsCats">
          ${CAT_KEYS.map((k, i) => `
            <button type="button" data-cat="${k}" aria-pressed="${i === 0}">${BANKS[k].label}</button>`).join('')}
        </div>
        <div class="hot-box" id="hsBox">
          <span class="hot-word" id="hsWord">准备开始</span>
          <span class="big-sub" id="hsHint">让猜词的同学背对屏幕</span>
        </div>
        <div class="btn-row" id="hsStartRow">
          <button class="btn btn-accent" type="button" id="hsStart">开始 60 秒</button>
        </div>
        <div class="btn-row" id="hsPlayRow" hidden>
          <button class="btn btn-accent" type="button" id="hsCorrect">猜对了 +1</button>
          <button class="btn btn-line" type="button" id="hsPass">跳过</button>
          <button class="btn btn-line btn-sm" type="button" id="hsStop">提前结束</button>
        </div>
        <p class="msg" id="hsMsg">队友只能描述，不能说出词里的任何一个字。</p>
        <div id="hsResult"></div>
      </div>`;

    const timeEl = q('#hsTime', stage), scoreEl = q('#hsScore', stage), skipEl = q('#hsSkip', stage);
    const barEl = q('#hsBar', stage), wordEl = q('#hsWord', stage), hintEl = q('#hsHint', stage);
    const startRow = q('#hsStartRow', stage), playRow = q('#hsPlayRow', stage);
    const startBtn = q('#hsStart', stage), resultEl = q('#hsResult', stage), msgEl = q('#hsMsg', stage);
    const catsEl = q('#hsCats', stage);

    let cat = 'classroom';
    let playing = false;
    let score = 0;
    let skipped = 0;
    let timer = null;
    let pool = [];
    let current = '';
    let correctList = [];
    let skippedList = [];

    function setMsg(text, kind = '') {
      msgEl.className = 'msg' + (kind ? ' ' + kind : '');
      msgEl.textContent = text;
    }

    function resetIdle() {
      playing = false;
      if (timer) { timer.stop(); timer = null; }
      score = 0;
      skipped = 0;
      correctList = [];
      skippedList = [];
      scoreEl.textContent = '0';
      skipEl.textContent = '0';
      timeEl.textContent = '60.0s';
      barEl.style.width = '100%';
      wordEl.textContent = '准备开始';
      hintEl.textContent = '让猜词的同学背对屏幕';
      startRow.hidden = false;
      playRow.hidden = true;
      startBtn.textContent = '开始 60 秒';
      resultEl.innerHTML = '';
      setMsg('队友只能描述，不能说出词里的任何一个字。');
    }

    function nextWord() {
      if (!pool.length) pool = shuffleArr(BANKS[cat].words);
      current = pool.pop();
      wordEl.textContent = current;
      wordEl.classList.remove('hit');
      void wordEl.offsetWidth;
      wordEl.classList.add('hit');
    }

    function stopGame(reason) {
      if (!playing) return;
      playing = false;
      if (timer) { timer.stop(); timer = null; }
      timeEl.textContent = '0.0s';
      barEl.style.width = '0%';
      startRow.hidden = false;
      playRow.hidden = true;
      startBtn.textContent = '再来一轮';
      wordEl.textContent = '本轮结束';
      hintEl.textContent = reason;
      setMsg(`猜对 ${score} 个，跳过 ${skipped} 个。`);

      const correctHtml = correctList.length
        ? `<div class="chips">${correctList.map(w => `<span class="chip ok">${esc(w)}</span>`).join('')}</div>`
        : '<p class="stage-note">这一轮还没有猜对。</p>';
      const skippedHtml = skippedList.length
        ? `<div class="chips">${skippedList.map(w => `<span class="chip miss">${esc(w)}</span>`).join('')}</div>`
        : '';
      resultEl.innerHTML = `
        <div class="result ${score > 0 ? 'ok' : ''}">
          <h3>猜对 ${score} 个</h3>
          <p>跳过 ${skipped} 个。</p>
          ${correctHtml}
          ${skippedHtml}
        </div>`;
      if (score > 0) api.burst(score >= 8 ? 40 : 20);
      tone(score > 0 ? 760 : 320, 0.16, score > 0 ? 'sine' : 'square');
    }

    function startGame() {
      if (playing) return;
      playing = true;
      score = 0;
      skipped = 0;
      correctList = [];
      skippedList = [];
      scoreEl.textContent = '0';
      skipEl.textContent = '0';
      pool = shuffleArr(BANKS[cat].words);
      current = '';
      resultEl.innerHTML = '';
      startRow.hidden = true;
      playRow.hidden = false;
      hintEl.textContent = '队友只能描述，不能说出词里的任何一个字';
      setMsg('开始！猜对一个得 1 分，猜不出就跳过。');
      nextWord();
      timer = countdown(api, 60,
        (left, total) => {
          timeEl.textContent = (left / 1000).toFixed(1) + 's';
          barEl.style.width = (left / total * 100) + '%';
        },
        () => stopGame('时间到'));
    }

    startBtn.addEventListener('click', startGame);
    q('#hsCorrect', stage).addEventListener('click', () => {
      if (!playing) return;
      score++;
      scoreEl.textContent = score;
      correctList.push(current);
      tone(760, 0.08);
      nextWord();
    });
    q('#hsPass', stage).addEventListener('click', () => {
      if (!playing) return;
      skipped++;
      skipEl.textContent = skipped;
      skippedList.push(current);
      tone(320, 0.06);
      nextWord();
    });
    q('#hsStop', stage).addEventListener('click', () => stopGame('提前结束'));
    catsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      if (playing) { toast('先结束这一轮再换主题'); return; }
      cat = btn.dataset.cat;
      qa('button', catsEl).forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      resetIdle();
      setMsg(`主题：${BANKS[cat].label}。`);
    });

    api.cleanup(() => { if (timer) timer.stop(); });
    resetIdle();
  };

  /* ============================================================
     25 少数派
     ------------------------------------------------------------
     三选一，全班同时举手，屏幕高亮人数最少的选项。
     关键设计：不显示实时票数，只在揭晓时高亮「最少」的那一档，
     否则后面举手的人会跟着前面的人走，少数派就消失了。
     ============================================================ */
  RENDERERS.g25 = function (stage, api) {
    const DEF = ['先做选择题', '先讲作业', '先休息两分钟'];
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已记录</span><b id="spTotal">0</b></div>
          <div class="hud"><span class="hud-k">状态</span><b id="spState">投票中</b></div>
        </div>
        <p class="stage-note">三个选项都能现场改。全班<strong>同时</strong>举手，每人只能选一个。</p>
        <div class="sp-list" id="spList"></div>
        <div class="btn-row">
          <button class="btn btn-accent" type="button" id="spReveal">揭晓少数派</button>
          <button class="btn btn-line" type="button" id="spReset">重新开始</button>
        </div>
        <p class="msg" id="spMsg">数完每一档人数，点右侧「+1」记上。</p>
      </div>`;

    const listEl = q('#spList', stage), totalEl = q('#spTotal', stage);
    const stateEl = q('#spState', stage), msgEl = q('#spMsg', stage);
    const revealEl = q('#spReveal', stage), resetEl = q('#spReset', stage);

    let counts = [0, 0, 0];
    let texts = DEF.slice();
    let revealed = false;

    function total() { return counts[0] + counts[1] + counts[2]; }

    // 只在「真的有人选」的档位里找最少 —— 否则一个 0 人的档位会被判成少数派，
    // 但没人选它并不代表它"少数"，只是没人选。
    function minVoted() {
      const voted = counts.filter(function (c) { return c > 0; });
      return voted.length ? Math.min.apply(null, voted) : 0;
    }

    function render() {
      const t = total();
      const min = minVoted();
      listEl.innerHTML = texts.map(function (text, i) {
        const isMin = revealed && counts[i] > 0 && counts[i] === min;
        return `
          <div class="sp-item${isMin ? ' is-min' : ''}" data-i="${i}">
            <span class="sp-no">${'ABC'[i]}</span>
            <input class="ipt sp-text" data-text="${i}" value="${esc(text)}" aria-label="选项 ${'ABC'[i]}">
            <span class="sp-count" data-count="${i}">${counts[i]}</span>
            <button class="btn btn-line btn-sm sp-plus" type="button" data-plus="${i}" aria-label="选项 ${'ABC'[i]} 加一">+1</button>
            <button class="btn btn-line btn-sm sp-minus" type="button" data-minus="${i}" aria-label="选项 ${'ABC'[i]} 减一">−1</button>
          </div>`;
      }).join('');
      totalEl.textContent = t;
      stateEl.textContent = revealed ? '已揭晓' : '投票中';
    }

    listEl.addEventListener('click', function (e) {
      if (revealed) return;
      const plus = e.target.closest('[data-plus]');
      const minus = e.target.closest('[data-minus]');
      if (plus) { counts[Number(plus.getAttribute('data-plus'))]++; render(); }
      if (minus) {
        const i = Number(minus.getAttribute('data-minus'));
        if (counts[i] > 0) counts[i]--;
        render();
      }
    });

    listEl.addEventListener('input', function (e) {
      const inp = e.target.closest('[data-text]');
      if (!inp) return;
      texts[Number(inp.getAttribute('data-text'))] = inp.value;
    });

    revealEl.addEventListener('click', function () {
      const t = total();
      if (!t) { msgEl.className = 'msg bad'; msgEl.textContent = '先记人数再揭晓。'; return; }
      revealed = true;
      render();
      const min = minVoted();
      const winners = [];
      counts.forEach(function (c, i) { if (c > 0 && c === min) winners.push(texts[i]); });
      msgEl.className = 'msg ok';
      msgEl.textContent = winners.length === 3
        ? '三档一样多 —— 全班居然完全分裂，加赛一轮。'
        : '少数派是「' + winners.join('」「') + '」（' + min + ' 人）。请他们说说理由。';
      tone(760, 0.1);
      api.burst(36);
    });

    resetEl.addEventListener('click', function () {
      counts = [0, 0, 0];
      revealed = false;
      msgEl.className = 'msg';
      msgEl.textContent = '数完每一档人数，点右侧「+1」记上。';
      render();
    });

    render();
  };

  /* ============================================================
     26 站队
     ------------------------------------------------------------
     二选一，学生起立走到教室左/右半边，天平动画揭晓比例。
     只显示百分比不显示绝对人数 —— 小班也不会尴尬。
     ============================================================ */
  RENDERERS.g26 = function (stage, api) {
    const DEF = ['先讲新课', '先复习旧课'];
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">左</span><b id="sdLeft">0</b></div>
          <div class="hud"><span class="hud-k">右</span><b id="sdRight">0</b></div>
          <div class="hud"><span class="hud-k">状态</span><b id="sdState">站队中</b></div>
        </div>
        <p class="stage-note">全班起立，支持哪边就走到教室对应的半边 —— 必须选一边，不能站中间。</p>
        <div class="sd-scale" id="sdScale">
          <div class="sd-pan sd-pan-l">
            <input class="ipt sd-text" id="sdTextL" value="${esc(DEF[0])}" aria-label="左边选项">
            <span class="sd-num" id="sdNumL">0 人</span>
            <button class="btn btn-line btn-sm" type="button" id="sdPlusL">左边 +1</button>
          </div>
          <div class="sd-beam" id="sdBeam">
            <span class="sd-fulcrum"></span>
          </div>
          <div class="sd-pan sd-pan-r">
            <input class="ipt sd-text" id="sdTextR" value="${esc(DEF[1])}" aria-label="右边选项">
            <span class="sd-num" id="sdNumR">0 人</span>
            <button class="btn btn-line btn-sm" type="button" id="sdPlusR">右边 +1</button>
          </div>
        </div>
        <div class="sd-pct" id="sdPct">左 50% · 右 50%</div>
        <div class="btn-row">
          <button class="btn btn-accent" type="button" id="sdReveal">揭晓比例</button>
          <button class="btn btn-line" type="button" id="sdReset">重新开始</button>
        </div>
        <p class="msg" id="sdMsg">数完两边的队伍，点对应按钮记上人数。</p>
      </div>`;

    const beamEl = q('#sdBeam', stage), pctEl = q('#sdPct', stage), msgEl = q('#sdMsg', stage);
    const numLEl = q('#sdNumL', stage), numREl = q('#sdNumR', stage);
    const leftEl = q('#sdLeft', stage), rightEl = q('#sdRight', stage), stateEl = q('#sdState', stage);
    const textLEl = q('#sdTextL', stage), textREl = q('#sdTextR', stage);

    let l = 0, r = 0, revealed = false;

    function tilt() {
      const t = l + r;
      const ratio = t ? l / t : 0.5;
      const deg = (ratio - 0.5) * 24;
      beamEl.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
      pctEl.textContent = '左 ' + Math.round(ratio * 100) + '% · 右 ' + Math.round((1 - ratio) * 100) + '%';
      numLEl.textContent = l + ' 人';
      numREl.textContent = r + ' 人';
      leftEl.textContent = l;
      rightEl.textContent = r;
    }

    q('#sdPlusL', stage).addEventListener('click', function () {
      if (revealed) return;
      l++; tilt(); tone(560, 0.06);
    });
    q('#sdPlusR', stage).addEventListener('click', function () {
      if (revealed) return;
      r++; tilt(); tone(660, 0.06);
    });

    q('#sdReveal', stage).addEventListener('click', function () {
      if (!l && !r) { msgEl.className = 'msg bad'; msgEl.textContent = '先记人数再揭晓。'; return; }
      revealed = true;
      stateEl.textContent = '已揭晓';
      const ratio = l / (l + r);
      const win = ratio >= 0.5 ? textLEl.value : textREl.value;
      const lose = ratio >= 0.5 ? textREl.value : textLEl.value;
      msgEl.className = 'msg ok';
      msgEl.textContent = '「' + win + '」占多数。请「' + lose + '」这一边派代表说说为什么这么选。';
      tone(820, 0.12);
      api.burst(40);
    });

    q('#sdReset', stage).addEventListener('click', function () {
      l = 0; r = 0; revealed = false;
      stateEl.textContent = '站队中';
      msgEl.className = 'msg';
      msgEl.textContent = '数完两边的队伍，点对应按钮记上人数。';
      tilt();
    });

    tilt();
  };

  /* ============================================================
     27 三句话
     ------------------------------------------------------------
     抽一人说三句关于自己的话（各 ≤10 字），一句是假的，全班投票。
     关键设计：揭晓前隐藏票数 —— 否则后面的人跟着前面投票。
     ============================================================ */
  RENDERERS.g27 = function (stage, api) {
    stage.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          <div class="hud"><span class="hud-k">已投票</span><b id="thTotal">0</b></div>
          <div class="hud"><span class="hud-k">状态</span><b id="thState">投票中</b></div>
        </div>
        <p class="stage-note">抽一位同学说三句关于自己的话，每句不超过 10 字，其中<strong>一句是假的</strong>。全班投票。</p>
        <div class="th-list" id="thList"></div>
        <div class="btn-row">
          <button class="btn btn-accent" type="button" id="thReveal">揭晓票数</button>
          <button class="btn btn-line" type="button" id="thReset">下一轮</button>
        </div>
        <p class="msg" id="thMsg">投票期间票数是隐藏的，揭晓时一次性公布。</p>
      </div>`;

    const listEl = q('#thList', stage), totalEl = q('#thTotal', stage);
    const stateEl = q('#thState', stage), msgEl = q('#thMsg', stage);

    let votes = [0, 0, 0];
    let texts = ['', '', ''];
    let revealed = false;

    function total() { return votes[0] + votes[1] + votes[2]; }

    function render() {
      const t = total();
      const max = Math.max.apply(null, votes);
      listEl.innerHTML = texts.map(function (text, i) {
        const hot = revealed && votes[i] === max && t > 0;
        return `
          <div class="th-item${hot ? ' is-top' : ''}" data-i="${i}">
            <span class="th-no">${i + 1}</span>
            <input class="ipt th-text" data-text="${i}" value="${esc(text)}"
                   placeholder="第 ${i + 1} 句话（不超过 10 字）" aria-label="第 ${i + 1} 句话">
            <span class="th-count">${revealed ? votes[i] + ' 票' : '— 票'}</span>
            <button class="btn btn-line btn-sm" type="button" data-vote="${i}" aria-label="第 ${i + 1} 句加一票">+1 票</button>
          </div>`;
      }).join('');
      totalEl.textContent = t;
      stateEl.textContent = revealed ? '已揭晓' : '投票中';
    }

    listEl.addEventListener('input', function (e) {
      const inp = e.target.closest('[data-text]');
      if (!inp) return;
      texts[Number(inp.getAttribute('data-text'))] = inp.value;
    });

    listEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-vote]');
      if (!btn || revealed) return;
      votes[Number(btn.getAttribute('data-vote'))]++;
      render();
      tone(600 + votes.length * 20, 0.05);
    });

    q('#thReveal', stage).addEventListener('click', function () {
      const t = total();
      if (!t) { msgEl.className = 'msg bad'; msgEl.textContent = '还没有人投票。'; return; }
      revealed = true;
      render();
      const max = Math.max.apply(null, votes);
      const idx = [];
      votes.forEach(function (v, i) { if (v === max) idx.push(i + 1); });
      msgEl.className = 'msg ok';
      msgEl.textContent = '票数最高的是第 ' + idx.join('、') + ' 句（' + max + ' 票）。请出题的同学公布哪句是假的。';
      tone(780, 0.12);
      api.burst(44);
    });

    q('#thReset', stage).addEventListener('click', function () {
      votes = [0, 0, 0];
      texts = ['', '', ''];
      revealed = false;
      msgEl.className = 'msg';
      msgEl.textContent = '投票期间票数是隐藏的，揭晓时一次性公布。';
      render();
    });

    render();
  };
})();
