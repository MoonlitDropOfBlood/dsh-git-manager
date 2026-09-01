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

const fileEntrySchema = z.object({
  path: z.string().readonly(),
  oldPath: z.string().readonly().optional(),
  x: z.string().readonly().optional(),
  y: z.string().readonly().optional(),
  kind: z.string().readonly(),
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
  ["discard", mutationResult],
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
];

function invocationOf(method, resultSchema) {
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
          schema: z.object({}).passthrough(),
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-git-manager#GitManager" + method + "Result",
      schema: resultSchema,
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