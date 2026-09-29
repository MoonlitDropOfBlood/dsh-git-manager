# dsh-git-manager v2 —— 完整 Git 管理工具：设计与实现契约

> 状态：已批准实施（2026-09-29）。本文档是 **Host（git-core.mjs / index.js / typert.host.js / scripts/self-test.mjs）与 Client（client.js / scripts/cdp-e2e.mjs）两侧共同遵守的契约**。
> 分工：host-core 队友负责 Host 侧全部文件；client-ui 队友负责 Client 侧全部文件；Lead 负责集成、安装与最终验证。
> **任何契约变更必须先报 Lead，由 Lead 改本文档，禁止两侧私下约定。**

## 0. P0 Bug 修复：确认弹窗被 diff 窗口遮挡

**现象**：在 diff 独立窗口里点「撤销此块」，二次确认弹窗出现在 diff 窗口**下面**，无法点击。

**根因**（client.js）：`ConfirmDialog` 直接渲染在 ChangesTab 的 JSX 树内，DOM 落在 `.gm-overlay`（`z-index:1000`，形成 stacking context）内部；而 `DiffWindow` 用 `ReactDOM.createPortal(..., document.body)` 落在 body 层（`z-index:1050`）。CSS 里 `.gm-confirm{z-index:1100}` 只在**自己的 stacking context 内**生效，整个 `.gm-overlay` 上下文（1000）低于 body 层的 diffwin（1050），所以确认框永远被压在下面。

**修复方案**（client-ui 实现，P0 最高优先级）：

1. **所有弹层统一走 Portal 落 body**：`ConfirmDialog`、未来新增的 stash/tag/reset/config 等弹窗，全部 `ReactDOM.createPortal(overlayNode, document.body)`。z-index 规范：面板 `.gm-overlay`=1000，diff 窗口 `.gm-diffwin`=1050，确认/表单弹窗 `.gm-confirm`=1100（弹窗内再叠弹窗时每层 +10）。**绝不**手动 appendChild 挪 React DOM（AGENTS.md 注意事项 §弹窗层级）。
2. **模块级 `modalStack` 替代裸 `modalDepth`**：模块作用域维护 `const modalStack = []`（元素 `{ close }`）。每个顶层弹层 mount 时 push、unmount 时移除；document 级 Esc 只关**栈顶**弹层（`modalStack[modalStack.length-1].close()`）；面板 Esc 处理器仅在 `modalStack.length === 0` 时关闭面板。DiffWindow 的 Esc 同理由栈顶规则接管。mask 点击关闭与 Esc 同语义（只关自身）。
3. 确认框出现时必须压住 diff 窗口（1100 > 1050）；确认框自己的 Esc/mask 只关确认框。
4. 回归点：分支删除、worktree 删除、丢弃文件、中止合并等现有 ConfirmDialog 使用点全部改走 portal 后行为不变（面板之上、Esc 只关自己）。

## 1. 功能全景（目标：一个完整 Git 管理工具）

| 域 | 现状 | v2 补齐 |
|---|---|---|
| 变更/暂存 | 文件级暂存/丢弃、hunk 撤销/取消暂存 | **提交框（message + amend）**、暂存全部/取消暂存全部、**暂存此块（stageHunk）**、逐文件「丢弃」已有、**stash 全家** |
| 分支 | 创建/切换/删除/重命名/merge/cherry-pick | **tag 列表/新建（含 annotated）/删除/push tag** |
| 历史 | 分支线图形、提交 diff 只读 | **过滤器（ref/tag、路径、作者、grep、日期）+ 加载更多**、**提交详情侧栏**、**范围对比（base..head）**、**revert 提交**、**reset 当前分支（soft/mixed/hard）** |
| 冲突 | 三方视图 + 二选一/编辑、继续/中止 | 不变（revert/cherry-pick 冲突复用） |
| Worktree | 列表/添加/删除/Prune/自动注册工作区 | **创建弹窗完善**（路径 + 新分支 + 起点） |
| 仓库级 | fetch/pull/push/init | **remote 增删改**、**config 读写（local/global）**、**blame**、**reflog** |

## 2. Remote 方法契约（Host ↔ Client 唯一事实源）

约定（与现有 30 个方法一致）：

- 请求统一带 `path`（目标仓库路径，一般传 probe 的 toplevel）；请求 schema 是 passthrough，但 Host 必须白名单读取字段并校验类型/形状（sha 仅十六进制、mode 枚举、name 非空等）。
- 返回一律 `{ok:true,value}` / `{ok:false,error:{code,message}}` 包络；**网关 JSON-safe**：可选字段有值才挂 key、不用 undefined、union 不塞 null（AGENTS.md「Remote 返回值」条）。
- 变更类方法返回值尽量带 `status`（statusOnlySchema），便于客户端刷新；会改变列表的（stash/tag/remote/config）返回新列表。
- 网络类（fetch/pull/push）沿用 `netResult`。

### 2.1 P0（随 bug 修复走）

| 方法 | 请求 | 返回 value |
|---|---|---|
| `stageHunk` | `{ path, file, hunkIndex }`（file=仓库根相对文件路径，hunkIndex=该文件 unstaged diff 内的块序号，0 起；与现有 hunkApply 请求 `{path, scope, file, hunkIndex}` 对齐） | `{ status }`。实现：getDiff(unstaged) → extractHunkPatch（**不** reverse）→ `git apply --cached`，cwd 必须在 probe.toplevel |

### 2.2 P1（本轮必做）

| 方法 | 请求 | 返回 value |
|---|---|---|
| `stashList` | `{ path }` | `{ stashes: stashEntry[] }` |
| `stashPush` | `{ path, message?, includeUntracked? }` | `{ stashes }` |
| `stashPop` | `{ path, index? }`（缺省 0） | `{ status }` |
| `stashApply` | `{ path, index? }` | `{ status }` |
| `stashDrop` | `{ path, index? }` | `{ stashes }` |
| `stashClear` | `{ path }` | `{ stashes }` |
| `tags` | `{ path }` | `{ tags: tagInfo[] }` |
| `tagCreate` | `{ path, name, sha?, message?, force? }`（message 非空→annotated） | `{ tags }` |
| `tagDelete` | `{ path, name }` | `{ tags }` |
| `reset` | `{ path, mode, target? }`，mode∈`soft\|mixed\|hard`，target 缺省 HEAD | `{ status }` |
| `revert` | `{ path, sha }` | `{ reverted: boolean, status }`（冲突**不抛错**：reverted=false，进 REVERT_HEAD 态，`mergeContinue`/`abortMerge` 已支持） |
| `blame` | `{ path, ref?, start?, end? }`（文件相对路径放 `file`？——否，见下） | `{ lines: blameLine[], truncated }` |
| `diffRange` | `{ path, from, to?, file?, kind? }`，kind∈`patch\|stat` 缺省 patch | `{ text, truncated }` |
| `reflog` | `{ path, limit? }` | `{ entries: reflogEntry[] }` |
| `log`（扩展现有） | 增加可选 `ref?, file?, author?, grep?, since?, until?`（原有 skip/limit 保留） | 结构不变 `{ commits, graph, hasMore }`；有过滤条件时 graph 可退化为单线（laneCount=1） |
| `push`（扩展现有） | 增加可选 `refSpec?`（如 `refs/tags/v1.0`，用于 push tag） | 结构不变 |

> `blame` 修正：请求为 `{ path, file, ref?, start?, end? }`——`path` 是仓库路径，**`file` 是仓库根相对的文件路径**（走 safeJoin 防护）。下表同理。
>
> **stash 冲突语义（Lead 裁决 2026-09-29）**：`stashPop`/`stashApply` 冲突**不抛错**，返回 `{status}`（conflicted 非空），**stash 条目保留**（git 原生语义）。`git stash pop` 冲突不写 MERGE_HEAD，因此：「继续」不走 `mergeContinue`——UI 显示两步动作：解决冲突并暂存/提交后「删除 stash 条目」（`stashDrop`）；「中止」走 `abortMerge` 兜底分支（见 §2.4）。

**新增数据形状**（typert.host.js 中定义，strict、readonly、双形态 codec）：

```
stashEntry = { index: number, ref: string, subject: string, at: number }
tagInfo    = { name: string, sha: string, short: string, subject: string, at: number,
               annotated: boolean, message?: string }   // message 有值才挂
blameLine  = { sha: string, short: string, author: string, at: number, line: number, text: string }
reflogEntry= { sha: string, short: string, selector: string, message: string, at: number }
configEntry= { key: string, value: string }
```

### 2.3 P2（P1 完成且验证通过后才做，可顺延下轮）

| 方法 | 请求 | 返回 value |
|---|---|---|
| `remoteAdd` | `{ path, name, url, pushUrl? }` | `{ remotes }` |
| `remoteRemove` | `{ path, name }` | `{ remotes }` |
| `remoteRename` | `{ path, oldName, newName }` | `{ remotes }` |
| `configList` | `{ path, global? }` | `{ entries: configEntry[] }` |
| `configSet` | `{ path, key, value, global? }` | `{ entries }` |
| `configUnset` | `{ path, key, global? }` | `{ entries }` |

### 2.4 Host 实现要点（host-core）

- 新函数进 `git-core.mjs`（零依赖、导出函数 + 纯解析器），命名对齐现有风格：`getStashes/parseStashList/stashPush/stashPop/stashApply/stashDrop/stashClear`、`getTags/parseTagList/createTag/deleteTag`、`resetRepo`、`revertCommit`、`getBlame/parseBlame`、`getDiffRange`、`getReflog/parseReflog`、`getLog` 扩展过滤参数、`pushBranch` 扩展 refSpec。
- 全部走 `runGit`/`runGitNet`，**绝不拼 shell 字符串**；文件路径一律 `safeJoin(toplevel, rel)`；涉及 patch 的操作 cwd 必须在 probe.toplevel。
- `resetRepo` 的 `hard`：Host 不做额外确认（确认是 UI 职责），但必须校验 mode 枚举与 target 格式（拒绝空格/选项注入：target 必须匹配 `^[0-9a-fA-F]{4,40}$` 或 `HEAD`/`HEAD~n`/`@{...}` 白名单正则，或干脆要求调用方传 sha/HEAD 系，禁止以 `-` 开头）。
- `index.js` 每个新方法 `markRemoteMethod(this, "<method>", "<method>")` + 异步实现，错误映射沿用现有 GitError 分类。
- **`abortMerge` 兜底分支（Lead 裁决 2026-09-29，对应 stash 冲突）**：无 MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/rebase 状态文件、但 `status` 存在 unmerged 条目时，对**这些冲突文件**执行 `git restore --source=HEAD --staged --worktree -- <files>`（清 unmerged index 并回到 HEAD），返回 `{status}`；**stash 条目保留**；其他文件已干净套用的改动保留（文档明示「中止只丢弃未解决的冲突文件改动」）。仍无 unmerged 条目且无任何操作 HEAD 时照旧抛错。`mergeContinue` 守卫不变。
- `typert.host.js`：METHODS 表加行、新数据 schema 加入；**codec 双形态（`schema` + `create`）**、request passthrough；result 包络用现有 `result()`/`netResult()` 生成器。
- `scripts/self-test.mjs`：每个新解析器加 fixture 断言；live 测试覆盖 stash 全家、tag 全家、reset 三模式、revert（含冲突路径）、blame、diffRange、reflog、log 过滤、stageHunk（hunk 级暂存后 status 校验）、push refSpec（本地 bare remote 模拟）；**每个新 Remote 方法的返回值必须过 `wire:` 守卫（strict schema + assertJsonSafe 复刻）**。CRLF 归一化注意事项见 AGENTS.md。
- `log`/`push` 是**扩展**不新增方法名，self-test 的 wire 守卫覆盖新返回路径。

## 3. UI 契约（client-ui）

### 3.1 面板结构

五 Tab 保持：变更 / 分支 / 历史 / 冲突 / Worktree；**新增第六 Tab「设置」**（remote + config 管理；P2 期间若 P2 未落地则显示「即将推出」占位）。Tab 样式沿用现有 token 选中态（`specific-sidebar-nav-item-active`）。

### 3.2 变更 Tab

- **提交框**（置顶）：多行 message 文本框（placeholder「提交信息（支持多行）」）、`amend` 勾选（勾选时拉取 HEAD 提交信息预填——通过 `log` limit 1 拿 subject/body，或直接留空让用户输入）、「提交」主按钮（`button-info-fill`）。提交成功后刷新 status/log 并清空框。
- 工具行：暂存全部 / 取消暂存全部（现有 stage(all) 能力）。
- 文件行按钮补齐：未暂存 → 「暂存」「撤销此块所在的 diff 窗口里操作」「丢弃」；已暂存 → 「取消暂存」「丢弃(取消暂存并丢弃)」。diff 窗口 hunk 按钮：未暂存 diff = 「暂存此块」（新增，**非危险，无确认**）+「撤销此块」（危险，二次确认）；已暂存 diff = 「取消暂存此块」（无确认）。
- **Stash 区**（变更 Tab 底部折叠区）：stash 列表（index + subject + 时间），行内「应用」「弹出」「删除」；区头「暂存更改到 stash…」（弹窗：message + 包含未跟踪勾选）与「清空 stash」（危险确认）。全部操作后刷新 status + stashList。

### 3.3 分支 Tab

- 现有分支操作不变。
- **Tag 区**（下半）：tag 列表（name + short + subject + 时间，annotated 加徽标），行内「push 到 origin」（走 push refSpec，非危险）、「删除」（确认）；区头「新建 tag…」（弹窗：name + target（默认 HEAD）+ annotated message 多行 + force 勾选）。

### 3.4 历史 Tab

- **过滤条**：ref 选择（全部/当前分支/任意分支/tag）、路径过滤输入、作者、grep、起止日期、「清除过滤」。变更即重取 log（走扩展参数）；底部「加载更多」采用 **maxCount 逐级放大 + 整窗重取（skip=0）**（Lead 裁决 2026-09-29：computeGraph 是 Host 对单次返回窗口计算的，按 skip 拼接会让第 2 页 link 行号整体错位；skip 参数仍透传给 log，只是 UI 不用它拼页）。
- **提交详情侧栏**（点提交行打开，替代直接开 diff 窗口；行内保留「查看 diff」按钮直接开现有 diff 窗口）：sha/author/date/完整 message、变更文件列表（状态 + 增删行数，来自 diffRange kind=stat 或 diff 解析），点文件开该提交的只读 diff 窗口。
- **提交操作**（详情侧栏底部）：「Revert 此提交」（非破坏，同 cherry-pick 契约：冲突跳冲突页）、「将当前分支 Reset 到此提交…」（弹窗：soft/mixed/hard 三选一单选；**hard 需额外输入 "RESET" 确认**（打字确认）；执行后刷新全部）。
- **范围对比模式**：工具行「对比…」进入选择态，依次点两个提交（base, head），显示 `diffRange`（kind=stat + patch 切换）；「退出对比」恢复。

### 3.4b P2 UI（P1 UI 全部完成且 `npm run check` 绿后才做；时间不足则报 Lead 顺延，不得挤占 P0/P1）

- **Reflog 模式**：历史 Tab 过滤条加「提交 | Reflog」模式切换；Reflog 模式复用提交行样式渲染 `reflogEntry[]`（selector + message + 时间），无分支线，点行可开该 sha 的提交详情。
- **Blame 窗口**：只读窗口（复用 `.gm-diffwin` 骨架与 modalStack 规则）入口两处：变更 Tab 未暂存/已暂存文件行的「Blame」按钮、历史提交详情侧栏的变更文件行「Blame」按钮。内容为 `blameLine[]` 按 sha 连续分组渲染：gutter（short sha + author + 日期）+ 行号 + 行内容，`truncated` 时显示截断提示。
- tagCreate 的 UI「target」输入映射 wire 字段 `sha`（Lead 确认）；push tag 走 `push({refSpec:"refs/tags/<name>", remote:"origin"})`（Lead 确认）。

### 3.5 Worktree / 冲突 Tab

- 冲突 Tab 底部按钮按状态分流（Lead 裁决）：有 MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/rebase → 现状「继续（mergeContinue）/中止操作（abortMerge）」不变；**仅 unmerged 条目（stash 冲突）** → 显示提示「stash 应用冲突：解决并暂存后删除 stash 条目，或中止（丢弃未解决的冲突文件改动，stash 保留）」，按钮为「删除 stash 条目（stashDrop）」与「中止（abortMerge 兜底）」。

- Worktree：「添加」改弹窗（路径输入 + 新分支名 + 起点），其余不变。
- 冲突 Tab 不变（revert/cherry-pick 冲突自动进入）。

### 3.6 设置 Tab（P2）

- Remote 区：列表（name / fetchUrl / pushUrl）+「添加」（name/url/pushUrl）+ 行内「重命名」「删除」（确认）。
- Config 区：local/global 切换、key-value 表、行内编辑、添加行、删除（确认）。**值必须可编辑文本框**，禁止展示后直接落 git config 而不确认。

### 3.7 UI 通用约束（必须遵守，AGENTS.md 教训）

- 颜色**一律 dsw token**，需要透明底用 `color-mix`；主按钮 `button-info-fill`/`button-info-hover` + `#fff`；危险 `state-error-primary` + `interactive-bg-hover-danger`；图标内联 SVG。
- 组件类型全部在 bundle 工厂作用域定义一次；`remote` 一律 `props.remote` 取（apply 内 wrapper 注入），**禁**裸引用 apply 局部变量。
- 新增 Remote 方法名必须进 `CLIENT_REMOTE` 的 descriptors（与 Host METHODS 同名同序）。
- 所有危险操作 UI 二次确认（含 hard reset 的打字确认）；force 相关只用 `--force-with-lease`（push）/ 明示 force 参数（tag）。
- 大 diff/大 blame：复用 truncated 提示样式，禁止一次渲染 >5000 行（截断 + 提示）。

## 4. 分工与写入范围（disjoint scopes）

| 角色 | 写入范围 | 只读 |
|---|---|---|
| Lead | `docs/plans/*`、`AGENTS.md`、集成验证 | 其余 |
| host-core | `git-core.mjs`、`index.js`、`typert.host.js`、`scripts/self-test.mjs` | 其余 |
| client-ui | `client.js`、`scripts/cdp-e2e.mjs` | 其余 |
| docs（便宜模型） | `README.md` | 其余 |

**依赖**：host-core 与 client-ui 并行按本契约实现；接口疑问一律报 Lead 裁决并更新本契约。两侧完成后 Lead 跑 `npm run check`、`npm test`（真实 git）、安装 bundle、boot manifest 校验、CDP e2e（`scripts/cdp-e2e.mjs`），修复集成问题后交付。

## 6. 实现偏差记录（Lead 裁决，随实现滚动更新）

- **stash/操作来源识别（client-ui）**：status 只有 merging/rebasing 位，无法区分 CHERRY_PICK_HEAD/REVERT_HEAD/stash。采用客户端 `conflictSource` 跟踪（产生冲突的操作时记录）；来源不明（如刷新后）时冲突 Tab 显示**两套按钮**（继续 + 删除 stash 条目/中止）防卡死。**批准**，行为记入契约 §3.5 补充：来源不明态允许双套按钮并存。
- **提交详情数据来源（client-ui）**：完整 message 由 `diff(scope=commit)` 的 `git show --format=fuller` 头解析；变更文件状态与增删行数由 patch 解析（parseUnifiedDiff 扩展）。契约 §3.4 原文允许 stat/patch 二选一，**批准**。
- **确认策略从严（client-ui）**：stash 删除/清空、tag 删除、remote 删除、config 删除、Untracked 删除全部均加二次确认，**批准**（多确认不违反契约）。
- **Reflog 加载更多**：limit 放大 + 整取（与 log 加载更多同精神），**批准**。
- **commit body（待 host-core）**：`commitSchema` 增加可选 `body`（`git log --format` 带出正文，message 结尾的多行正文；有值才挂 key），供 client amend 预填完整多行信息；client-ui 后续把 amend 预填从 subject-only 升级为 subject+body。
- **push refSpec（host-core 核对项）**：`push({remote, refSpec})` 必须拼成 `git push [--force-with-lease] <remote> <refSpec>`，refSpec 不得落在 repository 位置；live 测试覆盖 push tag 路径。

## 6.1 验证记录（2026-09-29，v2 交付）

- `npm run check` ✅；`npm test` ✅ **89 passed / 0 failed / 0 skipped**（真实 git，含全部 21 个新方法的 wire 守卫）。
- Host↔Client descriptors **51/51 同名同序** ✅（与 typert.host.js METHODS 逐一对齐）。
- `dsh plugin add` 安装 → `--dump-config` 组合树含 `gitManager` entry ✅ → 测试实例 `__DSH_BOOT__` 含插件 entry（combo `rev=f73d42ff3fee`）→ combo URL **200** ✅。
- CDP e2e **全 PASS**（普通实例 + 隔离 fixture 实例两轮）：apply 冒烟、入口按钮、面板六 Tab、提交框、暂存全部/取消暂存全部、stash/tag 主路径、设置 Tab remote/config 就位（P2 无降级）。**P0 层级断言实跑通过**：diff 窗口打开 → 「撤销此块」确认框出现 → z-index 1100 > 1050 → `elementFromPoint` 命中确认框（不被 diff 窗口遮挡）→ Esc 三级逐层关闭（确认框→diff 窗口→面板）。
- e2e 层级断言的受控 fixture 跑法（临时 DSH_HOME + profile junction + Documents default-workspace 预置脏仓库）已记入 AGENTS.md「headless dump-dom」条目。

## 7. P3 候选：对标一线 Git 工具的功能缺口（2026-09-29 调研）

调研对象：lazygit（73k stars，[功能清单](https://lazygit.dev/features/)）、GitKraken Desktop、Fork、Tower、SourceTree、Sublime Merge、GitLens（[核心功能](https://help.gitkraken.com/gitlens/gitlens-features/)）、IDEA Git。v2 已覆盖：hunk 级暂存/撤销、stash 全家、分支/tag、merge/cherry-pick/revert/reset、冲突解决、历史图+过滤+范围对比、blame/reflog、worktree、remote/config。缺口按优先级：

### P3-A（一线工具标配，建议下一轮补齐）

| # | 功能 | 现状 | 实现要点 |
|---|---|---|---|
| 1 | **交互式 rebase**（squash/fixup/drop/edit/上下移动） | ❌ 最大缺口 | 历史 Tab 提交行「从这里开始交互式 rebase…」→ todo 列表（拖拽排序 + 动作按钮）→ Host `rebaseInteractive`：写 todo 文件 + `GIT_SEQUENCE_EDITOR` 机制（现强制 GIT_EDITOR=true 需特判）；rebase 中态 continue/abort 已覆盖（rebase-merge 守卫已支持） |
| 2 | **行级暂存/撤销**（选择任意行 stage/discard） | ❌（只有 hunk 级） | diff 窗口行选择 → `extractLinePatch`（纯函数：hunk 拆到行级最小 patch）→ `git apply --cached` / `--reverse`；与 extractHunkPatch 同一道 safeJoin/toplevel 闸 |
| 3 | **任意提交 fixup / amend**（用暂存改动修正历史提交） | ❌（amend 只能改 HEAD） | 「修正此提交」= 建 fixup 提交 + autosquash rebase；依赖 #1 |
| 4 | **文件级历史**（file log + 逐版本 diff） | ❌（log 的 file 过滤只是近似） | 文件行「历史」入口 → file 过滤专用视图 + 点版本开 diffRange(from=sha^,to=sha,file) |
| 5 | **撤销上一步操作（undo）** | ❌ | 工具行「撤销上次提交 / 撤销上次 reset」快捷动作（reflog 驱动：`reset --soft HEAD~1`、`reset --hard ORIG_HEAD` 等）+ 操作 toast 带「撤销」链接；lazygit 招牌功能 |
| 6 | **分支行一键动作**：rebase 到当前 / fixup 到当前 | ❌（只有 merge/cherry-pick） | `rebaseBranch`（branch onto current）；危险级别同 merge，冲突走现有流程（rebase-merge 守卫已支持） |

### P3-B（常用，性价比高）

| # | 功能 | 实现要点 |
|---|---|---|
| 7 | `.gitignore` 编辑 | untracked 行「加入 .gitignore」→ safeJoin 写文件 + append 规则 |
| 8 | patch 导出/应用 | format-patch 生成下载 / 粘贴或选文件 `git apply`（路径防护） |
| 9 | submodule 管理 | status/init/update/deinit 列表视图 |
| 10 | bisect 二分 | start/good/bad/reset 简单流程视图 |
| 11 | pull `--autostash` 勾选 + fetch 输出可见 | 小改进 |
| 12 | 快捷键体系（j/k 导航、s 暂存、? 帮助） | 纯 client 侧 |
| 13 | 提交签署开关（GPG/SSH sign）+ commit template | config 联动 |

### 明确不做（平台/场景依赖过强）

PR/MR 集成（GitHub/GitLab）、git-flow、LFS、sparse checkout、多仓库 dashboard（DSH 会话与 worktree 已弱覆盖）。

## 8. P3-A 实现契约（2026-09-29 细化，本节为 Host/Client 唯一事实源）

沿用 §2 约定（请求带 `path`、JSON-safe、变更返回带 `status`、白名单校验）。**冲突统一契约**：rebase/fixup 冲突**不抛错**，返回 `{done:false,status}`（status.conflicted 非空），仓库进 rebase-merge/rebase-apply 态。

### 8.1 Host 新方法（4 个）

| 方法 | 请求 | 返回 value |
|---|---|---|
| `rebasePlan` | `{ path, base }`（base=起点提交，`checkRev` 白名单；todo 列表 = base..HEAD） | `{ entries: rebaseTodo[] }` |
| `rebaseRun` | `{ path, base, entries: rebaseTodo[] }`（entries 为用户调整后的 todo：action + 可选 message） | `{ done: boolean, status }`。实现：写 todo 文件 → `GIT_SEQUENCE_EDITOR` 指向「把 todo 文件内容替换为用户 entries」的机制（注意 `runGit` 现强制 `GIT_EDITOR=true`，需允许 per-call 覆盖 env）→ `git rebase -i --autosquash <base>`。done=true 干净完成；done=false 冲突进行中 |
| `fixupCommit` | `{ path, sha, mode?, message? }`，sha=`checkRev`，mode∈`fixup\|squash` 缺省 fixup（squash 时 message 可选） | `{ done: boolean, status }`。实现：`git commit --fixup=<sha>`（或 `--squash=<sha>`）→ `git rebase -i --autosquash <sha>^`（`GIT_SEQUENCE_EDITOR=true` 保留 git 生成的 autosquash todo）。**改写历史，UI 二次确认** |
| `rebaseBranch` | `{ path, branch }`（`checkRev` 白名单） | `{ done: boolean, status }`。将**当前分支** rebase 到 branch 之上（`git rebase <branch>`） |

`rebaseTodo = { sha: string, short: string, subject: string, action: string }`，action ∈ `pick|squash|fixup|drop|edit`（Host 校验枚举；`squash`/`fixup` 无 message 字段时挂 `""` 或省略 key，JSON-safe）。

**base 口径（Lead 裁决）**：Host 维持 **`base..HEAD`（不含 base）**，与 `git rebase -i <base>` 完全同构；「从该提交（含）整理到 HEAD」由 client 传 `base = <sha>^` 实现（REV_RE 允许 `^`）；**根提交无父 → 禁用「从这里整理历史…」按钮**。两侧不得采用 inclusive 口径。

**message 语义（Lead 裁决 2026-09-29）**：`squash`+message = **替换 squash 合并后的提交信息**（GIT_EDITOR 队列机制：按 todo 顺序逐条消费，message 非空覆盖 message 文件，空则保留 git 默认合并文本）；`fixup`+message = **忽略**（fixup 保留原信息，要改信息用 squash）。todo 由 Host 重建（action 枚举 + 纯 hex sha + subject 去换行截断，防 exec 注入）。

### 8.2 Host 修改（2 个现有方法，语义按状态分派）

- `mergeContinue`：rebase-merge / rebase-apply 存在 → **`git rebase --continue`**（而非 `git commit --no-edit`）；否则维持现状。守卫不变：无任何状态文件必须抛错。
- `abortMerge`：优先级 rebase 状态文件（→ `git rebase --abort`）> MERGE_HEAD（`merge --abort`）> CHERRY_PICK_HEAD（`cherry-pick --abort`）> REVERT_HEAD（`revert --abort`）> unmerged 兜底（§2.4 stash 冲突语义）> 抛错。

### 8.3 行级暂存/撤销（P3-A #2）

| 方法 | 请求 | 返回 value |
|---|---|---|
| `lineApply` | `{ path, file, scope, hunkIndex, rowStart, rowEnd, mode }`：scope∈`unstaged\|staged`；**rowStart/rowEnd=该 hunk 内 diff 行的 0 基下标（含端点，只计 @@ 头之后的 ctx/add/del 行，与 client 渲染行序一一对应）**；mode∈`stage\|unstage\|discard` | `{ status }` |

> **行号口径（Lead 裁决 2026-09-29，替代任何「结果侧行号」方案）**：用 **diff 行下标** 而非文件行号——client 渲染的行序与 host 解析 hunk 的行序天然一致，零发明语义、零换算误差。行区间可含 del 行（用户点选哪行就动哪行）。实现：`extractLinePatch(diffText, file, hunkIndex, rowStart, rowEnd)` 直接切 `rows[rowStart..rowEnd]` + 重写 `@@` 两侧行计数；应用时加 `--unidiff-zero`（选区可能无上下文行）。start>end 或越界抛 GitError。

- 纯函数 `extractLinePatch(diffText, file, hunkIndex, start, end)`：切出「文件头 + 单 hunk 行区间」最小 patch，**正确重写 `@@` 头的两侧行计数**（+ 保留必要上下文行）；必须有 fixture 覆盖：区间在 hunk 中段/开头/结尾、含纯 +/- 行、多 hunk 文件。
- 执行映射：`stage`→`git apply --cached`；`unstage`→`git apply --reverse --cached`；`discard`→`git apply --reverse`；一律在 probe.toplevel、safeJoin，与 hunkApply 同一道闸。
- 为对称，Host 侧同时提供 `stageHunk` 的 mode 对应能力无需重复——`lineApply` start/end 覆盖整个 hunk 时行为应与对应 hunk 操作一致（测试断言）。

### 8.4 文件级历史（P3-A #4，纯 Client）

复用 `log({file})` + `diffRange({from: sha+"^", to: sha, file})`，无新 Host 方法。入口：变更 Tab 文件行与提交详情侧栏文件行的「历史」按钮 → 只读文件历史视图（提交列表 + 逐版本 diff 窗口）。**根提交（无父）**：from 用空树 sha `4b825dc642cb6eb9a060e54bf8d69288fbee4904`（纯十六进制，checkRev 放行，每个仓库都存在该对象），比报错提示体验好（Lead 建议）。

### 8.5 undo（P3-A #5，纯 Client，复用现有方法）

- 变更 Tab 工具行「撤销上次提交」：`reset({mode:"soft", target:"HEAD~1"})`（改动回暂存区；二次确认）。
- 历史 Tab 工具行「撤销上次分支移动」：`reset({mode:"mixed", target:"@{1}"})`（HEAD 回退一个 reflog 步；二次确认 + 文案说明影响）。
- 每个 undo 动作的 toast 带「重做提示」文案（说明如何恢复，如 `reset @{2}` / reflog），不实现完整 redo 栈。

### 8.6 UI 契约（Client）

- 历史 Tab 详情侧栏新增按钮组：「**从这里整理历史…**」（打开 rebase todo 弹窗，todo = 该提交（含）到 HEAD）、「用暂存改动修正此提交…」（fixupCommit，二次确认）、「此文件的历史」（§8.4）。
- **rebase todo 弹窗**（FormDialog/modalStack 规范，z 1100）：行 = short sha + subject + action 下拉（pick/squash/fixup/drop/edit）+ 上移/下移按钮（不做拖拽）；squash/fixup 可填 message；底部「开始 Rebase」（危险级二次确认，文案说明改写历史）/「取消」。执行后 done=false → 关窗跳冲突页；done=true → 刷新。
- 分支行按钮「Rebase 当前到此分支」（二次确认，同 merge 级别）。
- 冲突 Tab 底部按钮在 rebase 态（rebase-merge/rebase-apply）显示「继续 Rebase」（mergeContinue）/「中止 Rebase」（abortMerge）；与 stash 冲突分流（§3.5）共存：来源判断顺序 rebase > merge/cherry/revert > stash。
- 一切弹层走既有 `useModalLayer`/portal/modalStack；颜色走 token；危险确认沿用 ConfirmDialog（hard reset 式打字确认仅保留给 reset hard）。

### 8.7 测试要求（self-test）

- `extractLinePatch` fixture 全矩阵（§8.3）+ 与 hunk 级等价断言。
- live：lineApply 三模式（含跨 +/- 混合区间）、rebasePlan/Run（drop+reorder+squash+fixup+edit 各至少一例、冲突路径 done=false → mergeContinue rebase 分派 → 完成；abortMerge rebase 分派）、fixupCommit（fixup 与 squash 两模式 + 冲突路径）、rebaseBranch（干净 + 冲突）。
- `mergeContinue`/`abortMerge` 的 rebase 分派各两条单测（含「无状态照旧抛错」回归）。
- 全部新/改 Remote 方法返回结构过 wire 守卫；descriptors 同名同序扩展（51 → **56**：+rebasePlan/rebaseRun/fixupCommit/rebaseBranch/lineApply）。

## 8.8 P3-A 验证记录（2026-09-29）

- `npm run check` ✅；`npm test` ✅ **107 passed / 0 failed / 0 skipped**（较 v2 净增 18 用例；含 extractLinePatch 8 组 fixture、rebase 纯函数防注入、lineApply 三模式 + 整 hunk 与 hunkApply 逐字节等价、drop+reorder、squash 消息队列（含跨进程续跑）、fixup 忽略 message、edit 停驻→mergeContinue、冲突→abort/continue、fixupCommit 三路径、rebaseBranch 干净+冲突、mergeContinue/abortMerge rebase 分派）。
- descriptors **56/56 同名同序** ✅。
- **RPC 级真实宿主验证**（curl `/api/gitManager/*`，隔离实例）：`rebasePlan` ✓；`rebaseRun` squash+message 全链路 ✓（done=true，历史正确重写为 pick+squash 合并且消息被替换——GIT_SEQUENCE_EDITOR + 消息队列机制在 DSH 宿主进程实证可用）；`lineApply` 单行暂存 ✓（`M  f2.txt` 精确入 staged）。
- CDP e2e **全 PASS**（干净会话）：v2 全套 + **行级选择浮条（暂存选中行/撤销选中行）** + **rebase todo 弹窗（todo 行/action 下拉/开始 Rebase/z≥1100）** + P0 层级回归。
- **集成加固**：`runGit` 默认 env 加 `ELECTRON_RUN_AS_NODE=1`（Electron 宿主下 `process.execPath` 是 Electron 主程序，此变量强制以纯 node 模式跑编辑器脚本；纯 node 宿主无副作用）。
- **排障教训**：多 Edge 测试实例残留 + 复用 user-data-dir 会串会话，症状是页面 `unauthorized`、connection lost 刷屏、probe 门控按钮不渲染——**与插件无关**；判别法=curl `/api` 带 cookie 正常而页面内 fetch 返回 unauthorized 即测试会话问题。清理测试进程必须按 CommandLine 匹配 `dsh-cdp-prof` 精确杀，**绝不盲杀 msedge**。

### P3-A 实现偏差记录（Lead 批准）

- client-ui：undo toast 右下角轻量形态（10s 自动消失）+ 重做提示用准确 `HEAD@{1}`；「撤销选中行」（lineApply discard）补二次确认；undo 入口放工具行（Reflog 模式隐藏）。**批准**。
- host-core：`done=false` 语义扩展为「冲突**或** edit 停驻」（status.conflicted 空/非空区分），契约原文超集，**批准**；`fixupCommit` root 提交自动退化 `--root`，**批准**；fixupCommit 的 squash+message 与 rebaseRun 同走替换语义，**批准**。


1. P0：diff 窗口内「撤销此块」确认框浮在 diff 窗口之上，Esc 只关确认框；面板/弹窗 Esc 层级行为符合 §0。
2. `npm run check` 全绿；`npm test` 在真实 git 下全绿（无 skip-live）。
3. 每个新 Remote 方法过 wire 守卫（strict schema + assertJsonSafe）。
4. `dsh plugin add` 安装成功且 `application: applied`；boot manifest 含插件 entry，client combo URL 200。
5. CDP e2e：入口按钮 → 面板六 Tab 可开 → 提交框/暂存/撤销块（含确认层级）/stash/tag/reset/revert 主路径冒烟通过。
6. 亮/暗主题下无硬编码色；危险操作均有二次确认。
