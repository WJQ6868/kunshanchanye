/* ============================================================
   perm.js —— 权限点定义与角色默认值
   ------------------------------------------------------------
   对应 docs/项目计划书 §8「角色权限矩阵」与 §8.9「权限 key」。

   设计要点（都来自计划书，改动前先回看那一节）：
   1) 权限点是「功能点」，不是「页面」。一个按钮一个 key。
   2) 三态：默认开 / 默认关 / 不可授予。讲师默认只开「上课必需」的几项。
   3) 管理员的权限不走这张表——管理员恒为全开，避免「管理员把自己锁死」。
   4) 讲师的实际权限 = 角色默认值 ⊕ 管理员逐项开关（granted 覆盖）。
   5) 班级范围是另一层：权限决定「能不能做这个动作」，
      classScopes 决定「对哪些班能做」。两层都过才放行。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 权限点 ---------- */

  // g: 分组；d: 讲师默认值；n: 不可授予讲师（管理员专属）；s: 敏感（二次确认）
  var PERMS = [
    /* A 账号 */
    { key: 'auth.change_password', g: '账号', label: '修改自己的密码', d: true },
    { key: 'auth.logout', g: '账号', label: '退出登录', d: true },

    /* B 班级 */
    { key: 'class.enter', g: '班级', label: '进入班级工作台', d: true },
    { key: 'class.view_all', g: '班级', label: '查看全部班级（含非任教班级，只读）', d: true },
    { key: 'class.create', g: '班级', label: '新建班级', d: false },
    { key: 'class.rename', g: '班级', label: '重命名班级', d: false },
    { key: 'class.delete', g: '班级', label: '删除班级', d: false, s: true },

    /* C 名单 */
    { key: 'roster.view', g: '名单', label: '查看班级名单', d: true },
    { key: 'roster.import', g: '名单', label: '导入名单（表格）', d: false },
    { key: 'roster.edit', g: '名单', label: '增删改学生', d: false },
    { key: 'roster.sync', g: '名单', label: '从教务同步名单', d: false },

    /* D 加分 */
    { key: 'score.add', g: '加分', label: '加分', d: true },
    { key: 'score.subtract', g: '加分', label: '扣分', d: true },
    { key: 'score.custom_value', g: '加分', label: '自定义分值（非预设按钮）', d: true },
    { key: 'score.delete_record', g: '加分', label: '删除单条加分记录', d: false, s: true },
    { key: 'score.clear_student', g: '加分', label: '清空某个学生的全部记录', d: false, s: true },
    { key: 'score.void', g: '加分', label: '撤销已提交的记录（冲正）', d: false, s: true },

    /* E 查询与导出 */
    { key: 'record.view_class', g: '查询导出', label: '查看本班加分流水', d: true },
    { key: 'record.view_cross_class', g: '查询导出', label: '查看其他班级的流水', d: false },
    { key: 'export.rank', g: '查询导出', label: '导出排行榜', d: true },
    { key: 'export.class', g: '查询导出', label: '导出本班学生明细', d: false },
    { key: 'export.student_sheet', g: '查询导出', label: '导出全校加分总表', d: false },
    { key: 'export.school', g: '查询导出', label: '导出全校汇总（含跨班）', d: false, n: true },

    /* F 课堂 */
    { key: 'draw.random', g: '课堂', label: '随机点名', d: true },
    { key: 'draw.mode_switch', g: '课堂', label: '切换点名动画', d: true },
    { key: 'draw.reset', g: '课堂', label: '重置本轮抽取', d: false },
    { key: 'theme.switch', g: '课堂', label: '切换主题', d: true },
    /* 讲师也能打开设置做基础调整（字号/音效/主题/快速模式）。
       清空数据那类真正危险的动作另有 settings.wipe 兜着，且只认 wjqcool。 */
    { key: 'settings.open', g: '课堂', label: '打开设置', d: true },
    { key: 'settings.wipe', g: '课堂', label: '清空本机数据', d: false, n: true },

    /* G 管理台 */
    { key: 'user.manage', g: '管理台', label: '人员管理（增删改账号）', d: false, n: true },
    { key: 'perm.manage', g: '管理台', label: '配置讲师权限', d: false, n: true },
    { key: 'audit.view', g: '管理台', label: '查看全量操作日志', d: false },
    { key: 'audit.view_self', g: '管理台', label: '查看自己的操作记录', d: true },
    { key: 'data.migrate', g: '管理台', label: '数据迁移与导入导出', d: false, n: true }
  ];

  var BY_KEY = {};
  PERMS.forEach(function (p) { BY_KEY[p.key] = p; });

  /* ---------- 角色 ---------- */

  var ROLES = {
    admin: { key: 'admin', label: '管理员', desc: '全部功能，可管理讲师与权限' },
    teacher: { key: 'teacher', label: '讲师', desc: '只能给任教班级加减分，其余按管理员授权' },
    viewer: { key: 'viewer', label: '访客', desc: '只读，用于大屏展示' },
    local: { key: 'local', label: '本机用户', desc: '本地模式，数据只在这台电脑' }
  };

  /* ---------- 计算有效权限 ---------- */

  /**
   * 角色默认权限表。
   * @param {String} role
   * @returns {Object} {permKey: true/false}
   */
  function defaultsFor(role) {
    var out = {};
    if (role === 'admin' || role === 'local') {
      PERMS.forEach(function (p) { out[p.key] = true; });
      return out;
    }
    PERMS.forEach(function (p) {
      if (role === 'viewer') {
        // 访客：纯只读，只在首页看班级列表/总分/前三名/排行榜。
        // 不给随机点名（draw.random）、不给进入工作台（class.enter），也不给任何写操作
        out[p.key] = /^(roster\.view|record\.view_class|export\.rank|auth\.logout|class\.view_all)$/.test(p.key);
        return;
      }
      out[p.key] = !!p.d;
    });
    return out;
  }

  /**
   * 合并角色默认值与管理员逐项覆盖。
   * @param {String} role
   * @param {Object} overrides {permKey: bool} 管理员逐项开关
   */
  function effective(role, overrides) {
    var out = defaultsFor(role);
    if (overrides && typeof overrides === 'object') {
      Object.keys(overrides).forEach(function (k) {
        if (!BY_KEY[k]) return;                       // 未知 key 忽略，防止脏数据放大权限
        if (BY_KEY[k].n && role !== 'admin') return;  // 不可授予项，讲师一律忽略
        out[k] = !!overrides[k];
      });
    }
    return out;
  }

  /** 管理员专属项（不可授予讲师） */
  function isAdminOnly(key) {
    return !!(BY_KEY[key] && BY_KEY[key].n);
  }

  /** 分组后的权限点，给权限配置界面用 */
  function grouped() {
    var order = ['账号', '班级', '名单', '加分', '查询导出', '课堂', '管理台'];
    var map = {};
    PERMS.forEach(function (p) {
      (map[p.g] || (map[p.g] = [])).push(p);
    });
    return order.filter(function (g) { return map[g]; }).map(function (g) {
      return { group: g, items: map[g] };
    });
  }

  global.RCPerm = {
    PERMS: PERMS,
    BY_KEY: BY_KEY,
    ROLES: ROLES,
    defaultsFor: defaultsFor,
    effective: effective,
    isAdminOnly: isAdminOnly,
    grouped: grouped
  };
})(window);
