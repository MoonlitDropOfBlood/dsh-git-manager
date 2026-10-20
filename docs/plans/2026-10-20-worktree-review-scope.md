# 2026-10-20 — Worktree 修改 review：作用域切进 + 行内状态（A+B）

## 背景与问题

用户反馈「worktree 中的修改不方便 review」。代码级根因：

1. 面板唯一作用域来源是 `scopedRepoPath`（会话目录 / repoTree 选中的子仓库）；
   linked worktree 是工作区外的独立目录，`repoTree` 只发现 submodule 与嵌套独立仓库，
   **不含 worktree** → 变更 Tab 永远看不到 worktree 里的改动。
2. Worktree Tab 每行只有 path/branch/detached + 删除，**不显示脏状态、没有 diff 入口**。
3. Host 能力其实已够：全部方法跑在 `probeRepo(path).toplevel` 上，对 worktree
   目录实测（probe/status/diff/log）全部正常——缺的是 client 侧作用域与入口。

未采纳的 C 方案（新增 `worktreeReview` 做 PR 式对比弹窗）留作后续独立特性；
当前 A+B 已覆盖「看不见 / 动不了」。命令行等价物：`git -C <wt> status --short`、
`git -C <wt> diff <base>`。

## A（P0）— Worktree 作用域（纯 client）

- 面板级新状态 `wtScope = { root, path, branch }`：`root` 与面板仓库不匹配即整体
  失效（面板重开自动回主仓库）；`scopedRepoPath` 优先级变为
  **worktree > 子仓库 > 主仓库**，进入 worktree 时清空 `repoSel`（两种作用域互斥）。
- WorktreesTab 行上「查看」按钮（非 current / 非 bare / 非作用域中）→
  `enterWorktree(w)`：记录作用域并切到变更 Tab。
- 作用域条 `.gm-wt-scope`（head 下方）：Worktree 徽标 + 路径 + 分支（优先实时
  `status.branch`）+「返回主仓库」。作用域期间：RepoSwitcher 隐藏（切子仓库会顶掉
  作用域）、「Fetch/Pull 全部」批量按钮隐藏（作用于主仓库树）、六 Tab 徽标跟随
  作用域仓库 status 而非主仓库树聚合。
- **变更 Tab 退化为单组视图**：`repos` 置 null（主仓库的树与 worktree 无关），
  组 = worktree 自身（名「Worktree」），`rootIsScoped` 视为 true → 组状态复用面板级
  `props.status`。组内一切操作（暂存/hunk/提交/stash/diff）照常走该组 toplevel。
- 探活 effect **deps 从 `[repoPath]` 改为 `[scopedRepoPath]`**（原 deps 只挂恒定的
  repoPath，作用域变化不会重探——注释宣称的行为与实现不符的存量问题，本次一并修正）；
  作用域目标不可用（目录被删/外部 remove）时自动退出作用域回主仓库重探。
- worktreeAdd 成功后自动注册 DSH 工作区的既有行为不变（沙盒可写前提）。

## B（P1）— 行内状态（Host `getWorktrees` 富化 + schema）

- `getWorktrees` 对每个非 bare 条目限 4 并发（`WORKTREE_CONCURRENCY`，复用
  `mapLimit`）跑一次 `getStatus(path)`：
  - `dirty = statusSummary(st)`（staged/unstaged/untracked/conflicted 四数字，恒挂）；
  - `ahead`/`behind`：仅有 upstream 时挂；
  - `headShort`：headSha 前 12 位（与 probeRepo `--short=12` 同口径），非空才挂；
  - 失败只挂 `error`（`gitErrText`），单节点失败不炸整体；bare 跳过。
- `typert.host.js` `worktreeSchema` 追加同名 optional 字段（strict schema 剥未声明
  key，Host 挂 key 必须与 schema 一一对应）。**不新增 Remote 方法**（方法列表守卫不动）。
- client 行渲染：`2+ 1~ 3?` 计数串（全 0 显示「干净」）、冲突红点、`↑n ↓n`
  上游差距 chip、`状态查询失败` 徽标；作用域命中行高亮 +「作用域中」徽标。
- WorktreesTab 挂载期间 15s 轮询；mutation（add/remove/prune）的返回值就是最新列表
  （含富化），直接采用、不再多打一轮查询。

## 测试

- self-test live「getWorktrees」：linked worktree 造 unstaged + untracked，断言
  dirty 计数 / headShort 长度 12 / 无 error / 无 upstream 时无 ahead-behind key /
  主仓条目同样富化。
- wire live：临时 addWorktree + 未跟踪文件让富化字段真实穿过 strict schema +
  assertJsonSafe，force remove 清理。
- client 行为属 UI 层，按项目惯例以 CDP e2e 验证（后续补；本次面板逻辑为状态派生，
  无新增弹层/层级变化）。

## 遗留

- C 方案（`worktreeReview` PR 式对比：基线分支选择 + 文件清单 + 逐文件 diff +
  提交列表，`git diff <base>` 含未提交 / `<base>...<branch>` 只看已提交）待做。
- worktree 行的 ahead/behind 是 upstream 口径；与 main 的 ahead/behind 需要 C 方案的
  基线对比。
- `runGit` 把 execFile 的 ENOENT 一律归类为「找不到 git 可执行文件」——worktree 目录
  被删时 `item.error` 文案会误导（实为 cwd 不存在）。client 目前原样展示；根治需把
  runGit 的 ENOENT 细分（cwd 缺失 vs 可执行文件缺失），注意回归面。
