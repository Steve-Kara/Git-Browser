#!/usr/bin/env node
/**
 * Git Browser — 实时 Git 仓库信息面板
 *
 * 零依赖：只用 Node 内置模块 + 系统 git 可执行文件。
 *
 * 设计要点：
 *  - 后端只读仓库（不做任何写操作），所有数据都来自 git 命令 + .git 目录读取。
 *  - 子进程输出捕获会自动在两种模式间选择：
 *      1) pipe  模式：常规环境（最快）
 *      2) file  模式：受限沙箱下禁止管道 stdio 时的回退（重定向到临时文件）
 *  - 实时性：fs.watch 递归监听仓库（含 .git），防抖后通过 SSE 推送变更事件；
 *    监听不可用时前端自动降级为轮询。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * 命令行参数
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    host: '127.0.0.1',
    port: Number(process.env.PORT || 8787),
    repos: [],
    watch: 'all', // all | git | poll
    open: false,
    help: false,
  };
  const push = (v) => {
    for (const part of String(v).split(/[;,]/)) {
      const p = part.trim();
      if (p) opts.repos.push(p);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') opts.port = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--repo' || a === '-r') push(next());
    else if (a === '--watch') opts.watch = next();
    else if (a === '--open') opts.open = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-')) push(a);
  }
  if (process.env.GIT_BROWSER_REPOS) push(process.env.GIT_BROWSER_REPOS);
  if (!opts.repos.length) opts.repos.push(APP_DIR);
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));

const HELP = `
Git Browser v${VERSION} — 实时 Git 仓库信息面板

用法:
  node server.mjs [选项] [仓库路径...]

选项:
  -p, --port <n>     监听端口 (默认 8787)
      --host <addr>  监听地址 (默认 127.0.0.1，仅本机可访问)
  -r, --repo <path>  要浏览的仓库路径，可重复或用逗号分隔 (默认: 本文件所在目录)
      --watch <mode> all | git | poll   监听模式 (默认 all)
  -h, --help         显示帮助

环境变量:
  PORT                  同 --port
  GIT_BROWSER_REPOS     同 --repo，多个用 ; 或 , 分隔

示例:
  node server.mjs                                  # 浏览本目录
  node server.mjs -r "C:\\code\\proj" -p 9000       # 浏览另一个仓库
  node server.mjs -r projA -r projB                # 多仓库，页面右上角切换
`.trim();

/* ------------------------------------------------------------------ *
 * 临时目录（file 模式下用来接收子进程输出）
 * ------------------------------------------------------------------ */

const TMP_DIR = (() => {
  const candidates = [os.tmpdir(), APP_DIR, process.cwd()];
  for (const base of candidates) {
    try {
      return fs.mkdtempSync(path.join(base, 'git-browser-'));
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('无法创建临时目录');
})();

const cleanupTasks = [];
process.on('exit', () => {
  for (const t of cleanupTasks) {
    try {
      t();
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ *
 * git 执行器：pipe 优先，EPERM 时回退到文件重定向
 * ------------------------------------------------------------------ */

let spawnMode = null; // 'pipe' | 'file'
let tmpCounter = 0;

function probePipeMode(cwd) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (mode) => {
      if (!settled) {
        settled = true;
        resolve(mode);
      }
    };
    let child;
    try {
      child = spawn('git', ['--version'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      done('file');
      return;
    }
    child.on('error', () => done('file'));
    child.on('exit', () => done('pipe'));
    setTimeout(() => done('pipe'), 4000).unref?.();
  });
}

async function runPipe(args, cwd, input, timeout) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const err = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeout);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? 124 : code ?? 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut: killed,
      });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runFile(args, cwd, input, timeout) {
  const id = `${process.pid}-${++tmpCounter}`;
  const outFile = path.join(TMP_DIR, `${id}.out`);
  const errFile = path.join(TMP_DIR, `${id}.err`);
  const inFile = input != null ? path.join(TMP_DIR, `${id}.in`) : null;
  if (inFile) fs.writeFileSync(inFile, input);

  const ofd = fs.openSync(outFile, 'w');
  const efd = fs.openSync(errFile, 'w');
  const ifd = inFile ? fs.openSync(inFile, 'r') : null;
  try {
    const code = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd,
          stdio: [ifd ?? 'ignore', ofd, efd],
          windowsHide: true,
        });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, timeout);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c ?? 0);
      });
    });
    return {
      code,
      stdout: fs.readFileSync(outFile, 'utf8'),
      stderr: fs.readFileSync(errFile, 'utf8'),
      timedOut: false,
    };
  } finally {
    for (const fd of [ofd, efd, ifd]) {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    for (const f of [outFile, errFile, inFile]) {
      if (f) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/**
 * 运行一条 git 命令。非 0 退出码不会抛错（返回 code），只有 spawn 层面失败才抛。
 * 统一关闭 core.quotePath：否则中文等非 ASCII 路径会被 octal 转义成 "\344\270\255…"。
 */
async function git(args, { cwd, input = null, timeout = 30000 } = {}) {
  if (spawnMode === null) spawnMode = await probePipeMode(cwd);

  const full = args[0] === '--version' ? args : ['-c', 'core.quotePath=false', ...args];
  const attempt = (mode) => (mode === 'pipe' ? runPipe(full, cwd, input, timeout) : runFile(full, cwd, input, timeout));

  try {
    const res = await attempt(spawnMode);
    return res;
  } catch (err) {
    // 受限沙箱：管道 stdio 被拒 → 永久切到 file 模式重试一次
    if (spawnMode === 'pipe') {
      spawnMode = 'file';
      try {
        return await attempt('file');
      } catch (err2) {
        return { code: -1, stdout: '', stderr: `spawn failed: ${err2.message}`, error: err2.message };
      }
    }
    return { code: -1, stdout: '', stderr: `spawn failed: ${err.message}`, error: err.message };
  }
}

/** 解析 `git --stat` 输出 */
function parseStat(raw) {
  const files = [];
  let summary = '';
  for (const line of lines(raw)) {
    if (/files? changed|insertions?\(|deletions?\(/.test(line)) {
      summary = line.trim();
      continue;
    }
    const m = line.match(/^(.*?)\s*\|\s*(.+)$/);
    if (!m) continue;
    const rawPath = m[1].trim();
    const info = m[2].trim();
    const binary = /^Bin\b/i.test(info);
    const added = (info.match(/\+/g) || []).length;
    const removed = (info.match(/-/g) || []).length;
    const count = Number((info.match(/^(\d+)/) || [])[1] ?? 0);
    let p = rawPath;
    const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (brace) p = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/');
    else if (p.includes(' => ')) p = p.split(' => ').pop().trim();
    p = p.replace(/^"|"$/g, '');
    files.push({ path: p, rawPath, info, added, removed, count, binary });
  }
  return { files, summary };
}

const trim = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
const lines = (s) => trim(s).split('\n').filter((l) => l.length > 0);

/* ------------------------------------------------------------------ *
 * 仓库注册表
 * ------------------------------------------------------------------ */

const REPOS = [];
let repoSeq = 0;

function slugify(p) {
  const base = path.basename(p) || 'repo';
  return base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

async function registerRepo(rawPath) {
  const abs = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { path: abs, error: `路径不存在: ${abs}` };
  }
  if (!stat.isDirectory()) return { path: abs, error: `不是目录: ${abs}` };

  // 注意：bare 仓库里 --show-toplevel 会失败，所以分开探测，不能一次 rev-parse 全都要
  const gitDirRes = await git(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: abs });
  if (gitDirRes.code !== 0) {
    return { path: abs, error: `不是 git 仓库: ${abs}` };
  }
  const gitDir = trim(gitDirRes.stdout) || path.join(abs, '.git');
  const bare = trim((await git(['rev-parse', '--is-bare-repository'], { cwd: abs })).stdout) === 'true';
  let worktree = null;
  if (!bare) {
    const topRes = await git(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd: abs });
    worktree = trim(topRes.stdout) || abs;
  }

  const id = `${slugify(abs)}-${repoSeq++}`;
  const repo = {
    id,
    name: path.basename(abs) || abs,
    path: abs,
    worktree,
    gitDir,
    bare,
    gitVersion: trim((await git(['--version'], { cwd: abs })).stdout),
  };
  return repo;
}

async function initRepos() {
  const problems = [];
  for (const p of ARGS.repos) {
    const repo = await registerRepo(p);
    if (repo.error) problems.push(repo.error);
    else REPOS.push(repo);
  }
  return problems;
}

function repoById(id) {
  if (!id) return REPOS[0] || null;
  return REPOS.find((r) => r.id === id) || null;
}

/* ------------------------------------------------------------------ *
 * 状态解析
 * ------------------------------------------------------------------ */

const CODE_LABEL = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '冲突',
  '?': '未跟踪',
  '!': '已忽略',
};

function codeLabel(ch) {
  return CODE_LABEL[ch] || ch;
}

/** 解析 `git status --porcelain=v2 --branch -z` */
function parseStatusPorcelainV2(raw) {
  const res = {
    branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ignored: [],
  };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const kind = t[0];
    if (kind === '#') {
      const rest = t.slice(1).trim();
      if (rest.startsWith('branch.oid ')) {
        const v = rest.slice('branch.oid '.length).trim();
        res.branch.oid = v === '(initial)' ? null : v;
      } else if (rest.startsWith('branch.head ')) {
        const v = rest.slice('branch.head '.length).trim();
        res.branch.head = v === '(detached)' ? null : v;
        res.branch.detached = v === '(detached)';
      } else if (rest.startsWith('branch.upstream ')) {
        res.branch.upstream = rest.slice('branch.upstream '.length).trim();
      } else if (rest.startsWith('branch.ab ')) {
        const m = rest.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          res.branch.ahead = Number(m[1]);
          res.branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    if (kind === '1' || kind === '2') {
      const f = t.split(' ');
      const xy = f[1] || '..';
      const isRename = kind === '2';
      const p = f.slice(isRename ? 9 : 8).join(' ');
      const origPath = isRename ? tokens[++i] : null;
      const entry = {
        path: p,
        origPath,
        x: xy[0],
        y: xy[1],
        modeHead: f[6],
        modeIndex: f[7],
        sub: f[2],
      };
      if (entry.x !== '.' && entry.x !== ' ') {
        res.staged.push({ ...entry, code: entry.x, codeLabel: codeLabel(entry.x) });
      }
      if (entry.y !== '.' && entry.y !== ' ') {
        res.unstaged.push({ ...entry, code: entry.y, codeLabel: codeLabel(entry.y) });
      }
      continue;
    }
    if (kind === 'u') {
      const f = t.split(' ');
      const xy = f[1] || 'UU';
      const p = f.slice(10).join(' ');
      res.conflicted.push({ path: p, xy, code: 'U', codeLabel: '冲突' });
      continue;
    }
    if (kind === '?') {
      res.untracked.push({ path: t.slice(2) });
      continue;
    }
    if (kind === '!') {
      res.ignored.push({ path: t.slice(2) });
      continue;
    }
  }
  return res;
}

function parseTrack(track) {
  if (!track) return { ahead: 0, behind: 0, gone: false };
  if (/gone/i.test(track)) return { ahead: 0, behind: 0, gone: true };
  const a = track.match(/ahead\s+(\d+)/i);
  const b = track.match(/behind\s+(\d+)/i);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, gone: false };
}

function detectOperation(repo) {
  const exists = (p) => {
    try {
      fs.statSync(path.join(repo.gitDir, p));
      return true;
    } catch {
      return false;
    }
  };
  const readTrim = (p) => {
    try {
      return fs.readFileSync(path.join(repo.gitDir, p), 'utf8').trim();
    } catch {
      return null;
    }
  };

  if (exists('rebase-merge')) {
    const head = readTrim('rebase-merge/head-name');
    const step = exists('rebase-merge/msgnum') ? `${readTrim('rebase-merge/msgnum')}/${readTrim('rebase-merge/end')}` : '';
    return { type: 'rebase', label: `变基进行中 (rebase)${step ? ` ${step}` : ''}`, detail: head };
  }
  if (exists('rebase-apply')) {
    const step = exists('rebase-apply/next') ? `${readTrim('rebase-apply/next')}/${readTrim('rebase-apply/last')}` : '';
    return { type: 'rebase', label: `am/rebase 进行中${step ? ` ${step}` : ''}`, detail: null };
  }
  if (exists('MERGE_HEAD')) {
    return { type: 'merge', label: '合并进行中 (merge)', detail: (readTrim('MERGE_HEAD') || '').slice(0, 7) };
  }
  if (exists('CHERRY_PICK_HEAD')) {
    return { type: 'cherry-pick', label: '拣选进行中 (cherry-pick)', detail: (readTrim('CHERRY_PICK_HEAD') || '').slice(0, 7) };
  }
  if (exists('REVERT_HEAD')) {
    return { type: 'revert', label: '回退进行中 (revert)', detail: (readTrim('REVERT_HEAD') || '').slice(0, 7) };
  }
  if (exists('BISECT_LOG')) {
    return { type: 'bisect', label: '二分查找进行中 (bisect)', detail: null };
  }
  if (exists('index.lock')) {
    return { type: 'lock', label: '检测到 index.lock：可能有 git 进程正在运行', detail: null };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 快照组装
 * ------------------------------------------------------------------ */

const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%D%x1e';

function parseLog(raw) {
  const commits = [];
  for (const rec of String(raw ?? '').split('\x1e')) {
    const r = rec.replace(/^\n+/, '');
    if (!r.trim()) continue;
    const f = r.split('\x1f');
    if (f.length < 9) continue;
    commits.push({
      hash: f[0],
      short: f[1],
      parents: f[2] ? f[2].split(' ').filter(Boolean) : [],
      author: f[3],
      email: f[4],
      authorDate: f[5],
      commitDate: f[6],
      subject: f[7],
      refs: f[8] ? f[8].split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
  }
  return commits;
}

async function buildState(repo) {
  const started = Date.now();
  const cwd = repo.worktree || repo.path;
  const g = (args) => git(args, { cwd });

  const [statusRes, headMeta, refsRes, remotesRes, stashRes, userRes, countRes, objectsRes, describeRes] = await Promise.all([
    g(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=no']),
    g(['log', '-1', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%cn%x1f%s%x1f%b']),
    g([
      'for-each-ref',
      '--format=%(refname)%1f%(objectname)%1f%(objectname:short)%1f%(objecttype)%1f%(committerdate:iso-strict)%1f%(authorname)%1f%(subject)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]),
    g(['remote', '-v']),
    g(['stash', 'list', '--format=%gd%x1f%ct%x1f%s']),
    g(['config', '--get-regexp', '^(user\\.(name|email)|core\\.bare|branch\\..*\\.remote)$']),
    g(['rev-list', '--count', 'HEAD']),
    g(['count-objects', '-vH']),
    g(['describe', '--tags', '--always', '--dirty']),
  ]);

  const status = parseStatusPorcelainV2(statusRes.stdout);
  const branch = status.branch;

  // HEAD 提交元数据
  let head = {
    state: 'unborn',
    branch: branch.head,
    detached: Boolean(branch.detached),
    oid: branch.oid,
    short: branch.oid ? branch.oid.slice(0, 7) : null,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    describe: describeRes.code === 0 ? trim(describeRes.stdout) : null,
    subject: null,
    author: null,
    email: null,
    date: null,
    committer: null,
  };
  if (headMeta.code === 0) {
    const f = headMeta.stdout.split('\x1f');
    head = {
      ...head,
      state: branch.detached ? 'detached' : branch.head ? 'branch' : 'detached',
      short: f[1] || head.short,
      oid: f[0] || head.oid,
      author: f[2] || null,
      email: f[3] || null,
      date: f[4] || null,
      commitDate: f[5] || null,
      committer: f[6] || null,
      subject: f[7] || null,
      body: trim(f[8] || ''),
    };
  } else if (branch.head) {
    head.state = 'unborn';
  }

  // refs
  const local = [];
  const remoteBranches = [];
  const tags = [];
  for (const line of lines(refsRes.stdout)) {
    const f = line.split('\x1f');
    if (f.length < 10) continue;
    const refname = f[0];
    const track = parseTrack(f[8]);
    const item = {
      ref: refname,
      name: refname.replace(/^refs\/(heads|remotes|tags)\//, ''),
      oid: f[1],
      short: f[2],
      type: f[3],
      date: f[4] || null,
      author: f[5] || null,
      subject: f[6] || null,
      upstream: f[7] || null,
      ahead: track.ahead,
      behind: track.behind,
      gone: track.gone,
      current: f[9] === '*',
    };
    if (refname.startsWith('refs/heads/')) local.push(item);
    else if (refname.startsWith('refs/remotes/')) remoteBranches.push(item);
    else if (refname.startsWith('refs/tags/')) tags.push(item);
  }
  local.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name));
  tags.reverse(); // 通常按名称倒序近似“最新在前”

  // 远端
  const remotes = [];
  const remoteMap = new Map();
  for (const line of lines(remotesRes.stdout)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    let r = remoteMap.get(m[1]);
    if (!r) {
      r = { name: m[1], fetch: null, push: null, url: m[2], branches: 0 };
      remoteMap.set(m[1], r);
      remotes.push(r);
    }
    r[m[3]] = m[2];
  }
  for (const rb of remoteBranches) {
    if (/\/HEAD$/.test(rb.name)) continue; // 符号引用不算分支
    const remoteName = rb.name.split('/')[0];
    const r = remoteMap.get(remoteName);
    if (r) r.branches++;
  }

  // stash
  const stash = [];
  for (const line of lines(stashRes.stdout)) {
    const f = line.split('\x1f');
    if (f.length < 3) continue;
    stash.push({
      ref: f[0],
      index: Number((f[0].match(/\{(\d+)\}/) || [])[1] ?? 0),
      date: new Date(Number(f[1]) * 1000).toISOString(),
      subject: f[2],
    });
  }

  // 用户身份 / 配置
  const config = {};
  for (const line of lines(userRes.stdout)) {
    const sp = line.indexOf(' ');
    if (sp > 0) config[line.slice(0, sp)] = line.slice(sp + 1);
  }

  // 统计
  const stats = {
    commits: countRes.code === 0 ? Number(trim(countRes.stdout)) || 0 : 0,
    objectsSize: null,
    objectsCount: null,
    loose: null,
    packs: null,
  };
  for (const line of lines(objectsRes.stdout)) {
    const m = line.match(/^(count|size|in-pack|size-pack|packs|count-pack):\s*(.+)$/);
    if (!m) continue;
    if (m[1] === 'size-pack') stats.packs = m[2].trim();
    else if (m[1] === 'size') stats.objectsSize = m[2].trim();
    else if (m[1] === 'count') stats.objectsCount = m[2].trim();
    else if (m[1] === 'in-pack') stats.loose = m[2].trim();
    else if (m[1] === 'packs') stats.packsCount = m[2].trim();
  }

  // 最近一次 fetch（FETCH_HEAD 修改时间）
  let lastFetch = null;
  try {
    lastFetch = fs.statSync(path.join(repo.gitDir, 'FETCH_HEAD')).mtime.toISOString();
  } catch {
    /* ignore */
  }

  return {
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - started,
    gitVersion: repo.gitVersion,
    repo: {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      worktree: repo.worktree,
      gitDir: repo.gitDir,
      bare: repo.bare,
    },
    head,
    operation: detectOperation(repo),
    branch,
    user: { name: config['user.name'] || null, email: config['user.email'] || null },
    remotes,
    localBranches: local,
    remoteBranches,
    tags,
    stash,
    lastFetch,
    stats,
    counts: {
      staged: status.staged.length,
      unstaged: status.unstaged.length,
      untracked: status.untracked.length,
      conflicted: status.conflicted.length,
      ignored: status.ignored.length,
    },
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    conflicted: status.conflicted,
    clean: status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * diff / 文件内容
 * ------------------------------------------------------------------ */

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

function pseudoDiffForNewFile(p, content) {
  const ls = content.split('\n');
  const body = ls.map((l) => `+${l}`).join('\n');
  const header = [
    `diff --git a/${p} b/${p}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${p}`,
    `@@ -0,0 +1,${ls.length} @@`,
  ].join('\n');
  return `${header}\n${body}`;
}

async function buildDiff(repo, { scope = 'worktree', rev = 'HEAD', p }) {
  const cwd = repo.worktree || repo.path;
  const base = ['--no-color', '--no-ext-diff'];
  let args;
  if (scope === 'index') args = ['diff', '--cached', ...base, '--', p];
  else if (scope === 'head') args = ['diff', rev, ...base, '--', p];
  else if (scope === 'worktree') args = ['diff', ...base, '--', p];
  else if (scope === 'commit') args = ['show', '--format=', ...base, rev, '--', p];
  else if (scope === 'untracked') {
    const abs = path.join(cwd, p);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return { diff: '', missing: true };
    if (st.size > MAX_FILE_BYTES) {
      return { diff: '', tooLarge: true, size: st.size, note: `文件过大 (${st.size} 字节)，未生成 diff` };
    }
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return { diff: '', binary: true, size: st.size, note: '二进制文件（未跟踪）' };
    const text = buf.toString('utf8');
    const count = text.split('\n').length;
    return {
      diff: pseudoDiffForNewFile(p, text),
      size: st.size,
      newFile: true,
      stat: { additions: count, deletions: 0 },
    };
  } else {
    throw Object.assign(new Error(`未知 scope: ${scope}`), { statusCode: 400 });
  }

  const res = await git(args, { cwd, timeout: 20000 });
  if (res.code !== 0 && !res.stdout) {
    throw Object.assign(new Error(trim(res.stderr) || 'git diff 失败'), { statusCode: 500 });
  }
  let diff = res.stdout;
  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + '\n... (diff 已截断)';
  }
  const binary = /^Binary files .* differ$/m.test(diff) || /GIT binary patch/.test(diff);
  return {
    diff,
    binary,
    empty: diff.trim().length === 0,
    stat: {
      additions: (diff.match(/^\+(?!\+\+)/gm) || []).length,
      deletions: (diff.match(/^-(?!--)/gm) || []).length,
    },
  };
}

async function buildFile(repo, { scope = 'worktree', rev = 'HEAD', p }) {
  const cwd = repo.worktree || repo.path;
  let buf;
  let source;
  if (scope === 'worktree') {
    const abs = path.join(cwd, p);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || st.isDirectory()) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
    if (st.size > MAX_FILE_BYTES) return { tooLarge: true, size: st.size, path: p };
    buf = await fsp.readFile(abs);
    source = '工作区';
  } else if (scope === 'index') {
    const res = await git(['show', `:0:${p}`], { cwd });
    if (res.code !== 0) throw Object.assign(new Error(trim(res.stderr) || '无法读取暂存区文件'), { statusCode: 404 });
    buf = Buffer.from(res.stdout, 'utf8');
    source = '暂存区';
  } else {
    const res = await git(['show', `${rev}:${p}`], { cwd });
    if (res.code !== 0) throw Object.assign(new Error(trim(res.stderr) || `无法读取 ${rev}:${p}`), { statusCode: 404 });
    buf = Buffer.from(res.stdout, 'utf8');
    source = rev;
  }
  const binary = buf.includes(0);
  const meta = await git(['log', '-1', '--format=%h%x1f%an%x1f%aI%x1f%s', '--', p], { cwd });
  const last = meta.code === 0 && meta.stdout.trim() ? meta.stdout.split('\x1f') : null;
  return {
    path: p,
    source,
    size: buf.length,
    binary,
    content: binary ? null : buf.toString('utf8'),
    truncated: false,
    lastCommit: last ? { short: last[0], author: last[1], date: last[2], subject: last[3] } : null,
  };
}

/* ------------------------------------------------------------------ *
 * 实时监听 + SSE
 * ------------------------------------------------------------------ */

class RepoWatcher {
  constructor(repo) {
    this.repo = repo;
    this.clients = new Set();
    this.watchers = [];
    this.timer = null;
    this.lastEvent = null;
    this.reason = null;
    this.watchError = null;
    this.start();
  }

  start() {
    if (ARGS.watch === 'poll') return;
    const roots = [];
    if (this.repo.worktree) roots.push(this.repo.worktree);
    if (!roots.includes(this.repo.gitDir)) roots.push(this.repo.gitDir);
    for (const root of roots) {
      try {
        const w = fs.watch(root, { recursive: ARGS.watch === 'all' }, (event, filename) => {
          this.onEvent(root, filename);
        });
        w.on('error', (e) => {
          this.watchError = e.message;
          this.broadcast({ type: 'watch-error', message: e.message });
        });
        this.watchers.push(w);
      } catch (err) {
        this.watchError = err.message;
      }
    }
    if (ARGS.watch !== 'all' && this.repo.worktree) {
      // 仅监听 .git 时，另外浅监听工作区顶层，至少能感知顶层文件增删
      try {
        const w = fs.watch(this.repo.worktree, { recursive: false }, (event, filename) => this.onEvent(this.repo.worktree, filename));
        this.watchers.push(w);
      } catch {
        /* ignore */
      }
    }
    cleanupTasks.push(() => this.stop());
  }

  onEvent(root, filename) {
    const name = filename ? String(filename).replace(/\\/g, '/') : '';
    this.reason = name || root;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastEvent = new Date().toISOString();
      this.broadcast({ type: 'change', at: this.lastEvent, reason: this.reason });
    }, 220);
  }

  add(res) {
    this.clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', repo: this.repo.id, watchError: this.watchError })}\n\n`);
    cleanupTasks.push(() => this.clients.delete(res));
  }

  remove(res) {
    this.clients.delete(res);
  }

  broadcast(payload) {
    const name = payload.type || 'message';
    const data = `event: ${name}\ndata: ${JSON.stringify({ ...payload, repo: this.repo.id })}\n\n`;
    for (const res of [...this.clients]) {
      try {
        res.write(data);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  stop() {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
  }
}

const watchers = new Map(); // repo.id -> RepoWatcher

function watcherFor(repo) {
  let w = watchers.get(repo.id);
  if (!w) {
    w = new RepoWatcher(repo);
    watchers.set(repo.id, w);
  }
  return w;
}

// 心跳，保证 SSE 连接与代理不超时
setInterval(() => {
  for (const w of watchers.values()) {
    for (const res of [...w.clients]) {
      try {
        res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n\n`);
      } catch {
        w.clients.delete(res);
      }
    }
  }
}, 20000).unref?.();

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  rel = decodeURIComponent(rel);
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) return sendText(res, 404, 'not found');
    const body = await fsp.readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    sendText(res, 404, 'not found');
  }
}

function requireRepo(url, res) {
  const repo = repoById(url.searchParams.get('repo'));
  if (!repo) {
    sendJSON(res, 404, { error: '未找到仓库，请检查启动参数 --repo' });
    return null;
  }
  return repo;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        version: VERSION,
        node: process.version,
        git: process.env.GIT_VERSION || null,
        spawnMode,
        watch: ARGS.watch,
        repos: REPOS.map((r) => ({ id: r.id, name: r.name, path: r.path })),
      });
    }

    if (p === '/api/repos') {
      return sendJSON(res, 200, {
        repos: REPOS.map((r) => ({ id: r.id, name: r.name, path: r.path, gitDir: r.gitDir, bare: r.bare })),
      });
    }

    if (p === '/api/state') {
      const repo = requireRepo(url, res);
      if (!repo) return;
      const state = await buildState(repo);
      return sendJSON(res, 200, state);
    }

    if (p === '/api/log') {
      const repo = requireRepo(url, res);
      if (!repo) return;
      const cwd = repo.worktree || repo.path;
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 120), 1), 500);
      const skip = Math.max(Number(url.searchParams.get('skip') || 0), 0);
      const all = url.searchParams.get('all') === '1';
      const ref = url.searchParams.get('ref') || '';
      const pathFilter = url.searchParams.get('path') || '';
      const args = ['log', `--max-count=${limit}`, `--skip=${skip}`, `--date=iso-strict`, `--format=${LOG_FORMAT}`];
      if (all) args.push('--all');
      if (ref) args.push(ref);
      if (pathFilter) args.push('--', pathFilter);
      const r = await git(args, { cwd });
      const headExists = ref ? true : (await git(['rev-parse', '--verify', 'HEAD'], { cwd })).code === 0;
      if (r.code !== 0 && !headExists) {
        return sendJSON(res, 200, { commits: [], unborn: true, ref: ref || 'HEAD', total: 0 });
      }
      if (r.code !== 0) {
        return sendJSON(res, 400, { error: trim(r.stderr) || 'git log 失败' });
      }
      const commits = parseLog(r.stdout);
      return sendJSON(res, 200, { commits, unborn: false, ref: ref || 'HEAD', limit, skip, hasMore: commits.length === limit });
    }

    if (p === '/api/commit') {
      const repo = requireRepo(url, res);
      if (!repo) return;
      const cwd = repo.worktree || repo.path;
      const rev = url.searchParams.get('rev');
      if (!rev) return sendJSON(res, 400, { error: '缺少 rev 参数' });
      const metaRes = await git(['show', '-s', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%D%x1f%s%x1f%B', rev], { cwd });
      if (metaRes.code !== 0) return sendJSON(res, 404, { error: trim(metaRes.stderr) || '找不到该提交' });
      const f = metaRes.stdout.split('\x1f');
      const parentInfo = f[2] ? f[2].split(' ').map((h) => ({ hash: h, short: h.slice(0, 7) })) : [];
      const isMerge = parentInfo.length > 1;

      // 合并提交用 git show 默认不输出任何补丁，因此统一改为「相对第一个父提交」的差异
      const statRes = isMerge
        ? await git(['diff', '--stat', '--no-color', parentInfo[0].hash, rev], { cwd, timeout: 30000 })
        : await git(['show', '-s', '--stat', '--format=', '--no-color', rev], { cwd, timeout: 30000 });
      const patchRes = isMerge
        ? await git(['diff', '--no-color', '--no-ext-diff', '--patch', '--find-renames', parentInfo[0].hash, rev], { cwd, timeout: 30000 })
        : await git(['show', '--format=', '--no-color', '--no-ext-diff', '--patch', '--find-renames', rev], { cwd, timeout: 30000 });

      let patch = patchRes.stdout;
      const truncated = patch.length > MAX_DIFF_BYTES;
      if (truncated) patch = patch.slice(0, MAX_DIFF_BYTES) + '\n... (patch 已截断)';
      return sendJSON(res, 200, {
        commit: {
          hash: f[0],
          short: f[1],
          parents: parentInfo,
          isMerge,
          author: f[3],
          authorEmail: f[4],
          authorDate: f[5],
          committer: f[6],
          committerEmail: f[7],
          commitDate: f[8],
          refs: f[9] ? f[9].split(',').map((s) => s.trim()).filter(Boolean) : [],
          subject: f[10],
          body: trim(f[11] || ''),
        },
        stat: parseStat(statRes.stdout),
        patch,
        truncated,
      });
    }

    if (p === '/api/diff') {
      const repo = requireRepo(url, res);
      if (!repo) return;
      const filePath = url.searchParams.get('path');
      if (!filePath) return sendJSON(res, 400, { error: '缺少 path 参数' });
      const scope = url.searchParams.get('scope') || 'worktree';
      const rev = url.searchParams.get('rev') || 'HEAD';
      const result = await buildDiff(repo, { scope, rev, p: filePath });
      return sendJSON(res, 200, { path: filePath, scope, rev, ...result });
    }

    if (p === '/api/file') {
      const repo = requireRepo(url, res);
      if (!repo) return;
      const filePath = url.searchParams.get('path');
      if (!filePath) return sendJSON(res, 400, { error: '缺少 path 参数' });
      const scope = url.searchParams.get('scope') || 'worktree';
      const rev = url.searchParams.get('rev') || 'HEAD';
      const result = await buildFile(repo, { scope, rev, p: filePath });
      return sendJSON(res, 200, result);
    }

    if (p === '/api/stream') {
      const repo = requireRepo(url, res);
      if (!repo) return;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      const w = watcherFor(repo);
      w.add(res);
      req.on('close', () => w.remove(res));
      return;
    }

    if (p.startsWith('/api/')) {
      return sendJSON(res, 404, { error: `未知接口: ${p}` });
    }

    return serveStatic(req, res, p);
  } catch (err) {
    const code = err.statusCode || 500;
    sendJSON(res, code, { error: err.message || String(err) });
  }
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

(async () => {
  if (ARGS.help) {
    console.log(HELP);
    process.exit(0);
  }

  const problems = await initRepos();
  if (problems.length) {
    console.error('[git-browser] 警告:');
    for (const p of problems) console.error('  - ' + p);
  }
  if (!REPOS.length) {
    console.error('[git-browser] 没有可用的 git 仓库，退出。用 --repo <path> 指定仓库。');
    process.exit(1);
  }

  // 预热 spawn 模式探测
  spawnMode = await probePipeMode(REPOS[0].worktree || REPOS[0].path);
  const gv = await git(['--version'], { cwd: REPOS[0].path });
  process.env.GIT_VERSION = trim(gv.stdout);

  // 连接即用：默认仓库的监听器提前建好
  for (const r of REPOS) watcherFor(r);

  server.listen(ARGS.port, ARGS.host, () => {
    const url = `http://${ARGS.host === '0.0.0.0' ? '127.0.0.1' : ARGS.host}:${ARGS.port}`;
    console.log(`[git-browser] v${VERSION} 已启动: ${url}`);
    console.log(`[git-browser] git: ${process.env.GIT_VERSION}`);
    console.log(`[git-browser] 子进程输出模式: ${spawnMode}`);
    console.log(`[git-browser] 监听模式: ${ARGS.watch}`);
    for (const r of REPOS) console.log(`[git-browser] 仓库: ${r.name}  ${r.path}${r.bare ? '  (bare)' : ''}`);
    for (const r of REPOS) {
      const w = watchers.get(r.id);
      if (w && w.watchError) console.error(`[git-browser] 监听警告 (${r.name}): ${w.watchError}`);
    }
    if (ARGS.open) {
      try {
        const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
      } catch (err) {
        console.error(`[git-browser] 无法自动打开浏览器: ${err.message}`);
      }
    }
  });

  server.on('error', (err) => {
    console.error(`[git-browser] 启动失败: ${err.message}`);
    process.exit(1);
  });
})();
