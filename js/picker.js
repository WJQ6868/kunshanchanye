/* ============================================================
   picker.js — 抽取算法
   设计要点：结果在动画开始前就用加密随机数确定，动画只是表现层，
   保证「动画停在哪就是谁」永远不会错位。
   ============================================================ */

(function (global) {
  'use strict';

  /** 加密级随机整数 [0, max) */
  function randInt(max) {
    if (max <= 0) return 0;
    if (max === 1) return 0;
    var c = global.crypto || global.msCrypto;
    if (c && c.getRandomValues) {
      // 拒绝采样，消除取模偏差
      var limit = Math.floor(0xFFFFFFFF / max) * max;
      var buf = new Uint32Array(1);
      var v;
      do {
        c.getRandomValues(buf);
        v = buf[0];
      } while (v >= limit);
      return v % max;
    }
    return Math.floor(Math.random() * max);
  }

  /** Fisher–Yates 洗牌（返回新数组） */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 从候选人里抽一个
   * @param {Array} candidates 候选学生
   * @param {Array<string>} exclude 已抽过的 name+id 键
   * @param {boolean} allowRepeat 是否允许重复
   * @returns {{student:Object|null, exhausted:boolean, pool:Array}}
   */
  function pick(candidates, exclude, allowRepeat) {
    if (!candidates || !candidates.length) {
      return { student: null, exhausted: true, pool: [] };
    }

    var pool = candidates;
    if (!allowRepeat) {
      var ex = Object.create(null);
      (exclude || []).forEach(function (k) { ex[k] = 1; });
      pool = candidates.filter(function (s) { return !ex[studentKey(s)]; });
    }

    if (!pool.length) {
      return { student: null, exhausted: true, pool: [] };
    }

    var idx = randInt(pool.length);
    return { student: pool[idx], exhausted: false, pool: pool, index: idx };
  }

  function studentKey(s) {
    return s ? (s.name + '\u0000' + (s.id || '')) : '';
  }

  /** 生成一段「假名字」序列用于动画滚动（从候选人中洗牌循环） */
  function fakeSequence(candidates, count) {
    if (!candidates.length) return [];
    var out = [];
    var pool = [];
    while (out.length < count) {
      if (!pool.length) pool = shuffle(candidates);
      out.push(pool.pop());
    }
    return out;
  }

  global.RCPicker = {
    randInt: randInt,
    shuffle: shuffle,
    pick: pick,
    studentKey: studentKey,
    fakeSequence: fakeSequence
  };
})(window);
