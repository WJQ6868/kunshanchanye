/* ============================================================
   perm.ts — 服务端权限模型
   ------------------------------------------------------------
   与前端 js/auth/perm.js 保持一致（同一份 34 条 key、同一套角色
   默认值），但这里是**唯一权威**：前端那套只决定界面显不显示，
   能不能做由这里裁决。

   两层授权（计划书 §5）：
     1. 权限（permission）：能不能做这个动作
     2. 范围（class scope）：对哪些班能做
   两层都过才放行；缺一即 403，并写审计 action='authz.denied'。
   ============================================================ */

export type Role = 'admin' | 'teacher' | 'viewer' | 'local';

export interface PermDef {
  key: string;
  group: string;
  label: string;
  /** 讲师角色默认是否拥有 */
  teacherDefault: boolean;
  /** 仅管理员可拥有，不可授予讲师 */
  adminOnly?: boolean;
  /** 敏感操作，审计里要额外记 details */
  sensitive?: boolean;
}

export const PERMS: PermDef[] = [
  { key: 'auth.change_password', group: '账号', label: '修改自己的密码', teacherDefault: true },
  { key: 'auth.logout', group: '账号', label: '退出登录', teacherDefault: true },

  { key: 'class.enter', group: '班级', label: '进入班级工作台', teacherDefault: true },
  { key: 'class.view_all', group: '班级', label: '查看全部班级（含非任教班级，只读）', teacherDefault: true },
  { key: 'class.create', group: '班级', label: '新建班级', teacherDefault: false },
  { key: 'class.rename', group: '班级', label: '重命名班级', teacherDefault: false },
  { key: 'class.delete', group: '班级', label: '删除班级', teacherDefault: false, sensitive: true },

  { key: 'roster.view', group: '名单', label: '查看学生名单', teacherDefault: true },
  { key: 'roster.import', group: '名单', label: '导入名单', teacherDefault: false },
  { key: 'roster.edit', group: '名单', label: '编辑学生信息', teacherDefault: false },
  { key: 'roster.sync', group: '名单', label: '从教务同步名单', teacherDefault: false },

  { key: 'score.add', group: '加分', label: '加分', teacherDefault: true },
  { key: 'score.subtract', group: '加分', label: '扣分', teacherDefault: true },
  { key: 'score.custom_value', group: '加分', label: '自定义分值', teacherDefault: true },
  { key: 'score.delete_record', group: '加分', label: '删除单条记录', teacherDefault: false, sensitive: true },
  { key: 'score.clear_student', group: '加分', label: '清空某学生记录', teacherDefault: false, sensitive: true },
  { key: 'score.void', group: '加分', label: '撤销操作', teacherDefault: false, sensitive: true },

  { key: 'record.view_class', group: '查询导出', label: '查看本班流水', teacherDefault: true },
  { key: 'record.view_cross_class', group: '查询导出', label: '跨班查看流水', teacherDefault: false },
  { key: 'export.rank', group: '查询导出', label: '导出排行榜', teacherDefault: true },
  { key: 'export.class', group: '查询导出', label: '导出班级表格', teacherDefault: false },
  { key: 'export.student_sheet', group: '查询导出', label: '导出学生明细', teacherDefault: false },
  { key: 'export.school', group: '查询导出', label: '导出全校数据', teacherDefault: false, adminOnly: true },

  { key: 'draw.random', group: '课堂', label: '随机点名', teacherDefault: true },
  { key: 'draw.mode_switch', group: '课堂', label: '切换点名动画', teacherDefault: true },
  { key: 'draw.reset', group: '课堂', label: '重置轮次', teacherDefault: false },
  { key: 'theme.switch', group: '课堂', label: '切换主题', teacherDefault: true },
  /* 讲师也能打开设置做基础调整（字号/音效/主题/快速模式）。
     清空数据那类真正危险的动作另有 settings.wipe 兜着，且只认 wjqcool。 */
  { key: 'settings.open', group: '课堂', label: '打开设置', teacherDefault: true },
  { key: 'settings.wipe', group: '课堂', label: '清空本机数据', teacherDefault: false, adminOnly: true },

  { key: 'user.manage', group: '管理台', label: '人员管理', teacherDefault: false, adminOnly: true },
  { key: 'perm.manage', group: '管理台', label: '权限配置', teacherDefault: false, adminOnly: true },
  { key: 'audit.view', group: '管理台', label: '查看全部审计', teacherDefault: false },
  { key: 'audit.view_self', group: '管理台', label: '查看自己的操作记录', teacherDefault: true },
  { key: 'data.migrate', group: '管理台', label: '数据迁移', teacherDefault: false, adminOnly: true },
];

export const BY_KEY: Record<string, PermDef> = Object.fromEntries(PERMS.map((p) => [p.key, p]));

/**
 * 访客只读白名单。
 * 只保留「看」：看名单、看班级记录、看排行榜、看全部班级、退出登录。
 * 不给 draw.random —— 访客不能触发随机点名（m08570 明确要求）。
 * 不给 class.enter —— 访客不进班级工作台，不点开学生（m08570 明确要求）。
 */
const VIEWER_ALLOW = new Set([
  'roster.view',
  'record.view_class',
  'export.rank',
  'class.view_all',
  'auth.logout',
]);

/** 角色默认权限 */
export function defaultsFor(role: Role): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (role === 'admin' || role === 'local') {
    for (const p of PERMS) out[p.key] = true;
    return out;
  }
  if (role === 'viewer') {
    for (const p of PERMS) out[p.key] = VIEWER_ALLOW.has(p.key);
    return out;
  }
  for (const p of PERMS) out[p.key] = p.teacherDefault;
  return out;
}

/**
 * 实际权限 = 角色默认 ⊕ 覆盖项。
 * 未知 key 忽略（防止脏数据放大权限）；
 * adminOnly 项对非管理员一律忽略（哪怕库里被写成 true）。
 */
export function effective(role: Role, overrides: Record<string, boolean> | null | undefined): Record<string, boolean> {
  const out = defaultsFor(role);
  if (role === 'admin' || role === 'local') return out;
  if (!overrides || typeof overrides !== 'object') return out;
  for (const [k, v] of Object.entries(overrides)) {
    const def = BY_KEY[k];
    if (!def) continue;
    if (def.adminOnly) continue;
    out[k] = !!v;
  }
  return out;
}

export function grouped(): Array<{ group: string; items: PermDef[] }> {
  const order = ['账号', '班级', '名单', '加分', '查询导出', '课堂', '管理台'];
  const map = new Map<string, PermDef[]>();
  for (const p of PERMS) {
    if (!map.has(p.group)) map.set(p.group, []);
    map.get(p.group)!.push(p);
  }
  return order.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  teacher: '讲师',
  viewer: '访客',
  local: '本机用户',
};
