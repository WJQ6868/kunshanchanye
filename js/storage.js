/* ============================================================
   storage.js — 本地持久化（localStorage 封装）
   键位约定：
     rollcall.roster.v1      全部学生名单
     rollcall.history.v1     抽取历史
     rollcall.settings.v1    界面设置
     rollcall.state.v1       本轮已抽（按班级分组）
     rollcall.classes.v1     当前班级
     rollcall.scores.v1.<班级>  该班级的加分记录（每班一个键，互相独立）
   ============================================================ */
(function (global) {
  'use strict';

  var PREFIX = 'rollcall.';

  var KEY = {
    ROSTER: PREFIX + 'roster.v1',
    HISTORY: PREFIX + 'history.v1',
    SETTINGS: PREFIX + 'settings.v1',
    STATE: PREFIX + 'state.v1',
    CLASSES: PREFIX + 'classes.v1',
    SCORES: PREFIX + 'scores.v1.'
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) {
      console.warn('[storage] read failed', key, e);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('[storage] write failed', key, e);
      return false;
    }
  }

  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* ---------- 班级相关的键名 ---------- */

  function scoreKeyOf(className) {
    return KEY.SCORES + encodeURIComponent(String(className == null ? '' : className));
  }

  function decodeScoreKey(k) {
    try { return decodeURIComponent(k.slice(KEY.SCORES.length)); } catch (e) { return ''; }
  }

  /** 自定义期限归一化：只接受 'YYYY-MM-DD'，其余一律当空（不限） */
  function normRange(r) {
    var out = { from: '', to: '' };
    if (!r || typeof r !== 'object') return out;
    ['from', 'to'].forEach(function (k) {
      var v = String(r[k] == null ? '' : r[k]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) out[k] = v;
    });
    return out;
  }

  /** 列出本机存过加分记录的所有班级名 */
  function listScoreClasses() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(KEY.SCORES) === 0) {
          var name = decodeScoreKey(k);
          if (name) out.push(name);
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  var Storage = {
    KEY: KEY,

    read: read,
    write: write,
    remove: remove,

    loadRoster: function () {
      var r = read(KEY.ROSTER, null);
      return Array.isArray(r) ? r : [];
    },
    saveRoster: function (list) {
      return write(KEY.ROSTER, list);
    },

    loadHistory: function () {
      var h = read(KEY.HISTORY, null);
      return Array.isArray(h) ? h : [];
    },
    saveHistory: function (list) {
      // 只保留最近 2000 条，防止无限增长
      var trimmed = list.slice(-2000);
      return write(KEY.HISTORY, trimmed);
    },

    loadSettings: function () {
      return Object.assign({
        anim: 'spotlight',
        theme: 'white',
        fast: false,
        sound: true,
        autoClose: false,
        repeat: false,
        panel: true
      }, read(KEY.SETTINGS, {}));
    },
    saveSettings: function (s) {
      return write(KEY.SETTINGS, s);
    },

    loadState: function () {
      var s = read(KEY.STATE, {});
      if (!s || typeof s !== 'object') s = {};
      var byClass = (s.pickedByClass && typeof s.pickedByClass === 'object') ? s.pickedByClass : {};
      return {
        // picked 是旧版本字段，首次运行时迁移到当前班级
        picked: Array.isArray(s.picked) ? s.picked : [],
        pickedByClass: byClass,
        /* 界面位置：刷新后回到原来的页面（而不是每次都回首页）。
           旧版本没有这些字段，取默认值即可。 */
        view: s.view === 'class' || s.view === 'games' ? s.view : 'home',
        homeTab: s.homeTab === 'classes' ? 'classes' : 'rank',
        stuPeriod: (s.stuPeriod === 'all' || s.stuPeriod === 'custom') ? s.stuPeriod : 'week',
        clsPeriod: (s.clsPeriod === 'week' || s.clsPeriod === 'month' || s.clsPeriod === 'custom')
          ? s.clsPeriod : 'all',
        /* 自定义期限：{from,to} 都是 'YYYY-MM-DD' 字符串，空串表示该端不限 */
        stuRange: normRange(s.stuRange),
        clsRange: normRange(s.clsRange)
      };
    },
    saveState: function (s) {
      return write(KEY.STATE, s);
    },

    /* ---------- 班级 ---------- */

    /**
     * 班级元数据 + 当前班级
     * 结构：{ current: String, list: [{name, createdAt}] }
     * 旧版本只有 { current }，list 缺失时由 RCClasses.ensure 从名单补齐。
     */
    loadClasses: function () {
      var c = read(KEY.CLASSES, {});
      if (!c || typeof c !== 'object') c = {};
      var list = [];
      if (Array.isArray(c.list)) {
        list = c.list.filter(function (x) {
          return x && typeof x.name === 'string';
        }).map(function (x) {
          return { name: x.name, createdAt: Number(x.createdAt) || 0 };
        });
      }
      return {
        current: (typeof c.current === 'string') ? c.current : '',
        list: list
      };
    },
    saveClasses: function (c) {
      var list = (c && Array.isArray(c.list)) ? c.list : [];
      return write(KEY.CLASSES, {
        current: (c && c.current) || '',
        list: list
      });
    },

    /* ---------- 加分记录（按班级独立存放） ---------- */

    scoreKeyOf: scoreKeyOf,
    listScoreClasses: listScoreClasses,

    loadScores: function (className) {
      var d = read(scoreKeyOf(className), null);
      if (!d || !Array.isArray(d.records)) return { records: [], updatedAt: 0 };
      return { records: d.records, updatedAt: d.updatedAt || 0 };
    },
    saveScores: function (className, records) {
      return write(scoreKeyOf(className), {
        records: Array.isArray(records) ? records : [],
        updatedAt: Date.now()
      });
    },
    removeScores: function (className) {
      remove(scoreKeyOf(className));
    },

    wipe: function () {
      remove(KEY.ROSTER);
      remove(KEY.HISTORY);
      remove(KEY.STATE);
      remove(KEY.CLASSES);
      listScoreClasses().forEach(function (name) {
        remove(scoreKeyOf(name));
      });
    }
  };

  global.RCStorage = Storage;
})(window);
