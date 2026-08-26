/**
 * dsh-git-manager — Typert Host manifest.
 *
 * 手写 TYPERT manifest（dsh typert-loader 从包的 `./typert` 导出加载）。
 * 描述 `gitManager` Remote 服务 27 个方法的 wire schema，让浏览器 Client 端
 * `ctx.remote.gitManager.<method>()` 可用（Client 端用 passthrough codec，
 * 这里 schema 仅供 Host 侧严格校验）。
 *
 * 与 index.js (GitManagerService) 和 client.js 的关键名字一致：
 *   - 服务键 / 类名：gitManager / GitManagerService
 *   - invocation id：dsh-git-manager#gitManager/<method>
 *   - result schema 都是 z.union([ok=true+value, ok=false+error])，strict。
 *
 * 不导出任何值，只通过 `model.services` 让 loader 读到。
 */

import { z } from "zod";

const id = (m, kind) => "dsh-git-manager#GitManager" + m + kind;

// ---- shared schemas -------------------------------------------------------

const errorSchema = z.object({
  code: z.string().readonly(),
  message: z.string().readonly(),
}).readonly();

const fileEntrySchema = z.object({
  path: z.string().readonly(),
  oldPath: z.string().readonly().optional(),
  x: z.string().readonly().optional(),
  y: z.string().readonly().optional(),
  kind: z.string().readonly(), // modified|added|deleted|renamed|copied|typechange|conflicted
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
}).readonly();

const graphSchema = z.object({
  nodes: z.array(z.object({ col: z.number().readonly(), color: z.number().readonly() }).readonly()).readonly(),
  links: z.array(z.object({
    fromRow: z.number().readonly(),
    fromCol: z.number().readonly(),
    toRow: z.number().readonly().nullable(),
    toCol: z.number().readonly(),
    color: z.number().readonly(),
    kind: z.string().readonly(), // parent|merge|collapse
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
}).readonly();

const remoteSchema = z.object({
  name: z.string().readonly(),
  fetchUrl: z.string().readonly().nullable(),
  pushUrl: z.string().readonly().nullable(),
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
const worktreesOnlySchema = z.object({ worktrees: z.array(worktreeSchema).readonly() }).readonly();
const commitValueSchema = z.object({
  commit: z.string().readonly(),
  status: statusSchema,
}).readonly();
const mergeValueSchema = z.object({
  merged: z.boolean().readonly(),
  status: statusSchema,
}).readonly();

// 网络操作可附带 status（失败时附 _status + _output 映射到 envelope）
const fetchValueSchema = z.object({
  output: z.string().readonly(),
  status: statusSchema,
}).readonly();

// ---- per-method result schemas ------------------------------------------

function result(valueSchema) {
  return z.union([
    z.object({ ok: z.literal(true).readonly(), value: valueSchema }).readonly(),
    z.object({ ok: z.literal(false).readonly(), error: errorSchema }).readonly(),
  ]).readonly();
}

// 网络操作失败时 envelope 额外带 output + status
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

// 1. probe
const probeResult = result(probeSchema);
// 2. overview（特殊：isRepo=false 时 value.probe={isRepo:false}）
const overviewResult = result(z.object({
  probe: probeSchema,
  status: statusSchema.nullable(),
  remotes: z.array(remoteSchema).readonly(),
}).readonly());
// 3. status
const statusResult = result(statusSchema);
// 4. diff
const diffResult = result(diffValueSchema);
// 5. log
const logResult = result(logValueSchema);
// 6. branches
const branchesResult = result(branchesValueSchema);
// 7. remotes
const remotesResult = result(z.array(remoteSchema).readonly());
// 8. worktrees
const worktreesResult = result(worktreesValueSchema);
// 9. conflictContent
const conflictContentResult = result(conflictContentValueSchema);
// 10. stage / 11. unstage / 12. discard
const mutationResult = result(statusOnlySchema);
// 13. commit
const commitResult = result(commitValueSchema);
// 14-17. branchCreate / checkout / branchDelete / branchRename
const branchMutResult = result(statusOnlySchema);
// 18. merge
const mergeResult = result(mergeValueSchema);
// 19. mergeAbort / 20. mergeContinue
const abortContinueResult = result(statusOnlySchema);
// 21. resolveConflict
const resolveConflictResult = result(statusOnlySchema);
// 22. fetch / 23. pull / 24. push
const fetchResult = netResult(fetchValueSchema);
const pullResult = netResult(fetchValueSchema);
const pushResult = netResult(fetchValueSchema);
// 25. worktreeAdd / 26. worktreeRemove / 27. worktreePrune
const worktreeMutResult = result(worktreesOnlySchema);
// 28. init
const initResult = result(z.object({ probe: probeSchema }).readonly());

// ---- invocation list ------------------------------------------------------

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
  ["discard", mutationResult],
  ["commit", commitResult],
  ["branchCreate", branchMutResult],
  ["checkout", branchMutResult],
  ["branchDelete", branchMutResult],
  ["branchRename", branchMutResult],
  ["merge", mergeResult],
  ["mergeAbort", abortContinueResult],
  ["mergeContinue", abortContinueResult],
  ["resolveConflict", resolveConflictResult],
  ["fetch", fetchResult],
  ["pull", pullResult],
  ["push", pushResult],
  ["worktreeAdd", worktreeMutResult],
  ["worktreeRemove", worktreeMutResult],
  ["worktreePrune", worktreeMutResult],
  ["init", initResult],
];

// ---- export ---------------------------------------------------------------

// loader 期望的最小形状：model.services[].{ key, exportName, invocations[] }
// 详细 shape 由 typert-loader 文档定义；这里给出 archive-manager / memory-manager
// 验证可行的最小子集。
export const model = {
  services: [
    {
      key: "gitManager",
      exportName: "GitManagerService",
      invocations: METHODS.map(([method, resultSchema]) => ({
        method,
        invocationId: "dsh-git-manager#gitManager/" + method,
        parameters: [{ name: "request", wire: "request", source: "json" }],
        result: { schema: resultSchema, typeSymbol: id(method, "Result") },
      })),
    },
  ],
};

// 也暴露直接的 invocations 给可能用到的 loader 形态
export const invocations = METHODS.map(([method, resultSchema]) => ({
  method,
  invocationId: "dsh-git-manager#gitManager/" + method,
  result: { schema: resultSchema, typeSymbol: id(method, "Result") },
}));