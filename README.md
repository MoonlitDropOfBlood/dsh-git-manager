# dsh-git-manager

DSH 正式 bundle 插件：在 DeepSeek Harness Web UI 里直接管理 Git 工作区，免去切换到外部客户端。

## 功能

- **入口在输入框工具行**：composer 底部「模式」选择器旁的 Git 按钮（git-branch 图标 + 分支名），hero 页与会话内都有；**仅当当前目录是 git 仓库时才显示**（60s 轮询）。
- 点击进入与「设置」同规格的居中弹窗（800px 宽、圆角 24、遮罩毛玻璃），遮罩点击 / Esc 均可关闭，包含五个 Tab：

| Tab | 内容 |
|---|---|
| **变更** | staged / unstaged / untracked 三组文件，stage / unstage / discard（CJK 文件名/路径完整支持），自绘 unified diff 渲染器，commit（含 amend / 全部暂存并提交） |
| **分支** | 本地 / 远程列表（upstream、ahead/behind），新建（带起点） / 切换 / 改名 / 删除（未合并且无 -D 二次确认） / 合并；与当前分支对比 diff |
| **历史** | **分支线** 图形（基于 `git log --all --date-order` + Host 侧 computeGraph 布局，Client 纯 SVG 渲染） + refs 徽章 + 加载更多；点击提交查看 commit diff |
| **冲突** | 合并进行中横幅（继续 / 中止）+ 每文件三种解决方式：ours / theirs / 手动编辑（base/ours/theirs 三栏对照 + 可编辑区） |
| **Worktree** | 列表 + 添加（可带新分支；成功后自动注册为 DSH 工作区，workspace-write 沙盒下即可写）+ 删除（脏目录需 force 二次确认）+ prune |

## 安全 / 体验

- 所有 git 命令走 `execFile` argv 数组，无 shell 注入；Windows 隐藏窗口；`GIT_TERMINAL_PROMPT=0` 防止凭证挂起
- 危险操作全部 UI 二次确认；force push 只允许 `--force-with-lease`
- diff / log 输出有上限保护（diff 1.5MB 截断提示、log 默认 200/页）
- 仓库路径防护（resolveConflict custom / untracked discard 防止越出仓库根目录）
- 重叠上下文：面板 DOM 通过 `ReactDOM.createPortal` 落到 `document.body`（z-index 1000），避开 `shell.overlay` 槽位的 stacking context 锁死，确保不被任何侧栏插件覆盖

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-git-manager   # 本地开发
# 或发布后：
dsh plugin --profile web add @duke-dsh-plugins/dsh-git-manager
```

装完**必须重启 DSH** 才生效。

## 开发

```bash
npm run check    # 语法检查全部 JS
npm test         # 自测（解析器 fixture + 临时仓库 live 集成）
```

修改后重启 DSH 验证。

## 发布

打 `v*` 标签推到 GitHub：`.github/workflows/release.yml` 自动跑测试、构建 tgz、发布 GitHub Release，并通过 OIDC Trusted Publishing 发布到 npm（已存在的版本自动跳过，可安全重放）。

> 首版 bootstrap：新包在 npmjs.com 尚无 trusted publisher 配置，先在本地发一次
> `npm publish --registry=https://registry.npmjs.org`，再到包设置里配置
> trusted publisher（repo `MoonlitDropOfBlood/dsh-git-manager` + workflow `.github/workflows/release.yml`），
> 之后的版本只需打标签推送。