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
import { parseReflog, classifyUndo, isCommitLike } from '../lib/reflog.mjs';

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
}

/* --------------------------- 撤销判定单元测试 --------------------------- */

function undoUnitChecks() {
  console.log('\n[6] 撤销判定（lib/reflog.mjs）');

  const reflog = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1faaaaaaa\x1fHEAD@{0}\x1fcommit: 第二次提交\x1fHEAD@{0}\x1f2026-01-02T00:00:00+08:00\x1e',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1fbbbbbbb\x1fHEAD@{1}\x1fcommit (initial): 第一次提交\x1fHEAD@{1}\x1f2026-01-01T00:00:00+08:00\x1e',
  ].join('');
  const parsed = parseReflog(reflog);
  check('parseReflog 解析条数与字段', parsed.length === 2 && parsed[0].short === 'aaaaaaa' && parsed[0].subject === 'commit: 第二次提交');
  check('parseReflog 忽略空记录', parseReflog('\x1e\x1e').length === 0);
  check('isCommitLike 识别各类提交', ['commit: x', 'commit (amend): x', 'commit (initial): x', 'commit (merge): x', 'cherry-pick: x', 'revert: x'].every(isCommitLike));
  check('isCommitLike 不误判其它操作', !['reset: moving to HEAD~1', 'checkout: moving from a to b', 'merge x: Fast-forward'].some(isCommitLike));

  const base = { entries: parsed, operation: null, unmerged: false, dirty: false, branch: 'main', detached: false, hasRemote: false, branchExists: () => true };

  const commitPlan = classifyUndo(base);
  check('普通提交 → reset --soft 回上一个提交', commitPlan.available && commitPlan.kind === 'reset-soft' && commitPlan.args.join(' ') === `reset --soft ${parsed[1].oid}`);
  check('提交撤销的方案里不含 --hard', !commitPlan.args.includes('--hard'));
  check('提交撤销说明了改动会回到暂存区', /暂存区/.test(commitPlan.effect));

  const amendPlan = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: 'commit (amend): 改过的提交' }, parsed[1]] });
  check('amend → 回到改写前的提交', amendPlan.kind === 'reset-soft' && /amend/.test(amendPlan.label));

  const mergeCommit = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: 'commit (merge): Merge branch x' }, parsed[1]] });
  check('合并提交 → 可撤销且提示影响', mergeCommit.kind === 'reset-soft' && mergeCommit.warnings.some((w) => /合并/.test(w)));

  const remotePlan = classifyUndo({ ...base, hasRemote: true });
  check('有远端时提示 force push 风险', remotePlan.warnings.some((w) => /force push/.test(w)));
  const dirtyPlan = classifyUndo({ ...base, dirty: true });
  check('工作区脏时不阻止撤销但会说明', dirtyPlan.available && dirtyPlan.warnings.some((w) => /保留/.test(w)));

  const initialOnly = classifyUndo({ ...base, entries: [parsed[1]] });
  check('仅一次提交 → 撤销 = 删除分支引用回到 unborn', initialOnly.available && initialOnly.kind === 'drop-initial' && initialOnly.args.join(' ') === 'update-ref -d refs/heads/main');
  check('无分支名时拒绝删除首次提交', classifyUndo({ ...base, entries: [parsed[1]], branch: null }).available === false);

  const resetPlan = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: 'reset: moving to HEAD~1' }, parsed[1]] });
  check('reset → reset --keep 回到之前', resetPlan.kind === 'reset-keep' && resetPlan.args[1] === '--keep');

  const checkoutPlan = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: 'checkout: moving from feat/x to main' }, parsed[1]] });
  check('分支切换 → switch 切回上一个分支', checkoutPlan.kind === 'switch-branch' && checkoutPlan.args.join(' ') === 'switch feat/x');

  // 「从游离提交切到分支」→ 撤销要重新游离回去；「从分支切到游离提交」→ 撤销是切回分支
  const checkoutDetached = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: `checkout: moving from ${'c'.repeat(40)} to main` }, parsed[1]] });
  check('从游离提交切到分支 → switch --detach 回去', checkoutDetached.kind === 'switch-branch' && checkoutDetached.args.join(' ') === `switch --detach ${'c'.repeat(40)}`);
  const checkoutToDetached = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: `checkout: moving from main to ${'c'.repeat(40)}` }, parsed[1]] });
  check('从分支切到游离提交 → switch 回原分支', checkoutToDetached.kind === 'switch-branch' && checkoutToDetached.args.join(' ') === 'switch main');

  check('上一个分支已删除 → 明确拒绝', classifyUndo({ ...base, branchExists: () => false, entries: [{ ...parsed[0], subject: 'checkout: moving from gone-branch to main' }, parsed[1]] }).available === false);

  const mergePlan = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: "merge feature: Merge made by the 'ort' strategy." }, parsed[1]] });
  check('已完成的合并 → reset --keep 回到合并前', mergePlan.kind === 'reset-keep' && /合并/.test(mergePlan.label));

  const rebasePlan = classifyUndo({ ...base, entries: [{ ...parsed[0], subject: 'rebase (finish): returning to refs/heads/main' }, parsed[1]] });
  check('已完成的变基 → 可撤销', rebasePlan.available && rebasePlan.kind === 'reset-keep' && /变基/.test(rebasePlan.label));

  const inProgress = classifyUndo({ ...base, entries: [], unmerged: true, operation: { type: 'merge', label: '合并进行中 (merge)' } });
  check('进行中的 merge → 撤销 = merge --abort', inProgress.available && inProgress.kind === 'abort' && inProgress.args.join(' ') === 'merge --abort');
  const rebaseProgress = classifyUndo({ ...base, entries: [], operation: { type: 'rebase', label: '变基进行中' } });
  check('进行中的 rebase → rebase --abort', rebaseProgress.args.join(' ') === 'rebase --abort');
  const bisect = classifyUndo({ ...base, entries: [], operation: { type: 'bisect', label: 'bisect' } });
  check('bisect → git bisect reset', bisect.args.join(' ') === 'bisect reset');
  const lock = classifyUndo({ ...base, entries: [], operation: { type: 'lock', label: 'index.lock' } });
  check('index.lock → 拒绝撤销', lock.available === false && /index\.lock/.test(lock.reason));

  check('无 reflog → 明确说明原因', classifyUndo({ ...base, entries: [] }).available === false);
  check('未知操作 → 不猜动作', classifyUndo({ ...base, entries: [{ ...parsed[0], subject: 'gc: something' }, parsed[1]] }).available === false);
  check('冲突未解决时 reset 类被拒', classifyUndo({ ...base, unmerged: true, entries: [{ ...parsed[0], subject: 'reset: moving to HEAD~1' }, parsed[1]] }).available === false);
  check('冲突未解决时提交撤销仍可用（reset --soft 不受影响）', classifyUndo({ ...base, unmerged: true }).available === true);

  const allPlans = [commitPlan, amendPlan, mergeCommit, initialOnly, resetPlan, checkoutPlan, checkoutDetached, mergePlan, rebasePlan, inProgress];
  check('所有方案都不含 --hard', allPlans.every((p) => !p.args.includes('--hard')));
  check('所有可用方案都有 label/command/args', allPlans.every((p) => p.available && p.label && p.command && Array.isArray(p.args)));
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
undoUnitChecks();
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
