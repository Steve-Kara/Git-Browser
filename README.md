# Git Browser 🌿

一个**本地网页版的 Git 仓库实时信息面板**：打开页面就能清楚看到当前仓库的真实状态——分支、HEAD、工作区变更、提交图、diff、stash、远端、ahead/behind……仓库一有变化，页面自动刷新。

- **零依赖**：只用 Node 内置模块 + 系统 `git` 命令，不需要 `npm install`
- **实时**：`fs.watch` 监听仓库 → SSE 推送 → 前端自动重取状态（监听不可用时自动降级为 2.5s 轮询）
- **只读**：只查看信息，不执行任何写操作（不会 commit / checkout / stash / reset）
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
```

## 界面

三栏布局，从上到下、从左到右都是「实时」的：

| 区域 | 内容 |
| --- | --- |
| 顶栏 | 仓库路径、当前分支、HEAD 短 hash、上游分支、领先/落后、`git describe`、无上游警告、SSE 连接状态 |
| 左栏 | 仓库信息（工作区 / git 目录 / 提交总数 / 对象数 / 身份 / 最近 fetch / git 版本）、进行中的操作（merge/rebase/cherry-pick/revert/bisect/index.lock）、本地分支（含每个分支的 ↑领先 ↓落后）、远端分支、标签、stash、远端 |
| 中栏 | **变更**：冲突 / 已暂存 / 未暂存 / 未跟踪 四组文件；**历史**：带泳道图的提交列表（支持点击分支/标签/stash 切换查看的 ref、`全部 refs` 开关） |
| 右栏 | 文件 diff（工作区⇄暂存区 / 暂存区⇄HEAD / 工作区⇄HEAD / 未跟踪整文件）、提交详情（meta + 按文件折叠的 patch + stat）、文件内容查看 |
| 底栏 | 各组计数、状态采集耗时、上次更新时间、连接模式 |

快捷键：`r` 刷新、`1`/`2` 切换变更/历史、`j`/`k` 上下选择、`Enter` 打开、`Esc` 关弹窗（右上角 `?` 也有说明）。

> 仓库还没有第一次提交时（unborn HEAD）也能正常用：会明确显示「尚无提交」并列出未跟踪文件，而不是报错。

## 参数

```
-p, --port <n>     监听端口（默认 8787）
    --host <addr>  监听地址（默认 127.0.0.1，仅本机可访问）
-r, --repo <path>  要浏览的仓库路径，可重复或用逗号分隔（默认：本目录）
    --watch <mode> all | git | poll   监听模式（默认 all）
    --open         启动后自动打开浏览器
-h, --help         帮助
```

环境变量：`PORT`（同 `--port`）、`GIT_BROWSER_REPOS`（同 `--repo`，多个用 `;` 或 `,` 分隔）。

## HTTP 接口

全部只读，返回 JSON（`/api/stream` 为 SSE）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 运行环境：node/git 版本、子进程输出模式、监听模式、仓库列表 |
| `GET /api/repos` | 已登记的仓库 |
| `GET /api/state` | 完整快照：head、operation、counts、staged/unstaged/untracked/conflicted、localBranches、remoteBranches、tags、stash、remotes、user、stats、lastFetch |
| `GET /api/log?limit=&skip=&ref=&all=1` | 提交列表（含 `parents`，供前端算泳道图） |
| `GET /api/commit?rev=` | 提交详情 + `stat` + `patch`（合并提交显示相对第一个父提交的差异） |
| `GET /api/diff?path=&scope=worktree\|index\|head\|untracked&rev=` | 单文件 diff |
| `GET /api/file?path=&scope=worktree\|index\|head&rev=` | 文件内容（二进制会标记） |
| `GET /api/stream` | SSE：`hello` / `change` / `ping` / `watch-error` |

数据来源主要是 `git status --porcelain=v2 --branch -z`、`git for-each-ref`、`git log`、`git diff`、`git show`、`git count-objects`，加上直接读 `.git` 下的 `MERGE_HEAD` / `rebase-merge/` / `CHERRY_PICK_HEAD` / `BISECT_LOG` 等来判断「进行中的操作」。

## 测试

```bash
node tools/smoke.mjs --mutate                    # 默认打 http://127.0.0.1:8787
node tools/smoke.mjs --base http://127.0.0.1:8788 --mutate
```

覆盖 61 项：纯函数单元测试（diff 渲染行号、HTML 转义防注入、提交泳道算法、格式化）、前端静态一致性（DOM id / CSS class 是否对得上）、全部接口与边界（未知 repo、未知提交、路径穿越）、以及 SSE 实时推送（真的写一个文件再删掉，验证事件到达）。

## 已知限制

- `--watch all` 会递归监听整个工作区；超大仓库建议 `--watch git`。个别环境（受限沙箱、网络盘）拿不到 `fs.watch` 事件时，前端会自动切到轮询并在顶栏提示。
- diff 上限 2MB、文件内容上限 512KB，超出会截断/提示；超过 512KB 的未跟踪文件不生成 diff。
- 仅设计给本机使用：默认只绑 `127.0.0.1`，没有鉴权。用 `--host 0.0.0.0` 暴露到局域网前请自行加一层保护。
- 在限制「带管道子进程」的沙箱里，服务端会自动把 git 输出重定向到临时文件（启动日志里的 `子进程输出模式: file`），功能不受影响；正常环境会自动用更快的 `pipe` 模式。

## 目录结构

```
server.mjs            HTTP + SSE 服务端、git 调用与状态解析
public/index.html     页面骨架
public/lib.js         纯函数（diff 渲染、泳道图、格式化）——可在 Node 中直接测试
public/app.js         状态管理、请求、渲染与交互
public/styles.css     深色主题样式
tools/smoke.mjs       冒烟测试（含纯函数单元测试）
```
