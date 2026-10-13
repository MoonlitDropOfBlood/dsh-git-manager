# 子仓库（submodule + 嵌套独立仓库）全插件支持 —— 规划与实现契约

日期：2026-10-13。状态：规划（已与用户确认两项选型）。

用户确认的选型：

1. **子仓库定义：两者都要** —— git submodule（`.gitmodules` 注册）**和**目录里嵌套独立 `.git` 的仓库，统一成一个「仓库树」模型，一套代码全覆盖。
2. **呈现方式：聚合 + 下钻** —— 变更 Tab 一个列表聚合主仓库 + 各子仓库（按仓库分组、可展开）；历史 / 分支 / 冲突 / Worktree / 设置 Tab 顶部有「仓库切换器」。

## 0. 现状诊断（为什么现在不支持）

| 层 | 现状 | 缺口 |
|---|---|---|
| Host Remote 方法 | 全部 56 个方法都接收 `request.path` 并在该路径上跑 git（`validatePath` + `runGit(request.path, ...)`） | **对子仓库天然可用**——只要 client 传子仓库 toplevel 即可。唯一缺口是 `validatePath` 只查「是目录」，无「必须位于主仓库内」的 containment 约束 |
| `probeRepo` | 返回 `{isRepo, toplevel, gitDir, ...}` | 对子仓库路径本身可用；缺「发现我的子仓库」 |
| `parseStatusV2` | 解析 porcelain v2 type 1/2/u 行，但**忽略第三列 `<sub>` 字段**（N/S/M/U/C/D/B/A 子仓库状态） | 子仓库指针变更/内容脏被当普通 modified 文件；diff 出 `Subproject commit` 原始文本，无语义 |
| 嵌套独立仓库 | `git status` 里只是 `? dir/` 未跟踪目录 | 无法发现、无法下钻；更危险：主仓库「暂存」它会把它变成意外 gitlink（见 §5.1） |
| Client | `repoPath = targetPath \|\| currentSessionCwd` 固定单仓库；六 Tab 全部硬绑这个 path | 无仓库模型、无分组、无切换器 |

结论：**这是一次「发现层 + 数据模型 + UI 结构」的改动，Remote 方法层大多是复用**。

## 1. 目标 / 非目标

### 目标

- **仓库树发现**：主仓库 + 全部 submodule（含递归、含未初始化）+ 直接子目录里的嵌套独立仓库，一次性列全。
- **变更 Tab 聚合**：按仓库分组的文件列表，组内操作（stage/unstage/discard/diff/hunk/commit）作用于该仓库自己的 toplevel。
- **六 Tab 仓库切换**：分支 / 历史 / 冲突 / Worktree / 设置顶部切换器，全部操作作用于所选仓库（复用现有 `path` 机制）。
- **子仓库语义正确**：指针变更 vs 内容脏 vs 未初始化 vs 冲突，四种状态可视、可操作。
- **submodule 管理**（P2）：init / update / sync / deinit / add 列表视图（补齐 v2 文档 P3-B #9）。

### 非目标

- 子仓库的子仓库全局递归扫描（只对 submodule 做 `--recursive` 注册链；嵌套仓库只扫直接子目录，下钻时按需再扫）。
- 把嵌套独立仓库一键「转换为 submodule」（P3 候选，见 §7）。
- 嵌套仓库内容展开进主仓库 diff（子仓库内容只在自己的仓库视图里出现）。

## 2. 仓库树模型（Host ↔ Client 唯一事实源）

### 2.1 发现算法（`listSubRepos`，git-core.mjs 新增）

输入 `rootToplevel`，输出仓库树节点数组（含 root 自身）。发现源两路合并、按 toplevel 去重：

1. **submodule 路（注册仓库）**：
   - `git submodule status --recursive`（在 root 跑）→ 每行 ` <sha> <path> (<describe>)`，前缀语义：` `正常 / `-`未初始化 / `+`指针不符 / `U`冲突。
   - 补 `git config -f .gitmodules --get-regexp '^submodule\..*\.(path|url)$'` 拿 name/url（`submodule status` 不给 url）。
   - 未初始化的也要列出（`kind:"submodule", initialized:false`），目录可能为空。
2. **嵌套仓库路（非注册仓库）**：
   - 取 root 的未跟踪目录清单：`git ls-files --others --directory --exclude-standard`（会折叠成 `dir/`）。
   - 对每个候选目录跑轻量 `probeRepo()`：`isRepo && resolve(toplevel) === resolve(candidate)` 才算嵌套仓库（否则它只是普通未跟踪目录，或它本身是更深层仓库的子目录——后者只取 toplevel，去重）。
   - 已被 submodule 路覆盖的路径跳过（submodule 优先，kind 不重复计）。

每个节点：

```js
{
  id,               // 稳定 id：相对 root 的 posix 路径（root 自身为 ""）
  path,             // 绝对 toplevel（Windows 反斜杠归一，与 safeJoin 同规）
  relPath,          // 相对 root 的 posix 路径，"" = root
  name,             // 展示名：submodule 取 .gitmodules name，嵌套取目录名，root 取目录名
  kind,             // "root" | "submodule" | "nested"
  depth,            // root=0
  // 状态摘要（每仓库 probeRepo + getStatus 摘要，只取计数，不带文件明细）
  initialized,      // submodule 专用；其余恒 true
  branch, detached, headShort, unborn,
  dirty: { staged, unstaged, untracked, conflicted },
  // submodule 专用（kind!=="submodule" 时**不挂这些 key**，JSON-safe 规则）
  submodule: {
    state,          // "ok" | "uninitialized" | "pointer-mismatch" | "conflict"
    sha,            // 当前 checkout 的 commit
    recordedSha,    // 父仓库 index 记录的 gitlink 指针
    url,
  },
}
```

> **JSON-safe 硬规则（AGENTS.md 教训）**：可选字段有值才挂 key；`dirty` 计数恒为数字（0 也算）；`branch` 无分支用 `""` 不用 `null`（unborn/detached 用布尔位表达）。self-test `wire:` 守卫必须覆盖 submodule / nested / root 三种节点形态。

### 2.2 新 Remote 方法

| 方法 | 请求 | 返回 | 期 |
|---|---|---|---|
| `repoTree` | `{path}` | `{repos:[...]}`（§2.1 节点数组） | P0 |
| `submoduleInit` | `{path, name?}` | `{status}`（`git submodule init [name]`） | P2 |
| `submoduleUpdate` | `{path, name?, init?, recursive?}` | `{status}`（`git submodule update [--init] [--recursive] [name]`） | P2 |
| `submoduleSync` | `{path, name?}` | `{status}` | P2 |
| `submoduleDeinit` | `{path, name, force?}` | `{status}`（危险操作，UI 二次确认） | P2 |
| `submoduleAdd` | `{path, url, name?, relPath}` | `{status, probe}`（relPath 过 safeJoin；网络操作走 runGitNet） | P2 |

`name` 入参白名单校验（`checkSubmoduleName`：非空、无空白/元字符、禁 `-` 开头），`relPath` 过 `safeJoin`，`url` 拒绝以 `-` 开头。全部方法走 `markRemoteMethod` + typert.host.js `METHODS` **同名同序** + 双形态 codec（`schema` + `create: () => schema`）。

### 2.3 现有 Remote 方法的修改

| 方法 | 修改 | 期 |
|---|---|---|
| `status` | `parseStatusV2` 提取 type 1/2 行第三列 `<sub>` 字段；`sub !== "N"` 时挂 `entry.subState`。gitlink 指针变更的条目挂 `entry.gitlink:{fromSha,toSha}`（从 diff 解析或 porcelain v2 的 hH/hI） | P0 |
| `validatePath` | 新增可选 containment 模式：子仓库操作时要求 `resolve(path)` 以 root toplevel 为前缀（`safeJoin` 同款归一化先 resolve）；`repoTree`/`submodule*` 用它，普通方法维持现状（兼容当前 session cwd 语义） | P0 |
| `resolveConflict` | gitlink 冲突（`<sub>` 为 `U`）的 ours/theirs 分派：对该路径 `git checkout --ours/--theirs -- <path>` + `git add -- <path>`（普通文本冲突逻辑不变） | P1 |
| `diff` | `file` 是 gitlink 时返回特殊结构（不拼文本 diff）：`{gitlink:{path, fromSha, toSha}}`，或维持文本但 client 特判 `Subproject commit` 头（实现取简者，倾向前者） | P1 |

其余 50 个方法**零改动**——它们已经是 path 泛化的。

## 3. UI 契约（client.js）

### 3.1 面板级仓库模型

```
GitPanel 状态新增：
  repoTree            // repoTree({path: rootPath}) 结果，probe 轮询缓存同款 60s
  activeRepoId        // "" = root；切换器与下钻都改它
  activeRepo          // repoTree 中选中的节点（其 .path 即所有请求的 path）
tabProps 增加：repoTree, activeRepo, setActiveRepo, rootPath
```

**关键：六 Tab 的 `repoPath` 从 `props.repoPath` 改为 `activeRepo.path`**——现有全部 `remote.*( {path: repoPath, ...} )` 调用点无需改写逻辑，只换值来源。

### 3.2 变更 Tab（聚合视图）

- 分组列表：root 组在最上，其余子仓库按 relPath 排序；每组组头一行：
  - 图标/徽标：submodule（🔗 + 状态色）/ nested（📁）/ root（仓库图标）；
  - `name` + `relPath`（root 只显 toplevel）；
  - 摘要 chips：分支、`±a/b/c` 脏计数、submodule 状态徽标（未初始化 / 指针不符 / 冲突）；
  - 组操作：「进入」（setActiveRepo → 其余 Tab 跟随）、折叠/展开。
- 组内文件行 = 现有 FileRow 复用，但 stage/unstage/discard/diff/hunk/blame/历史 全部传**该组仓库的 path**。
- 提交框：作用于「当前聚焦组」（默认 root；点击组头聚焦，框上方显示目标仓库名）。每组组头也可有「暂存全部」。
- **特殊行：gitlink 指针变更**（root 组里的 submodule 条目）：显示「指针 a1b2c3d → e4f5g6h」，操作为「暂存新指针」「查看子仓库历史」（下钻 + 历史 Tab）；不做普通文件 diff 入口。
- **特殊行：嵌套仓库未跟踪目录**：不提供「暂存」按钮（防意外 gitlink，§5.1），提供「进入此仓库」；P2 起可提供「转换为 submodule」引导。
- **未初始化 submodule**：组头显示「未初始化」+「初始化」按钮（`submoduleUpdate {init:true}`，P2；P0 先只显示状态）。

### 3.3 仓库切换器（分支 / 历史 / 冲突 / Worktree / 设置 Tab 通用）

- 位置：各 Tab 内容区顶部一行（`.gm-repo-bar`），面包屑形态：`主仓库 / libs/foo (submodule) / tools/bar`；点击任一段切换。
- 快捷键位/下拉形态二选一，以窄宽度（800px 面板）不换行为准。
- 切换后该 Tab 数据全部重取（现有 `useEffect [repoPath]` 依赖自动生效——把 `repoPath` 换成 `activeRepo.path` 即可）。
- 切换器上对有冲突的仓库打红点（冲突 Tab 的徽标聚合 N 个仓库）。

### 3.4 各 Tab 语义（per-repo）

| Tab | 切换后行为 | 备注 |
|---|---|---|
| 分支 | 分支/tag/merge/rebase 全部作用于所选仓库 | 零新逻辑 |
| 历史 | `log`/graph/reflog/范围对比 作用于所选仓库 | `computeGraph` 本来就是 per-repo 纯函数 |
| 冲突 | 所选仓库的冲突清单 | gitlink 冲突显示「指针冲突：选我们的/他们的指针」（P1） |
| Worktree | 所选仓库自己的 worktree 列表 | 注意 linked worktree 下的 submodule（§5.3） |
| 设置 | 所选仓库的 remote/config | submodule 的 url 在此可看（P2 可改） |

### 3.5 头部 Fetch/Pull/Push

P0：作用于 `activeRepo`。P2：加「全部仓库」批量（`git submodule foreach` 语义，逐仓库调用现有 fetch/pull/push，串行 + 进度）。

### 3.6 历史 Tab 的指针跳转（P1）

root 历史里某提交改了 gitlink → diff 窗口顶部显示指针 `a→b` +「在子仓库中查看 a..b」按钮：`setActiveRepo(sub)` → 切历史 Tab → `diffRange {from: a, to: b}`。若 a/b 不在子仓库当前 clone 里（浅克隆/旧指针已清）则按钮禁用并提示。

## 4. Host 侧实现要点（git-core.mjs / index.js）

1. `listSubRepos(root)`：§2.1 两路发现 + 去重；每节点并行（限流 ~4 并发）跑 `probeRepo` + `getStatus` 摘要；单仓库失败不炸整体（节点挂 `error:"..."` 字符串，其余照常）。
2. `repoTree` 在 index.js 包 envelope；**必须在 root toplevel 跑**（`git submodule status` 对 cwd 敏感）。
3. `getStatus` 摘要函数抽一个 `statusSummary(parsed)` 纯函数（staged/unstaged/untracked/conflicted 计数），`repoTree` 与 `status` 共用。
4. `parseStatusV2` 修改是纯函数改动：type 1 行 `parts[2]` 即 `<sub>`，type 2 同列；输出条目加 `subState`（仅非 "N" 时挂 key）。fixture 单测必须覆盖 `M`（内容脏）/`+` 语义（porcelain v2 中 gitlink 指针变更表现为 hH≠hI + sub 字段）。
5. containment 校验：`validateRepoPath(root, path)` = `resolve` 归一后前缀判定（复用 safeJoin 的归一化教训：先 `resolve(root)`）。

## 5. 关键坑（必须写进实现与测试）

### 5.1 嵌套仓库「暂存」= 意外 gitlink（实测 git 语义）

对未跟踪的嵌套仓库目录跑 `git add dir/`，git 会把整个目录折叠成一个 **mode 160000 gitlink**（嵌入仓库），之后 `git status` 显示 modified、diff 显示 `Subproject commit`，但它**不在 `.gitmodules` 里**——是所有 git 工具的经典陷阱。对策：nested 节点在主仓库组内**禁用暂存按钮**，只给「进入」；「暂存全部」（`stage all`）前过滤掉 nested 目录路径。

### 5.2 submodule 四态要分清

| 状态 | 来源 | UI | 可做什么 |
|---|---|---|---|
| 未初始化（`-`） | `submodule status` 前缀 `-` | 灰色组 + 「初始化」 | init/update（P2） |
| 指针不符（`+`） | 前缀 `+`，hH≠hI | 「指针 a→b」行 | 暂存新指针 / 丢弃（restore gitlink）/ 下钻看历史 |
| 内容脏 | submodule 自己的 status 非空 | 组内普通文件行 | 下钻后全部常规操作 |
| 冲突（`U`） | 合并中 gitlink 冲突 | 冲突 Tab + 指针选择 | ours/theirs + add（P1） |

### 5.3 路径与 worktree 归一化

- submodule 的 `.git` 是**文件**（gitdir 指向父仓库 `.git/modules/...`）；`probeRepo` 用 `rev-parse` 不读 `.git` 文件内容，天然安全，但任何 `existsSync(join(gitDir,...))` 逻辑（如 MERGE_HEAD 检测）已走 `resolve(cwd, gitDir)` 归一，新增代码必须沿用。
- linked worktree 里的 submodule 路径：`repoTree` 以「打开面板时的 root toplevel」为准逐层发现，worktree 切换不迁移（与现面板绑定会话目录的语义一致）。
- Windows 大小写：去重与 containment 用 `toLowerCase()` 比较（worktrees 的 `current` 判定已有先例）。

### 5.4 性能与缓存

- `repoTree` 每节点 2-3 个 git 调用；十来个子仓库 ≈ 30 个进程，冷启动约 1-2s。缓存 60s（与 probe 轮询同款）；mutation 后主动失效。
- 嵌套仓库发现只扫**直接子目录**（depth 1），深层下钻时按需再 `repoTree(subPath)`。

## 6. 测试要求（scripts/self-test.mjs）

1. **fixture**：临时 root 仓库 + `git submodule add <file:// 本地仓库>` + 嵌套 `git init` 目录 + 普通未跟踪目录（负例）。
2. `parseStatusV2`：`<sub>` 字段 fixture（N/M/U 各一），断言 `subState` 只在非 N 时挂 key。
3. `listSubRepos` live：三种节点齐、kind 正确、嵌套普通目录不误报、未初始化 submodule 列出。
4. `repoTree` wire 守卫：strict schema + assertJsonSafe 复刻跑三种节点形态（**新增 Remote 方法必须过**）。
5. containment：越界 path（root 外的目录）被 `validateRepoPath` 拒绝。
6. nested 暂存防护：`stage` 过滤逻辑单测（纯函数抽取）。
7. 静态守卫：typert 双形态、`METHODS` 同名同序、组件从 `props.remote` 取 remote——新增 6 方法后守卫必须全绿。
8. live 集成：submodule 指针变更 → `status` 出 gitlink 条目 + `subState`；指针暂存/丢弃回路。

## 7. 分期

### P0（基础：发现 + 聚合 + 切换，本轮核心交付）

- `listSubRepos` + `repoTree`（含 wire schema、containment）。
- `parseStatusV2` 的 `<sub>` 解析 + gitlink 条目语义。
- 变更 Tab 聚合分组视图（含 §5.1 nested 暂存防护、gitlink 指针行）。
- 仓库切换器 + 六 Tab `repoPath` 换源。
- self-test 全套（§6.1-6.7）。

### P1（下钻完善）

- diff 窗口 gitlink 特殊渲染 + 「在子仓库中查看 a..b」历史跳转（§3.6）。
- gitlink 冲突 ours/theirs（`resolveConflict` 分派）。
- 冲突徽标多仓库聚合。
- **未跟踪目录的 discard 删除支持**（C 代理实测发现的既有缺口，非本轮引入）：`discardFiles` 对未跟踪路径 `rm(abs, {force:true})` 无 `recursive:true` 且吞错——未跟踪**目录**（如 `plain-dir/`）即使通过嵌套仓库防护也删不掉；支持时须与 `containsGitDir` 防护保持先后顺序（先防护判定再删除）。

### P2（submodule 管理，补齐 v2 P3-B #9）

- `submoduleInit/Update/Sync/Deinit/Add` + 设置 Tab「子仓库」管理区。
- 未初始化 submodule 的「初始化」按钮；头部「全部仓库」fetch/pull。
- nested → submodule 转换引导（`submoduleAdd` 复用）。

### P3 候选（本轮不做）

- 子仓库跨仓库统一历史视图（合并多仓库 log）。
- submodule 指针批量更新（foreach 到最新）。
- 递归嵌套仓库全局扫描开关。

## 9. P0 实现偏差记录（Lead 裁决，已随实现落地）

| # | 偏差 | 裁决 |
|---|---|---|
| 1 | `ls-files --others --directory` 追加 `-z`（契约未写） | **通过**——非 -z 时特殊字符路径被 C 风格引号包裹，-z 语义一致且更稳 |
| 2 | `validateRepoPath` 在 win32 做 toLowerCase 比较 | **通过**——方案 §5.3 既定；POSIX 保持大小写敏感 |
| 3 | 深度 ≥2 的嵌套仓库不进树（折叠目录的外层不是仓库时） | **通过**——契约既定；下钻时对子仓库再调 `repoTree` 按需发现 |
| 4 | 病态 `.gitmodules`（越界路径）per-node 跳过不炸整体 | **通过**——单点失败不拖垮发现层 |
| 5 | `discard` 的 skipped 由 git-core 挂 `status.skipped`、index.js 提升为 `{status, skipped?}` envelope | **通过**——避免破坏现有 self-test 对 `discardFiles` 返回 status 的断言；status 内不残留 key |
| 6 | probe 抛错的 submodule error 节点仍挂 `submodule` key（initialized=true 为最佳猜测） | **通过**——未初始化（`-` 前缀）节点保证不挂 |
| 7 | Client `activeRepoId` 重置用 `repoSel{root,id}` 派生实现（契约写的是 reset effect） | **通过**——行为等价且省一轮旧仓库请求 |
| 8 | 非 root 组状态轮询 30s（方案 §5.4 的 60s 指 repoTree 缓存） | **通过**——不冲突；后台改动的反馈更快 |
| 9 | porcelain v2 `<sub>` 实测为 4 字符位置型标志（`SC..`/`S.M.`/`S..U`/`S...`/`SCM.`），client 徽标按标志位集合解码（C=指针不符、M=内容已修改、U=有未跟踪内容） | **已落地**——Lead 实证矩阵修正了 Client 初版按整串查表的缺陷 |

### 调度记录（2026-10-13）

- 三个子代理（Host / Client / Tests）按互不重叠写入范围并行：A=git-core.mjs+index.js+typert.host.js，B=client.js，C=scripts/self-test.mjs；Lead 只做契约下发、实证前置验证（发现层假设、`<sub>` 解码矩阵）、跨代理对齐、集成审查与文档。
- background `subagent` 无法用 `send_message` 中途续派（target not found ×2）——需要中途修正时由 Lead 直接改或等交付后处理。

## 10. P1 实现偏差记录（2026-10-13，Lead 裁决全部通过）

| # | 偏差 / 发现 | 裁决 |
|---|---|---|
| 1 | **契约的 gitlink 冲突机制被实测推翻**：`git checkout --ours/--theirs -- <gitlink>` 对 mode 160000 未合并条目是**静默空操作**（exit 0、三阶段原样保留），随后的 `git add` 记的是子模块工作副本当前 HEAD——ours/theirs 产出同一指针。已改为 `resolveGitlinkConflict`：`update-index --add --cacheinfo 160000,<stage sha>,<file>` 直接写 stage0（选中侧为删除时 `--force-remove`），随后**仅当子仓库干净**时 best-effort `checkout --detach` 同步工作区。D 与 F 双双独立实证 | 通过（接口零变化，仅换底层机制；AGENTS 常规注意事项已加防退化条目） |
| 2 | gitlink 冲突的**前提**：两侧指针互不为祖先——一侧是另一侧祖先时 git 直接 fast-forward 指针自动和解，根本不进冲突态 | 已写进 self-test 与 cdp-e2e-p1.mjs 注释（fixture 必须在 submodule 内造分叉提交） |
| 3 | `revExists` 的 `revs` 在 typert 按契约为**必填**（非 optional）；client 恒传数组，无影响 | 通过 |
| 4 | `requestRange(null)` 作为 HistoryTab 消费回执（历史 Tab 随切换卸载重挂，不清空会重复弹旧对比） | 通过 |
| 5 | 面板 15s 轮询顺带 `refreshTree()`——多仓库冲突/脏徽标原本会停在旧快照 | 通过（P1「徽标聚合核对」发现的真实缺口） |
| 6 | 嵌入仓库 gitlink（不在 .gitmodules、树里无节点）的跳转按钮呈 `no-sub` 禁用态而非隐藏 | 通过 |
| 7 | `containsGitDir` 预算 4 层/400 项 → **6 层/2000 项**（递归删除后漏检代价=删库，向检出保守方向放宽） | 通过 |
| 8 | ConflictsTab 解决指针后补 `refreshTree()`；compareHint 选满 base+head 后的文案修正 | 通过 |
| 9 | **遗留未覆盖**：`resolveGitlinkConflict` 的「选中侧删除了该子模块」分支（`--force-remove`）无测试（delete-vs-modify gitlink 的 fixture 易抖动，D/F 均未驯服） | P2 补专门 fixture |

### P1 CDP e2e（2026-10-13，Lead 独立完成）

真实 DSH 临时实例（桌面自带 node + `@deepseek-ai/dsh/lib/bin.js`，临时 DSH_HOME + `profiles/web` junction 回真实 profile，3579 端口）+ headless Edge（9223）+ fixture（主仓库 + submodule 指针漂移 + 嵌套仓库 + 未跟踪目录）。脚本 `scripts/cdp-e2e-p1.mjs` 三阶段 **30/30 全 PASS**：A=变更分组聚合（4 组）+ 指针 diff「指针 a→b」+ revExists 门控跳转（切作用域/切历史/自动范围对比）；B=gitlink 冲突现场制造（submodule 分叉提交）→ 冲突 Tab「子模块指针」行（ours/theirs、无手动编辑）→ 解决 +「继续」→ MERGE_HEAD 清除；C=未跟踪目录递归丢弃（UI 确认流）+ 嵌套仓库防护不误伤。拆解纪律：Edge 按 user-data-dir 精确匹配清杀（10 进程）、临时实例按 --port 匹配、junction `cmd /c rmdir`、用户 3080 实例全程健在、真实 profile 完好。

## 11. P2 实现偏差记录（2026-10-13，Lead 裁决全部通过）

| # | 偏差 / 发现 | 裁决 |
|---|---|---|
| 1 | 五方法参数由方案表的 `name?` 修正为 **`subPath`**——git CLI 的 init/update/sync/deinit/add 接受的是**路径**不是注册名（仅 add 的 `--name` 才是注册名） | 通过（方案表以实现为准） |
| 2 | `isLocalSubmoduleUrl` 覆盖超集：除契约的 existsSync/`./`/`../`/`/`/盘符外还含 UNC `\\server\share` | 通过（无安全削弱，代码注释已记权衡） |
| 3 | **`doDeinit` 补 `force:true`（Lead 修复）**：确认弹窗文案「会清空该子仓库工作区内容」是 `deinit -f` 语义，不带 -f 时 git 对有本地改动的子模块会拒绝——文案与行为必须一致 | 通过 |
| 4 | **`submoduleAdd` 的 `.git/modules` 残留回退（Lead 修复，e2e 实测发现）**：`git submodule add` 遇同名本地 gitdir 残留报 `fatal: A git directory for '...' is found locally`（卸载后重加/多轮 e2e 清理后必现）；按 git 自身提示捕获该错误后以 `--force` 重试一次（复用本地对象库，url 已过白名单） | 通过 |
| 5 | E2 四项 UI 偏离：`submoduleInit` 进 CLIENT_METHODS 但无 UI 调用点（「初始化并拉取」= `update{init:true}`，init 单独语义偏门，保留 API 完整性）；add 失败不关表单；`hasApi` 灰度守卫；notice 生命周期 | 全部通过 |
| 6 | F2 实测（写进测试注释）：`git submodule status` 的 `-` 前缀跟的是**工作副本是否 populate** 而非「是否注册」——`init` 后仍为 `-`，`update` 检出后才变空格；产品 `listSubRepos.initialized` 同源 → **UI 必须 init+update 成对调用**（变更 Tab「初始化」按钮的 `update{init:true,recursive:true}` 正是该语义） | 记录（非缺陷） |
| 7 | F2 实测：deinit 后空目录仍在父仓库内、`rev-parse HEAD` 会向上解析到父仓库（测试改用 `--show-toplevel` 落点判定）；无 force 的 deinit 只在子模块「不干净」时才拒 | 记录（测试口径） |

### P2 CDP e2e（2026-10-13，Lead 独立完成，27/27 × 2 连跑幂等）

脚本 `scripts/cdp-e2e-p2.mjs`，临时实例（3580 端口）+ headless Edge（9224）。五阶段：A=设置 Tab「子仓库」管理区渲染（1/2 计数、行按钮、origin 门控——无 origin 的 base-src 注册按钮禁用）；B=卸载→未初始化徽标→变更 Tab「初始化」→徽标消失（生命周期闭环，磁盘轮询为准）；C=「添加子模块」表单（本地路径 url 自动 file 放行 → .gitmodules + 克隆 + 计数 1/2→2/2）；D=嵌套仓库 vendor-tool **就地注册为 submodule**（内容不动 + 计数 2/2→3/1）；E=「Fetch 全部」跨仓库串行聚合 notice。**踩坑记录（对后续 e2e 有复用价值）**：①fixture Phase 0 做**全量确定性重建**（外科手术式清理敌不过多轮实验残留）；②沙盒**禁止删除工作区根目录本身**——改清内容；③FormDialog 是 Portal 落 body，受控输入的 React onChange 收不到冒泡不过 root 容器的合成事件 → 用 CDP `Input.insertText` 注入真实文本；④多行同名按钮必须**按行定位**（base-src 的注册按钮被禁用时 `find` 会取错）；⑤组头按钮文案是「初始化」（「初始化并拉取」只是 tooltip）；⑥树刷新落地有秒级滞后 → 所有「点击 → 断言 UI 状态」都用分级轮询窗口（15-45s）。

## 8. 验证清单（实现后手动验证）

1. 真实多 submodule 仓库打开面板：变更 Tab 分组正确、计数正确。
2. 改 submodule 内文件 → 出现在该子仓库组；改指针（子仓库 checkout 另一提交）→ root 组出现「指针 a→b」。
3. 嵌套仓库：主仓库组无「暂存」按钮；「进入」后六 Tab 全部正常。
4. 切换器在五个 Tab 都工作且状态独立（root 的历史与子仓库的历史互不串）。
5. 未初始化 submodule 显示灰色状态不报错。
6. 合并含 gitlink 冲突的分支 → 冲突 Tab 显示指针冲突（P1）。
7. `npm run check` + `npm test` 全绿；wire 守卫过；`dsh plugin add` + boot manifest + CDP e2e 按 AGENTS.md §0.2.0 流程复验。
