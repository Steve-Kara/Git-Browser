/**
 * reflog 解析 + 「撤销上一次操作」可行性判定
 *
 * 纯函数，不碰文件系统：server.mjs 用它生成撤销方案，tools/smoke.mjs 直接单测。
 * 设计原则：
 *   1) 只用「不丢工作」的做法（reset --soft / reset --keep / abort / switch），
 *      永远不会自动执行 reset --hard；
 *   2) 判定不了或把握不足时，返回 available:false 并给出原因，而不是猜一个动作。
 */

const HASH_RE = /^[0-9a-f]{7,40}$/i;

/** 解析 `git reflog show --format=%H%x1f%h%x1f%gd%x1f%gs%x1f%gD%x1f%aI%x1e` */
export function parseReflog(raw) {
  const entries = [];
  for (const rec of String(raw ?? '').split('\x1e')) {
    const line = rec.replace(/^\n+/, '');
    if (!line.trim()) continue;
    const f = line.split('\x1f');
    if (f.length < 6) continue;
    entries.push({
      oid: f[0],
      short: f[1],
      selector: f[2],
      subject: f[3],
      ref: f[4],
      date: f[5],
    });
  }
  return entries;
}

/** 该 reflog 主题是否属于「创建了一个提交」类操作 */
export function isCommitLike(subject) {
  return /^(commit( \(.*?\))?:|cherry-pick:|revert:)/.test(subject);
}

function plan(parts) {
  return { warnings: [], ...parts };
}

/**
 * 生成撤销方案。
 *
 * @param {object} ctx
 * @param {Array}  ctx.entries        reflog（新→旧）
 * @param {object} ctx.operation      进行中的操作（server 的 detectOperation 结果）
 * @param {boolean} ctx.unmerged      是否存在未解决的冲突条目
 * @param {boolean} ctx.dirty         工作区/暂存区是否有改动
 * @param {string} ctx.branch         当前分支（detached 时为 null）
 * @param {boolean} ctx.detached      是否 detached HEAD
 * @param {boolean} ctx.hasRemote     是否配置了远端
 * @param {(name:string)=>boolean} ctx.branchExists
 */
export function classifyUndo(ctx) {
  const {
    entries = [],
    operation = null,
    unmerged = false,
    dirty = false,
    branch = null,
    detached = false,
    hasRemote = false,
    branchExists = () => false,
  } = ctx;

  const pushWarning = (list) => list.filter(Boolean);

  // ---------- 1) 有进行中的操作：撤销 = 中止它 ----------
  if (operation) {
    const abortable = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };
    const sub = abortable[operation.type];
    if (sub) {
      return plan({
        available: true,
        kind: 'abort',
        label: `中止进行中的 ${operation.type}`,
        command: `git ${sub} --abort`,
        args: [sub, '--abort'],
        target: null,
        effect: '工作区与 HEAD 回到该操作开始之前的状态',
        warnings: pushWarning([unmerged ? '当前有冲突未解决，中止会丢弃这些冲突标记' : null]),
      });
    }
    if (operation.type === 'bisect') {
      return plan({
        available: true,
        kind: 'bisect-reset',
        label: '结束二分查找（bisect reset）',
        command: 'git bisect reset',
        args: ['bisect', 'reset'],
        target: null,
        effect: '回到开始 bisect 之前的分支与提交',
        warnings: [],
      });
    }
    if (operation.type === 'lock') {
      return plan({ available: false, reason: '检测到 index.lock：可能有 git 进程正在运行，此时不提供撤销' });
    }
  }

  // ---------- 2) 首次提交：reflog 只有一条，需要特殊处理 ----------
  if (entries.length === 0) {
    return plan({ available: false, reason: '没有可撤销的操作（reflog 为空，可能还没有任何提交）' });
  }

  const top = entries[0];
  const prev = entries[1] || null;
  const subject = top.subject || '';

  if (/^commit \(initial\)/.test(subject) && !prev) {
    if (branch) {
      return plan({
        available: true,
        kind: 'drop-initial',
        label: '撤销首次提交（仓库回到未初始化提交状态）',
        command: `git update-ref -d refs/heads/${branch}`,
        args: ['update-ref', '-d', `refs/heads/${branch}`],
        target: null,
        effect: '删除当前分支引用，HEAD 变回 unborn，所有文件原样留在暂存区',
        warnings: ['撤销后仓库会回到「没有任何提交」的状态；暂存内容不会丢'],
      });
    }
    return plan({ available: false, reason: '首次提交处于 detached HEAD，暂不支持撤销' });
  }

  if (!prev) {
    return plan({ available: false, reason: 'reflog 里没有更早的记录，无法撤销' });
  }

  const target = { oid: prev.oid, short: prev.short, subject: prev.subject };
  const targetDesc = `${prev.short} · ${prev.subject}`;
  const dirtyNote = dirty ? '当前有未提交的改动：撤销只移动 HEAD，这些改动会保留' : null;

  // ---------- 3) 创建提交类：soft reset ----------
  if (isCommitLike(subject)) {
    const amend = /^commit \(amend\)/.test(subject);
    const mergeCommit = /^commit \(merge\)/.test(subject);
    const pick = /^cherry-pick:/.test(subject);
    const revert = /^revert:/.test(subject);
    const label = amend
      ? '撤销上一次 amend（回到改写前的提交）'
      : mergeCommit
        ? '撤销上一次合并提交'
        : pick
          ? '撤销上一次 cherry-pick'
          : revert
            ? '撤销上一次 revert'
            : '撤销上一次提交';
    return plan({
      available: true,
      kind: 'reset-soft',
      label,
      command: `git reset --soft ${target.oid.slice(0, 7)}`,
      args: ['reset', '--soft', target.oid],
      target,
      effect: `HEAD 从 ${top.short} 移回 ${targetDesc}；这次提交的内容全部回到暂存区，不会丢`,
      warnings: pushWarning([
        dirtyNote,
        unmerged ? '存在未解决冲突，reset 可能失败，请先处理冲突' : null,
        mergeCommit ? '这会一并撤销由该次合并引入的提交（提交对象仍在，可用 reflog 找回）' : null,
        hasRemote ? '如果这次提交已经推送到远端，撤销后需要用 force push 才能同步远端' : null,
      ]),
    });
  }

  // ---------- 4) reset 类：回到 reset 之前 ----------
  if (/^reset:/.test(subject)) {
    if (unmerged) {
      return plan({ available: false, reason: '存在未解决的冲突，先解决冲突再撤销 reset' });
    }
    return plan({
      available: true,
      kind: 'reset-keep',
      label: `撤销上一次 reset（回到 ${prev.short}）`,
      command: `git reset --keep ${target.oid.slice(0, 7)}`,
      args: ['reset', '--keep', target.oid],
      target,
      effect: `HEAD 移回 ${targetDesc}；能保留的工作区改动会保留`,
      warnings: pushWarning([
        dirty ? '当前有未提交改动：若与目标冲突，git 会拒绝执行（不会覆盖你的改动）' : null,
        '如果上一次是 reset --hard，被丢弃的改动无法由本操作恢复（可在 reflog 里找当时的提交）',
      ]),
    });
  }

  // ---------- 5) 分支切换：切回去 ----------
  const co = subject.match(/^checkout: moving from (\S+) to (\S+)/);
  if (co) {
    const from = co[1];
    if (HASH_RE.test(from)) {
      return plan({
        available: true,
        kind: 'switch-branch',
        label: `撤销切换（回到游离提交 ${from.slice(0, 7)}）`,
        command: `git switch --detach ${from.slice(0, 7)}`,
        args: ['switch', '--detach', from],
        target: { oid: from, short: from.slice(0, 7), subject: '(detached)' },
        effect: `HEAD 重新指向 ${from.slice(0, 7)}`,
        warnings: pushWarning([dirty ? '当前有未提交改动：若切换会覆盖它们，git 将拒绝执行' : null]),
      });
    }
    if (!branchExists(from)) {
      return plan({ available: false, reason: `上一个分支 ${from} 已不存在，无法切回` });
    }
    return plan({
      available: true,
      kind: 'switch-branch',
      label: `撤销切换（回到分支 ${from}）`,
      command: `git switch ${from}`,
      args: ['switch', from],
      target: { oid: prev.oid, short: prev.short, subject: `分支 ${from}` },
      effect: `当前分支从 ${branch || 'detached'} 切回 ${from}`,
      warnings: pushWarning([dirty ? '当前有未提交改动：若切换会覆盖它们，git 将拒绝执行' : null]),
    });
  }

  // ---------- 6) 已完成的 merge / pull / rebase：回到操作前 ----------
  if (/^(merge|pull)/.test(subject) || /^rebase/.test(subject)) {
    if (unmerged) {
      return plan({ available: false, reason: '存在未解决的冲突，先解决冲突或中止当前操作' });
    }
    const what = /^pull/.test(subject) ? '拉取' : /^rebase/.test(subject) ? '变基' : '合并';
    return plan({
      available: true,
      kind: 'reset-keep',
      label: `撤销上一次${what}（回到 ${prev.short}）`,
      command: `git reset --keep ${target.oid.slice(0, 7)}`,
      args: ['reset', '--keep', target.oid],
      target,
      effect: `HEAD 移回 ${targetDesc}；未提交的改动会尽量保留`,
      warnings: pushWarning([
        dirty ? '当前有未提交改动：若与目标冲突，git 会拒绝执行' : null,
        `如果这次${what}已经推送到远端，撤销后需要 force push 才能同步`,
      ]),
    });
  }

  return plan({
    available: false,
    reason: `暂不支持撤销该操作（reflog: ${subject || '未知'}）`,
  });
}
