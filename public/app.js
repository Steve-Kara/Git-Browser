/* Git Browser 前端 —— 无第三方依赖；纯逻辑在 lib.js，这里负责状态、请求与渲染 */

import {
  esc,
  qs,
  relTime,
  absTime,
  fmtBytes,
  splitPath,
  diffRow,
  renderDiffText,
  commitFilesHtml,
  computeRows,
  graphSvg,
  refBadgeClass,
  GROUPS,
  resolveTheme,
  otherTheme,
  themeIcon,
  themeButtonTitle,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'gb-theme';

const S = {
  repos: [],
  repoId: null,
  snap: null,
  log: [],
  logUnborn: false,
  logHasMore: false,
  historyRef: '',
  allRefs: false,
  tab: 'status',
  sel: null, // {kind:'file', path, scope} | {kind:'commit', rev} | {kind:'blob', path, scope}
  detail: null,
  detailBusy: false,
  connected: false,
  pollTimer: null,
  stream: null,
  lastEventAt: null,
  lastFetchAt: null,
  cursor: 0,
  err: null,
  theme: 'dark',
  themeExplicit: false,
};

/* ------------------------------ 数据加载 ------------------------------ */

async function api(pathname, params = {}) {
  const q = qs({ repo: S.repoId, ...params });
  const res = await fetch(`${pathname}${q ? `?${q}` : ''}`, { cache: 'no-store' });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回非 JSON (${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

async function loadRepos() {
  const data = await api('/api/repos');
  S.repos = data.repos || [];
  if (!S.repoId || !S.repos.some((r) => r.id === S.repoId)) S.repoId = S.repos[0]?.id || null;
}

async function loadState() {
  try {
    S.snap = await api('/api/state');
    S.err = null;
  } catch (e) {
    S.err = e.message;
    render();
    return;
  }
  S.lastFetchAt = new Date().toISOString();
  render();
}

async function loadLog({ silent = false } = {}) {
  try {
    const data = await api('/api/log', { limit: 150, ref: S.historyRef, all: S.allRefs ? 1 : '' });
    S.log = data.commits || [];
    S.logUnborn = Boolean(data.unborn);
    S.logHasMore = Boolean(data.hasMore);
  } catch (e) {
    if (!silent) toast(`读取历史失败：${e.message}`, 'err');
    S.log = [];
  }
  if (!silent) render();
}

async function loadDetail() {
  if (!S.sel) {
    S.detail = null;
    render();
    return;
  }
  S.detailBusy = true;
  render();
  try {
    if (S.sel.kind === 'commit') S.detail = await api('/api/commit', { rev: S.sel.rev });
    else if (S.sel.kind === 'file') S.detail = await api('/api/diff', { path: S.sel.path, scope: S.sel.scope });
    else if (S.sel.kind === 'blob') S.detail = await api('/api/file', { path: S.sel.path, scope: S.sel.scope, rev: S.sel.rev });
    S.err = null;
  } catch (e) {
    S.detail = { error: e.message };
  }
  S.detailBusy = false;
  render();
}

async function refreshAll({ silent = true } = {}) {
  await loadState();
  await loadLog({ silent });
  if (S.sel) await loadDetail();
}

/* ------------------------------ 主题 ------------------------------ */

function systemPrefersLight() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}

function readSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function initTheme() {
  const saved = readSavedTheme();
  // 首屏由 index.html 里的内联脚本先落地，这里与之保持一致
  S.theme = document.documentElement.dataset.theme || resolveTheme(saved, systemPrefersLight());
  S.themeExplicit = saved === 'light' || saved === 'dark';
  renderThemeButton();
}

function applyTheme(theme, { persist = false } = {}) {
  S.theme = theme;
  document.documentElement.dataset.theme = theme;
  if (persist) {
    S.themeExplicit = true;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 隐私模式下写不了就只在本次会话生效 */
    }
  }
  renderThemeButton();
}

function toggleTheme() {
  applyTheme(otherTheme(S.theme), { persist: true });
}

function renderThemeButton() {
  const btn = $('btn-theme');
  if (!btn) return;
  btn.textContent = themeIcon(S.theme);
  btn.title = themeButtonTitle(S.theme);
  btn.setAttribute('aria-label', btn.title);
}

/* ------------------------------ 渲染：顶栏 ------------------------------ */

function renderTop() {
  const snap = S.snap;
  const sel = $('repo-select');
  if (sel.options.length !== S.repos.length) {
    sel.innerHTML = S.repos.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  }
  sel.value = S.repoId || '';

  $('repo-path').textContent = snap?.repo?.path || '';
  $('repo-path').title = snap ? `git 目录: ${snap.repo.gitDir}` : '';

  const chips = [];
  if (snap) {
    const h = snap.head;
    if (h.state === 'unborn') chips.push(`<span class="chip unborn">尚无提交 · ${esc(h.branch || 'HEAD')}</span>`);
    else if (h.state === 'detached') chips.push(`<span class="chip detached">detached HEAD</span>`);
    else chips.push(`<span class="chip branch">⎇ ${esc(h.branch || h.short)}</span>`);
    if (h.short) chips.push(`<span class="chip mono" title="${esc(h.oid)}">${esc(h.short)}</span>`);
    if (h.upstream) {
      chips.push(`<span class="chip mono">↑↓ ${esc(h.upstream)}</span>`);
      if (h.ahead) chips.push(`<span class="chip ahead">领先 ${h.ahead}</span>`);
      if (h.behind) chips.push(`<span class="chip behind">落后 ${h.behind}</span>`);
    } else if (h.state === 'branch') {
      chips.push(`<span class="chip warn">无上游分支</span>`);
    }
    if (h.describe) chips.push(`<span class="chip mono">${esc(h.describe)}</span>`);
    if (h.subject) chips.push(`<span class="chip subject" title="${esc(h.subject)}">${esc(h.subject)}</span>`);
    if (snap.repo.bare) chips.push(`<span class="chip bare">bare 仓库</span>`);
  }
  $('head-chips').innerHTML = chips.join('');
}

function renderLive() {
  const el = $('live');
  const txt = $('live-text');
  el.classList.remove('on', 'off', 'poll');
  if (S.connected) {
    el.classList.add('on');
    txt.textContent = S.lastEventAt ? `实时 · ${relTime(S.lastEventAt)}有变化` : '实时监听中';
  } else if (S.pollTimer) {
    el.classList.add('poll');
    txt.textContent = '轮询中';
  } else {
    el.classList.add('off');
    txt.textContent = '未连接';
  }
}

/* ------------------------------ 渲染：侧栏 ------------------------------ */

function renderSidebar() {
  const snap = S.snap;
  if (!snap) {
    $('sidebar').innerHTML = `<div class="side-section"><div class="empty-hint">加载中…</div></div>`;
    return;
  }
  const out = [];

  out.push(`<div class="side-section">
    <div class="side-title">仓库</div>
    <dl class="kv">
      <dt>名称</dt><dd>${esc(snap.repo.name)}</dd>
      <dt>工作区</dt><dd title="${esc(snap.repo.worktree || '')}">${esc(snap.repo.worktree || '（bare，无工作区）')}</dd>
      <dt>git 目录</dt><dd title="${esc(snap.repo.gitDir)}">${esc(snap.repo.gitDir)}</dd>
      <dt>提交总数</dt><dd>${snap.stats.commits}</dd>
      <dt>对象</dt><dd>${esc(snap.stats.objectsCount ?? '0')} 个${snap.stats.objectsSize ? ` · ${esc(snap.stats.objectsSize)}` : ''}</dd>
      <dt>身份</dt><dd>${snap.user.name ? `${esc(snap.user.name)}${snap.user.email ? ` &lt;${esc(snap.user.email)}&gt;` : ''}` : '<span class="muted">未配置</span>'}</dd>
      <dt>最近 fetch</dt><dd>${snap.lastFetch ? `${esc(relTime(snap.lastFetch))} <span class="muted">(${esc(absTime(snap.lastFetch))})</span>` : '<span class="muted">无记录</span>'}</dd>
      <dt>git</dt><dd>${esc((snap.gitVersion || '').replace('git version ', ''))}</dd>
    </dl>
  </div>`);

  if (snap.operation) {
    out.push(`<div class="side-section">
      <div class="side-title">进行中的操作</div>
      <div class="empty-hint" style="color:var(--yellow)">${esc(snap.operation.label)}${snap.operation.detail ? ` · ${esc(snap.operation.detail)}` : ''}</div>
    </div>`);
  }

  const branchRow = (b) => `
    <div class="ref-item ${b.current ? 'current' : ''} ${S.historyRef === b.ref || S.historyRef === b.name ? 'active' : ''}"
         data-act="set-ref" data-ref="${esc(b.name)}" title="${esc(b.subject || '')}${b.upstream ? `&#10;上游: ${esc(b.upstream)}` : ''}">
      <span class="glyph">${b.current ? '●' : '○'}</span>
      <span class="name">${esc(b.name)}</span>
      ${b.ahead ? `<span class="ab a">↑${b.ahead}</span>` : ''}
      ${b.behind ? `<span class="ab b">↓${b.behind}</span>` : ''}
      ${b.gone ? `<span class="ab b" title="上游分支已删除">gone</span>` : ''}
      <span class="rel">${esc(relTime(b.date))}</span>
    </div>`;

  out.push(`<div class="side-section">
    <div class="side-title">本地分支 <span class="count">${snap.localBranches.length}</span></div>
    ${snap.localBranches.length ? snap.localBranches.map(branchRow).join('') : '<div class="empty-hint">无分支（还没有提交）</div>'}
  </div>`);

  out.push(`<div class="side-section">
    <div class="side-title">远端分支 <span class="count">${snap.remoteBranches.length}</span></div>
    ${
      snap.remoteBranches.length
        ? snap.remoteBranches
            .map(
              (b) => `
        <div class="ref-item ${S.historyRef === b.name ? 'active' : ''}" data-act="set-ref" data-ref="${esc(b.name)}" title="${esc(b.subject || '')}">
          <span class="glyph">◇</span><span class="name">${esc(b.name)}</span><span class="rel">${esc(relTime(b.date))}</span>
        </div>`,
            )
            .join('')
        : '<div class="empty-hint">无远端跟踪分支</div>'
    }
  </div>`);

  out.push(`<div class="side-section">
    <div class="side-title">标签 <span class="count">${snap.tags.length}</span></div>
    ${
      snap.tags.length
        ? snap.tags
            .slice(0, 60)
            .map(
              (t) => `
        <div class="ref-item ${S.historyRef === t.name ? 'active' : ''}" data-act="set-ref" data-ref="${esc(t.name)}" title="${esc(t.subject || '')}">
          <span class="glyph">⚑</span><span class="name">${esc(t.name)}</span><span class="rel">${esc(relTime(t.date))}</span>
        </div>`,
            )
            .join('')
        : '<div class="empty-hint">无标签</div>'
    }
  </div>`);

  out.push(`<div class="side-section">
    <div class="side-title">Stash <span class="count">${snap.stash.length}</span></div>
    ${
      snap.stash.length
        ? snap.stash
            .map(
              (s) => `
        <div class="ref-item ${S.historyRef === s.ref ? 'active' : ''}" data-act="set-ref" data-ref="${esc(s.ref)}" title="${esc(s.subject)}">
          <span class="glyph">≡</span><span class="name">${esc(s.ref)}</span><span class="rel">${esc(relTime(s.date))}</span>
        </div>`,
            )
            .join('')
        : '<div class="empty-hint">无 stash</div>'
    }
  </div>`);

  out.push(`<div class="side-section">
    <div class="side-title">远端 <span class="count">${snap.remotes.length}</span></div>
    ${
      snap.remotes.length
        ? snap.remotes
            .map(
              (r) => `
        <div class="ref-item" style="cursor:default">
          <span class="glyph">⇅</span>
          <span class="name mono" title="fetch: ${esc(r.fetch || '')}&#10;push: ${esc(r.push || '')}">${esc(r.name)} <span class="muted">(${r.branches})</span></span>
        </div>`,
            )
            .join('')
        : '<div class="empty-hint">无远端</div>'
    }
  </div>`);

  $('sidebar').innerHTML = out.join('');
}

/* ------------------------------ 渲染：列表 ------------------------------ */

function fileRow(f, scope, code) {
  const p = f.path || f;
  const { dir, base } = splitPath(p);
  const active = S.sel?.kind !== 'commit' && S.sel?.path === p;
  const c = code || f.code || '?';
  const cls = c === '?' ? 'q' : c;
  return `<div class="file-item ${active ? 'sel' : ''}" data-act="open-file" data-path="${esc(p)}" data-scope="${esc(scope)}" data-code="${esc(c)}" title="${esc(f.origPath ? `${f.origPath} → ${p}` : p)}">
    <span class="code ${esc(cls)}">${esc(c)}</span>
    <span class="name">${esc(dir)}<b>${esc(base)}</b></span>
    ${f.origPath ? `<span class="size">← ${esc(splitPath(f.origPath).base)}</span>` : ''}
  </div>`;
}

function renderList() {
  const snap = S.snap;
  const badge = $('badge-status');
  if (snap) {
    const total = snap.counts.staged + snap.counts.unstaged + snap.counts.untracked + snap.counts.conflicted;
    badge.textContent = String(total);
    badge.style.color = snap.counts.conflicted ? 'var(--orange)' : total ? 'var(--fg)' : 'var(--fg-mute)';
  }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));

  if (!snap) {
    $('listbody').innerHTML = `<div class="empty-state">加载中…</div>`;
    return;
  }

  if (S.tab === 'status') {
    const out = [];
    if (snap.repo.bare) {
      out.push(`<div class="empty-state"><div class="big">🗄</div><h3>bare 仓库</h3>没有工作区，因此没有「工作区变更」。<br/>分支、标签与提交历史在「历史」标签页查看。</div>`);
      $('listbody').innerHTML = out.join('');
      return;
    }
    if (snap.head.state === 'unborn') {
      out.push(`<div class="list-head" style="color:var(--purple)">unborn HEAD · 分支 ${esc(snap.head.branch || '')} 还没有第一次提交</div>`);
    }
    if (snap.clean) {
      out.push(`<div class="empty-state"><div class="big">✓</div><h3>工作区干净</h3>没有未提交的变更。</div>`);
    }
    for (const g of GROUPS) {
      const items = snap[g.key] || [];
      if (!items.length) continue;
      const cap = 400;
      out.push(`<div class="list-head">${esc(g.title)} <span class="badge">${items.length}</span></div>`);
      out.push(items.slice(0, cap).map((f) => fileRow(f, g.scope || g.key, f.code || g.code)).join(''));
      if (items.length > cap) out.push(`<div class="empty-hint">还有 ${items.length - cap} 项未显示</div>`);
    }
    $('listbody').innerHTML = out.join('');
    return;
  }

  // 历史
  const out = [];
  out.push(`<div class="list-head">
    <span>${esc(S.historyRef || '当前 HEAD')}</span>
    <span style="flex:1"></span>
    <button class="btn sm ${S.allRefs ? 'active' : ''}" data-act="toggle-all">全部 refs</button>
    ${S.historyRef ? `<button class="btn sm" data-act="clear-ref">回到 HEAD</button>` : ''}
  </div>`);

  if (S.logUnborn) {
    out.push(`<div class="empty-state"><div class="big">🌱</div><h3>还没有任何提交</h3>
      仓库已经初始化（unborn HEAD），第一次 <code>git commit</code> 之后这里会出现提交图。</div>`);
    $('listbody').innerHTML = out.join('');
    return;
  }
  if (!S.log.length) {
    out.push(`<div class="empty-state">没有可显示的提交</div>`);
    $('listbody').innerHTML = out.join('');
    return;
  }

  out.push(
    computeRows(S.log)
      .map((r, i) => {
        const c = r.commit;
        const active = S.sel?.kind === 'commit' && S.sel.rev === c.hash;
        return `<div class="commit-item ${active ? 'sel' : ''}" data-act="open-commit" data-rev="${esc(c.hash)}" data-index="${i}">
      ${graphSvg(r)}
      <div class="cbody">
        <div class="subject">${c.refs.map((rf) => `<span class="ref-badge ${refBadgeClass(rf)}">${esc(rf.replace(/^HEAD -> /, 'HEAD→').replace(/^tag: /, '🏷 '))}</span> `).join('')}${esc(c.subject)}</div>
        <div class="meta"><span class="hash">${esc(c.short)}</span><span class="author">${esc(c.author)}</span><span>${esc(relTime(c.authorDate))}</span></div>
      </div>
    </div>`;
      })
      .join(''),
  );
  if (S.logHasMore) out.push(`<div class="empty-hint">已显示最近 ${S.log.length} 条提交</div>`);
  $('listbody').innerHTML = out.join('');
}

/* ------------------------------ 渲染：详情 ------------------------------ */

function renderBlob(content) {
  const ls = String(content ?? '').split('\n');
  return `<div class="diff">${ls.map((l, i) => diffRow('ctx', i + 1, '', l)).join('')}</div>`;
}

function scopeButtons(sel) {
  const opts = [
    ['worktree', '工作区 ⇄ 暂存区'],
    ['index', '暂存区 ⇄ HEAD'],
    ['head', '工作区 ⇄ HEAD'],
    ['untracked', '未跟踪（整文件）'],
  ];
  return `<div style="display:flex;gap:6px;flex-wrap:wrap">
    ${opts.map(([v, label]) => `<button class="btn sm ${sel.scope === v ? 'active' : ''}" data-act="set-scope" data-scope="${v}">${label}</button>`).join('')}
  </div>`;
}

function renderDetail() {
  const el = $('detail');
  if (!S.sel) {
    const snap = S.snap;
    el.innerHTML = `<div class="empty-state">
      <div class="big">◆</div>
      <h3>选择一个文件或提交</h3>
      <p>左栏是分支、标签、stash 与远端；中栏是工作区变更与提交历史。<br/>点击任意条目，这里会显示 diff 或提交详情。</p>
      ${snap?.clean ? '<p class="muted">当前工作区是干净的。</p>' : ''}
      ${snap?.head?.state === 'unborn' ? '<p class="muted">这个仓库还没有第一次提交（unborn HEAD）。</p>' : ''}
    </div>`;
    return;
  }

  const d = S.detail;
  if (!d) {
    el.innerHTML = `<div class="empty-state">加载中…</div>`;
    return;
  }
  if (d.error) {
    el.innerHTML = `<div class="empty-state"><div class="big">⚠</div><h3>无法加载</h3><p>${esc(d.error)}</p></div>`;
    return;
  }

  if (S.sel.kind === 'commit') {
    const c = d.commit;
    const statSummary = d.stat?.summary || '';
    el.innerHTML = `
      <div class="detail-head">
        <span class="btn sm ghost" data-act="clear-sel">✕</span>
        <span class="title">提交 ${esc(c.short)}</span>
        ${c.isMerge ? '<span class="chip warn">合并提交</span>' : ''}
        ${c.refs.map((r) => `<span class="ref-badge ${refBadgeClass(r)}">${esc(r)}</span>`).join('')}
        <span style="flex:1"></span>
        <button class="btn sm" data-act="copy" data-copy="${esc(c.hash)}">复制 hash</button>
        ${c.parents.length ? `<button class="btn sm" data-act="open-commit" data-rev="${esc(c.parents[0].hash)}">← 父提交 ${esc(c.parents[0].short)}</button>` : ''}
      </div>
      <div class="detail-body">
        <div class="msg-box"><div class="subj">${esc(c.subject)}</div>${c.body ? esc(c.body) : ''}</div>
        <div class="cards">
          <div class="card"><dt>完整 hash</dt><dd class="mono">${esc(c.hash)}</dd></div>
          <div class="card"><dt>作者</dt><dd>${esc(c.author)} &lt;${esc(c.authorEmail)}&gt;</dd></div>
          <div class="card"><dt>提交时间</dt><dd>${esc(absTime(c.commitDate))} <span class="muted">(${esc(relTime(c.commitDate))})</span></dd></div>
          <div class="card"><dt>父提交</dt><dd class="mono">${c.parents.length ? c.parents.map((p) => esc(p.short)).join(', ') : '（根提交）'}</dd></div>
        </div>
        ${statSummary ? `<div class="stat-summary">${esc(statSummary)}${c.isMerge ? ' · 以下差异相对第一个父提交' : ''}</div>` : ''}
        ${d.truncated ? '<div class="banner" style="border-radius:6px;margin-bottom:8px">补丁过长，已截断</div>' : ''}
        ${commitFilesHtml(d)}
      </div>`;
    return;
  }

  if (S.sel.kind === 'blob') {
    const f = d;
    el.innerHTML = `
      <div class="detail-head">
        <span class="btn sm ghost" data-act="clear-sel">✕</span>
        <span class="title">${esc(f.path)}</span>
        <span class="chip">${esc(f.source)}</span>
        <span class="chip mono">${fmtBytes(f.size)}</span>
        <span style="flex:1"></span>
        <button class="btn sm" data-act="copy" data-copy="${esc(f.path)}">复制路径</button>
      </div>
      <div class="detail-body">
        ${f.binary ? `<div class="empty-state">二进制文件（${fmtBytes(f.size)}），不显示内容</div>` : renderBlob(f.content)}
      </div>`;
    return;
  }

  // 文件 diff
  const sel = S.sel;
  const stat = d.stat
    ? `<span class="chip" style="color:var(--green)">+${d.stat.additions}</span><span class="chip" style="color:var(--red)">-${d.stat.deletions}</span>`
    : '';
  el.innerHTML = `
    <div class="detail-head">
      <span class="btn sm ghost" data-act="clear-sel">✕</span>
      <span class="title">${esc(sel.path)}</span>
      <span class="chip mono">${esc(sel.code || '')}</span>
      ${stat}
      <span style="flex:1"></span>
      <button class="btn sm" data-act="view-blob">查看文件内容</button>
      <button class="btn sm" data-act="copy" data-copy="${esc(sel.path)}">复制路径</button>
    </div>
    <div class="detail-body">
      <div style="margin-bottom:8px">${scopeButtons(sel)}</div>
      ${d.note ? `<div class="banner" style="border-radius:6px;margin-bottom:8px">${esc(d.note)}</div>` : ''}
      ${d.binary ? '<div class="empty-state">二进制文件，无文本 diff</div>' : renderDiffText(d.diff)}
    </div>`;
}

/* ------------------------------ 渲染总入口 ------------------------------ */

function renderStatusbar() {
  const snap = S.snap;
  const bits = [];
  if (snap) {
    bits.push(`<span>${esc(snap.repo.path)}</span>`);
    bits.push(
      `<span>Δ 暂存 ${snap.counts.staged} · 未暂存 ${snap.counts.unstaged} · 未跟踪 ${snap.counts.untracked}${snap.counts.conflicted ? ` · 冲突 ${snap.counts.conflicted}` : ''}</span>`,
    );
    bits.push(`<span>提交 ${snap.stats.commits}</span>`);
    bits.push(`<span>状态耗时 ${snap.buildMs}ms</span>`);
  }
  bits.push(`<span style="flex:1"></span>`);
  bits.push(`<span>更新于 ${S.lastFetchAt ? esc(absTime(S.lastFetchAt)) : '—'}</span>`);
  bits.push(`<span>${S.connected ? 'SSE 已连接' : S.pollTimer ? '轮询模式' : '未连接'}</span>`);
  if (S.err) bits.push(`<span style="color:var(--red)">${esc(S.err)}</span>`);
  $('statusbar').innerHTML = bits.join('');

  const banner = $('op-banner');
  if (snap?.operation) {
    banner.className = `banner${snap.operation.type === 'lock' ? ' error' : ''}`;
    banner.textContent = `⚠ ${snap.operation.label}${snap.operation.detail ? ` · ${snap.operation.detail}` : ''}`;
  } else {
    banner.className = 'banner hidden';
  }
}

function render() {
  renderTop();
  renderThemeButton();
  renderLive();
  renderSidebar();
  renderList();
  renderDetail();
  renderStatusbar();
}

/* ------------------------------ 交互 ------------------------------ */

const listItems = () => (S.tab === 'status' ? [...document.querySelectorAll('#listbody .file-item')] : [...document.querySelectorAll('#listbody .commit-item')]);

function moveCursor(delta) {
  const items = listItems();
  if (!items.length) return;
  S.cursor = Math.max(0, Math.min(items.length - 1, S.cursor + delta));
  items.forEach((el, i) => el.classList.toggle('sel', i === S.cursor));
  items[S.cursor].scrollIntoView({ block: 'nearest' });
}

function activateCursor() {
  const el = listItems()[S.cursor];
  if (el) el.click();
}

async function openFile(path, scope, code) {
  S.sel = { kind: 'file', path, scope, code };
  S.cursor = listItems().findIndex((el) => el.dataset.path === path && el.dataset.scope === scope);
  render();
  await loadDetail();
}

async function openCommit(rev) {
  S.sel = { kind: 'commit', rev };
  render();
  await loadDetail();
}

async function setHistoryRef(ref) {
  S.historyRef = ref || '';
  S.tab = 'history';
  await loadLog({ silent: false });
}

async function viewBlob() {
  if (S.sel?.kind !== 'file') return;
  const path = S.sel.path;
  const scope = S.sel.scope === 'index' ? 'index' : 'worktree';
  S.sel = { kind: 'blob', path, scope, rev: 'HEAD' };
  await loadDetail();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'open-file') {
    await openFile(t.dataset.path, t.dataset.scope, t.dataset.code);
  } else if (act === 'open-commit') {
    await openCommit(t.dataset.rev);
  } else if (act === 'set-ref') {
    await setHistoryRef(t.dataset.ref);
  } else if (act === 'clear-ref') {
    await setHistoryRef('');
  } else if (act === 'toggle-all') {
    S.allRefs = !S.allRefs;
    await loadLog({ silent: false });
  } else if (act === 'set-scope') {
    if (S.sel?.kind === 'file') {
      S.sel = { ...S.sel, scope: t.dataset.scope };
      await loadDetail();
    }
  } else if (act === 'view-blob') {
    await viewBlob();
  } else if (act === 'clear-sel') {
    S.sel = null;
    S.detail = null;
    render();
  } else if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(t.dataset.copy || '');
      toast('已复制', 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  }
});

$('tabs').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (!tab) return;
  S.tab = tab.dataset.tab;
  S.cursor = 0;
  render();
  if (S.tab === 'history' && !S.log.length) loadLog();
});

$('repo-select').addEventListener('change', async (ev) => {
  S.repoId = ev.target.value;
  S.sel = null;
  S.detail = null;
  S.historyRef = '';
  S.log = [];
  S.cursor = 0;
  connectStream();
  await refreshAll();
});

$('btn-refresh').addEventListener('click', () => refreshAll());
$('btn-theme').addEventListener('click', () => toggleTheme());

// 用户没显式选过主题时，跟随系统切换
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onSystemTheme = () => {
    if (!S.themeExplicit) applyTheme(resolveTheme(null, mq.matches));
  };
  if (mq.addEventListener) mq.addEventListener('change', onSystemTheme);
  else if (mq.addListener) mq.addListener(onSystemTheme);
}

document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, select, textarea')) return;
  if (ev.key === 'r' && !ev.ctrlKey && !ev.metaKey) refreshAll();
  else if (ev.key === 't' && !ev.ctrlKey && !ev.metaKey) toggleTheme();
  else if (ev.key === '1') {
    S.tab = 'status';
    render();
  } else if (ev.key === '2') {
    S.tab = 'history';
    render();
    if (!S.log.length) loadLog();
  } else if (ev.key === 'j') moveCursor(1);
  else if (ev.key === 'k') moveCursor(-1);
  else if (ev.key === 'Enter') activateCursor();
  else if (ev.key === 'Escape') $('help-modal').classList.add('hidden');
});

$('btn-help').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
$('btn-close-help').addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-modal').addEventListener('click', (ev) => {
  if (ev.target.id === 'help-modal') $('help-modal').classList.add('hidden');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAll();
});

/* ------------------------------ SSE / 轮询 ------------------------------ */

let streamFails = 0;

function startPolling(reason) {
  if (S.pollTimer) return;
  S.pollTimer = setInterval(() => refreshAll(), 2500);
  if (reason) toast(reason);
  renderLive();
}

function stopPolling() {
  if (S.pollTimer) {
    clearInterval(S.pollTimer);
    S.pollTimer = null;
  }
}

function connectStream() {
  if (S.stream) {
    try {
      S.stream.close();
    } catch {
      /* ignore */
    }
    S.stream = null;
  }
  const es = new EventSource(`/api/stream?${qs({ repo: S.repoId })}`);
  S.stream = es;

  es.addEventListener('hello', () => {
    S.connected = true;
    streamFails = 0;
    stopPolling();
    renderLive();
  });

  es.addEventListener('change', async (ev) => {
    let payload = {};
    try {
      payload = JSON.parse(ev.data);
    } catch {
      /* ignore */
    }
    S.lastEventAt = payload.at || new Date().toISOString();
    await refreshAll({ silent: true });
    renderLive();
  });

  es.addEventListener('watch-error', (ev) => {
    let payload = {};
    try {
      payload = JSON.parse(ev.data);
    } catch {
      /* ignore */
    }
    startPolling(`文件监听不可用（${payload.message || '未知原因'}），已切换到 2.5s 轮询`);
  });

  es.addEventListener('ping', () => {
    S.connected = true;
    renderLive();
  });

  es.onerror = () => {
    S.connected = false;
    streamFails += 1;
    renderLive();
    if (streamFails >= 2) startPolling('实时连接不稳定，已启用轮询兜底');
    // EventSource 会自动重连，这里不手动关闭
  };
}

/* ------------------------------ 启动 ------------------------------ */

(async function boot() {
  initTheme();
  try {
    await loadRepos();
  } catch (e) {
    document.body.innerHTML = `<div class="empty-state" style="padding:60px">无法连接后端：${esc(e.message)}</div>`;
    return;
  }
  if (!S.repos.length) {
    document.body.innerHTML = `<div class="empty-state" style="padding:60px">后端没有登记任何仓库，请用 <code>--repo &lt;path&gt;</code> 启动。</div>`;
    return;
  }
  render();
  connectStream();
  await loadState();
  await loadLog({ silent: true });
  render();

  // 首次进入给一个有用的默认选择
  if (S.snap) {
    const first = S.snap.conflicted[0] || S.snap.unstaged[0] || S.snap.staged[0] || S.snap.untracked[0];
    if (first) {
      const scope = S.snap.conflicted.includes(first) || S.snap.unstaged.includes(first) ? 'worktree' : S.snap.staged.includes(first) ? 'index' : 'untracked';
      await openFile(first.path, scope, first.code);
    } else if (S.log[0]) {
      await openCommit(S.log[0].hash);
    }
  }
})();
