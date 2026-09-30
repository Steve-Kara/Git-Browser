/**
 * Git Browser 纯函数库
 *
 * 这里只放不依赖 DOM 的逻辑（格式化、diff 渲染、提交泳道计算），
 * 因此可以在 Node 里直接 import 做单元测试。浏览器端由 app.js 引入。
 */

export const LANE_W = 12;
export const ROW_H = 22;
export const LANE_COUNT = 8;

/* ---------------------------- 主题 ---------------------------- */

export const THEMES = ['dark', 'light'];

/** 决定初始主题：用户显式选择 > 系统偏好 > 深色 */
export function resolveTheme(saved, prefersLight) {
  if (saved === 'light' || saved === 'dark') return saved;
  return prefersLight ? 'light' : 'dark';
}

export function otherTheme(theme) {
  return theme === 'light' ? 'dark' : 'light';
}

/** 按钮上显示的图标 = 当前主题 */
export function themeIcon(theme) {
  return theme === 'light' ? '☀️' : '🌙';
}

export function themeName(theme) {
  return theme === 'light' ? '浅色' : '深色';
}

export function themeButtonTitle(theme) {
  return `当前：${themeName(theme)}模式 · 点击切换到${themeName(otherTheme(theme))}模式 (t)`;
}

/** 列表分组定义（与 /api/state 字段对应） */
export const GROUPS = [
  { key: 'conflicted', title: '冲突', code: 'U' },
  { key: 'staged', title: '已暂存', scope: 'index' },
  { key: 'unstaged', title: '未暂存', scope: 'worktree' },
  { key: 'untracked', title: '未跟踪', scope: 'untracked' },
];

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  }
  return u.toString();
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = now - t;
  const abs = Math.abs(d);
  const fut = d < 0;
  const s = Math.round(abs / 1000);
  if (s < 45) return fut ? '即将' : '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return fut ? `${m} 分钟后` : `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return fut ? `${h} 小时后` : `${h} 小时前`;
  const day = Math.round(h / 24);
  if (day < 30) return fut ? `${day} 天后` : `${day} 天前`;
  const mo = Math.round(day / 30);
  if (mo < 12) return fut ? `${mo} 个月后` : `${mo} 个月前`;
  return fut ? `${Math.round(mo / 12)} 年后` : `${Math.round(mo / 12)} 年前`;
}

export function absTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function splitPath(p) {
  const i = String(p).lastIndexOf('/');
  if (i < 0) return { dir: '', base: p };
  return { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

/* ---------------------------- diff 渲染 ---------------------------- */

export function diffRow(kind, oldNo, newNo, text) {
  const ln = `${oldNo === '' ? '' : oldNo}`.padStart(4);
  const rn = `${newNo === '' ? '' : newNo}`.padStart(4);
  return `<div class="dl ${kind}"><span class="ln">${ln}</span><span class="ln">${rn}</span><span class="tx">${esc(text) || ' '}</span></div>`;
}

/** 把统一 diff 文本渲染成带行号的 HTML 行集合 */
export function renderDiffRows(text) {
  const all = String(text ?? '').split('\n');
  const CAP = 5000;
  let oldNo = 0;
  let newNo = 0;
  const out = [];
  const shown = all.length > CAP ? all.slice(0, CAP) : all;
  for (const line of shown) {
    if (line.startsWith('@@')) {
      // 普通 hunk: @@ -a,b +c,d @@   合并冲突的 combined hunk: @@@ -a,b -c,d +e,f @@@
      const m = line.match(/^@{2,} -(\d+)(?:,\d+)?(?:\s+-(\d+)(?:,\d+)?)?\s+\+(\d+)/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[3]);
      }
      out.push(diffRow('hunk', '', '', line));
      continue;
    }
    if (/^(diff --git|diff --cc|diff --combined|index |new file|deleted file|old mode|new mode|similarity|rename |copy |--- |\+\+\+ |\\ )/.test(line)) {
      out.push(diffRow('meta', '', '', line));
      continue;
    }
    if (line.startsWith('+')) out.push(diffRow('add', '', newNo++, line));
    else if (line.startsWith('-')) out.push(diffRow('del', oldNo++, '', line));
    else out.push(diffRow('ctx', oldNo++, newNo++, line));
  }
  if (all.length > CAP) out.push(`<div class="empty-state">diff 过长，仅渲染前 ${CAP} 行</div>`);
  return out.join('');
}

export function renderDiffText(text) {
  if (!text) return '<div class="empty-state">没有差异</div>';
  return `<div class="diff">${renderDiffRows(text)}</div>`;
}

/** 从 `diff --git` 头里取出文件路径（兼容 git 的引号包裹形式） */
export function diffPath(line) {
  const quoted = line.match(/^diff --git "a\/(.*)" "b\/(.*)"$/);
  if (quoted) return quoted[2];
  const plain = line.match(/^diff --git a\/(.*) b\/(.*)$/);
  if (plain) return plain[2];
  return line.replace(/^diff --git /, '');
}

/** 把整段 patch 按文件切成多块 */
export function splitPatch(text) {
  const chunks = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) chunks.push(cur);
      cur = { path: diffPath(line), lines: [line] };
    } else {
      if (!cur) cur = { path: '', lines: [] };
      cur.lines.push(line);
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.lines.some((l) => l.length > 0));
}

export function chunkStat(chunk) {
  let additions = 0;
  let deletions = 0;
  for (const l of chunk.lines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) additions++;
    else if (l.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/** 提交详情里的「按文件折叠」视图 */
export function commitFilesHtml(d) {
  const statMap = new Map();
  for (const f of d.stat?.files || []) {
    statMap.set(f.path, f);
    statMap.set(f.path.replace(/\\/g, '/'), f);
  }
  const chunks = splitPatch(d.patch);
  if (!chunks.length) {
    const files = d.stat?.files || [];
    if (!files.length) {
      return '<div class="empty-state">这个提交没有相对第一个父提交的内容改动（例如纯合并或空提交）</div>';
    }
    return `<div class="cards">${files
      .map(
        (f) =>
          `<div class="card"><dt>${esc(f.path)}</dt><dd>${
            f.binary ? '二进制' : `<span style="color:var(--green)">+${f.added}</span> <span style="color:var(--red)">-${f.removed}</span>`
          } <span class="muted">${esc(f.info)}</span></dd></div>`,
      )
      .join('')}</div>`;
  }
  return chunks
    .map((ch) => {
      const st = statMap.get(ch.path) || statMap.get(ch.path.replace(/^"|"$/g, ''));
      const computed = chunkStat(ch);
      const added = st ? st.added : computed.additions;
      const removed = st ? st.removed : computed.deletions;
      const status = ch.lines.some((l) => l.startsWith('new file'))
        ? 'A'
        : ch.lines.some((l) => l.startsWith('deleted file'))
          ? 'D'
          : ch.lines.some((l) => l.startsWith('rename '))
            ? 'R'
            : 'M';
      return `<details class="filediff" ${chunks.length <= 12 ? 'open' : ''}>
      <summary>
        <span class="code ${status}">${status}</span>
        <span class="mono fname">${esc(ch.path)}</span>
        <span class="statbar"><span style="color:var(--green)">+${added}</span> <span style="color:var(--red)">-${removed}</span></span>
      </summary>
      <div class="diff">${renderDiffRows(ch.lines.join('\n'))}</div>
    </details>`;
    })
    .join('');
}

/* ---------------------------- 提交泳道图 ---------------------------- */

/** 由提交列表（新→旧，含 parents）计算每行的泳道 */
export function computeRows(commits) {
  let lanes = [];
  const rows = [];
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      lanes.push(c.hash);
      col = lanes.length - 1;
    }
    const incoming = lanes.slice();
    const parents = c.parents || [];
    const kept = lanes.filter((h, i) => i !== col && !parents.includes(h));
    const outgoing = [...kept.slice(0, col), ...parents, ...kept.slice(col)];
    lanes = outgoing;
    rows.push({
      commit: c,
      col,
      incoming,
      outgoing,
      maxLane: Math.max(incoming.length, outgoing.length, col + 1),
      edges: parents.map((p) => ({ from: col, to: outgoing.indexOf(p) })).filter((e) => e.to >= 0),
    });
  }
  return rows;
}

/**
 * 泳道图 SVG。颜色不写死在这里，而是用 lane-N class 交给 CSS 变量，
 * 这样切换主题时不需要重新渲染列表。
 */
export function graphSvg(row) {
  const x = (i) => 1 + i * LANE_W + LANE_W / 2;
  const h = ROW_H;
  const w = Math.max(row.maxLane, 1) * LANE_W + 2;
  const lane = (i) => `lane-${((i % LANE_COUNT) + LANE_COUNT) % LANE_COUNT}`;
  const parts = [];
  for (let i = 0; i < Math.max(row.incoming.length, row.outgoing.length); i++) {
    if (row.incoming[i] && row.outgoing[i]) {
      parts.push(`<line class="${lane(i)}" x1="${x(i)}" y1="0" x2="${x(i)}" y2="${h}"/>`);
    }
  }
  for (const e of row.edges) {
    const x1 = x(e.from);
    const x2 = x(e.to);
    parts.push(`<path class="${lane(e.to)}" d="M ${x1} ${h / 2} C ${x1} ${h}, ${x2} ${h / 2}, ${x2} ${h}"/>`);
  }
  parts.push(`<circle class="${lane(row.col)}" cx="${x(row.col)}" cy="${h / 2}" r="3.6"/>`);
  return `<svg class="graph" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

export function refBadgeClass(ref) {
  if (/^HEAD/.test(ref)) return 'head';
  if (/^tag:/.test(ref)) return 'tag';
  if (/^origin\/|^[^/]+\//.test(ref)) return 'remote';
  return '';
}
