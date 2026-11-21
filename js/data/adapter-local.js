/* ============================================================
   adapter-local.js — 本地模式适配器（localStorage）
   ------------------------------------------------------------
   行为与现有版本完全一致：数据只在本机，无账号、无权限、无网络。
   与旧版唯一区别：读写都经过内存缓存，UI 拿到的是副本，
   外部改动缓存不会污染 localStorage 里的原始对象。
   ============================================================ */
(function (global) {
  'use strict';

  var C = global.RCDataContract;
  var clone = C.clone;

  function createLocalAdapter() {
    /* 缓存：null 表示尚未加载 */
    var cache = {
      roster: null,
      classes: null,
      scores: Object.create(null),
      settings: null,
      state: null,
      history: null
    };

    var listeners = [];

    function emit(evt) {
      listeners.forEach(function (cb) {
        try { cb(evt); } catch (e) { console.warn('[RCData.local] listener failed', e); }
      });
    }

    /* ---------- 读 ---------- */

    function getRoster() {
      if (cache.roster === null) cache.roster = global.RCStorage.loadRoster();
      return clone(cache.roster);
    }

    function getClasses() {
      if (cache.classes === null) cache.classes = global.RCStorage.loadClasses();
      return clone(cache.classes);
    }

    function getScores(className) {
      var k = String(className == null ? '' : className);
      if (!cache.scores[k]) cache.scores[k] = global.RCStorage.loadScores(k);
      return clone(cache.scores[k]);
    }

    function getSettings() {
      if (cache.settings === null) cache.settings = global.RCStorage.loadSettings();
      return clone(cache.settings);
    }

    function getState() {
      if (cache.state === null) cache.state = global.RCStorage.loadState();
      return clone(cache.state);
    }

    function getHistory() {
      if (cache.history === null) cache.history = global.RCStorage.loadHistory();
      return clone(cache.history);
    }

    function listScoreClasses() {
      return global.RCStorage.listScoreClasses();
    }

    /* ---------- 写（同步写缓存 + 同步落盘，本地模式没有"稍后"） ---------- */

    function setRoster(list) {
      cache.roster = Array.isArray(list) ? clone(list) : [];
      global.RCStorage.saveRoster(cache.roster);
      emit({ type: 'roster' });
      return true;
    }

    function setClasses(c) {
      cache.classes = {
        current: (c && c.current) || '',
        list: (c && Array.isArray(c.list)) ? clone(c.list) : []
      };
      global.RCStorage.saveClasses(cache.classes);
      emit({ type: 'classes' });
      return true;
    }

    function setScores(className, records) {
      var k = String(className == null ? '' : className);
      var recs = Array.isArray(records) ? clone(records) : [];
      cache.scores[k] = { records: recs, updatedAt: Date.now() };
      global.RCStorage.saveScores(k, recs);
      emit({ type: 'scores', cls: k });
      return true;
    }

    function setSettings(s) {
      cache.settings = clone(s) || {};
      global.RCStorage.saveSettings(cache.settings);
      emit({ type: 'settings' });
      return true;
    }

    function setState(s) {
      cache.state = clone(s) || {};
      global.RCStorage.saveState(cache.state);
      emit({ type: 'state' });
      return true;
    }

    function setHistory(list) {
      cache.history = Array.isArray(list) ? clone(list) : [];
      global.RCStorage.saveHistory(cache.history);
      emit({ type: 'history' });
      return true;
    }

    function removeScores(className) {
      var k = String(className == null ? '' : className);
      delete cache.scores[k];
      global.RCStorage.removeScores(k);
      emit({ type: 'scores', cls: k, removed: true });
      return true;
    }

    function wipe() {
      cache.roster = [];
      cache.classes = { current: '', list: [] };
      cache.scores = Object.create(null);
      cache.settings = null;
      cache.state = { picked: [], pickedByClass: {} };
      cache.history = [];
      global.RCStorage.wipe();
      emit({ type: 'wipe' });
      return true;
    }

    /* ---------- 身份：本地模式没有账号 ---------- */

    function me() {
      return {
        user: { id: 'local', displayName: '本机用户', role: 'local' },
        permissions: ['*'],
        classScopes: null,
        offline: true
      };
    }

    /* ---------- 生命周期 ---------- */

    function init() {
      // 预热：把现有数据读进缓存，顺便暴露统计给调试
      getRoster();
      getClasses();
      getSettings();
      getState();
      getHistory();
      return Promise.resolve({
        mode: 'local',
        reason: 'localStorage 本地模式（数据仅在本机浏览器）'
      });
    }

    function flush() {
      return Promise.resolve({ sent: 0, failed: 0 });
    }

    function onModeChange(cb) {
      if (typeof cb === 'function') listeners.push(cb);
    }

    function dispose() {
      listeners.length = 0;
      cache.roster = null;
      cache.classes = null;
      cache.scores = Object.create(null);
      cache.settings = null;
      cache.state = null;
      cache.history = null;
    }

    return {
      mode: 'local',
      me: me,
      getRoster: getRoster,
      getClasses: getClasses,
      getScores: getScores,
      getSettings: getSettings,
      getState: getState,
      getHistory: getHistory,
      listScoreClasses: listScoreClasses,
      setRoster: setRoster,
      setClasses: setClasses,
      setScores: setScores,
      setSettings: setSettings,
      setState: setState,
      setHistory: setHistory,
      removeScores: removeScores,
      wipe: wipe,
      init: init,
      flush: flush,
      onModeChange: onModeChange,
      dispose: dispose
    };
  }

  global.RCDataLocal = { create: createLocalAdapter };
})(window);
