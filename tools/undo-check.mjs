#!/usr/bin/env node
/**
 * 「撤销」端到端测试
 *
 * 这个脚本会：
 *   1. 在系统临时目录里造几个一次性仓库（两提交、合并冲突、仅一次提交）；
 *   2. 用 --repo 指向它们启动真实服务端（子进程 stdio 用 ignore，兼容受限沙箱）；
 *   3. 通过 HTTP 走完整的 inspect → 确认 → 撤销 流程，并用 git 独立核对仓库真实状态。
 *
 * 用法:
 *   node tools/undo-check.mjs
 *
 * 注意：只在临时目录里操作，不会碰你正在用的仓库。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------- 受限沙箱下不能用管道 stdio，所以 git 输出走临时文件 ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-undo-'));
let seq = 0;

function git(args, cwd) {
  const out = path.join(TMP, `o${++seq}`);
  const err = path.join(TMP, `e${++seq}`);
  const ofd = fs.openSync(out, 'w');
  const efd = fs.openSync(err, 'w');
  try {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, stdio: ['ignore', ofd, efd], windowsHide: true });
    return {
      code: r.status,
      stdout: fs.readFileSync(out, 'utf8').replace(/\s+$/, ''),
      stderr: fs.readFileSync(err, 'utf8').replace(/\s+$/, ''),
    };
  } finally {
    for (const fd of [ofd, efd]) fs.closeSync(fd);
    for (const f of [out, err]) fs.rmSync(f, { force: true });
  }
}

const IDENT = ['-c', 'user.name=Undo Tester', '-c', 'user.email=undo@example.com'];
function gcommit(cwd, message, file, content) {
  if (file) fs.writeFileSync(path.join(cwd, file), content);
  git(['add', '-A'], cwd);
  return git([...IDENT, 'commit', '-q', '-m', message], cwd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`服务端在 ${timeoutMs}ms 内没有就绪 (port ${port})`);
}

const servers = [];
async function startServer(repo, extraArgs = []) {
  const port = 18000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.mjs'), '--port', String(port), '--repo', repo, ...extraArgs], {
    cwd: APP_DIR,
    stdio: 'ignore',
    windowsHide: true,
  });
  servers.push(child);
  const health = await waitForServer(port);
  return { port, child, health, base: `http://127.0.0.1:${port}` };
}

async function j(base, p, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${base}${p}${q ? `?${q}` : ''}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function undo(base, body) {
  const res = await fetch(`${base}/api/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/* ---------------------------------------------------------------- */

async function scenarioCommitUndo() {
  console.log('\n[1] 撤销最近一次提交');
  const repo = fs.mkdtempSync(path.join(TMP, 'repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  gcommit(repo, '第一次提交', 'a.txt', 'A\n');
  const oidA = git(['rev-parse', 'HEAD'], repo).stdout;
  gcommit(repo, '第二次提交', 'b.txt', 'B\n');
  const oidB = git(['rev-parse', 'HEAD'], repo).stdout;

  const { base, port } = await startServer(repo);
  const repoId = (await j(base, '/api/repos')).json.repos[0].id;

  const inspect = await j(base, '/api/undo/inspect', { repo: repoId });
  check('inspect → 200 且给出方案', inspect.status === 200 && inspect.json?.plan?.available === true, `status=${inspect.status}`);
  check('方案 kind = reset-soft', inspect.json.plan.kind === 'reset-soft', inspect.json.plan.kind);
  check('目标指向上一个提交', inspect.json.plan.target.oid === oidA);
  check('expectOid 等于当前 HEAD', inspect.json.expectOid === oidB);
  check('命令预览是 reset --soft（不含 --hard）', /^git reset --soft /.test(inspect.json.plan.command) && !/--hard/.test(inspect.json.plan.command), inspect.json.plan.command);
  check('reflog 摘要回显了上一次操作', /第二次提交/.test(inspect.json.reflog?.[0]?.subject || ''), inspect.json.reflog?.[0]?.subject);

  // 错误的 expectOid 必须被拒绝
  const stale = await undo(base, { repo: repoId, kind: 'reset-soft', expectOid: oidA });
  check('expectOid 不匹配 → 409 拒绝', stale.status === 409, `status=${stale.status}`);
  check('拒绝时 HEAD 未变化', git(['rev-parse', 'HEAD'], repo).stdout === oidB);

  // kind 不匹配也必须被拒绝
  const wrongKind = await undo(base, { repo: repoId, kind: 'abort', expectOid: oidB });
  check('kind 不匹配 → 409 拒绝', wrongKind.status === 409, `status=${wrongKind.status}`);

  // 正片
  const res = await undo(base, { repo: repoId, kind: 'reset-soft', expectOid: oidB });
  check('撤销 → 200', res.status === 200 && res.json?.ok === true, `status=${res.status} ${res.json?.error || ''}`);
  check('HEAD 回到第一次提交', git(['rev-parse', 'HEAD'], repo).stdout === oidA, git(['rev-parse', 'HEAD'], repo).stdout);
  check('撤销的内容留在暂存区（b.txt 已暂存）', git(['diff', '--cached', '--name-only'], repo).stdout.includes('b.txt'), git(['diff', '--cached', '--name-only'], repo).stdout);
  check('工作区文件没有丢（b.txt 仍在磁盘上）', fs.existsSync(path.join(repo, 'b.txt')));
  check('提交总数从 2 变回 1', git(['rev-list', '--count', 'HEAD'], repo).stdout === '1');

  // 撤销本身也是一次操作，因此应该可以再撤销回去（reflog 顶部变成 reset: moving to ...）
  const after = await j(base, '/api/undo/inspect', { repo: repoId });
  check('撤销后仍可继续撤销（回到被撤销的提交）', after.json.plan.available === true && after.json.plan.kind === 'reset-keep' && after.json.plan.target.oid === oidB, JSON.stringify(after.json.plan));
  const back = await undo(base, { repo: repoId, kind: 'reset-keep', expectOid: after.json.expectOid });
  if (back.status === 200) {
    check('撤销的撤销 → HEAD 回到第二次提交', git(['rev-parse', 'HEAD'], repo).stdout === oidB, git(['rev-parse', 'HEAD'], repo).stdout);
  } else {
    // 也可能因为「暂存区改动会被覆盖」被 git --keep 安全拒绝 —— 两种结果都允许，但绝不能丢改动
    check(
      '撤销的撤销被安全拒绝且改动未丢',
      git(['rev-parse', 'HEAD'], repo).stdout === oidA && git(['diff', '--cached', '--name-only'], repo).stdout.includes('b.txt'),
      `${back.status} ${back.json?.error || ''}`,
    );
    console.log(`      （git --keep 拒绝了往返撤销：${back.json?.error || back.status} —— 属于预期的安全行为）`);
  }
  check('撤销接口不接受 GET', (await fetch(`${base}/api/undo?repo=${repoId}`)).status === 405);
  return { repo, port };
}

async function scenarioInitialCommit() {
  console.log('\n[2] 撤销首次提交（回到 unborn HEAD）');
  const repo = fs.mkdtempSync(path.join(TMP, 'repo-init-'));
  git(['init', '-q', '-b', 'main'], repo);
  gcommit(repo, '唯一一次提交', 'only.txt', 'only\n');

  const { base } = await startServer(repo);
  const repoId = (await j(base, '/api/repos')).json.repos[0].id;
  const inspect = await j(base, '/api/undo/inspect', { repo: repoId });
  check('首次提交 → 方案为 drop-initial', inspect.json.plan.kind === 'drop-initial', inspect.json.plan.kind);
  check('命令为 update-ref -d 当前分支', inspect.json.plan.command === 'git update-ref -d refs/heads/main', inspect.json.plan.command);

  const res = await undo(base, { repo: repoId, kind: 'drop-initial', expectOid: inspect.json.expectOid });
  check('撤销 → 200', res.status === 200, `${res.status} ${res.json?.error || ''}`);
  check('HEAD 已不存在（回到 unborn）', git(['rev-parse', '--verify', 'HEAD'], repo).code !== 0);
  check('文件仍在暂存区', git(['diff', '--cached', '--name-only'], repo).stdout.includes('only.txt'));
  check('工作区文件没丢', fs.existsSync(path.join(repo, 'only.txt')));
}

async function scenarioMergeAbort() {
  console.log('\n[3] 中止进行中的合并');
  const repo = fs.mkdtempSync(path.join(TMP, 'repo-merge-'));
  git(['init', '-q', '-b', 'main'], repo);
  gcommit(repo, 'base', 'f.txt', 'base\n');
  git(['checkout', '-q', '-b', 'topic'], repo);
  gcommit(repo, 'topic 改动', 'f.txt', 'topic\n');
  git(['checkout', '-q', 'main'], repo);
  gcommit(repo, 'main 改动', 'f.txt', 'mainline\n');
  const preMerge = git(['rev-parse', 'HEAD'], repo).stdout;
  const merge = git(['merge', 'topic'], repo);
  check('场景准备：合并产生冲突', fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), merge.stdout + merge.stderr);

  const { base } = await startServer(repo);
  const repoId = (await j(base, '/api/repos')).json.repos[0].id;
  const state = await j(base, '/api/state', { repo: repoId });
  check('状态接口报告 merge 进行中', state.json.operation?.type === 'merge', JSON.stringify(state.json.operation));
  check('状态接口报告 1 个冲突文件', state.json.counts.conflicted === 1, String(state.json.counts.conflicted));

  const inspect = await j(base, '/api/undo/inspect', { repo: repoId });
  check('撤销方案为 merge --abort', inspect.json.plan.kind === 'abort' && inspect.json.plan.command === 'git merge --abort', inspect.json.plan.command);
  check('提示冲突会被丢弃', inspect.json.plan.warnings.some((w) => /冲突/.test(w)), JSON.stringify(inspect.json.plan.warnings));

  const res = await undo(base, { repo: repoId, kind: 'abort', expectOid: inspect.json.expectOid });
  check('中止合并 → 200', res.status === 200, `${res.status} ${res.json?.error || ''}`);
  check('MERGE_HEAD 已消失', !fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')));
  check('HEAD 未变（回到合并前）', git(['rev-parse', 'HEAD'], repo).stdout === preMerge);
  check('工作区已回到干净状态', git(['status', '--porcelain'], repo).stdout === '');
  check('文件内容回到 main 版本', fs.readFileSync(path.join(repo, 'f.txt'), 'utf8').trim() === 'mainline');
}

async function scenarioReadOnly() {
  console.log('\n[4] --read-only 关闭写操作');
  const repo = fs.mkdtempSync(path.join(TMP, 'repo-ro-'));
  git(['init', '-q', '-b', 'main'], repo);
  gcommit(repo, 'a', 'a.txt', 'A\n');
  const oidA = git(['rev-parse', 'HEAD'], repo).stdout;
  gcommit(repo, 'b', 'b.txt', 'B\n');
  const oidB = git(['rev-parse', 'HEAD'], repo).stdout;

  const { base, health } = await startServer(repo, ['--read-only']);
  check('health 报告 writeEnabled=false', health.writeEnabled === false, JSON.stringify(health));
  const repoId = (await j(base, '/api/repos')).json.repos[0].id;
  const state = await j(base, '/api/state', { repo: repoId });
  check('state 也带 writeEnabled=false（供前端置灰按钮）', state.json.writeEnabled === false);
  const inspect = await j(base, '/api/undo/inspect', { repo: repoId });
  check('只读模式下仍可 inspect（只读）', inspect.status === 200 && inspect.json.plan.available === true);

  const res = await undo(base, { repo: repoId, kind: 'reset-soft', expectOid: oidB });
  check('只读模式下 POST /api/undo → 403', res.status === 403, `${res.status} ${res.json?.error || ''}`);
  check('仓库未被改动', git(['rev-parse', 'HEAD'], repo).stdout === oidB && oidB !== oidA);
}

/* ---------------------------------------------------------------- */

console.log('撤销端到端测试（全部在临时目录里进行）');
try {
  await scenarioCommitUndo();
  await scenarioInitialCommit();
  await scenarioMergeAbort();
  await scenarioReadOnly();
} catch (err) {
  failures.push(`执行中断: ${err.message}`);
  console.log(`\n✗ 执行中断: ${err.message}`);
} finally {
  for (const child of servers) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  await sleep(200);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
