/* ============================================================
   adapter-interface.js — 数据源适配器契约（P1 基座）
   ------------------------------------------------------------
   设计要点（见 docs/项目计划书 §5、§10.7）：
   1. 前端只有一套 UI，读写数据一律经过 RCData 门面，不直接碰
      localStorage，也不直接 fetch。
   2. 读操作是「同步」的：从内存缓存取（RCData.cache），这样
      2454 行的 app.js 不用改成 async，课堂交互零延迟。
   3. 写操作是「同步写缓存 + 异步落盘」：本地模式立刻写
      localStorage；远程模式立刻入离线队列再补传，失败不丢。
   4. 适配器必须实现下面 CONTRACT 列出的全部方法，缺失即报错
      （fail fast，避免"看起来能跑但少同步了一个键"）。

   契约方法一览（★=必须同步返回）：
     ★ mode                  'local' | 'remote'
     ★ me()                  {user, permissions[], classScopes[]} | null
     ★ getRoster()           Student[]
     ★ getClasses()          {current, list}
     ★ getScores(cls)        {records[], updatedAt}
     ★ getSettings()         {}
     ★ getState()            {pickedByClass, picked}
     ★ getHistory()          []
     ★ listScoreClasses()    string[]
     ★ setRoster(list)
     ★ setClasses(c)
     ★ setScores(cls, recs)
     ★ setSettings(s)
     ★ setState(s)
     ★ setHistory(list)
     ★ removeScores(cls)
     ★ wipe()
       init(opts)            Promise<{mode, reason}>
       flush()               Promise<{sent, failed}>
       onModeChange(cb)      订阅模式切换
       dispose()             释放监听
   ============================================================ */
(function (global) {
  'use strict';

  /** 契约要求同步实现的成员 */
  var REQUIRED_SYNC = [
    'me',
    'getRoster', 'getClasses', 'getScores', 'getSettings', 'getState',
    'getHistory', 'listScoreClasses',
    'setRoster', 'setClasses', 'setScores', 'setSettings', 'setState',
    'setHistory', 'removeScores', 'wipe'
  ];

  /** 契约要求异步实现的成员 */
  var REQUIRED_ASYNC = ['init', 'flush', 'onModeChange', 'dispose'];

  /** 校验一个适配器对象是否完整实现契约 */
  function validate(name, adapter) {
    var missing = [];
    REQUIRED_SYNC.concat(REQUIRED_ASYNC).forEach(function (k) {
      if (!adapter || typeof adapter[k] !== 'function') missing.push(k);
    });
    if (!adapter || (adapter.mode !== 'local' && adapter.mode !== 'remote')) {
      missing.push('mode(必须为 local|remote)');
    }
    if (missing.length) {
      throw new Error('[RCData] 适配器 "' + name + '" 未实现契约：' + missing.join(', '));
    }
    return adapter;
  }

  /* ---------- 深拷贝：缓存与调用方隔离，防止外部改引用 ---------- */

  function clone(v) {
    if (v == null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }

  /**
   * 加分记录数组的专用拷贝。
   *
   * 为什么不直接用 clone：加分记录是**扁平对象**（id/t/name/sid/delta/reason/op），
   * 走 JSON 往返要序列化再解析整个数组。8 万条记录实测 105~120ms/次，而一帧里
   * 界面刷新会调 loadScores 好几次（卡片分数、日志面板、统计条、班级汇总、首页），
   * 200 人的班级每次加分就卡 1.5 秒（性能测试 P1-1）。
   * 换成逐条 Object.assign 只要 17~35ms（快 3~6 倍），语义完全一样：
   * 调用方拿到的仍是新数组 + 新对象，改它不会污染缓存。
   *
   * 注意：这里只适用于「值全是基本类型」的扁平对象。嵌套对象请继续用 clone。
   * （实测 for-in + hasOwnProperty 反而更慢，别换成那种写法。）
   */
  function cloneRecords(list) {
    if (!Array.isArray(list)) return [];
    var out = new Array(list.length);
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      out[i] = (r == null || typeof r !== 'object') ? r : Object.assign({}, r);
    }
    return out;
  }

  /* ---------- 学生唯一键（与 scores.js / picker.js 保持一致） ---------- */

  function studentKey(s) {
    return (s && s.name ? String(s.name) : '') + '\u0000' + (s && s.id ? String(s.id) : '');
  }

  /* ---------- 时间与格式化（远程模式需要 ISO 时间） ---------- */

  function nowISO() {
    return new Date().toISOString();
  }

  /* ---------- 幂等键：离线补传靠它去重 ---------- */

  function newRequestId() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    var b = new Uint8Array(16);
    try {
      if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
      else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    } catch (e2) {
      for (var j = 0; j < 16; j++) b[j] = Math.floor(Math.random() * 256);
    }
    var hex = '';
    for (var k = 0; k < 16; k++) hex += (b[k] + 0x100).toString(16).slice(1);
    return hex;
  }

  global.RCDataContract = {
    REQUIRED_SYNC: REQUIRED_SYNC,
    REQUIRED_ASYNC: REQUIRED_ASYNC,
    validate: validate,
    clone: clone,
    cloneRecords: cloneRecords,
    studentKey: studentKey,
    nowISO: nowISO,
    newRequestId: newRequestId
  };
})(window);
