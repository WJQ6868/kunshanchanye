/* ============================================================
   anim-wheel.js — 幸运转盘 + 彩带粒子
   结果先定，再算旋转角，保证指针停在正确扇区
   ============================================================ */

(function (global) {
  'use strict';

  var canvas, ctx, confetti, cctx;
  var hubText;
  var students = [];
  var rotation = 0;      // 当前角度（弧度）
  var raf = 0;
  var running = false;
  var W = 900, H = 900;

  var PALETTE = [
    '#ffd166', '#ef476f', '#4cc9f0', '#06d6a0', '#a06cd5',
    '#ff9f1c', '#2ec4b6', '#e07a5f', '#8ecae6', '#f4a261'
  ];
  var PALETTE_DARK = [
    '#c99b23', '#b32d4c', '#2b8fa8', '#049f78', '#7348a0',
    '#c47512', '#1f9188', '#a85540', '#5c93a8', '#b5763f'
  ];

  // 主题相关的描边/遮罩颜色（白色主题下不能再用深底）
  var theme = 'gold';
  var THEME_COLORS = {
    gold: {
      halo: 'rgba(255,209,102,', emptyFill: 'rgba(255,255,255,0.06)',
      emptyText: 'rgba(238,242,255,0.45)', mask: 'rgba(8,10,20,0.92)',
      ring: 'rgba(255,209,102,0.55)', bulbA: 'rgba(255,209,102,0.9)',
      bulbB: 'rgba(255,255,255,0.35)', name: 'rgba(10,8,4,0.86)',
      nameShadow: 'rgba(255,255,255,0.35)'
    },
    blue: {
      halo: 'rgba(123,216,255,', emptyFill: 'rgba(255,255,255,0.06)',
      emptyText: 'rgba(234,246,255,0.45)', mask: 'rgba(6,16,30,0.92)',
      ring: 'rgba(123,216,255,0.55)', bulbA: 'rgba(123,216,255,0.9)',
      bulbB: 'rgba(255,255,255,0.35)', name: 'rgba(6,16,30,0.86)',
      nameShadow: 'rgba(255,255,255,0.35)'
    },
    white: {
      halo: 'rgba(37,99,235,', emptyFill: 'rgba(15,23,42,0.06)',
      emptyText: 'rgba(51,65,85,0.62)', mask: 'rgba(255,255,255,0.96)',
      ring: 'rgba(37,99,235,0.42)', bulbA: 'rgba(37,99,235,0.75)',
      bulbB: 'rgba(15,23,42,0.22)', name: 'rgba(17,24,39,0.90)',
      nameShadow: 'rgba(255,255,255,0.65)'
    }
  };

  function setTheme(t) {
    theme = THEME_COLORS[t] ? t : 'gold';
    draw();
  }

  function TC() { return THEME_COLORS[theme] || THEME_COLORS.gold; }

  function setup(cv, cf, hub) {
    canvas = cv;
    confetti = cf;
    hubText = hub;

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    W = 900; H = 900;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (confetti) {
      var rect = confetti.getBoundingClientRect();
      confetti.width = Math.max(1, rect.width * dpr);
      confetti.height = Math.max(1, rect.height * dpr);
      cctx = confetti.getContext('2d');
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeConfetti();
  }

  function resizeConfetti() {
    if (!confetti || !cctx) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var rect = confetti.getBoundingClientRect();
    if (rect.width < 2) return;
    confetti.width = rect.width * dpr;
    confetti.height = rect.height * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setStudents(list) {
    students = list || [];
    rotation = 0;
    draw();
  }

  /** 绘制转盘 */
  function draw() {
    if (!ctx) return;
    var n = students.length;
    var cx = W / 2, cy = H / 2;
    var R = W / 2 - 10;

    ctx.clearRect(0, 0, W, H);

    // 外圈光晕
    var halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.06);
    halo.addColorStop(0, TC().halo + '0)');
    halo.addColorStop(1, TC().halo + '0.20)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
    ctx.fill();

    if (!n) {
      ctx.fillStyle = TC().emptyFill;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = TC().emptyText;
      ctx.font = '700 40px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待导入名单', cx, cy);
      return;
    }

    var arc = (Math.PI * 2) / n;
    var showText = n <= 40;
    var showShort = n <= 90;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    for (var i = 0; i < n; i++) {
      var start = i * arc;
      var end = start + arc;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, start, end);
      ctx.closePath();

      // 扇区底色：交替明暗
      var ci = i % PALETTE.length;
      var g = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R);
      g.addColorStop(0, i % 2 ? PALETTE_DARK[ci] : PALETTE[ci]);
      g.addColorStop(1, i % 2 ? shade(PALETTE_DARK[ci], -0.18) : shade(PALETTE[ci], -0.22));
      ctx.fillStyle = g;
      ctx.fill();

      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // 文字
      if (showText || (showShort && i % Math.ceil(n / 40) === 0)) {
        ctx.save();
        ctx.rotate(start + arc / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        var name = students[i].name;
        var fs = n <= 12 ? 44 : n <= 24 ? 34 : n <= 40 ? 27 : n <= 60 ? 22 : 16;
        ctx.font = '800 ' + fs + 'px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.fillStyle = TC().name;
        ctx.shadowColor = TC().nameShadow;
        ctx.shadowBlur = 3;
        var maxLen = n <= 40 ? 6 : 4;
        if (name.length > maxLen) name = name.slice(0, maxLen);
        ctx.fillText(name, R - 22, 0);
        ctx.restore();
      }
    }

    ctx.restore();

    // 内圈遮罩
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.20, 0, Math.PI * 2);
    ctx.fillStyle = TC().mask;
    ctx.fill();

    // 外环装饰
    ctx.beginPath();
    ctx.arc(cx, cy, R + 2, 0, Math.PI * 2);
    ctx.strokeStyle = TC().ring;
    ctx.lineWidth = 4;
    ctx.stroke();

    // 外圈小灯珠
    var bulbs = 32;
    for (var b = 0; b < bulbs; b++) {
      var a = (b / bulbs) * Math.PI * 2 + rotation * 0.25;
      var bx = cx + Math.cos(a) * (R + 10);
      var by = cy + Math.sin(a) * (R + 10);
      ctx.beginPath();
      ctx.arc(bx, by, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = b % 2 ? TC().bulbA : TC().bulbB;
      ctx.fill();
    }
  }

  function shade(hex, amt) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.slice(0, 2), 16);
    var g = parseInt(c.slice(2, 4), 16);
    var b = parseInt(c.slice(4, 6), 16);
    function f(v) {
      v = Math.round(v + 255 * amt);
      return Math.max(0, Math.min(255, v));
    }
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }

  /**
   * 播放旋转
   * @param {Object} opt {winner, winnerIndex, fast, sound}
   */
  function play(opt) {
    var winner = opt.winner;
    var n = students.length;
    var fast = !!opt.fast;
    var sound = opt.sound !== false && global.RCAudio;

    return new Promise(function (resolve) {
      if (!n || !winner) { resolve(); return; }

      var idx = opt.winnerIndex;
      if (idx == null || idx < 0) {
        idx = students.findIndex(function (s) {
          return RCPicker.studentKey(s) === RCPicker.studentKey(winner);
        });
      }
      if (idx < 0) idx = 0;

      var arc = (Math.PI * 2) / n;
      // 指针在正上方（-PI/2）。扇区 i 中心角 = idx*arc + arc/2（相对转盘 0 度）
      // 需要 rotation 使 (idx*arc + arc/2 + rotation) ≡ -PI/2  (mod 2PI)
      var targetBase = -Math.PI / 2 - (idx * arc + arc / 2);
      // 转 6~8 圈 + 落在目标
      var turns = fast ? 3 : 6 + RCPicker.randInt(3);
      var jitter = (RCPicker.randInt(1000) / 1000 - 0.5) * arc * 0.5; // 扇区内随机偏移，避免总停正中
      var from = rotation % (Math.PI * 2);
      var target = targetBase + jitter + turns * Math.PI * 2;
      // 保证是正向旋转
      while (target <= from) target += Math.PI * 2;

      var totalMs = fast ? 1100 : 3600 + RCPicker.randInt(900);
      var t0 = performance.now();
      running = true;

      if (sound) { try { RCAudio.whirr(totalMs); } catch (e) {} }

      function step(now) {
        if (!running) { resolve(); return; }
        var p = Math.min(1, (now - t0) / totalMs);
        // easeOutQuint 更适合转盘（前段匀快，后段长缓停）
        var eased = 1 - Math.pow(1 - p, 5);
        rotation = from + (target - from) * eased;
        draw();

        if (p < 1) {
          raf = requestAnimationFrame(step);
        } else {
          rotation = target % (Math.PI * 2);
          draw();
          running = false;
          if (sound) { try { RCAudio.fanfare(); } catch (e) {} }
          burstConfetti();
          resolve();
        }
      }
      raf = requestAnimationFrame(step);
    });
  }

  /* ---------------- 彩带粒子 ---------------- */

  var particles = [];
  var confettiRaf = 0;

  function burstConfetti() {
    if (!cctx || !confetti) return;
    resizeConfetti();
    var w = confetti.clientWidth, h = confetti.clientHeight;
    var colors = PALETTE.concat(['#ffffff', '#ffd166']);
    for (var i = 0; i < 140; i++) {
      particles.push({
        x: w / 2 + (Math.random() - 0.5) * w * 0.2,
        y: h * 0.42,
        vx: (Math.random() - 0.5) * 13,
        vy: -Math.random() * 15 - 4,
        w: 5 + Math.random() * 8,
        h: 8 + Math.random() * 12,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1,
        decay: 0.0055 + Math.random() * 0.006
      });
    }
    if (!confettiRaf) confettiRaf = requestAnimationFrame(confettiStep);
  }

  function confettiStep() {
    if (!cctx) { confettiRaf = 0; return; }
    var w = confetti.clientWidth, h = confetti.clientHeight;
    cctx.clearRect(0, 0, w, h);

    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.vy += 0.42;
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= p.decay;

      if (p.life <= 0 || p.y > h + 60) { particles.splice(i, 1); continue; }

      cctx.save();
      cctx.globalAlpha = Math.max(0, p.life);
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      cctx.fillStyle = p.color;
      cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cctx.restore();
    }

    if (particles.length) {
      confettiRaf = requestAnimationFrame(confettiStep);
    } else {
      cctx.clearRect(0, 0, w, h);
      confettiRaf = 0;
    }
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
  }

  function reset() {
    rotation = 0;
    draw();
  }

  global.AnimWheel = {
    setup: setup,
    setStudents: setStudents,
    play: play,
    stop: stop,
    reset: reset,
    redraw: draw,
    setTheme: setTheme,
    resize: function () { resizeConfetti(); draw(); },
    /** 调试用：当前旋转角 + 指针所指扇区序号 */
    debugHit: function () {
      var n = students.length;
      if (!n) return null;
      var arc = (Math.PI * 2) / n;
      // 指针在 -PI/2；扇区 i 覆盖 [i*arc, (i+1)*arc) + rotation
      var a = (-Math.PI / 2 - rotation) % (Math.PI * 2);
      if (a < 0) a += Math.PI * 2;
      var idx = Math.floor(a / arc) % n;
      return { idx: idx, name: students[idx] && students[idx].name, rotation: rotation };
    }
  };
})(window);
