<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="#4D6BFE"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
</p>

<h3 align="center">DeepSeek Harness Git 管理插件</h3>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-Plugin-4D6BFE?style=flat" alt="DSH plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Web%20UI-Yes-22C55E?style=flat" alt="Web UI">
</p>

<p align="center"><sub>中文</sub></p>

---

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的 **Git 工作区管理**插件：不用再切到外部 Git 客户端——输入框工具行的 Git 按钮一键打开与「设置」同规格的居中面板，按六个功能域覆盖日常全部 Git 操作：变更暂存（hunk 级 / 行级 / stash）、分支与 tag、带分支线图形的提交历史（交互式 rebase / revert / reset / fixup / undo / 范围对比）、合并冲突解决、worktree 管理，以及 remote / config 仓库设置。

## 功能全景（六域）

面板按六个功能域组织（六个 Tab：变更 / 分支 / 历史 / 冲突 / Worktree / 设置）：

| 域 | 能力 |
|---|---|
| 📝 变更 | 置顶**提交框**（多行 message + amend）、staged / unstaged / untracked 三组文件、文件级暂存/取消暂存/全部暂存，diff 窗口内 **hunk 级 + 行级操作**（暂存/撤销/取消暂存此块、**点选任意行暂存/撤销**，IDEA 式逐块），文件「丢弃」（CJK 文件名完整支持）、**文件历史**，**stash 全家**：暂存更改到 stash（可含未跟踪）、列表、应用 / 弹出 / 删除 / 清空 |
| 🌿 分支 | 本地 / 远程列表（upstream、ahead/behind 角标），新建（带起点）/ 切换 / 改名 / 删除（未合并需二次确认）/ 合并，与当前分支对比 diff；**Tag 区**：列表、新建（含 annotated + force）、push 到远程、删除 |
| 🕸 历史 | **分支线图形**（`git log --all --date-order` + Host 侧布局计算 + Client 纯 SVG 渲染，长跨度边自动省略淡化、悬停高亮单条分支走向）+ refs 徽章 + 「加载更多」渐进取全窗；**过滤条**（ref/tag、文件路径、作者、grep、起止日期）；**提交详情侧栏**（完整信息 + 变更文件统计，点文件开只读 diff / blame / 该文件历史）；**范围对比**（依次选 base / head 两提交看 diff）；**交互式 rebase**（「从这里整理历史…」：todo 排序 + pick/squash/fixup/drop/edit + squash 信息编辑）；提交操作：**Revert**、**Reset 当前分支**（soft / mixed / hard）、**fixup 修正任意提交**、cherry-pick 到当前分支、**undo**（撤销上次提交 / 撤销上次分支移动，带重做提示） |
| 🔀 冲突 | 合并进行中横幅（继续 / 中止）+ 每文件三种解决方式：ours / theirs / 手动编辑（base / ours / theirs 三栏对照 + 可编辑区）；revert / cherry-pick 冲突复用同一流程 |
| 🌳 Worktree | 列表 / **添加弹窗**（路径 + 新分支名 + 起点；**成功后自动注册为 DSH 工作区**，workspace-write 沙盒下直接可写）/ 删除（脏目录需 force 二次确认）/ prune |
| ⚙️ 设置 | **Remote 管理**：列表（fetch / push URL）、添加、重命名、删除；**Config 读写**：local / global 切换、key-value 表编辑、添加、删除 |
| 🎨 主题适配 | 颜色全部走 DSH 设计 token（主按钮与输入框发送按钮同色），明暗主题自动跟随 |

## 仓库感知入口与面板

| 功能 | 说明 |
|---|---|
| 🔘 仓库感知入口 | composer 底部「模式」选择器旁的 Git 按钮（分支图标 + 当前分支名），hero 页与会话内都有；**仅当前目录是 git 仓库时显示**（60s 轮询缓存，非仓库完全不占位） |
| 🪟 设置同规格面板 | 800px 居中弹窗、圆角 24、毛玻璃遮罩；**Esc 与遮罩点击均可关闭**；DOM 经 Portal 落到 body 层（z-index 1000），不被任何侧栏插件遮挡；diff 窗口、确认/表单弹窗全部 Portal 落 body 并按层级叠加（1000 / 1050 / 1100），Esc 只关栈顶弹层 |

## Remote 方法一览

Host 侧 `gitManager` 服务暴露的 Remote 方法（客户端 RPC 唯一入口），v2 新增/扩展部分加粗：

| 方法 | 用途 |
|---|---|
| `probe` / `overview` / `status` | 仓库探测（是否 git 仓库、当前分支）与整体状态概览 |
| `diff` / **`stageHunk`** | 查看工作区 diff；**按 hunk 序号暂存单个块**（`git apply --cached`） |
| `stage` / `unstage` / `discard` | 文件级暂存 / 取消暂存 / 丢弃（含未跟踪） |
| `commit` | 提交（支持 amend、全部暂存并提交） |
| **`stashList` / `stashPush` / `stashPop` / `stashApply` / `stashDrop` / `stashClear`** | **stash 全家：列表、暂存（可含未跟踪）、弹出、应用、删除、清空** |
| `branches` / `branchCreate` / `branchDelete` / `branchRename` / `merge` | 分支列表与新建 / 删除 / 改名 / 合并 |
| **`tags` / `tagCreate` / `tagDelete`** | **tag 列表、新建（annotated / force）、删除** |
| `log`（扩展） | 提交列表 + 分支线布局；**新增 ref / 路径 / 作者 / grep / 日期过滤参数** |
| `push`（扩展） / `pull` / `fetch` | 网络操作（`netResult` 包络）；**push 新增 refSpec 参数（用于 push tag）** |
| **`diffRange`** | **任意 base..head 范围对比（patch / stat 两种输出）** |
| **`blame`** | **逐行归属查询（sha / 作者 / 时间 / 行内容，支持行区间与截断）** |
| **`reflog`** | **引用日志（head 移动历史）** |
| **`revert`** | **Revert 指定提交（冲突不抛错，进 REVERT_HEAD 态走冲突流程）** |
| **`reset`** | **Reset 当前分支（soft / mixed / hard）** |
| **`rebasePlan` / `rebaseRun`** | **交互式 rebase：todo 计划（base..HEAD）+ 执行（pick/squash/fixup/drop/edit、排序、squash 信息替换）** |
| **`fixupCommit`** | **用暂存改动修正任意历史提交（fixup / squash + autosquash rebase）** |
| **`rebaseBranch`** | **当前分支 rebase 到指定分支之上** |
| **`lineApply`** | **行级暂存 / 撤销 / 取消暂存（diff 行区间最小补丁）** |
| `cherryPick` / `mergeContinue` / `abortMerge` | cherry-pick / rebase 与冲突后续：继续（按状态分派 commit / rebase --continue）/ 中止（merge / cherry-pick / revert / rebase 通用） |
| `resolveConflict` | 冲突解决（ours / theirs / 自定义内容） |
| **`remoteAdd` / `remoteRemove` / `remoteRename`** | **remote 增 / 删 / 改** |
| **`configList` / `configSet` / `configUnset`** | **git config 读 / 写 / 删（local / global）** |
| `worktrees` / `worktreeAdd` / `worktreeRemove` / `worktreePrune` | worktree 管理 |
| `init` | 目录初始化为 git 仓库 |

## 工作原理

```
Composer Git 按钮（conversation.input.left，仅仓库显示）
  └─ probe 轮询探测（60s 缓存，非仓库返回 null）
        └─ 点击 → 全屏面板（ReactDOM.createPortal → document.body，z-index 1000）
              └─ Remote RPC（gitManager.*，返回值网关 JSON-safe 校验）
                    └─ Host：git-core.mjs（execFile argv 数组，无 shell 拼接）
                          └─ git 子进程（GIT_TERMINAL_PROMPT=0，凭证挂起免疫）
```

- 所有 git 调用走 `execFile` argv 数组，无 shell 注入；Windows 下隐藏子进程窗口。
- 危险操作全部 UI 二次确认（丢弃 / 中止合并 / 删除分支或 tag / 清空 stash 等）；**hard reset 需额外输入 "RESET" 打字确认**；force push 只允许 `--force-with-lease`。
- 输出有上限保护：diff 超 1.5MB 截断提示、log 默认 200 条 / 页；大 diff / blame 截断渲染，不一次输出超大内容。
- 仓库路径防护：涉及写文件的操作（未跟踪 discard / 手动解冲突 / blame / hunk patch）先校验路径不越出仓库根；sha 入参白名单校验（纯十六进制），reset target 拒绝选项注入。

## 安装

### 标准安装（推荐）

本插件是**标准 DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，包内自带 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

```bash
# npm（推荐）
dsh plugin --profile web add @duke-dsh-plugins/dsh-git-manager

# 或从 GitHub Release tarball 安装
dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-git-manager/releases/download/v1.0.0/duke-dsh-plugins-dsh-git-manager-1.0.0.tgz

# 本地开发：pnpm 软链到本仓库，改代码即生效（无需重新复制）
dsh plugin --profile web add /path/to/dsh-git-manager
```

重启 DSH 后：当前工作区是 git 仓库时，输入框「模式」选择器旁出现 Git 按钮。

> `dsh plugin add` 把插件装成 profile 的 npm 依赖并追加到 `dsh.profile.bundles`，启动时 DSH 自动应用包内的 `cordis.patch.yml` 挂载插件。卸载：`dsh plugin --profile web remove dsh-git-manager`。

### 兼容性

宿主要求 **DSH `^0.1.0-rc.7 || ^0.2.0-rc.1`**（`package.json` 顶层 `engines.dsh` + `dsh.engines.dsh` 双位置声明，dshmarket 卡片的「宿主要求」/「适配本机 DSH 版本」筛选即读此值）。Typert strict codec 采用 `schema` + `create()` 双形态，已用 DSH 全部 21 个 typert-loader 版本（0.1.0-rc.6 … 0.1.7-rc.2）逐一校验 manifest 通过——0.1.6-alpha.2 起 DSH 改用 `codec.create().` 工厂，只写 `schema` 会在 0.1.7 上导致 `$mount` 抛 `has no create() factory`、入口按钮不出现。

## 使用

1. **打开面板**：当前工作区是 git 仓库时，点击输入框工具行的 **Git 按钮**（分支图标 + 分支名）。
2. **变更**：置顶提交框写 message（可 amend）；勾选文件 stage / unstage；点击文件看 diff，窗口内可逐 hunk 暂存 / 撤销 / 取消暂存；底部 Stash 区暂存 / 应用 / 清空工作区改动。
3. **分支**：顶部 Fetch / Pull / Push（ahead/behind 角标同步状态）；分支列表里切换、新建、改名、合并、删除；下方 Tag 区新建、push、删除 tag。
4. **历史**：分支线 + 提交列表，可用过滤条按 ref / 路径 / 作者 / 关键字 / 日期筛选；点提交打开详情侧栏（查看 diff、cherry-pick、Revert、Reset 到此提交——hard 需打字确认）；「对比…」可依次选两个提交看范围 diff。
5. **冲突**：合并 / cherry-pick / revert 冲突时出现在此 Tab——逐文件选 ours / theirs，或手动编辑后保存标记已解决；全部解决后「继续」。
6. **Worktree**：添加弹窗输入路径（可同时开新分支、选起点）；添加成功后自动注册为 DSH 工作区，直接在侧栏打开开会话即可让 agent 在沙盒内读写。
7. **设置**：管理 remote（添加 / 重命名 / 删除）与 git config（local / global 读写）。
8. **关闭**：Esc 或点击遮罩。

## 目录结构

```
dsh-git-manager/
├── index.js              # Host 半：GitManagerService（TypertRemoteService 子类，类插件）
├── client.js             # Client 半：__ModuleLoader__ bundle（composer 入口按钮 + 弹窗面板）
├── typert.host.js        # Typert Host manifest：gitManager 全方法的 wire schema
├── git-core.mjs          # 零依赖：runGit 封装 + 全部查询/变更函数 + 解析器
├── git-graph.mjs         # 零依赖：computeGraph 分支线布局（纯函数）
├── cordis.patch.yml      # dsh bundle patch（挂载行）
├── scripts/self-test.mjs # 独立自测：解析器 fixture + 临时仓库 live 集成（不依赖 DSH 进程）
├── .github/workflows/    # GitHub Actions 发布（tag → npm OIDC + GitHub Release）
├── AGENTS.md             # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE               # MIT
```

## 开发

```bash
npm run check           # 语法检查全部 JS
npm test                # 自测（解析器 fixture + 临时仓库 live 集成，真实 git）
dsh plugin --profile web add /path/to/dsh-git-manager   # 安装/重装到本机 DSH profile
```

改插件后**必须重启 DSH** 才生效。详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件三件套机制、网关 JSON-safe 返回值、主题 token 映射等完整踩坑。

## 发布

打 `v*` 标签推到 GitHub：`.github/workflows/release.yml` 自动跑测试、构建 tgz、发布 GitHub Release，并通过 OIDC Trusted Publishing 发布到 npm（已存在的版本自动跳过，可安全重放）。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
