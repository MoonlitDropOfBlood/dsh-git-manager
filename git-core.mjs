// git-core.mjs — dsh-git-manager 核心
//
// 零依赖 git CLI 封装：所有 git 调用通过 runGit 走 argv 数组（无 shell），
// 全部解析器为纯函数（便于 TDD 单测）。本文件可被 index.js 与 scripts/self-test.mjs 共用。
//
// 设计要点：
//   - runGit(cwd, args, opts) → 统一出口，超时/过大/缺 git 抛 GitError(kind, ...)
//   - 解析器只接受字符串、只返回结构化对象；不依赖 git core 内部
//   - 路径防护（safeJoin）：discard 未跟踪 / resolveConflict custom 共用
//   - 查询/变更函数全部 async(cwd, ...)，抛 GitError，由 index.js 包 envelope

import { execFile } from "node:child_process";
import { rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// ============================================================================
// runGit 封装
// ============================================================================

export class GitError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = "GitError";
    this.kind = kind; // "missing" | "timeout" | "too-large" | "exit"
    Object.assign(this, extra || {});
  }
}

const BASE_ARGS = [
  "-c", "core.quotepath=false",
  "-c", "color.ui=false",
  "-c", "i18n.logoutputencoding=UTF-8",
];

const LOCAL_TIMEOUT = 30000;
const NET_TIMEOUT = 180000;

export function runGit(cwd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCAL_TIMEOUT;
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      BASE_ARGS.concat(args),
      {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
        env: Object.assign({}, process.env, {
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
        }),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        if (err.code === "ENOENT") {
          return reject(new GitError("missing", "找不到 git 可执行文件，请先安装 Git。", { cause: err }));
        }
        if (err.killed || err.signal === "SIGTERM") {
          return reject(new GitError("timeout", "git 操作超时（>" + Math.round(timeoutMs / 1000) + "s）", { stderr }));
        }
        if (err.code === "ENOBUFS" || /maxBuffer/i.test(String(err.message || ""))) {
          return reject(new GitError("too-large", "git 输出过大，请缩小范围（如单文件 diff）。", { stderr }));
        }
        const exitCode = typeof err.code === "number" ? err.code : null;
        const msg = String(stderr || err.message || "git 命令失败").trim();
        reject(new GitError("exit", msg, { exitCode, stderr, stdout }));
      },
    );
  });
}

// 与 runGit 等价的便捷封装：跑网络类命令（fetch/pull/push）使用更长超时。
export function runGitNet(cwd, args, opts = {}) {
  return runGit(cwd, args, Object.assign({ timeoutMs: NET_TIMEOUT }, opts));
}

// ============================================================================
// 路径防护（discard 未跟踪 + resolveConflict custom 共用）
// ============================================================================

export function safeJoin(toplevel, rel) {
  if (!toplevel || typeof rel !== "string" || rel.length === 0) {
    throw new GitError("exit", "非法路径：路径为空");
  }
  // 绝对路径直接拒绝（只能传相对路径）
  if (resolve(rel) === rel || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("/")) {
    throw new GitError("exit", "非法路径（必须是相对路径）：" + rel);
  }
  // 关键：toplevel 先 resolve 归一化。git rev-parse 在 Windows 上输出正斜杠
  // （如 "D:/repo"），而 resolve() 归一为反斜杠；不归一化就会让下面的
  // startsWith(root + sep) 永远 false，所有合法路径都被误判越界。
  const root = resolve(toplevel);
  const abs = resolve(root, rel);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new GitError("exit", "非法路径（越出仓库根目录）：" + rel);
  }
  return abs;
}

// ============================================================================
// 查询：probeRepo
// ============================================================================

export async function probeRepo(path) {
  // 不是目录就返回 { isRepo:false }，让客户端提供「初始化仓库」入口
  if (!path) return { isRepo: false };
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { isRepo: false };
    }
  } catch (_) {
    return { isRepo: false };
  }
  let revRaw;
  try {
    revRaw = await runGit(path, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--is-bare-repository"]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") {
      // 不是仓库（exit 128 + "not a git repository"）
      return { isRepo: false };
    }
    throw e;
  }
  const lines = revRaw.stdout.split("\n").map((s) => s.trim());
  const toplevel = lines[0];
  const gitDir = lines[1];
  const commonDir = lines[2];
  const bare = lines[3] === "true";

  // 当前 ref
  let branch = null;
  let detached = false;
  let headShort = null;
  let unborn = false;
  try {
    const sym = await runGit(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    branch = sym.stdout.trim() || null;
    // symbolic-ref 成功 ≠ HEAD 存在：unborn 分支（init 后无 commit）同样返回
    // refs/heads/<name>。必须再用 rev-parse 验证 HEAD 可解析。
    try {
      const ver = await runGit(path, ["rev-parse", "--short=12", "HEAD"]);
      headShort = ver.stdout.trim();
    } catch (_) {
      unborn = true;
    }
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") {
      detached = true;
      try {
        const ver = await runGit(path, ["rev-parse", "--short=12", "HEAD"]);
        headShort = ver.stdout.trim();
      } catch (_) {
        unborn = true;
      }
    } else {
      throw e;
    }
  }

  // worktree 判定
  let isLinkedWorktree = false;
  let mainWorktreePath = undefined;
  if (gitDir && commonDir && gitDir !== commonDir) {
    isLinkedWorktree = true;
    try {
      const m = await runGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      // mainWorktreePath 是主 worktree 的工作目录（不是 .git），从 commonDir 反推
      // 例：commonDir = "D:/repo/.git" → mainWorktreePath = "D:/repo"
      const absCommon = resolve(path, m.stdout.trim());
      const parent = absCommon.replace(/[\\/]\.git$/, "");
      if (parent !== absCommon) mainWorktreePath = parent;
    } catch (_) { /* noop */ }
  }

  // merge / rebase 状态（gitDir 可能是相对路径，先归一化到 cwd）
  const gitDirAbs = resolve(path, gitDir);
  const merging = existsSync(join(gitDirAbs, "MERGE_HEAD"));
  const rebasing = existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply"));

  return {
    isRepo: true,
    toplevel,
    gitDir,
    commonDir,
    bare,
    branch,
    detached,
    headShort: unborn ? null : headShort,
    unborn,
    merging,
    rebasing,
    isLinkedWorktree,
    mainWorktreePath,
  };
}

// ============================================================================
// 解析器（纯函数，TDD 单测目标）
// ============================================================================

// 将 porcelain v2 + -z 输出解析为 status 对象
// 文档：https://git-scm.com/docs/git-status
//   - header 行以 '#' 开头
//   - 类型 1（ordinary）："1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
//   - 类型 2（rename/copy）："2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> R<score> <newPath>" + 下一 token = origPath
//   - 类型 u（unmerged/conflict）："u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
//   - 未跟踪："? <path>"，已忽略："! <path>"
export function parseStatusV2(text) {
  const result = {
    branch: null,
    detached: false,
    headSha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    unborn: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  if (!text) return result;
  const tokens = text.split("\0");
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    if (tok.startsWith("# branch.oid ")) {
      const v = tok.slice("# branch.oid ".length).trim();
      if (v === "(initial)") {
        result.unborn = true;
        result.headSha = null;
      } else if (v) {
        result.headSha = v;
      }
    } else if (tok.startsWith("# branch.head ")) {
      const v = tok.slice("# branch.head ".length).trim();
      if (v && v !== "(detached)") result.branch = v;
      else if (v === "(detached)") result.detached = true;
    } else if (tok.startsWith("# branch.upstream ")) {
      result.upstream = tok.slice("# branch.upstream ".length).trim() || null;
    } else if (tok.startsWith("# branch.ab ")) {
      const m = tok.slice("# branch.ab ".length).trim().match(/^\+(\d+)\s+-(\d+)/);
      if (m) { result.ahead = Number(m[1]); result.behind = Number(m[2]); }
    } else if (tok.startsWith("1 ") || tok.startsWith("2 ") || tok.startsWith("u ") || tok.startsWith("? ")) {
      // 第一遍只关心 header
    }
  }
  // 第二遍处理条目（含 rename 的双 token）
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length === 0) continue;
    if (tok.startsWith("# ") || tok.startsWith("? ") || tok.startsWith("! ")) continue;
    const parts = tok.split(" ");
    const type = parts[0];
    if (type === "1" || type === "u") {
      entries.push({ tok, origPath: null });
    } else if (type === "2") {
      // rename/copy: <newPath> 后面紧跟一个 origPath token
      const next = tokens[i + 1] || "";
      entries.push({ tok, origPath: next.length > 0 ? next : null });
      i++;
    }
  }
  for (const e of entries) {
    const parts = e.tok.split(" ");
    const type = parts[0];
    if (type === "1") {
      const x = parts[1][0];
      const y = parts[1][1];
      const path = parts.slice(8).join(" ");
      if (x !== "." && x !== "?") {
        result.staged.push({ path, x, y, kind: mapXYChar(x) });
      }
      if (y !== "." && y !== "?") {
        result.unstaged.push({ path, x, y, kind: mapXYChar(y) });
      }
    } else if (type === "2") {
      const x = parts[1][0];
      const y = parts[1][1];
      const path = parts.slice(9).join(" ");
      if (x !== "." && x !== "?") {
        result.staged.push({ path, x, y, kind: "renamed", oldPath: e.origPath || "" });
      }
      if (y !== "." && y !== "?") {
        result.unstaged.push({ path, x, y, kind: "renamed", oldPath: e.origPath || "" });
      }
    } else if (type === "u") {
      const xy = parts[1];
      const path = parts.slice(10).join(" ");
      result.conflicted.push({ path, xy });
    }
  }
  // 第三遍：未跟踪 / 已忽略
  for (const tok of tokens) {
    if (tok.startsWith("? ")) result.untracked.push(tok.slice(2));
  }
  return result;
}

function mapXYChar(c) {
  // 把 porcelain v2 的单字符 X/Y 映射为 kind：
  //   M = modified（内容修改）, A = added（新增到 index）, D = deleted（删于 index/工作区）,
  //   R = renamed, C = copied, T = typechange（文件类型/权限变化）, U = unmerged/conflict
  switch (c) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "typechange";
    case "U": return "conflicted";
    default: return "modified";
  }
}

// ============================================================================
// 查询：getStatus（含 merging/rebasing 标记，依赖 gitDir 路径）
// ============================================================================

export async function getStatus(cwd) {
  const raw = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"]);
  const parsed = parseStatusV2(raw.stdout);
  // 用 probeRepo 拿到 gitDir 判断 merging/rebasing。
  // gitDir 可能是相对路径（cwd=toplevel 时返回 ".git"）——必须 resolve(cwd, gitDir)
  // 归一化到仓库，否则 join(".git", ...) 相对到 DSH 进程 cwd，merging 永远 false。
  let merging = false, rebasing = false;
  try {
    const probe = await probeRepo(cwd);
    if (probe.isRepo && probe.gitDir) {
      const gitDirAbs = resolve(cwd, probe.gitDir);
      merging = existsSync(join(gitDirAbs, "MERGE_HEAD"));
      rebasing = existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply"));
    }
  } catch (_) { /* noop */ }
  return Object.assign({}, parsed, { merging, rebasing });
}

// ============================================================================
// 解析器：parseBranchRefs
//   输入：git for-each-ref --format=<fmt> refs/heads refs/remotes 输出（每行 \n 分割，
//          字段 \t 分割；subject 可能有 tab 但放最后）
//   格式字段：%(refname)%09%(refname:short)%09%(objectname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(HEAD)%09%(subject)
// ============================================================================

export function parseBranchRefs(text) {
  const result = { locals: [], remotes: [] };
  if (!text) return result;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 8) continue;
    const [refname, name, shortSha, at, upstream, track, headFlag, ...rest] = parts;
    const subject = rest.join("\t");
    const branch = {
      name,
      refname,
      shortSha,
      at: Number(at) || 0,
      upstream: upstream || null,
      ahead: null,
      behind: null,
      upstreamGone: false,
      subject,
      current: headFlag === "*",
    };
    if (track) {
      const mAhead = /ahead (\d+)/.exec(track);
      const mBehind = /behind (\d+)/.exec(track);
      if (mAhead) branch.ahead = Number(mAhead[1]);
      if (mBehind) branch.behind = Number(mBehind[1]);
      if (/gone/.test(track)) branch.upstreamGone = true;
    }
    if (refname.startsWith("refs/remotes/")) {
      result.remotes.push(branch);
    } else {
      result.locals.push(branch);
    }
  }
  return result;
}

// ============================================================================
// 解析器：parseRemotes
//   输入：git remote -v 输出
//   行：name\turl (fetch|push)
// ============================================================================

export function parseRemotes(text) {
  const map = new Map();
  if (!text) return [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/);
    if (!m) continue;
    const [, name, url, kind] = m;
    if (!map.has(name)) map.set(name, { name, fetchUrl: null, pushUrl: null });
    const entry = map.get(name);
    if (kind === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return Array.from(map.values());
}

// ============================================================================
// 解析器：parseLogText
//   输入：git log -z --format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s
//   record 分隔：\0；field 分隔：\x1f
//   parents 是空格分隔的 oid 列表
// ============================================================================

export function parseLogText(text) {
  const commits = [];
  if (!text) return commits;
  for (const rec of text.split("\0")) {
    if (rec.length === 0) continue;
    const parts = rec.split("\x1f");
    if (parts.length < 8) continue;
    const [sha, short, parentsRaw, author, email, at, refs, subject] = parts;
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
    commits.push({
      sha,
      short,
      parents,
      author,
      email,
      at: Number(at) || 0,
      refs: refs || "",
      subject,
    });
  }
  return commits;
}

// ============================================================================
// 查询：getBranches / getRemotes / getLog
// ============================================================================

const BRANCH_FMT =
  "%(refname)%09%(refname:short)%09%(objectname:short)%09%(committerdate:unix)" +
  "%09%(upstream:short)%09%(upstream:track)%09%(HEAD)%09%(subject)";

export async function getBranches(cwd) {
  const raw = await runGit(cwd, [
    "for-each-ref", "--format=" + BRANCH_FMT,
    "refs/heads", "refs/remotes",
  ]);
  const parsed = parseBranchRefs(raw.stdout);
  // 当前分支：尝试从 status header 拿
  let current = null;
  try {
    const st = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z"]);
    for (const tok of st.stdout.split("\0")) {
      if (tok.startsWith("# branch.head ")) {
        const v = tok.slice("# branch.head ".length).trim();
        if (v && v !== "(detached)") current = v;
      }
    }
  } catch (_) { /* noop */ }
  if (current) {
    for (const b of parsed.locals) b.current = (b.name === current);
  }
  return Object.assign({ current }, parsed);
}

export async function getRemotes(cwd) {
  const raw = await runGit(cwd, ["remote", "-v"]);
  return parseRemotes(raw.stdout);
}

export async function getLog(cwd, opts = {}) {
  const maxCount = opts.maxCount ?? 200;
  const skip = opts.skip ?? 0;
  const all = opts.all === true;
  const ref = opts.ref || null;
  const args = ["log", "--date-order", "-z", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s",
    "--max-count=" + maxCount, "--skip=" + skip];
  if (all) args.push("--all");
  if (ref) args.push(ref);
  let raw;
  try {
    raw = await runGit(cwd, args);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") {
      // 只对 unborn HEAD / unknown revision 这两类"预期无历史"的情况返回空；
      // 其他错误（如 ref 拼错、被禁用、网络）必须透传，否则 UI 看不出问题。
      const msg = (e.stderr || e.message || "").toLowerCase();
      const expectedEmpty = /does not have any commits/.test(msg)
        || /unknown revision/.test(msg)
        || /ambiguous argument ['"]?unknown/.test(msg)
        || /not a git repository/.test(msg);
      if (expectedEmpty) return { commits: [], hasMore: false };
      throw e;
    }
    throw e;
  }
  const commits = parseLogText(raw.stdout);
  return { commits, hasMore: commits.length === maxCount };
}

// ============================================================================
// 解析器：parseWorktreePorcelain
//   输入：git worktree list --porcelain（与 -c core.quotepath=false 配合，CJK 路径不过滤）
//   记录按空行分隔，每行 key 空格 value
//   key ∈ worktree | HEAD | branch | detached | bare | locked | prunable
// ============================================================================

export function parseWorktreePorcelain(text) {
  const result = [];
  if (!text) return result;
  // 兼容 -z：有些平台可能输出 NUL 分隔（rare）；优先按空行切
  const normalized = text.replace(/\0/g, "\n");
  const records = normalized.split(/\n\s*\n/);
  for (const rec of records) {
    if (rec.trim().length === 0) continue;
    const item = { path: null, headSha: null, branch: null, detached: false, bare: false, locked: false, prunable: null };
    for (const line of rec.split("\n")) {
      const idx = line.indexOf(" ");
      let key, value;
      if (idx < 0) {
        key = line.trim();
        value = "";
      } else {
        key = line.slice(0, idx);
        value = line.slice(idx + 1);
      }
      if (key === "worktree") item.path = value;
      else if (key === "HEAD") item.headSha = value;
      else if (key === "branch") {
        const m = /^refs\/heads\/(.+)$/.exec(value);
        item.branch = m ? m[1] : value;
      } else if (key === "detached") item.detached = true;
      else if (key === "bare") item.bare = true;
      else if (key === "locked") item.locked = value || true;
      else if (key === "prunable") item.prunable = value || true;
    }
    if (item.path) result.push(item);
  }
  return result;
}

// ============================================================================
// 查询：getWorktrees
// ============================================================================

export async function getWorktrees(cwd) {
  const raw = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const list = parseWorktreePorcelain(raw.stdout);
  // 标注 current（cwd 或 toplevel 与 item.path 匹配）
  const probe = await probeRepo(cwd);
  const toplevel = probe.isRepo ? probe.toplevel : null;
  for (const item of list) {
    item.current = (toplevel && item.path && (item.path === toplevel || item.path.toLowerCase() === toplevel.toLowerCase()));
  }
  return { worktrees: list };
}

// ============================================================================
// 查询：getDiff（4 种 scope + 未跟踪合成 + 截断）
// ============================================================================

const DIFF_TEXT_CAP = 1500 * 1000; // 1.5MB 字符，超出置 truncated

export async function getDiff(cwd, opts = {}) {
  const scope = opts.scope || "worktree";
  const context = opts.context ?? 3;
  const ctxArg = ["-U" + context];
  let text = "";
  let truncated = false;
  try {
    if (scope === "worktree") {
      const args = ["diff"].concat(ctxArg).concat(opts.file ? ["--", opts.file] : []);
      const r = await runGit(cwd, args);
      text = r.stdout;
    } else if (scope === "staged") {
      const args = ["diff", "--cached"].concat(ctxArg).concat(opts.file ? ["--", opts.file] : []);
      const r = await runGit(cwd, args);
      text = r.stdout;
    } else if (scope === "commit") {
      if (!opts.sha) throw new GitError("exit", "diff(scope=commit) 需要 sha");
      const args = ["show", "--format=fuller", "--no-color", "-U" + context, opts.sha].concat(opts.file ? ["--", opts.file] : []);
      const r = await runGit(cwd, args);
      text = r.stdout;
    } else if (scope === "compare") {
      if (!opts.base || !opts.target) throw new GitError("exit", "diff(scope=compare) 需要 base + target");
      const args = ["diff", "-U" + context, opts.base + "..." + opts.target].concat(opts.file ? ["--", opts.file] : []);
      const r = await runGit(cwd, args);
      text = r.stdout;
    } else if (scope === "untracked") {
      if (!opts.file) throw new GitError("exit", "diff(scope=untracked) 需要 file");
      // git diff --no-index 在有差异时退出 1，正常
      try {
        const r = await runGit(cwd, ["diff", "--no-index", "-U" + context, "--", "/dev/null", opts.file]);
        text = r.stdout;
      } catch (e) {
        if (e instanceof GitError && e.kind === "exit" && e.exitCode === 1 && e.stdout) {
          text = e.stdout; // 退出 1 + 有 stdout = 有差异
        } else {
          throw e;
        }
      }
    } else {
      throw new GitError("exit", "未知 scope：" + scope);
    }
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit" && e.exitCode === 1 && e.stdout) {
      // 普通 diff exit 1 表示有差异，正常返回 stdout
      text = e.stdout;
    } else {
      throw e;
    }
  }
  if (text.length > DIFF_TEXT_CAP) {
    text = text.slice(0, DIFF_TEXT_CAP);
    truncated = true;
  }
  return { text, truncated };
}

// ============================================================================
// 变更：stage / unstage / discard / commit
// ============================================================================

export async function stageFiles(cwd, files, all) {
  if (all) {
    await runGit(cwd, ["add", "-A"]);
  } else {
    if (!Array.isArray(files) || files.length === 0) throw new GitError("exit", "stage 需要 files 或 all=true");
    await runGit(cwd, ["add", "--"].concat(files));
  }
  return getStatus(cwd);
}

export async function unstageFiles(cwd, files) {
  if (!Array.isArray(files) || files.length === 0) throw new GitError("exit", "unstage 需要 files");
  await runGit(cwd, ["restore", "--staged", "--"].concat(files));
  return getStatus(cwd);
}

export async function discardFiles(cwd, files, includeUntracked) {
  if (!Array.isArray(files) || files.length === 0) throw new GitError("exit", "discard 需要 files");
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "discard：仓库不可用");
  // git rev-parse --git-dir 在 cwd=toplevel 时返回相对 ".git"；existsSync 必须
  // 基于仓库 cwd 解析绝对路径，否则拿 DSH 进程 cwd 去判断 MERGE_HEAD 就废了。
  const gitDirAbs = resolve(cwd, probe.gitDir);

  // 防护前置：先校验所有请求路径都在仓库根内（拒绝绝对路径与 .. 越界），
  // 再做任何破坏性动作。
  for (const f of files) safeJoin(probe.toplevel, f);

  // 拆分：未跟踪 vs 已跟踪。git restore 对未跟踪路径直接报 "did not match"，
  // 把整批操作炸掉 → 必须先分类。未跟踪清单来自 status（probeRepo 不含 status）。
  const st = await getStatus(cwd);
  const untrackedSet = new Set(st.untracked || []);
  const tracked = [];
  const toDelete = [];
  for (const f of files) {
    if (untrackedSet.has(f)) toDelete.push(f);
    else tracked.push(f);
  }
  if (tracked.length > 0) {
    await runGit(cwd, ["restore", "--worktree", "--"].concat(tracked));
  }
  if (includeUntracked && toDelete.length > 0) {
    for (const f of toDelete) {
      const abs = safeJoin(probe.toplevel, f);
      try {
        await rm(abs, { force: true });
      } catch (_) { /* missing 是正常的 */ }
    }
  }
  const status = await getStatus(cwd);
  // 同时带 merging/rebasing 给客户端（避免 banner 漏掉：见 self-test §4.7.4）
  status.merging = existsSync(join(gitDirAbs, "MERGE_HEAD"));
  status.rebasing = existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply"));
  return status;
}

export async function commitStaged(cwd, message, amend) {
  if (typeof message !== "string" || message.length === 0) throw new GitError("exit", "commit 需要 message");
  const args = ["commit", "-m", message];
  if (amend) args.push("--amend");
  await runGit(cwd, args);
  const sha = (await runGit(cwd, ["rev-parse", "--short=12", "HEAD"])).stdout.trim();
  const status = await getStatus(cwd);
  return Object.assign({ commit: sha }, { status });
}

// ============================================================================
// 变更：分支 + merge + 解决
// ============================================================================

export async function createBranch(cwd, name, startPoint, checkout) {
  if (typeof name !== "string" || name.length === 0) throw new GitError("exit", "branchCreate 需要 name");
  if (checkout) {
    await runGit(cwd, ["switch", "-c", name].concat(startPoint ? [startPoint] : []));
  } else {
    await runGit(cwd, ["branch", name].concat(startPoint ? [startPoint] : []));
  }
  return getStatus(cwd);
}

export async function switchBranch(cwd, name) {
  if (typeof name !== "string" || name.length === 0) throw new GitError("exit", "checkout 需要 name");
  await runGit(cwd, ["switch", name]);
  return getStatus(cwd);
}

export async function deleteBranch(cwd, name, force) {
  if (typeof name !== "string" || name.length === 0) throw new GitError("exit", "branchDelete 需要 name");
  await runGit(cwd, ["branch", force ? "-D" : "-d", name]);
  return getStatus(cwd);
}

export async function renameBranch(cwd, oldName, newName) {
  await runGit(cwd, ["branch", "-m", oldName, newName]);
  return getStatus(cwd);
}

export async function mergeBranch(cwd, branch, noFf) {
  if (typeof branch !== "string") throw new GitError("exit", "merge 需要 branch");
  const args = ["merge", "--no-edit"];
  if (noFf) args.push("--no-ff");
  args.push(branch);
  let merged = true;
  try {
    await runGit(cwd, args);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit" && /conflict/i.test(e.stderr || "")) {
      merged = false;
    } else if (e instanceof GitError && e.kind === "exit") {
      // 自动判断：exit 但无 conflict 关键词 → 用 status 看 conflicted
      const st = await getStatus(cwd);
      if (st.conflicted.length > 0) merged = false;
      else throw e;
    } else {
      throw e;
    }
  }
  const status = await getStatus(cwd);
  return { merged, status };
}

export async function abortMerge(cwd) {
  await runGit(cwd, ["merge", "--abort"]);
  return getStatus(cwd);
}

export async function continueMerge(cwd) {
  // 守门：MERGE_HEAD 不存在时 `git commit --no-edit` 会提交当前 staged 内容，
  // 用户误点会得到一个"意外空 commit"——必须先校验。
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "continueMerge：仓库不可用");
  const gitDirAbs = resolve(cwd, probe.gitDir);
  const inMerge = existsSync(join(gitDirAbs, "MERGE_HEAD"))
    || existsSync(join(gitDirAbs, "rebase-merge"))
    || existsSync(join(gitDirAbs, "rebase-apply"));
  if (!inMerge) {
    throw new GitError("exit", "当前不在合并/变基中，无可继续的操作");
  }
  await runGit(cwd, ["commit", "--no-edit"]);
  return getStatus(cwd);
}

// ============================================================================
// 冲突内容 + 解决
// ============================================================================

export async function getConflictContent(cwd, file) {
  if (typeof file !== "string") throw new GitError("exit", "conflictContent 需要 file");
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "conflictContent：仓库不可用");
  const out = { ours: undefined, theirs: undefined, base: undefined, worktree: undefined };
  const read = async (label, stage) => {
    try {
      const r = await runGit(cwd, ["show", ":" + stage + ":" + file]);
      out[label] = r.stdout;
    } catch (e) {
      if (e instanceof GitError && e.kind === "exit") {
        out[label] = undefined; // 阶段不存在（常见：删文件时 stage 不存在）
      } else throw e;
    }
  };
  await read("base", 1);
  await read("ours", 2);
  await read("theirs", 3);
  try {
    const abs = safeJoin(probe.toplevel, file);
    out.worktree = await readFile(abs, "utf8");
  } catch (_) { out.worktree = undefined; }
  return out;
}

export async function resolveConflictFile(cwd, file, strategy, content) {
  if (typeof file !== "string") throw new GitError("exit", "resolveConflict 需要 file");
  if (strategy === "ours") {
    await runGit(cwd, ["checkout", "--ours", "--", file]);
    await runGit(cwd, ["add", "--", file]);
  } else if (strategy === "theirs") {
    await runGit(cwd, ["checkout", "--theirs", "--", file]);
    await runGit(cwd, ["add", "--", file]);
  } else if (strategy === "custom") {
    const probe = await probeRepo(cwd);
    if (!probe.isRepo) throw new GitError("not-a-repo", "resolveConflict：仓库不可用");
    const abs = safeJoin(probe.toplevel, file);
    await writeFile(abs, content || "", "utf8");
    await runGit(cwd, ["add", "--", file]);
  } else {
    throw new GitError("exit", "未知 strategy：" + strategy);
  }
  return getStatus(cwd);
}

// ============================================================================
// 网络：fetch / pull / push
// ============================================================================

const NET_OUTPUT_TAIL = 4000;
function tail(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(s.length - n) : s;
}

export async function fetchRemote(cwd, remote) {
  const args = ["fetch", "--prune"];
  if (remote) args.push(remote);
  let output = "";
  let err = null;
  try {
    const r = await runGitNet(cwd, args);
    output = tail((r.stdout + r.stderr).trim(), NET_OUTPUT_TAIL);
  } catch (e) {
    if (e instanceof GitError) {
      err = e;
      output = tail((e.stdout || "" + (e.stderr || "")).trim(), NET_OUTPUT_TAIL);
    } else throw e;
  }
  const status = await getStatus(cwd);
  if (err) {
    // 把 status 一并附在错误上，让 Host 仍能把 status 推给客户端（不丢上下文）
    err._status = status;
    err._output = output;
    throw err;
  }
  return { output, status };
}

export async function pullBranch(cwd, opts = {}) {
  const args = ["pull"];
  if (opts.rebase) args.push("--rebase");
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);
  let output = "";
  let err = null;
  try {
    const r = await runGitNet(cwd, args);
    output = tail((r.stdout + r.stderr).trim(), NET_OUTPUT_TAIL);
  } catch (e) {
    if (e instanceof GitError) {
      err = e;
      output = tail(((e.stdout || "") + (e.stderr || "")).trim(), NET_OUTPUT_TAIL);
    } else throw e;
  }
  const status = await getStatus(cwd);
  if (err) { err._status = status; err._output = output; throw err; }
  return { output, status };
}

export async function pushBranch(cwd, opts = {}) {
  const args = ["push"];
  if (opts.setUpstream) args.push("-u");
  if (opts.forceWithLease) args.push("--force-with-lease");
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);
  let output = "";
  let err = null;
  try {
    const r = await runGitNet(cwd, args);
    output = tail((r.stdout + r.stderr).trim(), NET_OUTPUT_TAIL);
  } catch (e) {
    if (e instanceof GitError) {
      err = e;
      output = tail(((e.stdout || "") + (e.stderr || "")).trim(), NET_OUTPUT_TAIL);
    } else throw e;
  }
  const status = await getStatus(cwd);
  if (err) { err._status = status; err._output = output; throw err; }
  return { output, status };
}

// ============================================================================
// Worktree 管理
// ============================================================================

export async function addWorktree(cwd, worktreePath, newBranch, startPoint) {
  if (!worktreePath) throw new GitError("exit", "worktreeAdd 需要 worktreePath");
  // git worktree add 语法：worktree add [-b <new>] [--detach] <path> [<commit-ish>]
  // 关键：<path> 必须是第一个位置参数；detach 是 flag（无值），commit-ish 在 path 之后。
  const args = ["worktree", "add"];
  if (newBranch) args.push("-b", newBranch);
  if (newBranch && startPoint) {
    // git > 2.30 接受 -b newBranch startPoint 与 -b newBranch startPoint path 两种顺序；统一 path-first
    args.push(worktreePath, startPoint);
  } else {
    args.push(worktreePath);
    if (startPoint) {
      // 隐式 detached：把 startPoint 当 commit-ish 加在 path 后面
      args.push(startPoint);
    }
  }
  await runGit(cwd, args);
  return getWorktrees(cwd);
}

export async function removeWorktree(cwd, worktreePath, force) {
  if (!worktreePath) throw new GitError("exit", "worktreeRemove 需要 worktreePath");
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  await runGit(cwd, args);
  return getWorktrees(cwd);
}

export async function pruneWorktrees(cwd) {
  await runGit(cwd, ["worktree", "prune"]);
  return getWorktrees(cwd);
}

export async function initRepo(cwd) {
  await runGit(cwd, ["init", "-b", "main"]);
  return probeRepo(cwd);
}