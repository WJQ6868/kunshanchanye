/**
 * 把旧项目的 styles.css 机械转换成「只作用于小游戏页」的样式表。
 *
 * 为什么要转换：旧项目是一整站（body/html/hero/library 全站样式 + 橙色令牌），
 * 直接塞进 rollcall 会污染全局（body 背景、.btn、.stage 等）。这里把每条选择器
 * 都加上 `#screenGames` 前缀，把设计令牌重新映射到 rollcall 的白蓝令牌上，
 * 全局选择器（html、body、通配符、::selection 等）直接丢弃——rollcall 已经有了。
 *
 * 用法：node rollcall/tools/scope-games-css.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = 'C:/Users/wangj/Documents/Trae-CN/default/课堂破冰游戏/styles.css';
const OUT = path.join(ROOT, 'css/games.css');
const SCOPE = '#screenGames';

const raw = fs.readFileSync(SRC, 'utf8');

/* ---------- 1. 粗粒度切块：顶层 rule / @keyframes / @media ---------- */
function splitTopLevel(css) {
  const out = [];
  let i = 0;
  let buf = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      buf += css.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '{') {
      // 找到匹配的 }
      let depth = 0;
      let j = i;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
      }
      buf += css.slice(i, j + 1);
      out.push(buf.trim());
      buf = '';
      i = j + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const DROP_SELECTORS = new Set([
  '*,*::before,*::after',
  'html',
  'body',
  'body.lock',
  'h1,h2,h3,h4,p,ul,ol,dl,dd',
  'ul,ol',
  'button,input,textarea,select',
  'button',
  'a',
  '[hidden]',
  'input[type=number]',
  'input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button',
  '::selection',
  ':focus-visible',
]);

function scopeSelectorList(list) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !DROP_SELECTORS.has(s.replace(/\s+/g, '')))
    .filter((s) => !isDropped(s))
    .map((s) => `${SCOPE} ${s}`)
    .join(',');
}

/**
 * 旧项目整站页面的样式（hero、图书馆列表、筛选条、入场动画……）在新项目里
 * 由我们自己的页面骨架替代，这些规则既不生效也徒增体积与串味风险，整块丢弃。
 * 只保留「舞台 + 抽屉 + 各游戏渲染器」真正要用的部分。
 */
const DROP_PREFIXES = [
  '.hero', '.anim-', '.how', '.sec-head', '.tips', '.tip-no', '.materials',
  '.library', '.filter-', '.cat', '.game-list', '.game-row', '.row-',
  '.kicker', '.eyebrow', '.wrap', '.rules-', '.mats', '.tips-list',
];

function isDropped(sel) {
  // 取复合选择器的第一个类名做判断
  const first = sel.split(/[\s>+~]/)[0];
  return DROP_PREFIXES.some((p) => first === p || first.startsWith(p));
}

function transform(css) {
  const blocks = splitTopLevel(css);
  const out = [];
  for (const b of blocks) {
    const open = b.indexOf('{');
    if (open < 0) { out.push(b); continue; }
    const rawHead = b.slice(0, open);
    // 把选择器前面的注释摘出来，只拿真正的选择器做判断
    const comments = rawHead.match(/\/\*[\s\S]*?\*\//g) || [];
    const head = rawHead.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = b.slice(open + 1, b.lastIndexOf('}'));
    const pre = comments.length ? comments.join('\n') + '\n' : '';

    if (/^@keyframes/.test(head)) { out.push(pre + b.slice(b.indexOf(head))); continue; }
    if (/^@media/.test(head)) {
      out.push(`${pre}${head}{\n${transform(body)}\n}`);
      continue;
    }
    if (/^:root/.test(head)) continue; // 令牌单独重写

    const sel = scopeSelectorList(head);
    if (!sel) continue;
    out.push(`${pre}${sel}{${body}}`);
  }
  return out.join('\n');
}

const scoped = transform(raw);

/* ---------- 2. 令牌重新映射到 rollcall 白蓝主题 ---------- */
const tokens = `/* ============================================================
   games.css — 课堂小游戏页样式（由 tools/scope-games-css.mjs 生成后手工补充）
   ------------------------------------------------------------
   所有规则都限定在 #screenGames 之内，避免污染主应用的全局样式。
   颜色令牌全部换成 rollcall 的白蓝体系，深色主题自动跟随。
   ============================================================ */

/* 旧项目的橙色纸张令牌 → rollcall 白蓝令牌 */
${SCOPE} {
  --paper: var(--bg-0);
  --paper-2: var(--bg-2);
  --paper-3: var(--bg-3);
  --ink: var(--text);
  --ink-soft: var(--text-dim);
  --muted: var(--text-mute, #64748b);
  --line: var(--line);
  --line-strong: var(--line-strong);
  --accent: var(--accent);
  --accent-deep: var(--accent-2);
  --accent-soft: var(--accent-soft);
  --gold: var(--warn);
  --ok: var(--ok-text, #0b6b4a);
  --ok-soft: var(--accent-soft);
  --bad: var(--danger);
  --bad-soft: #fde8e8;
  --sans: inherit;
  --serif: inherit;
  --ease: var(--ease-out);
  --shadow: var(--shadow-md);
  color: var(--text);
  font-family: inherit;
}
`;

/* ---------- 3. 只在深色主题下需要覆盖的地方 ---------- */
const darkOverrides = `
/* ============================ 深色主题适配 ============================ */
/* 旧项目是浅色纸张底，深色主题下纸张令牌要反过来 */
html[data-theme="gold"] ${SCOPE},
html[data-theme="blue"] ${SCOPE} {
  --bad-soft: rgba(220, 38, 38, .16);
  --shadow: 0 24px 60px rgba(0, 0, 0, .5);
}

html[data-theme="gold"] ${SCOPE} .projection,
html[data-theme="blue"] ${SCOPE} .projection {
  background: var(--bg-1);
  color: var(--text);
}

html[data-theme="gold"] ${SCOPE} .sheet-panel,
html[data-theme="blue"] ${SCOPE} .sheet-panel {
  background: var(--bg-1);
  color: var(--text);
}
`;

fs.writeFileSync(OUT, tokens + '\n' + scoped + '\n' + darkOverrides, 'utf8');
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
