# Git Browser 🌿

一个**本地网页版的 Git 仓库实时信息面板**：打开页面就能清楚看到当前仓库的真实状态——分支、HEAD、工作区变更、提交图、diff、stash、远端、ahead/behind……仓库一有变化，页面自动刷新。

- **零依赖**：只用 Node 内置模块 + 系统 `git` 命令，不需要 `npm install`
- **实时**：`fs.watch` 监听仓库 → SSE 推送 → 前端自动重取状态（监听不可用时自动降级为 2.5s 轮询）
- **默认只读**：只查看信息；唯一的写操作是顶栏的「撤销」，每次都要在弹窗里确认（`--read-only` 可完全关闭）
- **不污染仓库**：运行时只在系统临时目录里放临时文件，不在你的仓库里留任何东西

## 快速开始

```bash
node server.mjs                 # 浏览本目录（server.mjs 所在目录）
# 然后打开 http://127.0.0.1:8787
```

Windows 也可以直接双击 `start.cmd`。

浏览别的仓库 / 换端口 / 同时看多个仓库：

```bash
node server.mjs -r "D:\code\my-project"           # 指定仓库
node server.mjs -r projA -r projB -p 9000         # 多仓库 + 换端口（页面右上角切换）
node server.mjs -r . --open                       # 启动后自动打开浏览器
node server.mjs --watch git                       # 只监听 .git（超大工作区时更省资源）
node server.mjs --read-only                        # 完全禁用「撤销」，纯只读
```

## 界面

三栏布局，从上到下、从左到右都是「实时」的：

| 区域 | 内容 |
| --- | --- |
| 顶栏 | 仓库路径、当前分支、HEAD 短 hash、上游分支、领先/落后、`git describe`、无上游警告、SSE 连接状态、**撤销按钮**、**浅色/深色切换** |
| 左栏 | 仓库信息（工作区 / git 目录 / 提交总数 / 对象数 / 身份 / 最近 fetch / git 版本）、进行中的操作（merge/rebase/cherry-pick/revert/bisect/index.lock）、本地分支（含每个分支的 ↑领先 ↓落后）、远端分支、标签、stash、远端 |
| 中栏 | **变更**：冲突 / 已暂存 / 未暂存 / 未跟踪 四组文件；**历史**：带泳道图的提交列表（支持点击分支/标签/stash 切换查看的 ref、`全部 refs` 开关） |
| 右栏 | 文件 diff（工作区⇄暂存区 / 暂存区⇄HEAD / 工作区⇄HEAD / 未跟踪整文件）、提交详情（meta + 按文件折叠的 patch + stat）、文件内容查看 |
| 底栏 | 各组计数、状态采集耗时、上次更新时间、连接模式 |

快捷键：`r` 刷新、`t` 切换浅色/深色、`1`/`2` 切换变更/历史、`j`/`k` 上下选择、`Enter` 打开、`Esc` 关弹窗（右上角 `?` 也有说明）。

### 主题（浅色 / 深色）

- 默认深色；从未手动切换过时**跟随系统** `prefers-color-scheme`，手动切过一次后以你的选择为准（存在 `localStorage` 的 `gb-theme`）。
- 顶栏 🌙/☀️ 按钮或快捷键 `t` 切换；主题在首屏样式加载前就已落定，不会有深→浅闪烁。
- 所有颜色都收敛成 CSS 变量令牌（深色在 `:root`，浅色在 `:root[data-theme="light"]`），提交泳道图的颜色也走变量，所以**切换主题不需要重新渲染列表**。
- 自动化会检查：浅色必须覆盖深色的每一个颜色令牌（防止继承深色值）、组件样式里不允许写死颜色、以及正文/diff 增删/chip 等关键组合的 WCAG 对比度达标。

> 仓库还没有第一次提交时（unborn HEAD）也能正常用：会明确显示「尚无提交」并列出未跟踪文件，而不是报错。

## 撤销上一次操作

顶栏的「↩ 撤销」会撤销**最近一次改变 HEAD 的 git 操作**。点击后先只读地检查 reflog，弹窗里会明确写出：要执行的确切命令、HEAD 会从哪个提交移到哪个提交、影响是什么、有哪些风险，确认后才执行。

**安全模型**（这几条是硬规则，代码里有对应的单元测试）：

- **永远不用 `reset --hard`**。只用 `reset --soft` / `reset --keep` / `--abort` / `switch` 这类不会丢弃工作的动作。
- 判定不了就不猜：返回「暂不支持撤销该操作」而不是随便挑一个动作。
- 服务端**重新推导**撤销方案后才执行，客户端只能请求「执行哪一类撤销」，**不能自带 git 命令**。
- 带乐观并发校验：确认时看到的 HEAD 与执行时的 HEAD 不一致 → 拒绝执行（`409`），防止撤销错对象。
- 一次「撤销」本身也会进 reflog，所以撤销之后还可以再撤销回去。

支持的场景：

| reflog 里的上一次操作 | 撤销方式 | 说明 |
| --- | --- | --- |
| `commit:` / `commit (amend):` / `commit (merge):` / `cherry-pick:` / `revert:` | `git reset --soft <上一个提交>` | 提交内容全部回到暂存区，不丢改动 |
| `commit (initial):`（全仓库只有一次提交） | `git update-ref -d refs/heads/<当前分支>` | 回到 unborn HEAD，文件原样留在暂存区；提交对象仍可通过 reflog 找回 |
| `reset:` | `git reset --keep <之前的 HEAD>` | 能保留的改动保留；若会覆盖改动则 git 拒绝执行 |
| `checkout: moving from A to B` | `git switch A`（A 是游离提交时用 `switch --detach`） | 切回上一个分支；分支已被删除时明确拒绝 |
| `merge:` / `pull:` / `rebase:`（已完成） | `git reset --keep <操作前的 HEAD>` | 回到操作之前 |
| 进行中的 merge / rebase / cherry-pick / revert | `git <操作> --abort` | 中止并回到开始前的状态 |
| bisect 进行中 | `git bisect reset` | 结束二分查找 |
| 检测到 `index.lock` | 拒绝 | 可能有 git 进程正在运行 |

## 参数

```
-p, --port <n>     监听端口（默认 8787）
    --host <addr>  监听地址（默认 127.0.0.1，仅本机可访问）
-r, --repo <path>  要浏览的仓库路径，可重复或用逗号分隔（默认：本目录）
    --watch <mode> all | git | poll   监听模式（默认 all）
    --read-only    禁用「撤销」写操作（默认允许，撤销前仍需页面确认）
    --open         启动后自动打开浏览器
-h, --help         帮助
```

环境变量：`PORT`（同 `--port`）、`GIT_BROWSER_REPOS`（同 `--repo`，多个用 `;` 或 `,` 分隔）。

## HTTP 接口

除 `POST /api/undo` 外全部只读，返回 JSON（`/api/stream` 为 SSE）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 运行环境：node/git 版本、子进程输出模式、监听模式、写操作是否启用、仓库列表 |
| `GET /api/repos` | 已登记的仓库 |
| `GET /api/state` | 完整快照：head、operation、counts、staged/unstaged/untracked/conflicted、localBranches、remoteBranches、tags、stash、remotes、user、stats、lastFetch、writeEnabled |
| `GET /api/log?limit=&skip=&ref=&all=1` | 提交列表（含 `parents`，供前端算泳道图） |
| `GET /api/commit?rev=` | 提交详情 + `stat` + `patch`（合并提交显示相对第一个父提交的差异） |
| `GET /api/diff?path=&scope=worktree\|index\|head\|untracked&rev=` | 单文件 diff |
| `GET /api/file?path=&scope=worktree\|index\|head&rev=` | 文件内容（二进制会标记） |
| `GET /api/undo/inspect` | **只读**检查：当前可撤销什么、确切命令、影响与风险、`expectOid` |
| `POST /api/undo` | 执行撤销，body `{repo, kind, expectOid}`。`kind` 必须与服务端重新推导的方案一致，`expectOid` 必须等于当前 HEAD，否则 `409`；`--read-only` 时 `403` |
| `GET /api/stream` | SSE：`hello` / `change` / `ping` / `watch-error` |

数据来源主要是 `git status --porcelain=v2 --branch -z`、`git for-each-ref`、`git log`、`git diff`、`git show`、`git count-objects`，加上直接读 `.git` 下的 `MERGE_HEAD` / `rebase-merge/` / `CHERRY_PICK_HEAD` / `BISECT_LOG` 等来判断「进行中的操作」。

## 测试

```bash
node tools/smoke.mjs --mutate                    # 默认打 http://127.0.0.1:8787
node tools/smoke.mjs --base http://127.0.0.1:8788 --mutate
node tools/undo-check.mjs                        # 撤销的端到端测试（自建临时仓库）
```

- `tools/smoke.mjs` 覆盖 111 项：纯函数单元测试（diff 渲染行号、HTML 转义防注入、提交泳道算法、主题解析、格式化）、**撤销判定单元测试**（各种 reflog 场景 → 方案是否安全）、前端静态一致性（DOM id / CSS class 是否对得上）、主题（令牌对等、无写死颜色、对比度）、全部接口与边界（未知 repo、未知提交、路径穿越）、以及 SSE 实时推送（真的写一个文件再删掉，验证事件到达）。
- `tools/undo-check.mjs` 覆盖 38 项端到端断言：在系统临时目录里造「两次提交 / 仅一次提交 / 合并冲突 / 只读模式」四类仓库，用 `--repo` 真启动服务端，走完 inspect → 确认 → 撤销，再用 git 独立核对仓库真实状态（HEAD、暂存区、工作区文件、`MERGE_HEAD`），并验证 `expectOid` 不匹配、`kind` 不匹配、`--read-only` 都被正确拒绝。**只在临时目录里操作，不会碰你正在用的仓库。**

## 已知限制

- `--watch all` 会递归监听整个工作区；超大仓库建议 `--watch git`。个别环境（受限沙箱、网络盘）拿不到 `fs.watch` 事件时，前端会自动切到轮询并在顶栏提示。
- diff 上限 2MB、文件内容上限 512KB，超出会截断/提示；超过 512KB 的未跟踪文件不生成 diff。
- 仅设计给本机使用：默认只绑 `127.0.0.1`。撤销是写操作，**用 `--host 0.0.0.0` 暴露到局域网时务必加 `--read-only`**（服务端在检测到「非本机地址 + 写操作开启」时会在启动日志里告警）。
- 撤销不做 force push、不恢复被 `reset --hard` 丢弃的工作区改动（那些改动不在 reflog 里；能找回的是提交对象）。
- 在限制「带管道子进程」的沙箱里，服务端会自动把 git 输出重定向到临时文件（启动日志里的 `子进程输出模式: file`），功能不受影响；正常环境会自动用更快的 `pipe` 模式。

## 目录结构

```
server.mjs            HTTP + SSE 服务端、git 调用与状态解析、撤销接口
lib/reflog.mjs        reflog 解析与「可撤销性」判定（纯函数，服务端与测试共用）
public/index.html     页面骨架 + 首屏主题脚本
public/lib.js         纯函数（diff 渲染、泳道图、主题解析、格式化）——可在 Node 中直接测试
public/app.js         状态管理、请求、渲染与交互
public/styles.css     深色/浅色两套主题令牌 + 组件样式
tools/smoke.mjs       冒烟测试（纯函数单测 + 主题检查 + 接口边界 + SSE 实测）
tools/undo-check.mjs  撤销端到端测试（自建临时仓库，真跑 git reset）
```
