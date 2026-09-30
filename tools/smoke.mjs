#!/usr/bin/env node
/**
 * Git Browser 冒烟测试
 *
 * 用法:
 *   node tools/smoke.mjs [--base http://127.0.0.1:8787] [--mutate] [--repo <path>]
 *
 * --mutate  允许在仓库工作区临时创建/删除一个文件，用来验证 SSE 实时推送
 * --repo    指定要校验的前端静态资源所在目录（默认：脚本上级目录）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../public/lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const BASE = argVal('--base', process.env.BASE || 'http://127.0.0.1:8787');
const MUTATE = argv.includes('--mutate');
const REPO_HINT = argVal('--repo', '');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getJSON(p, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${p}${q ? `?${q}` : ''}`, { cache: 'no-store' });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/* --------------------------- 主题检查 --------------------------- */

/** 把 styles.css 拍平成 [选择器, 声明块] 列表（本项目没有嵌套规则） */
function parseCssBlocks(css) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    blocks.push({ selector: m[1].trim(), body: m[2] });
  }
  return blocks;
}

function tokensOf(css, selectorMatch) {
  const tokens = new Map();
  for (const b of parseCssBlocks(css)) {
    if (!selectorMatch(b.selector)) continue;
    for (const decl of b.body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      if (name.startsWith('--')) tokens.set(name, decl.slice(i + 1).trim());
    }
  }
  return tokens;
}

function parseColor(value) {
  const v = String(value ?? '').trim();
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  return null;
}

/** 半透明色叠在底色上的实际观感色 */
function composite(value, baseValue) {
  const c = parseColor(value);
  const b = parseColor(baseValue) || { r: 255, g: 255, b: 255, a: 1 };
  if (!c) return null;
  const mix = (x, y) => Math.round(x * c.a + y * (1 - c.a));
  return `#${[mix(c.r, b.r), mix(c.g, b.g), mix(c.b, b.b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(value) {
  const c = parseColor(value);
  return c ? [c.r, c.g, c.b] : null;
}

function relLuminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(fg, bg) {
  const a = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!a || !b) return null;
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function themeChecks() {
  console.log('\n[5] 主题（浅色/深色）');
  const rawCss = fs.readFileSync(path.join(APP_DIR, 'public', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(APP_DIR, 'public', 'index.html'), 'utf8');

  // 注释会让选择器解析错位，先去注释再拍平
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const dark = tokensOf(css, (s) => s === ':root');
  const light = tokensOf(css, (s) => s.includes('data-theme="light"'));

  check('存在深色令牌块 :root', dark.size > 20, `tokens=${dark.size}`);
  check('存在浅色令牌块 [data-theme="light"]', light.size > 20, `tokens=${light.size}`);

  // 1) 浅色必须覆盖深色的每一个颜色令牌（否则会继承深色值 —— 浅色模式下必然穿帮）
  const shared = new Set(['--mono']);
  const missing = [...dark.keys()].filter((k) => !shared.has(k) && !light.has(k));
  check('浅色覆盖了全部颜色令牌（无继承深色值）', missing.length === 0, missing.join(', '));
  const extra = [...light.keys()].filter((k) => !dark.has(k));
  check('浅色没有定义深色里不存在的令牌', extra.length === 0, extra.join(', '));

  // 2) 所有 var(--x) 引用都必须在深色块里有定义
  const referenced = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const undefinedTokens = [...referenced].filter((t) => !dark.has(t));
  check('CSS 里引用的令牌全部有定义', undefinedTokens.length === 0, undefinedTokens.join(', '));

  // 3) 组件样式里不应再有写死的颜色（令牌块本身除外）
  const componentCss = css.replace(/:root(\[[^\]]*\])?\s*\{[^}]*\}/g, '');
  const strayHex = [...componentCss.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
  check('组件样式里没有写死的颜色（全部走令牌）', strayHex.length === 0, strayHex.join(', '));

  // 4) 对比度：正文/次要文字/diff 增删/chip 文字都要达标
  const pairs = [
    ['正文 fg / bg', '--fg', '--bg', 4.5],
    ['次要文字 fg-dim / bg-2', '--fg-dim', '--bg-2', 4.5],
    ['弱化文字 fg-mute / bg', '--fg-mute', '--bg', 3],
    ['链接 accent / bg', '--accent', '--bg', 4.5],
    ['新增行文字 / 新增行底色', '--diff-add-fg', '--diff-add-bg', 4.5],
    ['删除行文字 / 删除行底色', '--diff-del-fg', '--diff-del-bg', 4.5],
    ['hunk 头文字 / 底色', '--diff-hunk-fg', '--diff-hunk-bg', 4.5],
    ['分支 chip 文字 / 底色', '--chip-branch-fg', '--chip-branch-bg', 4.5],
    ['警告 chip 文字 / 底色', '--chip-warn-fg', '--chip-warn-bg', 4.5],
    ['错误横幅文字 / 底色', '--banner-err-fg', '--banner-err-bg', 4.5],
  ];
  for (const [, themeName, tokens] of [
    ['dark', '深色', dark],
    ['light', '浅色', light],
  ]) {
    const bad = [];
    for (const [label, fgTok, bgTok, min] of pairs) {
      const base = tokens.get('--bg');
      const ratio = contrastRatio(composite(tokens.get(fgTok), base), composite(tokens.get(bgTok), base));
      if (ratio === null) bad.push(`${label}(无法解析)`);
      else if (ratio < min) bad.push(`${label}=${ratio.toFixed(2)}<${min}`);
    }
    check(`${themeName}模式文字对比度全部达标`, bad.length === 0, bad.join('; '));
  }

  // 5) 泳道颜色：两种主题都要有 8 条且互不相同
  for (const [name, tokens] of [['深色', dark], ['浅色', light]]) {
    const lanes = Array.from({ length: 8 }, (_, i) => tokens.get(`--lane-${i}`));
    check(`${name}模式定义了 8 条泳道颜色且互不重复`, lanes.every(Boolean) && new Set(lanes).size === 8, lanes.join(','));
  }

  // 6) 首屏主题落地：内联脚本必须在 <link rel=stylesheet> 之前设置 data-theme
  const scriptIdx = html.indexOf("dataset.theme");
  const linkIdx = html.indexOf('href="/styles.css"');
  check('主题在首屏样式前应用（无闪烁）', scriptIdx > 0 && linkIdx > scriptIdx, `script@${scriptIdx} link@${linkIdx}`);
  check('切换按钮 #btn-theme 存在', /id="btn-theme"/.test(html));
  check('帮助里包含 t 快捷键', /<kbd>t<\/kbd>/.test(html));
}

/* --------------------------- 纯函数单元测试 --------------------------- */

const SAMPLE_PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = "<script>alert(1)</script>";',
  'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"',
  'new file mode 100644',
  '--- /dev/null',
  '+++ "b/\\344\\270\\255.txt"',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
].join('\n');

function libChecks() {
  console.log('\n[0] 纯函数单元测试 (public/lib.js)');

  // HTML 转义 —— diff 内容全部来自仓库，必须防注入
  check('esc 转义尖括号与引号', lib.esc('<img src=x onerror="a">') === '&lt;img src=x onerror=&quot;a&quot;&gt;');
  check('esc 处理 null/undefined', lib.esc(null) === '' && lib.esc(undefined) === '');

  const rows = lib.renderDiffRows(SAMPLE_PATCH);
  check('diff 渲染包含色块行', rows.includes('dl add') && rows.includes('dl del') && rows.includes('dl hunk'));
  check('diff 内容中的脚本标签被转义', rows.includes('&lt;script&gt;') && !rows.includes('<script>'));

  // 行号：@@ -1,3 +1,4 @@ 之后依次是 ctx(1,1) / del(old 2) / add(new 2) / add(new 3)
  const ln = [...rows.matchAll(/<span class="ln">(\s*\d*)<\/span><span class="ln">(\s*\d*)<\/span>/g)].map((m) => [m[1].trim(), m[2].trim()]);
  check('hunk 头之后上下文行行号为 (1,1)', ln[5]?.[0] === '1' && ln[5]?.[1] === '1', JSON.stringify(ln.slice(4, 9)));
  check('删除行只占旧行号 (2,-)', ln[6]?.[0] === '2' && ln[6]?.[1] === '', JSON.stringify(ln[6]));
  check('新增行只占新行号 (-,2/3)', ln[7]?.[0] === '' && ln[7]?.[1] === '2' && ln[8]?.[1] === '3', JSON.stringify(ln.slice(7, 9)));
  check('第二段 hunk (@@ -0,0 +1,2 @@) 新行号从 1 开始', ln[13]?.[0] === '' && ln[13]?.[1] === '' && ln[14]?.[1] === '1' && ln[15]?.[1] === '2', JSON.stringify(ln.slice(13, 16)));

  // combined hunk（合并冲突时 git 输出 @@@）
  const combined = lib.renderDiffRows('@@@ -1,2 -1,2 +1,6 @@@\n++<<<<<<< HEAD\n +ours\n++=======');
  const cln = [...combined.matchAll(/<span class="ln">(\s*\d*)<\/span><span class="ln">(\s*\d*)<\/span>/g)].map((m) => [m[1].trim(), m[2].trim()]);
  check('combined hunk (@@@) 能解析出 old/new 起始行号', cln[1]?.[1] === '1' && cln[2]?.[0] === '1' && cln[2]?.[1] === '2', JSON.stringify(cln));

  // patch 分块
  const chunks = lib.splitPatch(SAMPLE_PATCH);
  check('splitPatch 切成 2 个文件块', chunks.length === 2, `got=${chunks.length}`);
  check('splitPatch 解析普通路径', chunks[0]?.path === 'src/app.js', chunks[0]?.path);
  check('splitPatch 解析带引号的路径', chunks[1]?.path === '\\344\\270\\255.txt', chunks[1]?.path);
  check('chunkStat 统计增删行', (() => { const s = lib.chunkStat(chunks[0]); return s.additions === 2 && s.deletions === 1; })());

  const html = lib.commitFilesHtml({ patch: SAMPLE_PATCH, stat: { files: [{ path: 'src/app.js', added: 2, removed: 1, info: '2 +-', rawPath: 'src/app.js' }], summary: '2 files changed' } });
  check('commitFilesHtml 生成可折叠文件块', html.includes('<details class="filediff"') && html.includes('+2'));
  check('commitFilesHtml 无 patch 时给出说明', lib.commitFilesHtml({ patch: '', stat: { files: [] } }).includes('没有相对第一个父提交的内容改动'));

  // 泳道图：线性 + 合并
  const linear = lib.computeRows([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  check('线性历史始终在第 0 条泳道', linear.every((r) => r.col === 0), JSON.stringify(linear.map((r) => r.col)));
  check('线性历史父边指向下一行', linear[0].edges[0].to === 0 && linear[0].edges[0].from === 0);

  const merged = lib.computeRows([
    { hash: 'm', parents: ['p1', 'p2'] },
    { hash: 'p1', parents: ['base'] },
    { hash: 'p2', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  check('合并提交展开为两条泳道', merged[0].col === 0 && merged[0].edges.length === 2 && merged[0].edges[1].to === 1, JSON.stringify(merged[0].edges));
  check('两条泳道在 base 处汇合', merged[3].col === 0 && merged[2].edges[0].to === 0, JSON.stringify(merged.map((r) => [r.col, r.edges])));
  check('泳道数量不超过提交数且非负', merged.every((r) => r.col >= 0 && r.maxLane >= 1));
  check('graphSvg 生成合法 SVG', /^<svg class="graph" width="\d+" height="\d+"/.test(lib.graphSvg(merged[0])));
  check('graphSvg 中不出现非法 NaN', !lib.graphSvg(merged[0]).includes('NaN'));

  // 格式化
  check('fmtBytes 分级', lib.fmtBytes(512) === '512 B' && lib.fmtBytes(2048) === '2.0 KB');
  check('relTime 刚刚 / 分钟', lib.relTime(new Date(Date.now() - 5000).toISOString()) === '刚刚' && lib.relTime(new Date(Date.now() - 5 * 60000).toISOString()) === '5 分钟前');
  check('splitPath 拆分目录', lib.splitPath('a/b/c.js').dir === 'a/b/' && lib.splitPath('x.js').dir === '');
  check('refBadgeClass 识别类型', lib.refBadgeClass('HEAD -> main') === 'head' && lib.refBadgeClass('tag: v1') === 'tag' && lib.refBadgeClass('origin/main') === 'remote');

  // 主题纯函数
  check('resolveTheme: 显式选择优先于系统偏好', lib.resolveTheme('light', false) === 'light' && lib.resolveTheme('dark', true) === 'dark');
  check('resolveTheme: 无选择时跟随系统', lib.resolveTheme(null, true) === 'light' && lib.resolveTheme(null, false) === 'dark');
  check('resolveTheme: 脏数据回落到深色', lib.resolveTheme('blue', false) === 'dark' && lib.resolveTheme(undefined, undefined) === 'dark');
  check('otherTheme 互换', lib.otherTheme('dark') === 'light' && lib.otherTheme('light') === 'dark');
  check('themeIcon 深色🌙 / 浅色☀️', lib.themeIcon('dark') === '🌙' && lib.themeIcon('light') === '☀️');
  check('themeButtonTitle 说明当前与目标', lib.themeButtonTitle('light').includes('浅色') && lib.themeButtonTitle('light').includes('深色'));

  // 泳道图改为 class 驱动颜色，主题切换无需重渲染
  const svg = lib.graphSvg(lib.computeRows([{ hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }])[0]);
  check('graphSvg 用 lane-N class 而非写死颜色', svg.includes('lane-0') && !/#[0-9a-f]{6}/i.test(svg), svg);
  check('graphSvg 泳道序号不越界', !/lane-([89]|\d\d)/.test(lib.graphSvg(lib.computeRows(Array.from({ length: 30 }, (_, i) => ({ hash: `h${i}`, parents: i < 29 ? [`h${i + 1}`] : [] }))).at(-1))));
}

/* --------------------------- 静态一致性 --------------------------- */

function staticChecks() {
  console.log('\n[1] 前端静态一致性');
  const html = fs.readFileSync(path.join(APP_DIR, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(APP_DIR, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(APP_DIR, 'public', 'styles.css'), 'utf8');

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...usedIds].filter((id) => !htmlIds.has(id));
  check('app.js 引用的 DOM id 都存在于 index.html', missing.length === 0, missing.join(', '));

  const classesUsed = new Set([...js.matchAll(/class="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  const classesDefined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const unknown = [...classesUsed].filter((c) => !classesDefined.has(c));
  check('app.js 使用的 CSS class 都有样式定义', unknown.length === 0, unknown.join(', '));

  check('index.html 已加载 app.js 模块', /<script[^>]+src="\/app\.js"/.test(html));
  check('index.html 已加载 styles.css', /href="\/styles\.css"/.test(html));
}

/* --------------------------- HTTP 接口 --------------------------- */

async function httpChecks() {
  console.log('\n[2] 接口可用性');

  const health = await getJSON('/api/health');
  check('GET /api/health → 200 且 ok', health.status === 200 && health.json?.ok === true, `status=${health.status}`);
  console.log(`      运行环境: node ${health.json?.node}, 输出模式 ${health.json?.spawnMode}, 监听 ${health.json?.watch}`);

  const repos = await getJSON('/api/repos');
  check('GET /api/repos → 至少一个仓库', repos.status === 200 && Array.isArray(repos.json?.repos) && repos.json.repos.length > 0);
  const repoId = repos.json?.repos?.[0]?.id;
  console.log(`      仓库: ${repos.json?.repos?.map((r) => `${r.name} (${r.path})`).join(', ')}`);

  const state = await getJSON('/api/state', { repo: repoId });
  check('GET /api/state → 200', state.status === 200, `status=${state.status}`);
  const s = state.json || {};
  check('state.repo.path 存在', typeof s.repo?.path === 'string' && s.repo.path.length > 0);
  check('state.repo.gitDir 存在', typeof s.repo?.gitDir === 'string');
  check('state.head.state 合法', ['branch', 'detached', 'unborn'].includes(s.head?.state), `got=${s.head?.state}`);
  check('state.counts 结构完整', ['staged', 'unstaged', 'untracked', 'conflicted'].every((k) => typeof s.counts?.[k] === 'number'));
  check('state.localBranches 是数组', Array.isArray(s.localBranches));
  check('state.tags 是数组', Array.isArray(s.tags));
  check('state.stash 是数组', Array.isArray(s.stash));
  check('state.remotes 是数组', Array.isArray(s.remotes));
  check('state.stats.commits 是数字', typeof s.stats?.commits === 'number');
  check('state.buildMs 是数字', typeof s.buildMs === 'number');
  console.log(`      HEAD=${s.head?.branch ?? '(detached)'} state=${s.head?.state} 提交=${s.stats?.commits} 变更: 暂存 ${s.counts?.staged}/未暂存 ${s.counts?.unstaged}/未跟踪 ${s.counts?.untracked}/冲突 ${s.counts?.conflicted}`);

  // 未跟踪文件应当能看到本项目的文件（在 git-browser 仓库里）
  const untrackedNames = (s.untracked || []).map((f) => f.path);
  if (REPO_HINT) {
    // 不假设这些文件处于什么状态（可能已提交），只要求工作区里读得到
    for (const probe of ['server.mjs', 'public/app.js', 'public/styles.css']) {
      const r = await getJSON('/api/file', { repo: repoId, path: probe, scope: 'worktree' });
      check(`工作区里能读到 ${probe}`, r.status === 200 && typeof r.json?.content === 'string', `status=${r.status}`);
    }
    check('未跟踪列表里没有 .git 内部文件', !untrackedNames.some((p) => p.startsWith('.git/')));
  }

  // 单文件的状态一致性
  const all = [...(s.staged || []).map((f) => ({ ...f, _scope: 'index' })), ...(s.unstaged || []).map((f) => ({ ...f, _scope: 'worktree' })), ...(s.untracked || []).map((f) => ({ ...f, _scope: 'untracked' })), ...(s.conflicted || []).map((f) => ({ ...f, _scope: 'worktree' }))];
  check('变更项都带 path', all.every((f) => typeof f.path === 'string' && f.path.length > 0));

  if (all.length) {
    const pick = all.find((f) => f._scope === 'untracked') || all[0];
    const diff = await getJSON('/api/diff', { repo: repoId, path: pick.path, scope: pick._scope });
    check(`GET /api/diff (${pick._scope}) → 200`, diff.status === 200, `status=${diff.status} ${diff.json?.error || ''}`);
    check('diff 响应带 diff 字段', typeof diff.json?.diff === 'string');

    const file = await getJSON('/api/file', { repo: repoId, path: pick.path, scope: pick._scope === 'index' ? 'index' : 'worktree' });
    check('GET /api/file → 200 且带 content/binary', file.status === 200 && (typeof file.json?.content === 'string' || file.json?.binary === true), `status=${file.status}`);
  } else {
    console.log('      （仓库没有可测的变更文件）');
  }

  // 篡改 scope 应被拒绝或安全处理
  const bad = await getJSON('/api/diff', { repo: repoId, path: 'no-such-file-xyz', scope: 'worktree' });
  check('不存在的文件不会 500', bad.status < 500, `status=${bad.status}`);

  const badRepo = await getJSON('/api/state', { repo: 'nope' });
  check('未知 repo → 404 JSON 错误', badRepo.status === 404 && typeof badRepo.json?.error === 'string', `status=${badRepo.status}`);

  const badApi = await getJSON('/api/nope');
  check('未知接口 → 404 JSON 错误', badApi.status === 404 && typeof badApi.json?.error === 'string');

  console.log('\n[3] 历史 / 提交');
  const log = await getJSON('/api/log', { repo: repoId, limit: 10 });
  check('GET /api/log → 200', log.status === 200, `status=${log.status}`);
  check('log 返回 commits 数组', Array.isArray(log.json?.commits));
  if (log.json?.unborn) {
    console.log('      仓库尚无提交（unborn HEAD）—— 分支/日志的空态处理正确');
    check('unborn 仓库 localBranches 为空', (s.localBranches || []).length === 0);
  } else if (log.json?.commits?.length) {
    const c = log.json.commits[0];
    check('提交包含 hash/short/parents/subject/authorDate', Boolean(c.hash && c.short && Array.isArray(c.parents) && c.subject && c.authorDate));
    const detail = await getJSON('/api/commit', { repo: repoId, rev: c.hash });
    check('GET /api/commit → 200 且带 patch', detail.status === 200 && typeof detail.json?.patch === 'string', `status=${detail.status}`);
    check('提交详情 meta 完整', Boolean(detail.json?.commit?.hash === c.hash && detail.json?.commit?.author));
    const missing = await getJSON('/api/commit', { repo: repoId, rev: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    check('不存在的提交 → 404', missing.status === 404, `status=${missing.status}`);
  }

  // 静态资源
  const page = await fetch(`${BASE}/`);
  const htmlText = await page.text();
  check('GET / → 200 且是 HTML', page.status === 200 && /<title>Git Browser/.test(htmlText));
  for (const asset of ['/app.js', '/lib.js', '/styles.css']) {
    const r = await fetch(`${BASE}${asset}`);
    check(`GET ${asset} → 200`, r.status === 200, `status=${r.status}`);
  }
  const traversal = await fetch(`${BASE}/../server.mjs`);
  check('路径穿越被拒绝', traversal.status === 403 || traversal.status === 404, `status=${traversal.status}`);

  return { repoId, state: s };
}

/* --------------------------- SSE 实时推送 --------------------------- */

async function sseCheck(repo) {
  console.log('\n[4] SSE 实时推送');
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/stream?repo=${encodeURIComponent(repo.id)}`, {
    headers: { accept: 'text/event-stream' },
    signal: ac.signal,
  });
  check('GET /api/stream 建立连接', res.status === 200 && String(res.headers.get('content-type')).includes('text/event-stream'), `status=${res.status}`);

  const events = [];
  let buf = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evName = (chunk.match(/^event: (.+)$/m) || [])[1] || 'message';
          const data = (chunk.match(/^data: (.+)$/m) || [])[1];
          if (data === undefined) continue; // retry: 等无数据块不构成事件
          events.push({ event: evName, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await new Promise((r) => setTimeout(r, 400));
  check('收到 hello 事件（含仓库 id）', events.some((e) => e.event === 'hello' && e.data?.repo === repo.id), JSON.stringify(events.map((e) => e.event)));

  const target = repo.worktree || repo.path;
  const probe = path.join(target, `.gb-smoke-${Date.now()}.tmp`);
  if (!MUTATE) {
    console.log('      （未加 --mutate，跳过写文件触发推送的验证）');
  } else {
    fs.writeFileSync(probe, 'smoke test\n');
    await new Promise((r) => setTimeout(r, 1500));
    const changed = events.find((e) => e.event === 'change');
    check('写文件后收到 change 事件', Boolean(changed), JSON.stringify(events.map((e) => e.event)));
    if (changed) check('change 事件带 at 时间戳', typeof changed.data?.at === 'string');
    fs.unlinkSync(probe);
    await new Promise((r) => setTimeout(r, 800));
  }

  ac.abort();
  await pump.catch(() => {});
}

/* --------------------------- 主流程 --------------------------- */

console.log(`Git Browser 冒烟测试 → ${BASE}`);
console.log(`应用目录: ${APP_DIR}`);

staticChecks();
libChecks();
themeChecks();
let ctx;
try {
  ctx = await httpChecks();
} catch (err) {
  console.error(`\n接口测试中断: ${err.message}`);
  process.exit(1);
}
try {
  await sseCheck({
    id: ctx.repoId,
    worktree: ctx.state.repo?.worktree,
    path: ctx.state.repo?.path,
  });
} catch (err) {
  check('SSE 测试执行', false, err.message);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (failures.length) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
