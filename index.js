/**
 * dsh-git-manager — Host half.
 *
 * A Cordis "class plugin": this module exports `GitManagerService` extending
 * `TypertRemoteService`. The DSH loader instantiates the class and registers it
 * as the `gitManager` service; the Typert Gateway exposes its `@Remote`-marked
 * methods to the browser Client half under the `gitManager` Remote namespace.
 *
 * Responsibilities:
 *   - 56 Remote methods（30 个 v1 + v2 §2.1/§2.2/§2.3 的 21 个 + P3-A §8.1/§8.3
 *     的 5 个：rebasePlan/rebaseRun/fixupCommit/rebaseBranch/lineApply）：
 *     probe / overview / status / diff / log / branches / worktrees /
 *     conflictContent + 全部变更类（含 hunkApply 逐块操作、cherryPick 单提交
 *     拣选、stageHunk 逐块暂存、lineApply 行级暂存/撤销）。
 *   - Path validation (fs.stat) + envelope wrapping (`{ok, value}` / `{ok, error}`).
 *   - GitError → user-friendly error code mapping (not-a-repo / dubious-ownership
 *     / auth-failed / timeout / too-large / git-missing / git-failed).
 *   - Network ops (fetch/pull/push): on failure, surface `_output` + `_status`
 *     side-channel data from git-core as envelope fields, so Client can refresh
 *     the UI while showing the error.
 *
 * All file I/O + git invocation goes through git-core.mjs; this file is purely
 * the Cordis glue.
 */

import { statSync } from "node:fs";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";

// 诊断冒烟：loader import 本 entry 时必然执行。若 boot 日志没有这行，
// 说明 entry 根本没被 import（组合树/加载层问题），而非模块代码错误。
try { console.error("[dsh-git-manager] index.js module body executed"); } catch (_) { /* noop */ }

import {
  GitError,
  probeRepo,
  getStatus,
  getBranches,
  getRemotes,
  getLog,
  getWorktrees,
  getConflictContent,
  getDiff,
  stageFiles,
  unstageFiles,
  discardFiles,
  applyHunk,
  stageHunkFile,
  commitStaged,
  createBranch,
  switchBranch,
  deleteBranch,
  renameBranch,
  mergeBranch,
  abortMerge,
  continueMerge,
  cherryPickCommit,
  revertCommit,
  resolveConflictFile,
  fetchRemote,
  pullBranch,
  pushBranch,
  addWorktree,
  removeWorktree,
  pruneWorktrees,
  initRepo,
  getStashes,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
  stashClear,
  getTags,
  createTag,
  deleteTag,
  resetRepo,
  getBlame,
  getDiffRange,
  getReflog,
  addRemote,
  removeRemote,
  renameRemote,
  getConfig,
  setConfig,
  unsetConfig,
  rebasePlan,
  rebaseRun,
  fixupCommit,
  rebaseBranch,
  applyLine,
} from "./git-core.mjs";
import { computeGraph } from "./git-graph.mjs";

// Node ESM 不支持 Stage 3 装饰器，手动驱动 Remote() 装饰器。
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method", name: method, static: false, private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

// ---- error envelope mapping ------------------------------------------------

/**
 * Map a raw error (usually GitError) to the user-facing {code, message}.
 * Codes are documented in §3.3 of plan + plan §5.
 */
function mapGitError(e) {
  if (e instanceof GitError) {
    const stderr = e.stderr || e.message || "";
    const out = { code: "git-failed", message: String(stderr).trim() || "git 命令失败" };
    if (e.kind === "missing") { out.code = "git-missing"; out.message = "找不到 git 可执行文件，请先安装 Git。"; return out; }
    if (e.kind === "timeout") { out.code = "timeout"; return out; }
    if (e.kind === "too-large") { out.code = "diff-too-large"; return out; }
    // kind === "exit"
    const low = stderr.toLowerCase();
    if (/not a git repository/.test(low)) { out.code = "not-a-repo"; return out; }
    if (/dubious ownership/.test(low)) {
      out.code = "dubious-ownership";
      // 安全：不给用户擅自改全局配置；只提示命令
      const path = e && e._path ? e._path : "<path>";
      out.message = `目录所有权不被信任（git ≥2.35 新安全特性）。请运行：git config --global --add safe.directory ${path}`;
      return out;
    }
    if (/authentication failed|permission denied|could not read from remote/i.test(stderr)) {
      out.code = "auth-failed"; return out;
    }
    if (/conflict/i.test(stderr)) { out.code = "merge-conflict"; return out; }
    return out;
  }
  return { code: "internal", message: String(e && e.message || e) };
}

// 把 fetch/pull/push 失败时 GitError 上挂的 _output / _status 也回传出去
function netErrorEnvelope(e, path) {
  const env = mapGitError(e);
  const out = { ok: false, error: env };
  if (e && typeof e._output === "string") out.output = e._output;
  if (e && e._status) out.status = e._status;
  return out;
}

// ---- path validation ------------------------------------------------------

function validatePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new GitError("exit", "请求缺少 path");
  }
  try {
    const s = statSync(path);
    if (!s.isDirectory()) {
      throw new GitError("exit", "path 不是目录：" + path);
    }
  } catch (e) {
    if (e instanceof GitError) throw e;
    throw new GitError("exit", "path 不可访问：" + path);
  }
}

// ---- the service ----------------------------------------------------------

export class GitManagerService extends TypertRemoteService {
  // 不需要 workspaceRegistry / sessions ——目标路径全由 client 显式传入
  static inject = [];
  constructor(ctx, config) { super(ctx, "gitManager"); } // 必须传精确服务键

  [Service.init]() {
    markRemoteMethod(this, "probe", "probe");
    markRemoteMethod(this, "overview", "overview");
    markRemoteMethod(this, "status", "status");
    markRemoteMethod(this, "diff", "diff");
    markRemoteMethod(this, "log", "log");
    markRemoteMethod(this, "branches", "branches");
    markRemoteMethod(this, "remotes", "remotes");
    markRemoteMethod(this, "worktrees", "worktrees");
    markRemoteMethod(this, "conflictContent", "conflictContent");
    markRemoteMethod(this, "stage", "stage");
    markRemoteMethod(this, "unstage", "unstage");
    markRemoteMethod(this, "discard", "discard");
    markRemoteMethod(this, "hunkApply", "hunkApply");
    markRemoteMethod(this, "commit", "commit");
    markRemoteMethod(this, "branchCreate", "branchCreate");
    markRemoteMethod(this, "checkout", "checkout");
    markRemoteMethod(this, "branchDelete", "branchDelete");
    markRemoteMethod(this, "branchRename", "branchRename");
    markRemoteMethod(this, "merge", "merge");
    markRemoteMethod(this, "mergeAbort", "mergeAbort");
    markRemoteMethod(this, "mergeContinue", "mergeContinue");
    markRemoteMethod(this, "cherryPick", "cherryPick");
    markRemoteMethod(this, "resolveConflict", "resolveConflict");
    markRemoteMethod(this, "fetch", "fetch");
    markRemoteMethod(this, "pull", "pull");
    markRemoteMethod(this, "push", "push");
    markRemoteMethod(this, "worktreeAdd", "worktreeAdd");
    markRemoteMethod(this, "worktreeRemove", "worktreeRemove");
    markRemoteMethod(this, "worktreePrune", "worktreePrune");
    markRemoteMethod(this, "init", "init");
    // v2 §2.1 stageHunk + §2.2 P1
    markRemoteMethod(this, "stageHunk", "stageHunk");
    markRemoteMethod(this, "stashList", "stashList");
    markRemoteMethod(this, "stashPush", "stashPush");
    markRemoteMethod(this, "stashPop", "stashPop");
    markRemoteMethod(this, "stashApply", "stashApply");
    markRemoteMethod(this, "stashDrop", "stashDrop");
    markRemoteMethod(this, "stashClear", "stashClear");
    markRemoteMethod(this, "tags", "tags");
    markRemoteMethod(this, "tagCreate", "tagCreate");
    markRemoteMethod(this, "tagDelete", "tagDelete");
    markRemoteMethod(this, "reset", "reset");
    markRemoteMethod(this, "revert", "revert");
    markRemoteMethod(this, "blame", "blame");
    markRemoteMethod(this, "diffRange", "diffRange");
    markRemoteMethod(this, "reflog", "reflog");
    // v2 §2.3 P2
    markRemoteMethod(this, "remoteAdd", "remoteAdd");
    markRemoteMethod(this, "remoteRemove", "remoteRemove");
    markRemoteMethod(this, "remoteRename", "remoteRename");
    markRemoteMethod(this, "configList", "configList");
    markRemoteMethod(this, "configSet", "configSet");
    markRemoteMethod(this, "configUnset", "configUnset");
    // P3-A §8.1/§8.3（51 → 56）
    markRemoteMethod(this, "rebasePlan", "rebasePlan");
    markRemoteMethod(this, "rebaseRun", "rebaseRun");
    markRemoteMethod(this, "fixupCommit", "fixupCommit");
    markRemoteMethod(this, "rebaseBranch", "rebaseBranch");
    markRemoteMethod(this, "lineApply", "lineApply");
  }

  // === query ===
  async probe(request) {
    try { return { ok: true, value: await probeRepo(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async overview(request) {
    try {
      validatePath(request.path);
      const [probe, status, remotes] = await Promise.all([
        probeRepo(request.path),
        getStatus(request.path),
        getRemotes(request.path),
      ]);
      return { ok: true, value: { probe, status, remotes } };
    } catch (e) {
      const err = mapGitError(e);
      // probe 失败（非仓库）让客户端拿到 isRepo:false —— 改 ok:true, value.probe.isRepo
      if (err.code === "not-a-repo") {
        return { ok: true, value: { probe: { isRepo: false }, status: null, remotes: [] } };
      }
      return { ok: false, error: err };
    }
  }

  async status(request) {
    try { validatePath(request.path); return { ok: true, value: await getStatus(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async diff(request) {
    try { validatePath(request.path); return { ok: true, value: await getDiff(request.path, request) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async log(request) {
    try {
      validatePath(request.path);
      const r = await getLog(request.path, request);
      // Host 侧组装 graph，Client 只画
      const graph = computeGraph(r.commits);
      return { ok: true, value: Object.assign({}, r, { graph }) };
    } catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async branches(request) {
    try { validatePath(request.path); return { ok: true, value: await getBranches(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async remotes(request) {
    try { validatePath(request.path); return { ok: true, value: await getRemotes(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async worktrees(request) {
    try { validatePath(request.path); return { ok: true, value: await getWorktrees(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async conflictContent(request) {
    try { validatePath(request.path); return { ok: true, value: await getConflictContent(request.path, request.file) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // === mutations (all return fresh status/worktrees in value) ===
  async stage(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await stageFiles(request.path, request.files || [], !!request.all) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async unstage(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await unstageFiles(request.path, request.files || []) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async discard(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await discardFiles(request.path, request.files || [], !!request.includeUntracked) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // IDEA 式逐块操作：scope=worktree 撤销此块（恢复成 index 版本）；
  // scope=staged 取消暂存此块（改动移回工作区，不丢内容）。
  async hunkApply(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await applyHunk(request.path, request) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async commit(request) {
    try { validatePath(request.path); return { ok: true, value: await commitStaged(request.path, request.message, !!request.amend) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async branchCreate(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await createBranch(request.path, request.name, request.startPoint, !!request.checkout) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async checkout(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await switchBranch(request.path, request.name) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async branchDelete(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await deleteBranch(request.path, request.name, !!request.force) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async branchRename(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await renameBranch(request.path, request.oldName, request.newName) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async merge(request) {
    try { validatePath(request.path); return { ok: true, value: await mergeBranch(request.path, request.branch, !!request.noFf) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async mergeAbort(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await abortMerge(request.path) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async mergeContinue(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await continueMerge(request.path) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // cherry-pick 单个提交到当前分支。冲突不抛错：返回 picked:false + status
  //（仓库进入 CHERRY_PICK_HEAD 态，走冲突页解决后 mergeContinue 完成 pick）。
  async cherryPick(request) {
    try { validatePath(request.path); return { ok: true, value: await cherryPickCommit(request.path, request.sha) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async resolveConflict(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await resolveConflictFile(request.path, request.file, request.strategy, request.content) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async fetch(request) {
    try { validatePath(request.path); return { ok: true, value: await fetchRemote(request.path, request.remote) }; }
    catch (e) { return netErrorEnvelope(e, request.path); }
  }

  async pull(request) {
    try { validatePath(request.path); return { ok: true, value: await pullBranch(request.path, request || {}) }; }
    catch (e) { return netErrorEnvelope(e, request.path); }
  }

  async push(request) {
    try { validatePath(request.path); return { ok: true, value: await pushBranch(request.path, request || {}) }; }
    catch (e) { return netErrorEnvelope(e, request.path); }
  }

  async worktreeAdd(request) {
    try { validatePath(request.path); return { ok: true, value: await addWorktree(request.path, request.worktreePath, request.newBranch, request.startPoint) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async worktreeRemove(request) {
    try { validatePath(request.path); return { ok: true, value: await removeWorktree(request.path, request.worktreePath, !!request.force) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async worktreePrune(request) {
    try { validatePath(request.path); return { ok: true, value: await pruneWorktrees(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async init(request) {
    try {
      // init 接受不存在或为空目录 —— 不强制 validatePath
      const path = request.path;
      if (typeof path !== "string" || path.length === 0) {
        return { ok: false, error: { code: "bad-path", message: "init 需要 path" } };
      }
      return { ok: true, value: { probe: await initRepo(path) } };
    } catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // === v2 §2.1/§2.2：stageHunk + stash 全家 + tag 全家 + reset/revert/blame/diffRange/reflog ===

  // IDEA 式「暂存此块」：unstaged diff 的第 hunkIndex 块正向进 index（非危险，无确认）
  async stageHunk(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await stageHunkFile(request.path, request) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async stashList(request) {
    try { validatePath(request.path); return { ok: true, value: await getStashes(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async stashPush(request) {
    try { validatePath(request.path); return { ok: true, value: await stashPush(request.path, request.message, !!request.includeUntracked) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // pop/apply 冲突不抛错（git-core 契约）：返回 {status}，status.conflicted 非空即
  // 交冲突页处理；stash 条目保留，中止走 abortMerge 兜底（Lead 裁决 2026-09-29）。
  async stashPop(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await stashPop(request.path, request.index) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async stashApply(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await stashApply(request.path, request.index) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async stashDrop(request) {
    try { validatePath(request.path); return { ok: true, value: await stashDrop(request.path, request.index) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async stashClear(request) {
    try { validatePath(request.path); return { ok: true, value: await stashClear(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async tags(request) {
    try { validatePath(request.path); return { ok: true, value: await getTags(request.path) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // message 非空 → annotated tag；name/sha 走白名单校验（防选项注入）
  async tagCreate(request) {
    try { validatePath(request.path); return { ok: true, value: await createTag(request.path, request.name, request.sha, request.message, !!request.force) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async tagDelete(request) {
    try { validatePath(request.path); return { ok: true, value: await deleteTag(request.path, request.name) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // mode∈soft|mixed|hard、target 走白名单（sha/HEAD/HEAD~n/@{...}）；
  // hard 不做 UI 确认（确认是 client 职责）
  async reset(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await resetRepo(request.path, request.mode, request.target) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // 冲突不抛错：reverted=false + status，仓库进 REVERT_HEAD 态（与 cherryPick 同款）
  async revert(request) {
    try { validatePath(request.path); return { ok: true, value: await revertCommit(request.path, request.sha) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async blame(request) {
    try { validatePath(request.path); return { ok: true, value: await getBlame(request.path, request) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async diffRange(request) {
    try { validatePath(request.path); return { ok: true, value: await getDiffRange(request.path, request) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async reflog(request) {
    try { validatePath(request.path); return { ok: true, value: await getReflog(request.path, request) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // === v2 §2.3 P2：remote 增删改 + config 读写（返回新列表，便于客户端刷新） ===

  async remoteAdd(request) {
    try { validatePath(request.path); return { ok: true, value: await addRemote(request.path, request.name, request.url, request.pushUrl) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async remoteRemove(request) {
    try { validatePath(request.path); return { ok: true, value: await removeRemote(request.path, request.name) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async remoteRename(request) {
    try { validatePath(request.path); return { ok: true, value: await renameRemote(request.path, request.oldName, request.newName) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async configList(request) {
    try { validatePath(request.path); return { ok: true, value: await getConfig(request.path, !!request.global) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async configSet(request) {
    try { validatePath(request.path); return { ok: true, value: await setConfig(request.path, request.key, request.value, !!request.global) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  async configUnset(request) {
    try { validatePath(request.path); return { ok: true, value: await unsetConfig(request.path, request.key, !!request.global) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // === P3-A §8.1/§8.3：rebase 全家 + 行级暂存/撤销 ===

  // todo 候选：base..HEAD（不含 base），最旧在前（rebase todo 应用顺序）
  async rebasePlan(request) {
    try { validatePath(request.path); return { ok: true, value: await rebasePlan(request.path, request.base) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // entries 条目 action 枚举 + sha 白名单校验（防 todo 注入）；
  // 冲突/ edit 停驻不抛错：done=false + status，进 rebase 态
  async rebaseRun(request) {
    try { validatePath(request.path); return { ok: true, value: await rebaseRun(request.path, request.base, request.entries) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // 用暂存改动修正任意历史提交（改写历史，UI 二次确认）；squash+message 替换合并信息
  async fixupCommit(request) {
    try { validatePath(request.path); return { ok: true, value: await fixupCommit(request.path, request.sha, request.mode, request.message) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // 当前分支 rebase 到 branch 之上（二次确认同 merge 级；冲突走冲突页）
  async rebaseBranch(request) {
    try { validatePath(request.path); return { ok: true, value: await rebaseBranch(request.path, request.branch) }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }

  // 行级操作：scope/mode 组合白名单（unstaged/stage、staged/unstage、unstaged/discard）
  async lineApply(request) {
    try { validatePath(request.path); return { ok: true, value: { status: await applyLine(request.path, request) } }; }
    catch (e) { return { ok: false, error: mapGitError(e) }; }
  }
}

// cordis loader 的 unwrapExports 取 `exports.default ?? exports`：ESM 命名空间
// 对象不是合法 plugin（报 "invalid plugin, expect function or object with an
// apply method, received object"）。必须 default 导出 Service 类——
// memory-manager / archive-manager 同款，方案文档此前漏掉了这一行。
export default GitManagerService;