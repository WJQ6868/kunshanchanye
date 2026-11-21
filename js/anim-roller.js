/* ============================================================
   anim-roller.js — 滚屏抽签
   中间大字快速滚动，上下两行模糊残影，easeOutExpo 减速定格
   ============================================================ */

(function (global) {
  'use strict';

  var nameEl, topEl, bottomEl, labelEl;
  var raf = 0;
  var running = false;
  var lastSeq = [];

  function mount(name, top, bottom, label) {
    nameEl = name;
    topEl = top;
    bottomEl = bottom;
    labelEl = label;
  }

  function setLabel(text) {
    if (labelEl) labelEl.textContent = text;
  }

  function reset() {
    if (nameEl) { nameEl.textContent = '准备就绪'; nameEl.classList.remove('rolling', 'hit'); }
    if (topEl) topEl.textContent = '';
    if (bottomEl) bottomEl.textContent = '';
    setLabel('READY');
  }

  function setLines(prev, next) {
    if (topEl) topEl.textContent = prev || '';
    if (bottomEl) bottomEl.textContent = next || '';
  }

  /**
   * @param {Object} opt {pool:Array, winner:student, fast:boolean, sound:boolean}
   */
  function play(opt) {
    var pool = (opt.pool && opt.pool.length) ? opt.pool : [];
    var winner = opt.winner;
    var fast = !!opt.fast;
    var sound = opt.sound !== false && global.RCAudio;

    return new Promise(function (resolve) {
      if (!winner || !pool.length) { resolve(); return; }

      running = true;
      nameEl.classList.remove('hit');
      nameEl.classList.add('rolling');
      setLabel('ROLLING');

      // 预先造好滚动序列（最后一个是中奖者）
      var totalMs = fast ? 1000 : 3200;
      var seq = RCPicker.fakeSequence(pool, 200).map(function (s) { return s.name; });
      var t0 = performance.now();
      var lastTick = 0;
      var cursor = 0;

      function step(now) {
        if (!running) { resolve(); return; }
        var elapsed = now - t0;
        var p = Math.min(1, elapsed / totalMs);
        // easeOutExpo：开始极快，结尾缓停
        var eased = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);

        // 当前应显示到序列的第几个
        var idx = Math.floor(eased * seq.length);
        idx = Math.min(idx, seq.length - 1);

        if (idx !== cursor) {
          cursor = idx;
          var nm = seq[idx];
          nameEl.textContent = nm;
          var prev = seq[Math.max(0, idx - 1)] || '';
          var next = seq[Math.min(seq.length - 1, idx + 1)] || '';
          setLines(prev, next);
          if (sound && now - lastTick > 70) {
            lastTick = now;
            try { RCAudio.tick(900 + RCPicker.randInt(500)); } catch (e) {}
          }
        }

        if (p < 1) {
          raf = requestAnimationFrame(step);
        } else {
          finish();
          resolve();
        }
      }

      function finish() {
        running = false;
        nameEl.textContent = winner.name;
        nameEl.classList.remove('rolling');
        nameEl.classList.add('hit');
        setLines('', '');
        setLabel('DRAWN');
        if (sound) { try { RCAudio.fanfare(); } catch (e) {} }
      }

      raf = requestAnimationFrame(step);
    });
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    if (nameEl) nameEl.classList.remove('rolling');
  }

  global.AnimRoller = {
    mount: mount,
    reset: reset,
    play: play,
    stop: stop
  };
})(window);
