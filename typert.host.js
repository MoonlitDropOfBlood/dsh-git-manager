/**
 * dsh-git-manager — Typert Host manifest.
 *
 * 手写 TYPERT manifest（dsh-typert-loader 从包的 `./typert` 导出加载）。
 * 必须导出名为 `TYPERT` 的 manifest 对象（loader 的 validateTypertManifest 校验），
 * 形状与 memory-manager / archive-manager 的手写 manifest 一致：
 *   { package, face: "host", schemas: [], invocations: [...], model: {services:[...]}, events: [], objects: [] }
 *
 * 每个 invocation：{ id, service, namespace, method, invocation:{kind:"direct"},
 *   parameters:[{name, wire, source, codec:{mode:"strict", typeSymbol, schema}}],
 *   result:{mode:"strict", typeSymbol, schema} }
 *
 * 与 index.js (GitManagerService) 和 client.js 的关键名字一致：
 *   - 服务键 / 类名：gitManager / GitManagerService
 *   - invocation id：dsh-git-manager#gitManager/<method>
 */

import { z } from "zod";

// ---- shared schemas -------------------------------------------------------

const errorSchema = z.object({
  code: z.string().readonly(),
  message: z.string().readonly(),
}).readonly();

// status 的文件条目：子仓库支持 P0 新增两个可选字段（有值才挂 key，
// 否则网关 assertJsonValue 拒绝显式 undefined 的 own key——见 AGENTS.md）
//   subState —— porcelain v2 <sub> 原样字符串（"SC.." 等，仅非 "N" 时存在）
//   gitlink  —— staged 的 gitlink 指针变更：hH/hI 均为 40 位 sha 且不相等
const gitlinkSchema = z.object({
  fromSha: z.string().readonly(),
  toSha: z.string().readonly(),
}).readonly();

const fileEntrySchema = z.object({
  path: z.string().readonly(),
  oldPath: z.string().readonly().optional(),
  x: z.string().readonly().optional(),
  y: z.string().readonly().optional(),
  kind: z.string().readonly(),
  subState: z.string().readonly().optional(),
  gitlink: gitlinkSchema.optional(),
}).readonly();

const conflictEntrySchema = z.object({
  path: z.string().readonly(),
  xy: z.string().readonly(),
}).readonly();

const branchInfoSchema = z.object({
  name: z.string().readonly(),
  refname: z.string().readonly(),
  shortSha: z.string().readonly(),
  at: z.number().readonly(),
  upstream: z.string().readonly().nullable(),
  ahead: z.number().readonly().nullable(),
  behind: z.number().readonly().nullable(),
  upstreamGone: z.boolean().readonly(),
  subject: z.string().readonly(),
  current: z.boolean().readonly(),
}).readonly();

const commitSchema = z.object({
  sha: z.string().readonly(),
  short: z.string().readonly(),
  parents: z.array(z.string().readonly()).readonly(),
  author: z.string().readonly(),
  email: z.string().readonly(),
  at: z.number().readonly(),
  refs: z.string().readonly(),
  subject: z.string().readonly(),
  // v2 §6：subject 之后的多行正文（amend 预填用）；无正文挂 ""（字段稳定）
  body: z.string().readonly().optional(),
}).readonly();

const graphSchema = z.object({
  nodes: z.array(z.object({ col: z.number().readonly(), color: z.number().readonly() }).readonly()).readonly(),
  links: z.array(z.object({
    fromRow: z.number().readonly(),
    fromCol: z.number().readonly(),
    toRow: z.number().readonly().nullable(),
    toCol: z.number().readonly(),
    color: z.number().readonly(),
    kind: z.string().readonly(),
  }).readonly()).readonly(),
  laneCount: z.number().readonly(),
}).readonly();

const probeSchema = z.object({
  isRepo: z.boolean().readonly(),
  toplevel: z.string().readonly().optional(),
  gitDir: z.string().readonly().optional(),
  commonDir: z.string().readonly().optional(),
  bare: z.boolean().readonly().optional(),
  branch: z.string().readonly().nullable().optional(),
  detached: z.boolean().readonly().optional(),
  headShort: z.string().readonly().nullable().optional(),
  unborn: z.boolean().readonly().optional(),
  merging: z.boolean().readonly().optional(),
  rebasing: z.boolean().readonly().optional(),
  isLinkedWorktree: z.boolean().readonly().optional(),
  mainWorktreePath: z.string().readonly().optional(),
}).readonly();

const statusSchema = z.object({
  branch: z.string().readonly().nullable(),
  detached: z.boolean().readonly(),
  headSha: z.string().readonly().nullable(),
  upstream: z.string().readonly().nullable(),
  ahead: z.number().readonly(),
  behind: z.number().readonly(),
  unborn: z.boolean().readonly(),
  staged: z.array(fileEntrySchema).readonly(),
  unstaged: z.array(fileEntrySchema).readonly(),
  untracked: z.array(z.string().readonly()).readonly(),
  conflicted: z.array(conflictEntrySchema).readonly(),
  merging: z.boolean().readonly(),
  rebasing: z.boolean().readonly(),
}).readonly();

const worktreeSchema = z.object({
  path: z.string().readonly(),
  headSha: z.string().readonly().nullable(),
  branch: z.string().readonly().nullable(),
  detached: z.boolean().readonly(),
  bare: z.boolean().readonly(),
  locked: z.union([z.boolean().readonly(), z.string().readonly()]).readonly().optional(),
  prunable: z.union([z.boolean().readonly(), z.string().readonly()]).readonly().optional(),
  current: z.boolean().readonly().optional(),
  // 行内状态富化（getWorktrees：非 bare worktree 才有；可选字段有值才挂 key）
  headShort: z.string().readonly().optional(),
  dirty: z.object({
    staged: z.number().readonly(),
    unstaged: z.number().readonly(),
    untracked: z.number().readonly(),
    conflicted: z.number().readonly(),
  }).readonly().optional(),
  ahead: z.number().readonly().optional(),
  behind: z.number().readonly().optional(),
  error: z.string().readonly().optional(),
}).readonly();

const remoteSchema = z.object({
  name: z.string().readonly(),
  fetchUrl: z.string().readonly().nullable(),
  pushUrl: z.string().readonly().nullable(),
}).readonly();

// ---- v2 §2.2 新增数据形状（strict、readonly；可选字段有值才挂） ----

const stashEntrySchema = z.object({
  index: z.number().readonly(),
  ref: z.string().readonly(),
  subject: z.string().readonly(),
  at: z.number().readonly(),
}).readonly();

const tagInfoSchema = z.object({
  name: z.string().readonly(),
  sha: z.string().readonly(),
  short: z.string().readonly(),
  subject: z.string().readonly(),
  at: z.number().readonly(),
  annotated: z.boolean().readonly(),
  message: z.string().readonly().optional(),
}).readonly();

const blameLineSchema = z.object({
  sha: z.string().readonly(),
  short: z.string().readonly(),
  author: z.string().readonly(),
  at: z.number().readonly(),
  line: z.number().readonly(),
  text: z.string().readonly(),
}).readonly();

const reflogEntrySchema = z.object({
  sha: z.string().readonly(),
  short: z.string().readonly(),
  selector: z.string().readonly(),
  message: z.string().readonly(),
  at: z.number().readonly(),
}).readonly();

const configEntrySchema = z.object({
  key: z.string().readonly(),
  value: z.string().readonly(),
}).readonly();

// ---- 子仓库支持 P0（2026-10-13）：仓库树 RepoNode ----
// 可选字段一律 .optional() 且 Host 侧「有值才挂 key」；字符串无值用 ""、
// 计数恒为数字（不挂 null/undefined）。

const repoDirtySchema = z.object({
  staged: z.number().readonly(),
  unstaged: z.number().readonly(),
  untracked: z.number().readonly(),
  conflicted: z.number().readonly(),
}).readonly();

// 只在 kind==="submodule" 且 initialized=true 时存在（未初始化节点不挂 key）
const repoSubmoduleSchema = z.object({
  state: z.enum(["ok", "pointer-mismatch", "conflict"]).readonly(),
  sha: z.string().readonly(),
  recordedSha: z.string().readonly(),
  url: z.string().readonly(),
}).readonly();

const repoNodeSchema = z.object({
  id: z.string().readonly(),
  path: z.string().readonly(),
  relPath: z.string().readonly(),
  name: z.string().readonly(),
  kind: z.enum(["root", "submodule", "nested"]).readonly(),
  depth: z.number().readonly(),
  initialized: z.boolean().readonly(),
  branch: z.string().readonly(),
  detached: z.boolean().readonly(),
  unborn: z.boolean().readonly(),
  headShort: z.string().readonly(),
  dirty: repoDirtySchema,
  // 仅当该节点 probe/status 查询失败时挂（节点仍返回，dirty 全 0）
  error: z.string().readonly().optional(),
  // 仅 kind==="nested" 且该仓库有 origin remote 时挂（P2：供客户端「注册为
  // submodule」转换用）。submodule/root 不挂——submodule 的 url 在 submodule.url。
  originUrl: z.string().readonly().optional(),
  submodule: repoSubmoduleSchema.optional(),
}).readonly();

const repoTreeValueSchema = z.object({
  repos: z.array(repoNodeSchema).readonly(),
}).readonly();

// P3-A §8.1：rebase todo 条目（action ∈ pick|squash|fixup|drop|edit，Host 枚举校验；
// message 仅 squash 有值才挂）
const rebaseTodoSchema = z.object({
  sha: z.string().readonly(),
  short: z.string().readonly(),
  subject: z.string().readonly(),
  action: z.string().readonly(),
  message: z.string().readonly().optional(),
}).readonly();

const branchesValueSchema = z.object({
  current: z.string().readonly().nullable(),
  locals: z.array(branchInfoSchema).readonly(),
  remotes: z.array(branchInfoSchema).readonly(),
}).readonly();

const logValueSchema = z.object({
  commits: z.array(commitSchema).readonly(),
  graph: graphSchema,
  hasMore: z.boolean().readonly(),
}).readonly();

const worktreesValueSchema = z.object({
  worktrees: z.array(worktreeSchema).readonly(),
}).readonly();

const conflictContentValueSchema = z.object({
  ours: z.string().readonly().optional(),
  theirs: z.string().readonly().optional(),
  base: z.string().readonly().optional(),
  worktree: z.string().readonly().optional(),
}).readonly();

const diffValueSchema = z.object({
  text: z.string().readonly(),
  truncated: z.boolean().readonly(),
}).readonly();

const statusOnlySchema = z.object({ status: statusSchema }).readonly();
const commitValueSchema = z.object({
  commit: z.string().readonly(),
  status: statusSchema,
}).readonly();
const mergeValueSchema = z.object({
  merged: z.boolean().readonly(),
  status: statusSchema,
}).readonly();
// cherry-pick 与 merge 同款契约：冲突时 picked=false 不抛错，
// 仓库进 CHERRY_PICK_HEAD 态，交冲突页解决后 mergeContinue 完成 pick
const cherryPickValueSchema = z.object({
  picked: z.boolean().readonly(),
  status: statusSchema,
}).readonly();
const fetchValueSchema = z.object({
  output: z.string().readonly(),
  status: statusSchema,
}).readonly();

function result(valueSchema) {
  return z.union([
    z.object({ ok: z.literal(true).readonly(), value: valueSchema }).readonly(),
    z.object({ ok: z.literal(false).readonly(), error: errorSchema }).readonly(),
  ]).readonly();
}

function netResult(valueSchema) {
  return z.union([
    z.object({ ok: z.literal(true).readonly(), value: valueSchema }).readonly(),
    z.object({
      ok: z.literal(false).readonly(),
      error: errorSchema,
      output: z.string().readonly().optional(),
      status: statusSchema.optional(),
    }).readonly(),
  ]).readonly();
}

// ---- per-method result schemas ------------------------------------------

const probeResult = result(probeSchema);
const overviewResult = result(z.object({
  probe: probeSchema,
  status: statusSchema.nullable(),
  remotes: z.array(remoteSchema).readonly(),
}).readonly());
const statusResult = result(statusSchema);
const diffResult = result(diffValueSchema);
const logResult = result(logValueSchema);
const branchesResult = result(branchesValueSchema);
const remotesResult = result(z.array(remoteSchema).readonly());
const worktreesResult = result(worktreesValueSchema);
const conflictContentResult = result(conflictContentValueSchema);
const mutationResult = result(statusOnlySchema);
const commitResult = result(commitValueSchema);
const mergeResult = result(mergeValueSchema);
const cherryPickResult = result(cherryPickValueSchema);
const fetchResult = netResult(fetchValueSchema);
const worktreeMutResult = result(worktreesValueSchema);
const initResult = result(z.object({ probe: probeSchema }).readonly());
// discard 与其它变更方法不同款：除 status 外还可能带 skipped（未跟踪清理时
// 含 .git 的嵌套仓库路径被跳过不删；有值才挂 key）
const discardValueSchema = z.object({
  status: statusSchema,
  skipped: z.array(z.string().readonly()).readonly().optional(),
}).readonly();
const discardResult = result(discardValueSchema);

// ---- v2 §2.2/§2.3 新增 result schemas -----------------------------------

const stashesValueSchema = z.object({
  stashes: z.array(stashEntrySchema).readonly(),
}).readonly();
const tagsValueSchema = z.object({
  tags: z.array(tagInfoSchema).readonly(),
}).readonly();
const blameValueSchema = z.object({
  lines: z.array(blameLineSchema).readonly(),
  truncated: z.boolean().readonly(),
}).readonly();
const reflogValueSchema = z.object({
  entries: z.array(reflogEntrySchema).readonly(),
}).readonly();
const configValueSchema = z.object({
  entries: z.array(configEntrySchema).readonly(),
}).readonly();
const remotesValueSchema = z.object({
  remotes: z.array(remoteSchema).readonly(),
}).readonly();
// revert 与 cherry-pick 同款契约：冲突 reverted=false 不抛错，进 REVERT_HEAD 态
const revertValueSchema = z.object({
  reverted: z.boolean().readonly(),
  status: statusSchema,
}).readonly();

const stashesResult = result(stashesValueSchema);
const tagsResult = result(tagsValueSchema);
const blameResult = result(blameValueSchema);
const reflogResult = result(reflogValueSchema);
const configResult = result(configValueSchema);
const remoteListResult = result(remotesValueSchema); // v2 remoteAdd/Remove/Rename 返回 { remotes }
const revertResult = result(revertValueSchema);

// ---- P3-A（§8.1/§8.3）result schemas -----------------------------------

// rebasePlan：todo 候选（base..HEAD 不含 base，最旧在前）
const rebasePlanResult = result(z.object({
  entries: z.array(rebaseTodoSchema).readonly(),
}).readonly());
// rebaseRun / fixupCommit / rebaseBranch 共款：done=false = 冲突或 edit 停驻进行中
const rebaseDoneValueSchema = z.object({
  done: z.boolean().readonly(),
  status: statusSchema,
}).readonly();
const rebaseRunResult = result(rebaseDoneValueSchema);
const fixupResult = result(rebaseDoneValueSchema);
const rebaseBranchResult = result(rebaseDoneValueSchema);

// ---- 子仓库支持 P0（2026-10-13）：repoTree ----
const repoTreeResult = result(repoTreeValueSchema);

// ---- 子仓库支持 P1：revExists（sha 存在性门控）----
// 恒为数组（空数组合法）；ok:false = 该 sha 不在这个仓库的对象库里（跳转禁用），
// 非法 sha 由 git-core 抛错走错误信封，不会混进 checks 里。
const revExistsValueSchema = z.object({
  checks: z.array(z.object({
    rev: z.string().readonly(),
    ok: z.boolean().readonly(),
  }).readonly()).readonly(),
}).readonly();
const revExistsResult = result(revExistsValueSchema);

// ---- 子仓库支持 P2（2026-10-13）：submodule 管理五方法 ----
// 前四个与其它变更方法同款：{ status }；submoduleAdd 额外带新子仓库 probe，
// 客户端可直接把新节点插进仓库树。
const submoduleAddValueSchema = z.object({
  status: statusSchema,
  probe: probeSchema,
}).readonly();
const submoduleAddResult = result(submoduleAddValueSchema);

// per-method 请求补充字段（基础形态是 passthrough 的 z.object({})，这里给个别方法
// 显式声明新增的可选入参；其余键仍由 passthrough 放行）
const REQUEST_SHAPES = {
  // stage {all:true} 时排除嵌套独立仓库目录（方案 §5.1：暂存它会变成意外 gitlink）；
  // files 模式忽略该参数
  stage: {
    exclude: z.array(z.string().readonly()).readonly().optional(),
  },
  // path 由 passthrough 放行；revs 只接受字符串数组（元素级 sha 白名单在 git-core）
  revExists: {
    revs: z.array(z.string().readonly()).readonly(),
  },
  // submodule 管理五方法（子仓库支持 P2）。位置参数是「仓库内路径」（相对
  // toplevel，git submodule 子命令收路径而非注册名），越界防护在 git-core 的
  // safeJoin；deinit 必填（缺省会清空全部子模块）。
  submoduleInit: {
    subPath: z.string().readonly().optional(),
  },
  submoduleUpdate: {
    subPath: z.string().readonly().optional(),
    init: z.boolean().readonly().optional(),
    recursive: z.boolean().readonly().optional(),
  },
  submoduleSync: {
    subPath: z.string().readonly().optional(),
  },
  submoduleDeinit: {
    subPath: z.string().readonly(),
  },
  submoduleAdd: {
    url: z.string().readonly(),
    subPath: z.string().readonly(),
    name: z.string().readonly().optional(),
  },
};

function requestSchemaOf(method) {
  const shape = REQUEST_SHAPES[method];
  return shape ? z.object(shape).passthrough() : z.object({}).passthrough();
}

// ---- manifest ------------------------------------------------------------

const METHODS = [
  ["probe", probeResult],
  ["overview", overviewResult],
  ["status", statusResult],
  ["diff", diffResult],
  ["log", logResult],
  ["branches", branchesResult],
  ["remotes", remotesResult],
  ["worktrees", worktreesResult],
  ["conflictContent", conflictContentResult],
  ["stage", mutationResult],
  ["unstage", mutationResult],
  ["discard", discardResult],
  ["hunkApply", mutationResult],
  ["commit", commitResult],
  ["branchCreate", mutationResult],
  ["checkout", mutationResult],
  ["branchDelete", mutationResult],
  ["branchRename", mutationResult],
  ["merge", mergeResult],
  ["mergeAbort", mutationResult],
  ["mergeContinue", mutationResult],
  ["cherryPick", cherryPickResult],
  ["resolveConflict", mutationResult],
  ["fetch", fetchResult],
  ["pull", fetchResult],
  ["push", fetchResult],
  ["worktreeAdd", worktreeMutResult],
  ["worktreeRemove", worktreeMutResult],
  ["worktreePrune", worktreeMutResult],
  ["init", initResult],
  // ---- v2 §2.1 stageHunk + §2.2 P1 ----
  ["stageHunk", mutationResult],
  ["stashList", stashesResult],
  ["stashPush", stashesResult],
  ["stashPop", mutationResult],
  ["stashApply", mutationResult],
  ["stashDrop", stashesResult],
  ["stashClear", stashesResult],
  ["tags", tagsResult],
  ["tagCreate", tagsResult],
  ["tagDelete", tagsResult],
  ["reset", mutationResult],
  ["revert", revertResult],
  ["blame", blameResult],
  ["diffRange", diffResult],
  ["reflog", reflogResult],
  // ---- v2 §2.3 P2 ----
  ["remoteAdd", remoteListResult],
  ["remoteRemove", remoteListResult],
  ["remoteRename", remoteListResult],
  ["configList", configResult],
  ["configSet", configResult],
  ["configUnset", configResult],
  // ---- P3-A §8.1/§8.3（51 → 56）----
  ["rebasePlan", rebasePlanResult],
  ["rebaseRun", rebaseRunResult],
  ["fixupCommit", fixupResult],
  ["rebaseBranch", rebaseBranchResult],
  ["lineApply", mutationResult],
  // ---- 子仓库支持 P0（56 → 57）：repoTree（仓库树发现）----
  ["repoTree", repoTreeResult],
  // ---- 子仓库支持 P1（57 → 58）：revExists（sha 存在性门控）----
  ["revExists", revExistsResult],
  // ---- 子仓库支持 P2（58 → 63）：submodule 管理五方法 ----
  ["submoduleInit", mutationResult],
  ["submoduleUpdate", mutationResult],
  ["submoduleSync", mutationResult],
  ["submoduleDeinit", mutationResult],
  ["submoduleAdd", submoduleAddResult],
];

function invocationOf(method, resultSchema) {
  // strict codec 必须「双形态」（实测 21 个 typert-loader 版本的矩阵结论）：
  //   - ≤0.1.6-alpha.1：loader/registry/gateway 校验并使用 `schema`（zod 实例，`.parse`）
  //   - ≥0.1.6-alpha.2（含 0.1.7-rc.x）：校验 `create()` 工厂，gateway 解码走 `codec.create().parse(...)`
  // 两代校验各看一个键、互不检查对方，所以两个键并存才能同时通过新旧两端；
  // 只写 schema 会在 0.1.7 的客户端 $mount 注册时抛 "strict codec has no create() factory"，
  // 导致插件槽位注册失败、入口按钮不出现（表现为"插件加载不上"）。
  const requestSchema = requestSchemaOf(method);
  return {
    id: "dsh-git-manager#gitManager/" + method,
    service: "gitManager",
    namespace: "gitManager",
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-git-manager#GitManager" + method + "Request",
          schema: requestSchema,
          create: () => requestSchema,
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-git-manager#GitManager" + method + "Result",
      schema: resultSchema,
      create: () => resultSchema,
    },
    sourceLocation: { file: "index.js", line: 1, column: 1 },
  };
}

// service members（Remote 方法）与 types 用生成器构造，与 invocations 同源
function serviceMemberOf(method) {
  return {
    kind: "method",
    name: method,
    signature: "@Remote('" + method + "') async " + method + "(request: GitManager" + method + "Request): Promise<GitManager" + method + "Result>",
    summary: "gitManager." + method + "() — see index.js.",
    jsDoc: "/**\n * gitManager." + method + "()\n * @param request - the request payload.\n * @returns the result envelope.\n */",
  };
}

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-git-manager",
  face: "host",
  schemas: [],
  invocations: METHODS.map(([m, r]) => invocationOf(m, r)),
  model: {
    services: [
      {
        description: "Git workspace management service: probe, status, diff, branches, log (with branch graph), conflicts, worktrees, and commit/fetch/pull/push.",
        summary: "Git workspace management service.",
        tags: [],
        jsDoc: "/**\n * Git workspace management service.\n */",
        key: "gitManager",
        exportName: "GitManagerService",
        members: METHODS.map(([m]) => serviceMemberOf(m)),
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
};

export default TYPERT;