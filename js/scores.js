/* ============================================================
   scores.js — 加分数据模型（纯逻辑，不碰 DOM）
   班级分组、累计总分、CSV 构建都在这里，app.js 只负责渲染与交互
   ============================================================ */

(function (global) {
  'use strict';

  var MAX_REASON = 40;     // 原因最长字符
  var MAX_OPERATOR = 24;   // 操作人姓名最长字符
  var MAX_ABS = 1000;      // 单次加减分绝对值上限，防手滑输入 99999

  /* ---------- 班级 ---------- */

  /** 学生所属班级键（''=未分班） */
  function classKey(s) {
    return (s && s.group) ? String(s.group).trim() : '';
  }

  /** 班级显示名 */
  function classLabel(c) {
    return c ? String(c) : '未分班';
  }

  /** 从名单里按出现顺序取出班级列表，未分班排在最后 */
  function groupsOf(students) {
    var seen = Object.create(null);
    var named = [];
    var hasBlank = false;
    (students || []).forEach(function (s) {
      var c = classKey(s);
      if (!c) { hasBlank = true; return; }
      if (!seen[c]) { seen[c] = 1; named.push(c); }
    });
    if (hasBlank) named.push('');
    return named;
  }

  /** 名单里是否出现过班级信息 */
  function hasClasses(students) {
    return (students || []).some(function (s) { return !!classKey(s); });
  }

  /* ---------- 学生身份 ---------- */

  /** 学生唯一键：姓名 + 学号（与 picker 保持一致） */
  function studentKey(s) {
    return (s && s.name ? String(s.name) : '') + '\u0000' + (s && s.id ? String(s.id) : '');
  }

  /** 加分记录里存的是 name / sid 两个字段，这里还原成同一个键 */
  function keyOf(name, sid) {
    return (name || '') + '\u0000' + (sid || '');
  }

  /* ---------- 数值 ---------- */

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function fmtNum(n) {
    var v = round2(n);
    if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
    return String(v);
  }

  function fmtDelta(n) {
    var v = round2(n);
    return (v > 0 ? '+' : '') + fmtNum(v);
  }

  /* ---------- 记录 ---------- */

  function makeId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * 给一批学生生成加分记录（一条记录对应一个学生）
   * @param {Array} students 学生对象数组
   * @param {Number} delta 分值，可正可负
   * @param {String} reason 原因
   * @param {String} operator 操作人姓名（讲师/管理员真名，写进记录便于追溯）
   * @returns {Array} 新记录数组（不改动入参）
   */
  function makeRecords(students, delta, reason, operator) {
    var d = round2(delta);
    if (!isFinite(d) || d === 0) return [];
    if (d > MAX_ABS) d = MAX_ABS;
    if (d < -MAX_ABS) d = -MAX_ABS;

    var t = Date.now();
    var rs = String(reason == null ? '' : reason).trim().slice(0, MAX_REASON);
    var op = String(operator == null ? '' : operator).trim().slice(0, MAX_OPERATOR);
    return (students || []).map(function (s) {
      return {
        id: makeId(),
        t: t,
        name: s && s.name ? String(s.name) : '',
        sid: s && s.id ? String(s.id) : '',
        delta: d,
        reason: rs,
        op: op
      };
    });
  }

  /** 某个学生的累计总分 */
  function totalOf(records, key) {
    var sum = 0;
    (records || []).forEach(function (r) {
      if (keyOf(r.name, r.sid) === key) sum += Number(r.delta) || 0;
    });
    return round2(sum);
  }

  /** 全班每个学生的累计分：{studentKey: number} */
  function totals(records) {
    var m = Object.create(null);
    (records || []).forEach(function (r) {
      var k = keyOf(r.name, r.sid);
      m[k] = round2((m[k] || 0) + (Number(r.delta) || 0));
    });
    return m;
  }

  /**
   * 全班每个学生的「加分次数 + 总分」：{studentKey: {count, total, plus, minus}}
   * count 只统计正分记录（加了几次分）；minus 单独记扣分次数，方便导出时说明。
   */
  function statsOf(records) {
    var m = Object.create(null);
    (records || []).forEach(function (r) {
      var k = keyOf(r.name, r.sid);
      if (!m[k]) m[k] = { count: 0, total: 0, plus: 0, minus: 0 };
      var d = Number(r.delta) || 0;
      m[k].total = round2(m[k].total + d);
      if (d > 0) { m[k].plus += 1; m[k].count += 1; }
      else if (d < 0) { m[k].minus += 1; }
    });
    return m;
  }

  /** 全班加分总额 */
  function sumOf(records) {
    var sum = 0;
    (records || []).forEach(function (r) { sum += Number(r.delta) || 0; });
    return round2(sum);
  }

  /** 某个学生的记录，按时间正序 */
  function ofStudent(records, key) {
    return (records || []).filter(function (r) {
      return keyOf(r.name, r.sid) === key;
    }).sort(function (a, b) { return a.t - b.t; });
  }

  function removeById(records, id) {
    return (records || []).filter(function (r) { return r.id !== id; });
  }

  function removeOfStudent(records, key) {
    return (records || []).filter(function (r) {
      return keyOf(r.name, r.sid) !== key;
    });
  }

  /* ---------- 时间与文件名 ---------- */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDate(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtDateTime(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    return fmtDate(ts) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function safeFileName(s) {
    var v = String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
    if (v.length > 40) v = v.slice(0, 40);
    return v || '未分班';
  }

  /** 「一班_加分记录_2026-11-19.csv」 */
  function fileNameFor(className, ts) {
    return safeFileName(classLabel(className)) + '_加分记录_' + fmtDate(ts) + '.csv';
  }

  /* ---------- CSV ---------- */

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * 生成某个班级的加分记录 CSV 文本（不含 BOM，CRLF 换行）
   * 列：序号 / 班级 / 姓名 / 学号 / 分值 / 该生累计 / 原因 / 操作人 / 时间
   */
  function buildCSV(className, records) {
    var list = (records || []).slice().sort(function (a, b) { return a.t - b.t; });
    var rows = [['序号', '班级', '姓名', '学号', '分值', '该生累计', '原因', '操作人', '时间']];
    var run = Object.create(null);

    list.forEach(function (r, i) {
      var k = keyOf(r.name, r.sid);
      run[k] = round2((run[k] || 0) + (Number(r.delta) || 0));
      rows.push([
        i + 1,
        classLabel(className),
        r.name || '',
        r.sid || '',
        fmtDelta(r.delta),
        fmtNum(run[k]),
        r.reason || '',
        r.op || '',
        fmtDateTime(r.t)
      ]);
    });

    return rows.map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n');
  }

  global.RCScore = {
    MAX_REASON: MAX_REASON,
    MAX_OPERATOR: MAX_OPERATOR,
    MAX_ABS: MAX_ABS,
    classKey: classKey,
    classLabel: classLabel,
    groupsOf: groupsOf,
    hasClasses: hasClasses,
    studentKey: studentKey,
    keyOf: keyOf,
    round2: round2,
    fmtNum: fmtNum,
    fmtDelta: fmtDelta,
    makeId: makeId,
    makeRecords: makeRecords,
    totalOf: totalOf,
    totals: totals,
    statsOf: statsOf,
    sumOf: sumOf,
    ofStudent: ofStudent,
    removeById: removeById,
    removeOfStudent: removeOfStudent,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    safeFileName: safeFileName,
    fileNameFor: fileNameFor,
    buildCSV: buildCSV
  };
})(window);
