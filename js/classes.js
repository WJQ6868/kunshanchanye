/* ============================================================
   classes.js — 班级域模型（纯逻辑，不碰 DOM）
   ------------------------------------------------------------
   班级不再只是「名单里的 group 字段」，而是有独立元数据的一等对象：
   可以先建空班级、可以重命名、可以删除，首页按元数据顺序排列。

   班级元数据：[{name, createdAt}]
     name      '' 表示「未分班」（只由导入产生，不能手工新建）
     createdAt 创建时间戳（首页排序依据）
   统计全部由「名单 + 该班加分记录」现算，不落冗余字段。
   ============================================================ */

(function (global) {
  'use strict';

  var MAX_NAME = 20;   // 班级名最长字符

  /** 规范化班级名：折叠空白、去首尾、截断 */
  function normName(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  /** 学生所属班级键（''=未分班），与 RCScore.classKey 同构 */
  function classKeyOf(s) {
    return (s && s.group) ? String(s.group).trim() : '';
  }

  /**
   * 补全班级元数据：保留已有顺序，把名单里出现但元数据缺失的班级追加到末尾。
   * 这样旧版本（只有 roster 没有 classes.list）也能无损升级。
   */
  function ensure(list, roster) {
    var out = [];
    var seen = Object.create(null);

    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c || typeof c.name !== 'string') return;
      var name = normName(c.name);
      // 名字被规范化后变空、但原值非空 → 说明是纯空白，丢弃
      if (name === '' && c.name !== '') return;
      if (seen[name]) return;
      seen[name] = 1;
      out.push({ name: name, createdAt: Number(c.createdAt) || Date.now() });
    });

    var order = [];
    var has = Object.create(null);
    (roster || []).forEach(function (s) {
      var k = classKeyOf(s);
      if (!has[k]) { has[k] = 1; order.push(k); }
    });
    order.forEach(function (k) {
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ name: k, createdAt: Date.now() });
    });

    return out;
  }

  function has(list, name) {
    var n = String(name == null ? '' : name);
    return (list || []).some(function (c) { return c.name === n; });
  }

  /** 新建班级（返回新数组；重名或空名返回 null） */
  function add(list, name) {
    var n = normName(name);
    if (!n) return null;
    if (has(list, n)) return null;
    return (list || []).concat([{ name: n, createdAt: Date.now() }]);
  }

  /** 重命名（返回新数组；非法或重名返回 null） */
  function rename(list, from, to) {
    var n = normName(to);
    if (!n || n === from) return null;
    if (has(list, n)) return null;
    return (list || []).map(function (c) {
      return c.name === from ? { name: n, createdAt: c.createdAt } : c;
    });
  }

  function remove(list, name) {
    return (list || []).filter(function (c) { return c.name !== name; });
  }

  /** 某个班的学生（保持名单顺序） */
  function studentsOf(name, roster) {
    var n = String(name == null ? '' : name);
    return (roster || []).filter(function (s) { return classKeyOf(s) === n; });
  }

  /**
   * 班级统计：人数 / 总分 / 平均分 / 最近一次加分时间 / 记录条数
   * @param {String} name 班级名
   * @param {Array} roster 全部学生
   * @param {Array} records 该班的加分记录
   */
  function statsOf(name, roster, records) {
    var key = String(name == null ? '' : name);
    var count = 0;
    (roster || []).forEach(function (s) {
      if (classKeyOf(s) === key) count++;
    });

    var recs = records || [];
    var total = 0;
    var last = 0;
    recs.forEach(function (r) {
      total += Number(r.delta) || 0;
      var t = Number(r.t) || 0;
      if (t > last) last = t;
    });

    total = Math.round(total * 100) / 100;
    return {
      count: count,
      total: total,
      avg: count ? Math.round(total / count * 100) / 100 : 0,
      last: last,
      records: recs.length
    };
  }

  global.RCClasses = {
    MAX_NAME: MAX_NAME,
    normName: normName,
    classKeyOf: classKeyOf,
    ensure: ensure,
    has: has,
    add: add,
    rename: rename,
    remove: remove,
    studentsOf: studentsOf,
    statsOf: statsOf
  };
})(window);
