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

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的 **Git 工作区管理**插件：不用再切到外部 Git 客户端——输入框工具行的 Git 按钮一键打开与「设置」同规格的居中面板，覆盖日常全部 Git 操作：status / diff、分支管理、合并冲突解决、commit / fetch / pull / push、worktree 管理，以及**带分支线图形的提交历史**。

## 功能

| 功能 | 说明 |
|---|---|
| 🔘 仓库感知入口 | composer 底部「模式」选择器旁的 Git 按钮（分支图标 + 当前分支名），hero 页与会话内都有；**仅当前目录是 git 仓库时显示**（60s 轮询缓存，非仓库完全不占位） |
| 🪟 设置同规格面板 | 800px 居中弹窗、圆角 24、毛玻璃遮罩；**Esc 与遮罩点击均可关闭**；DOM 经 Portal 落到 body 层（z-index 1000），不被任何侧栏插件遮挡 |
| 📝 变更 | staged / unstaged / untracked 三组文件，stage / unstage / discard（CJK 文件名完整支持），自绘 unified diff 渲染器，commit（含 amend / 全部暂存并提交） |
| 🌿 分支 | 本地 / 远程列表（upstream、ahead/behind 角标），新建（带起点）/ 切换 / 改名 / 删除（未合并需二次确认）/ 合并，与当前分支对比 diff |
| 🕸 历史 | **分支线图形**（`git log --all --date-order` + Host 侧布局计算 + Client 纯 SVG 渲染）+ refs 徽章 + 分页加载；点击提交查看 commit diff |
| 🔀 冲突 | 合并进行中横幅（继续 / 中止）+ 每文件三种解决方式：ours / theirs / 手动编辑（base / ours / theirs 三栏对照 + 可编辑区） |
| 🌳 Worktree | 列表 / 添加（可带新分支；**成功后自动注册为 DSH 工作区**，workspace-write 沙盒下直接可写）/ 删除（脏目录需 force 二次确认）/ prune |
| 🎨 主题适配 | 颜色全部走 DSH 设计 token（主按钮与输入框发送按钮同色），明暗主题自动跟随 |

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
- 危险操作全部 UI 二次确认；force push 只允许 `--force-with-lease`。
- 输出有上限保护：diff 超 1.5MB 截断提示、log 默认 200 条 / 页。
- 仓库路径防护：涉及写文件的操作（未跟踪 discard / 手动解冲突）先校验路径不越出仓库根。

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

## 使用

1. **打开面板**：当前工作区是 git 仓库时，点击输入框工具行的 **Git 按钮**（分支图标 + 分支名）。
2. **变更**：勾选文件 stage / unstage；点击文件看 diff；底部输入提交信息 commit（可 amend、可一键全部暂存并提交）。
3. **分支**：顶部 Fetch / Pull / Push（ahead/behind 角标同步状态）；分支列表里切换、新建、改名、合并、删除。
4. **历史**：分支线 + 提交列表；点击提交展开该 commit 的文件级 diff。
5. **冲突**：合并冲突时出现在此 Tab——逐文件选 ours / theirs，或手动编辑后保存标记已解决；全部解决后「继续合并」。
6. **Worktree**：添加 worktree（可同时开新分支）；添加成功后自动注册为 DSH 工作区，直接在侧栏打开开会话即可让 agent 在沙盒内读写。
7. **关闭**：Esc 或点击遮罩。

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
npm test                # 自测（解析器 fixture + 临时仓库 live 集成，61 项）
dsh plugin --profile web add /path/to/dsh-git-manager   # 安装/重装到本机 DSH profile
```

改插件后**必须重启 DSH** 才生效。详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件三件套机制、网关 JSON-safe 返回值、主题 token 映射等完整踩坑。

## 发布

打 `v*` 标签推到 GitHub：`.github/workflows/release.yml` 自动跑测试、构建 tgz、发布 GitHub Release，并通过 OIDC Trusted Publishing 发布到 npm（已存在的版本自动跳过，可安全重放）。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
