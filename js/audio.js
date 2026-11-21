/* ============================================================
   audio.js — WebAudio 合成音效（无外部音频文件）
   ============================================================ */
(function (global) {
  'use strict';

  var ctx = null;
  var enabled = true;

  function ac() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function env(node, t0, attack, decay, peak) {
    var g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  /** 短促咔哒声：滚屏时使用，pitch 越高越尖锐 */
  function tick(pitch) {
    if (!enabled) return;
    var c = ac(); if (!c) return;
    var t = c.currentTime;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(pitch || 1200, t);
    env(g, t, 0.002, 0.045, 0.06);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  /** 中奖提示音：三音上行 */
  function fanfare() {
    if (!enabled) return;
    var c = ac(); if (!c) return;
    var notes = [523.25, 659.25, 783.99, 1046.5];
    var t0 = c.currentTime;
    notes.forEach(function (f, i) {
      var t = t0 + i * 0.085;
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, t);
      env(g, t, 0.012, 0.42, 0.16);
      osc.connect(g).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  }

  /** 转盘旋转的低频呼啸（持续音，返回 stop 函数） */
  function whirr(durationMs) {
    if (!enabled) return function () {};
    var c = ac(); if (!c) return function () {};
    var t = c.currentTime;
    var dur = Math.max(0.2, (durationMs || 3000) / 1000);
    var osc = c.createOscillator();
    var g = c.createGain();
    var filter = c.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + dur * 0.55);
    osc.frequency.exponentialRampToValueAtTime(80, t + dur);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.linearRampToValueAtTime(1800, t + dur * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.15);
    g.gain.setValueAtTime(0.05, t + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter).connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    return function () { try { osc.stop(); } catch (e) {} };
  }

  /** 聚光灯跳动声 */
  function blip(i) {
    tick(700 + (i % 5) * 130);
  }

  global.RCAudio = {
    tick: tick,
    blip: blip,
    fanfare: fanfare,
    whirr: whirr,
    setEnabled: function (v) { enabled = !!v; },
    isEnabled: function () { return enabled; },
    /** 浏览器要求用户手势后才能播放音频，首次点击时预热 */
    unlock: function () { ac(); }
  };
})(window);
