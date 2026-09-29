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
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

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
          // 编辑器脚本由 buildEditorCommand 用 process.execPath 启动：Electron 宿主下
          // execPath 是 Electron 主程序，此变量强制其以纯 node 模式跑脚本；纯 node
          // 宿主下无副作用（P3-A 集成加固，2026-09-29）。
          ELECTRON_RUN_AS_NODE: "1",
        }, opts.env || {}), // per-call 覆盖（P3-A rebase 的 GIT_SEQUENCE_EDITOR / GIT_EDITOR 队列）
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
// 入参白名单校验（防选项注入：execFile 不拼 shell，但位置参数若以 "-" 开头
// 会被 git 当作选项；rev/tag 名/文件名一律先过白名单再进 argv）
// ============================================================================

// rev / ref：sha、HEAD、HEAD~n、@{...}、分支/tag 名等；禁 "-" 开头、空白与元字符
const REV_RE = /^[A-Za-z0-9._\/^~@{}:+=-]+$/;
export function checkRev(rev, label) {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new GitError("exit", (label || "操作") + " 需要 ref");
  }
  if (rev.startsWith("-") || !REV_RE.test(rev)) {
    throw new GitError("exit", (label || "操作") + " 非法 ref：" + rev);
  }
  return rev;
}

// reset target 白名单（契约 §2.4）：sha 十六进制 / HEAD / HEAD~n / @{...}，
// 拒绝其他一切形态（含 "-" 开头）防选项注入。
export function checkResetTarget(target) {
  const t = target == null || target === "" ? "HEAD" : target;
  if (typeof t !== "string") throw new GitError("exit", "reset target 非法");
  const ok = /^[0-9a-fA-F]{4,40}$/.test(t)
    || t === "HEAD"
    || /^HEAD~[0-9]{1,3}$/.test(t)
    || /^@\{[A-Za-z0-9._^~:+-]{1,64}\}$/.test(t);
  if (!ok) throw new GitError("exit", "reset target 非法：" + t);
  return t;
}

// tag / 分支名校验（对齐 git check-ref-format 的关键禁止项）
export function checkRefName(name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw new GitError("exit", (label || "操作") + " 需要 name");
  }
  const bad = name.startsWith("-") || name.startsWith("/") || name.endsWith("/")
    || name.endsWith(".") || name.endsWith(".lock") || name.includes("..")
    || name.includes("//") || name.includes("@{") || /[\s~^:?*\[\\]/.test(name);
  if (bad) throw new GitError("exit", (label || "操作") + " 非法名称：" + name);
  return name;
}

// stash 序号：缺省 0，必须是非负整数
export function checkStashIndex(index) {
  if (index == null || index === "") return 0;
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    throw new GitError("exit", "非法 stash 序号：" + index);
  }
  return n;
}

// remote 名：git remote add/rename/remove 的 name
export function checkRemoteName(name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw new GitError("exit", (label || "remote") + " 需要 name");
  }
  if (name.startsWith("-") || /[\s~^:?*\[\\/@{}]/.test(name) || name.includes("..")) {
    throw new GitError("exit", (label || "remote") + " 非法名称：" + name);
  }
  return name;
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

  const out = {
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
  };
  // 网关 assertJsonValue 会拒绝显式 undefined 的 own key——defined 才带上
  if (mainWorktreePath !== undefined) out.mainWorktreePath = mainWorktreePath;
  return out;
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
//   输入：git log -z --format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b
//   record 分隔：\0；field 分隔：\x1f
//   parents 是空格分隔的 oid 列表；body 是 subject 之后的多行正文（v2 §6，
//   amend 预填用），无正文时为 ""（字段恒定挂载，wire 安全）
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
    // %b 带尾随换行；去掉尾随空白，保留内部多行结构
    const body = (parts[8] || "").replace(/\s+$/, "");
    commits.push({
      sha,
      short,
      parents,
      author,
      email,
      at: Number(at) || 0,
      refs: refs || "",
      subject,
      body,
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
  // maxCount/limit 兼容两种叫法（契约 §2.2 "原有 skip/limit 保留"）
  const maxCount = opts.maxCount ?? opts.limit ?? 200;
  const skip = opts.skip ?? 0;
  const all = opts.all === true;
  const ref = opts.ref || null;
  const args = ["log", "--date-order", "-z", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b",
    "--max-count=" + maxCount, "--skip=" + skip];
  if (all) args.push("--all");
  if (ref) args.push(checkRev(ref, "log"));
  // 过滤器（v2 §2.2）：author / grep / since / until 都是选项值（单 argv，无注入面）
  if (typeof opts.author === "string" && opts.author.length > 0) args.push("--author=" + opts.author);
  if (typeof opts.grep === "string" && opts.grep.length > 0) args.push("--grep=" + opts.grep);
  if (typeof opts.since === "string" && opts.since.length > 0) args.push("--since=" + opts.since);
  if (typeof opts.until === "string" && opts.until.length > 0) args.push("--until=" + opts.until);
  // 路径过滤：safeJoin 防护（拒绝对对路径 / .. 越界），pathspec 放 "--" 之后
  let fileArg = null;
  if (typeof opts.file === "string" && opts.file.length > 0) {
    safeJoin(cwd, opts.file);
    fileArg = opts.file;
  }
  let raw;
  try {
    raw = await runGit(cwd, fileArg ? args.concat(["--", fileArg]) : args);
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
    // prunable 不能是 null（typert union(boolean,string) 不含 null），默认 false
    const item = { path: null, headSha: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
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
// 变更：hunk 级补丁（IDEA 式逐块操作：撤销此块 / 取消暂存此块）
// ============================================================================

// 从完整 unified diff 文本中提取"某文件的第 hunkIndex 个块"，拼成可独立
// `git apply` 的最小补丁（文件头 + 单个 hunk）。纯函数，便于 fixture 测试。
export function extractHunkPatch(diffText, file, hunkIndex) {
  if (typeof diffText !== "string" || diffText.length === 0) {
    throw new GitError("exit", "没有可用的 diff 文本");
  }
  if (typeof file !== "string" || file.length === 0) {
    throw new GitError("exit", "hunk 操作需要 file");
  }
  const idx = Number(hunkIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new GitError("exit", "非法 hunkIndex：" + hunkIndex);
  }
  // 按 "diff --git " 切文件段；段内：@@ 之前是文件头，之后每 @@ 开一个 hunk，
  // "\ No newline at end of file" 等尾随行归入当前 hunk。
  const sections = [];
  let cur = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { headerLines: [line], hunks: [], curHunk: null };
      sections.push(cur);
    } else if (!cur) {
      continue; // diff 之前的行（如 git show 的提交头）
    } else if (line.startsWith("@@")) {
      cur.curHunk = [line];
      cur.hunks.push(cur.curHunk);
    } else if (cur.curHunk) {
      cur.curHunk.push(line);
    } else {
      cur.headerLines.push(line);
    }
  }
  const unquote = (p) => (p && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
  const wantNew = "b/" + file;
  const wantOld = "a/" + file;
  let target = null;
  for (const s of sections) {
    let newPath = null;
    let oldPath = null;
    for (const h of s.headerLines) {
      if (h.startsWith("+++ ")) newPath = unquote(h.slice(4));
      else if (h.startsWith("--- ")) oldPath = unquote(h.slice(4));
    }
    if (newPath === wantNew || oldPath === wantOld) { target = s; break; }
    // 兜底：diff --git a/<old> b/<new> 首行整体匹配
    if (s.headerLines[0] === "diff --git " + wantOld + " " + wantNew) { target = s; break; }
  }
  if (!target) throw new GitError("exit", "diff 中找不到文件：" + file);
  if (idx >= target.hunks.length) {
    throw new GitError("exit", "hunkIndex 越界：" + idx + "（该文件共 " + target.hunks.length + " 块）");
  }
  const patch = target.headerLines.concat(target.hunks[idx]).join("\n");
  return patch.endsWith("\n") ? patch : patch + "\n";
}

// 对单个 hunk 执行反向应用：
//   scope=worktree → git apply --reverse        把工作区该块恢复成 index 版本（IDEA「撤销」）
//   scope=staged   → git apply --reverse --cached 把该块移出暂存区（改动保留在工作区）
// 返回最新 status（与其他 mutation 一致）。
export async function applyHunk(cwd, opts = {}) {
  const scope = opts.scope;
  if (scope !== "worktree" && scope !== "staged") {
    throw new GitError("exit", "hunkApply 只支持 scope=worktree（撤销此块）/ staged（取消暂存此块）");
  }
  const file = opts.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new GitError("exit", "hunkApply 需要 file");
  }
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "hunkApply：仓库不可用");
  // 路径防护：与 discard 同一道闸（拒绝绝对路径 / .. 越界）
  safeJoin(probe.toplevel, file);
  // patch 内路径是仓库根相对路径，getDiff/git apply 都必须在 toplevel 跑
  // （cwd 是子目录时 git diff -- <根相对路径> 会匹配不到）。
  const top = probe.toplevel;
  const diff = await getDiff(top, { scope, file });
  const patch = extractHunkPatch(diff.text, file, opts.hunkIndex);
  const tmpFile = join(tmpdir(), "dsh-gm-hunk-" + process.pid + "-" + randomBytes(6).toString("hex") + ".patch");
  try {
    await writeFile(tmpFile, patch, "utf8");
    const args = ["apply", "--reverse", "--whitespace=nowarn"];
    if (scope === "staged") args.push("--cached");
    args.push(tmpFile);
    await runGit(top, args);
  } finally {
    await rm(tmpFile, { force: true });
  }
  return getStatus(top);
}

// ============================================================================
// 变更：lineApply + extractLinePatch（P3-A §8.3 行级暂存/撤销）
// ============================================================================

// 从完整 unified diff 中提取「某文件第 hunkIndex 个块内 rows[rowStart..rowEnd]」的
// 最小补丁（纯函数）。行下标 0 基、含端点、只计 @@ 头之后的 ctx/add/del 行
// （"\ No newline at end of file" 等标记行随其紧邻上一行自动带出、不单独寻址）。
// 正确重写 @@ 头两侧行计数与起始行号：count>0 时 start=首行号；count=0 时
// start=插入点前一行（git -U0 实测约定，如 `@@ -3,0 +4,2 @@`）；原 hunk 该侧
// 本就为 0 时 start 保持不变。覆盖整个 hunk 时输出与 extractHunkPatch 逐字节一致。
export function extractLinePatch(diffText, file, hunkIndex, rowStart, rowEnd) {
  if (typeof diffText !== "string" || diffText.length === 0) {
    throw new GitError("exit", "没有可用的 diff 文本");
  }
  if (typeof file !== "string" || file.length === 0) {
    throw new GitError("exit", "lineApply 需要 file");
  }
  const hIdx = Number(hunkIndex);
  if (!Number.isInteger(hIdx) || hIdx < 0) {
    throw new GitError("exit", "非法 hunkIndex：" + hunkIndex);
  }
  const r0 = Number(rowStart);
  const r1 = Number(rowEnd);
  if (!Number.isInteger(r0) || !Number.isInteger(r1)) {
    throw new GitError("exit", "非法行区间：" + rowStart + ".." + rowEnd);
  }
  if (r0 > r1) {
    throw new GitError("exit", "非法行区间（rowStart>rowEnd）：" + r0 + ".." + r1);
  }
  // 切文件段 / hunk（与 extractHunkPatch 同一套解析规则）
  const sections = [];
  let cur = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { headerLines: [line], hunks: [], curHunk: null };
      sections.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("@@")) {
      cur.curHunk = [line];
      cur.hunks.push(cur.curHunk);
    } else if (cur.curHunk) {
      cur.curHunk.push(line);
    } else {
      cur.headerLines.push(line);
    }
  }
  const unquote = (p) => (p && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
  const wantNew = "b/" + file;
  const wantOld = "a/" + file;
  let target = null;
  for (const s of sections) {
    let newPath = null;
    let oldPath = null;
    for (const h of s.headerLines) {
      if (h.startsWith("+++ ")) newPath = unquote(h.slice(4));
      else if (h.startsWith("--- ")) oldPath = unquote(h.slice(4));
    }
    if (newPath === wantNew || oldPath === wantOld) { target = s; break; }
    if (s.headerLines[0] === "diff --git " + wantOld + " " + wantNew) { target = s; break; }
  }
  if (!target) throw new GitError("exit", "diff 中找不到文件：" + file);
  if (hIdx >= target.hunks.length) {
    throw new GitError("exit", "hunkIndex 越界：" + hIdx + "（该文件共 " + target.hunks.length + " 块）");
  }
  const hunk = target.hunks[hIdx];
  const header = hunk[0];
  const rows = hunk.slice(1);
  // 可寻址行 = ctx/add/del；标记行（\ ...）不计下标
  const addrIdx = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i][0];
    if (t === " " || t === "+" || t === "-") addrIdx.push(i);
  }
  if (r0 < 0 || r1 >= addrIdx.length) {
    throw new GitError("exit", "行区间越界：" + r0 + ".." + r1 + "（该 hunk 共 " + addrIdx.length + " 行）");
  }
  // 选中行 + 紧随其后的标记行（\ No newline at end of file 等）
  const picked = [];
  for (let k = r0; k <= r1; k++) {
    const i = addrIdx[k];
    picked.push(rows[i]);
    if (rows[i + 1] !== undefined && rows[i + 1].startsWith("\\")) picked.push(rows[i + 1]);
  }
  // @@ 头重写
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (!m) throw new GitError("exit", "无法解析 hunk 头：" + header);
  const oldStart = Number(m[1]);
  const oldCount = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  const suffix = m[5] || "";
  let oldBefore = 0, newBefore = 0;
  for (let k = 0; k < r0; k++) {
    const t = rows[addrIdx[k]][0];
    if (t === " " || t === "-") oldBefore++;
    if (t === " " || t === "+") newBefore++;
  }
  let selOld = 0, selNew = 0;
  for (const line of picked) {
    const t = line[0];
    if (t === " " || t === "-") selOld++;
    if (t === " " || t === "+") selNew++;
  }
  const startFor = (origStart, origCount, before, count) => {
    if (count > 0) return origStart + before;
    if (origCount === 0) return origStart; // 该侧原本就是 0：start 已是"前一行"语义
    return Math.max(origStart + before - 1, 0);
  };
  const isFull = r0 === 0 && r1 === addrIdx.length - 1;
  const newHeader = isFull
    ? header // 整 hunk：与 extractHunkPatch 逐字节一致（计数/起点本就相等）
    : "@@ -" + startFor(oldStart, oldCount, oldBefore, selOld) + (selOld === 1 ? "" : "," + selOld)
      + " +" + startFor(newStart, newCount, newBefore, selNew) + (selNew === 1 ? "" : "," + selNew)
      + " @@" + suffix;
  const patch = target.headerLines.concat([newHeader]).concat(picked).join("\n");
  return patch.endsWith("\n") ? patch : patch + "\n";
}

// 执行映射（§8.3）：stage→apply --cached；unstage→apply --reverse --cached；
// discard→apply --reverse。选区可能无上下文 → --unidiff-zero。
// 与 hunkApply 同一道闸：safeJoin + cwd 必须在 probe.toplevel。
export async function applyLine(cwd, opts = {}) {
  const file = opts.file;
  const scope = opts.scope;
  const mode = opts.mode;
  if (typeof file !== "string" || file.length === 0) {
    throw new GitError("exit", "lineApply 需要 file");
  }
  const key = scope + "/" + mode;
  if (key !== "unstaged/stage" && key !== "staged/unstage" && key !== "unstaged/discard") {
    throw new GitError("exit", "lineApply 非法 scope/mode 组合：" + key);
  }
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "lineApply：仓库不可用");
  safeJoin(probe.toplevel, file);
  const top = probe.toplevel;
  const diff = await getDiff(top, { scope: scope === "staged" ? "staged" : "worktree", file });
  const patch = extractLinePatch(diff.text, file, opts.hunkIndex, opts.rowStart, opts.rowEnd);
  const tmpFile = join(tmpdir(), "dsh-gm-line-" + process.pid + "-" + randomBytes(6).toString("hex") + ".patch");
  try {
    await writeFile(tmpFile, patch, "utf8");
    const args = ["apply", "--unidiff-zero", "--whitespace=nowarn"];
    if (mode === "stage") args.push("--cached");
    else if (mode === "unstage") args.push("--reverse", "--cached");
    else args.push("--reverse");
    args.push(tmpFile);
    await runGit(top, args);
  } finally {
    await rm(tmpFile, { force: true });
  }
  return getStatus(top);
}

// ============================================================================
// 变更：stageHunk（暂存此块，v2 §2.1）
//   getDiff(unstaged) → extractHunkPatch（不 reverse）→ git apply --cached
//   把工作区该 hunk 的内容正向应用到 index（hunk 级暂存，不动其他块）
// ============================================================================

export async function stageHunkFile(cwd, opts = {}) {
  const file = opts.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new GitError("exit", "stageHunk 需要 file");
  }
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "stageHunk：仓库不可用");
  // 路径防护：与 hunkApply/discard 同一道闸（拒绝绝对路径 / .. 越界）
  safeJoin(probe.toplevel, file);
  // patch 内路径是仓库根相对路径，getDiff/git apply 都必须在 toplevel 跑
  const top = probe.toplevel;
  const diff = await getDiff(top, { scope: "worktree", file });
  const patch = extractHunkPatch(diff.text, file, opts.hunkIndex);
  const tmpFile = join(tmpdir(), "dsh-gm-stage-" + process.pid + "-" + randomBytes(6).toString("hex") + ".patch");
  try {
    await writeFile(tmpFile, patch, "utf8");
    await runGit(top, ["apply", "--cached", "--whitespace=nowarn", tmpFile]);
  } finally {
    await rm(tmpFile, { force: true });
  }
  return getStatus(top);
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
  // 按进行中的操作类型选择 abort 命令（P3-A §8.2 优先级）：
  // rebase > MERGE_HEAD > CHERRY_PICK_HEAD > REVERT_HEAD > unmerged 兜底 > 抛错。
  // 各操作状态互斥，`git merge --abort` 对 cherry-pick/rebase 状态无效（反之亦然）。
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "abortMerge：仓库不可用");
  const gitDirAbs = resolve(cwd, probe.gitDir);
  const inRebase = existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply"));
  const inMerge = existsSync(join(gitDirAbs, "MERGE_HEAD"));
  const inCherryPick = existsSync(join(gitDirAbs, "CHERRY_PICK_HEAD"));
  const inRevert = existsSync(join(gitDirAbs, "REVERT_HEAD"));
  if (inRebase) {
    await runGit(cwd, ["rebase", "--abort"]);
    await cleanupRebaseQueue(gitDirAbs); // rebase 中止：squash 消息队列作废
  } else if (inMerge) {
    await runGit(cwd, ["merge", "--abort"]);
  } else if (inCherryPick) {
    await runGit(cwd, ["cherry-pick", "--abort"]);
  } else if (inRevert) {
    await runGit(cwd, ["revert", "--abort"]);
  } else {
    // 兜底（Lead 裁决 2026-09-29，stash pop/apply 冲突路径）：stash 冲突不写任何
    // 操作 HEAD 状态文件，只留 unmerged index 条目。对这些冲突文件
    // `git restore --source=HEAD --staged --worktree`（文件清单来自 status 的
    // unmerged 条目并过 safeJoin），其他文件已套用的改动保留、stash 条目保留。
    // 既无状态文件又无 unmerged → 照旧抛错，防止误点把 staged 内容干出"空操作"。
    const st = await getStatus(cwd);
    const unmerged = (st.conflicted || []).map((e) => e.path);
    if (unmerged.length > 0) {
      for (const f of unmerged) safeJoin(probe.toplevel, f);
      await runGit(probe.toplevel, ["restore", "--source=HEAD", "--staged", "--worktree", "--"].concat(unmerged));
    } else {
      throw new GitError("exit", "当前没有可中止的合并/cherry-pick/revert 操作");
    }
  }
  return getStatus(cwd);
}

export async function continueMerge(cwd) {
  // 守门：MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / rebase 目录都不存在时，
  // `git commit --no-edit` 会提交当前 staged 内容，用户误点会得到一个
  // "意外空 commit"——必须先校验。
  // cherry-pick/revert 冲突解决后同样由 `git commit --no-edit` 完成
  //（MERGE_MSG 已备好原提交信息，commit 成功自动清状态文件）。
  // P3-A §8.2 状态分派：rebase-merge/rebase-apply → `git rebase --continue`。
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "continueMerge：仓库不可用");
  const gitDirAbs = resolve(cwd, probe.gitDir);
  const inRebase = existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply"));
  const inCommit = existsSync(join(gitDirAbs, "MERGE_HEAD"))
    || existsSync(join(gitDirAbs, "CHERRY_PICK_HEAD"))
    || existsSync(join(gitDirAbs, "REVERT_HEAD"));
  if (!inRebase && !inCommit) {
    throw new GitError("exit", "当前不在合并/变基/cherry-pick 中，无可继续的操作");
  }
  if (inRebase) {
    // 重新挂载 squash 消息队列（rebaseRun 落在 gitDir、跨进程存活），
    // 保证冲突之后的 squash 步骤仍按队列顺序替换提交信息
    const armed = await rebaseMessageQueueEnv(gitDirAbs);
    try {
      await runGit(cwd, ["rebase", "--continue"], { env: armed.env });
    } finally {
      if (armed.scriptPath) await rm(armed.scriptPath, { force: true });
    }
    if (!isRebasing(gitDirAbs)) await cleanupRebaseQueue(gitDirAbs);
  } else {
    await runGit(cwd, ["commit", "--no-edit"]);
  }
  return getStatus(cwd);
}

// cherry-pick 单个提交到当前分支。
// 冲突时不抛错（与 mergeBranch 同款契约）：返回 { picked:false, status }，
// 仓库进入 CHERRY_PICK_HEAD 状态 → 冲突页解决后「继续」即完成 pick，
// 「中止」走 abortMerge 的 cherry-pick --abort 分支。
// 其他失败（空 pick、工作区脏导致无法应用等）原样抛 GitError。
export async function cherryPickCommit(cwd, sha) {
  // sha 白名单校验：虽然 execFile argv 不拼 shell，仍收紧到纯十六进制
  if (typeof sha !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new GitError("exit", "cherryPick 需要合法 commit sha（4-64 位十六进制）");
  }
  let picked = true;
  try {
    await runGit(cwd, ["cherry-pick", sha]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") {
      const st = await getStatus(cwd);
      if (st.conflicted.length > 0 || /conflict/i.test(e.stderr || "")) {
        picked = false;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
  const status = await getStatus(cwd);
  return { picked, status };
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
// 解析器：parseStashList（v2 §2.2）
//   输入：git stash list -z --format=%gd%x1f%gs%x1f%ct（记录以 \0 分隔）
//   输出 stashEntry：{ index, ref, subject, at }
// ============================================================================

const STASH_FMT = "%gd%x1f%gs%x1f%ct";

export function parseStashList(text) {
  const out = [];
  if (!text) return out;
  for (const rec of text.split("\0")) {
    if (rec.trim().length === 0) continue;
    const parts = rec.split("\x1f");
    if (parts.length < 3) continue;
    const [ref, subject, atRaw] = parts;
    const m = /stash@\{(\d+)\}/.exec(ref);
    out.push({
      index: m ? Number(m[1]) : out.length,
      ref,
      subject,
      at: Number(atRaw) || 0,
    });
  }
  return out;
}

export async function getStashes(cwd) {
  const r = await runGit(cwd, ["stash", "list", "-z", "--format=" + STASH_FMT]);
  return { stashes: parseStashList(r.stdout) };
}

export async function stashPush(cwd, message, includeUntracked) {
  const args = ["stash", "push"];
  if (includeUntracked) args.push("-u");
  if (typeof message === "string" && message.length > 0) args.push("-m", message);
  await runGit(cwd, args);
  return getStashes(cwd);
}

// pop / apply 共用：冲突不抛错（与 mergeBranch/revertCommit 同款契约），
// status.conflicted 非空即把最新 status 交回客户端走冲突页；
// 其他失败（坏序号等）原样抛 GitError，不吞错误。
async function stashApplyish(cwd, cmd, index) {
  const sel = "stash@{" + checkStashIndex(index) + "}";
  let err = null;
  try {
    await runGit(cwd, ["stash", cmd, sel]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") err = e;
    else throw e;
  }
  const status = await getStatus(cwd);
  if (err && status.conflicted.length === 0) throw err;
  return status;
}

export async function stashPop(cwd, index) {
  return stashApplyish(cwd, "pop", index);
}

export async function stashApply(cwd, index) {
  return stashApplyish(cwd, "apply", index);
}

export async function stashDrop(cwd, index) {
  await runGit(cwd, ["stash", "drop", "stash@{" + checkStashIndex(index) + "}"]);
  return getStashes(cwd);
}

export async function stashClear(cwd) {
  await runGit(cwd, ["stash", "clear"]);
  return getStashes(cwd);
}

// ============================================================================
// 解析器：parseTagList（v2 §2.2）
//   输入：git for-each-ref --format=<TAG_FMT> refs/tags
//   TAG_FMT 每条 7 字段、%00 分隔、条目以换行收尾（contents 可多行，
//   不能按换行切记录）→ 按 \0 切成 7 字段一组；组首 chunk 带上一条的换行前缀。
//   输出 tagInfo：{ name, sha, short, subject, at, annotated, message? }
// ============================================================================

const TAG_FMT =
  "%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)" +
  "%00%(creatordate:unix)%00%(subject)%00%(contents)%00";

export function parseTagList(text) {
  const out = [];
  if (!text) return out;
  const chunks = text.split("\0");
  for (let i = 0; i + 6 < chunks.length; i += 7) {
    const name = chunks[i].replace(/^[\r\n]+/, "");
    const objectname = chunks[i + 1];
    const objecttype = chunks[i + 2];
    const deref = chunks[i + 3];
    const at = Number(chunks[i + 4]) || 0;
    const subject = chunks[i + 5].replace(/^[\r\n]+/, "");
    const contents = chunks[i + 6].replace(/^[\r\n]+/, "");
    if (!name) continue;
    const annotated = objecttype === "tag";
    // annotated tag 的 ref 指向 tag 对象，%(*objectname) 才是提交 sha
    const sha = (annotated && deref ? deref : objectname) || objectname || "";
    const item = {
      name,
      sha,
      short: sha.slice(0, 7),
      subject: subject.trim(),
      at,
      annotated,
    };
    // message 只在 annotated 且有内容时挂（网关 JSON-safe：不挂 undefined key）
    const message = contents.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    if (annotated && message) item.message = message;
    out.push(item);
  }
  return out;
}

export async function getTags(cwd) {
  const r = await runGit(cwd, ["for-each-ref", "--format=" + TAG_FMT, "refs/tags"]);
  return { tags: parseTagList(r.stdout) };
}

export async function createTag(cwd, name, sha, message, force) {
  checkRefName(name, "tagCreate");
  const annotated = typeof message === "string" && message.trim().length > 0;
  const args = ["tag"];
  if (annotated) args.push("-a", "-m", message);
  if (force) args.push("-f");
  args.push(name);
  if (sha) args.push(checkRev(sha, "tagCreate"));
  await runGit(cwd, args);
  return getTags(cwd);
}

export async function deleteTag(cwd, name) {
  checkRefName(name, "tagDelete");
  await runGit(cwd, ["tag", "-d", name]);
  return getTags(cwd);
}

// ============================================================================
// 变更：reset（v2 §2.2）/ revert
// ============================================================================

// reset 当前分支。mode 只允许 soft|mixed|hard（枚举校验，防 "-" 注入）；
// target 走 checkResetTarget 白名单（sha / HEAD / HEAD~n / @{...}）。
// hard 本身不做 UI 确认——确认是 client 的职责（契约 §2.4）。
export async function resetRepo(cwd, mode, target) {
  const m = mode === "soft" || mode === "mixed" || mode === "hard" ? mode : null;
  if (!m) throw new GitError("exit", "reset mode 只允许 soft|mixed|hard，收到：" + mode);
  const t = checkResetTarget(target);
  await runGit(cwd, ["reset", "--" + m, t]);
  return getStatus(cwd);
}

// revert 单个提交。冲突不抛错（与 cherryPickCommit 同款契约）：
// 返回 { reverted:false, status }，仓库进 REVERT_HEAD 态 → 冲突页解决后
// mergeContinue 完成、abortMerge 的 revert --abort 分支中止。
// 其他失败原样抛 GitError。
export async function revertCommit(cwd, sha) {
  if (typeof sha !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new GitError("exit", "revert 需要合法 commit sha（4-64 位十六进制）");
  }
  let reverted = true;
  let err = null;
  try {
    await runGit(cwd, ["revert", "--no-edit", sha]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") { reverted = false; err = e; }
    else throw e;
  }
  const status = await getStatus(cwd);
  if (!reverted) {
    // 只有"冲突 / revert 进行中（REVERT_HEAD 在场）"按不抛错处理；其余透传
    const probe = await probeRepo(cwd);
    const inRevert = probe.isRepo
      && existsSync(join(resolve(cwd, probe.gitDir), "REVERT_HEAD"));
    if (!inRevert && status.conflicted.length === 0) throw err;
  }
  return { reverted, status };
}

// ============================================================================
// 解析器：parseBlame（v2 §2.2）
//   输入：git blame --porcelain 输出
//   组头："<sha> <origLine> <finalLine> [<numLines>]" + 元数据块（author/author-time/...）
//   组内后续行：同 sha 短头 + 直接 "\t<原文>"。元数据只在组头出现一次，
//   之后同 sha 的行沿用最近一次的 author/at。
//   输出 blameLine：{ sha, short, author, at, line, text }
// ============================================================================

export function parseBlame(text) {
  const out = [];
  if (!text) return out;
  let author = "";
  let at = 0;
  let head = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("\t")) {
      if (head) {
        out.push({
          sha: head.sha,
          short: head.sha.slice(0, 7),
          author,
          at,
          line: head.finalLine,
          text: raw.slice(1),
        });
        head = null;
      }
      continue;
    }
    const m = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(raw);
    if (m) {
      head = { sha: m[1], finalLine: Number(m[3]) };
      continue;
    }
    if (raw.startsWith("author ")) author = raw.slice(7);
    else if (raw.startsWith("author-time ")) at = Number(raw.slice(12)) || 0;
  }
  return out;
}

const BLAME_LINE_CAP = 5000; // UI 一次渲染上限（契约 §3.7）

export async function getBlame(cwd, opts = {}) {
  const file = opts.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new GitError("exit", "blame 需要 file");
  }
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "blame：仓库不可用");
  safeJoin(probe.toplevel, file);
  const top = probe.toplevel;
  const args = ["blame", "--porcelain"];
  if (opts.start != null || opts.end != null) {
    const start = opts.start == null ? 1 : Number(opts.start);
    const end = opts.end == null ? start : Number(opts.end);
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
      throw new GitError("exit", "blame 行区间非法：" + opts.start + ".." + opts.end);
    }
    args.push("-L", start + "," + end);
  }
  if (opts.ref) args.push(checkRev(opts.ref, "blame"));
  args.push("--", file);
  const r = await runGit(top, args);
  const all = parseBlame(r.stdout);
  const truncated = all.length > BLAME_LINE_CAP;
  return { lines: truncated ? all.slice(0, BLAME_LINE_CAP) : all, truncated };
}

// ============================================================================
// 变更/查询：diffRange（v2 §2.2 范围对比）
//   请求 { from, to?, file?, kind? }，kind ∈ patch|stat（缺省 patch）
//   to 缺省时与工作区比较（git diff <from>）；file 走 safeJoin，在 toplevel 跑
// ============================================================================

export async function getDiffRange(cwd, opts = {}) {
  const from = checkRev(opts.from, "diffRange");
  const to = opts.to ? checkRev(opts.to, "diffRange") : null;
  const kind = opts.kind === "stat" ? "stat" : "patch";
  const file = typeof opts.file === "string" && opts.file.length > 0 ? opts.file : null;
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "diffRange：仓库不可用");
  const top = probe.toplevel;
  if (file) safeJoin(top, file);
  const args = ["diff"];
  if (kind === "stat") args.push("--stat");
  else args.push("-U3");
  args.push(from);
  if (to) args.push(to);
  if (file) args.push("--", file);
  let text = "";
  try {
    const r = await runGit(top, args);
    text = r.stdout;
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit" && e.exitCode === 1 && e.stdout) {
      text = e.stdout; // exit 1 + 有 stdout = 有差异
    } else {
      throw e;
    }
  }
  if (text.length > DIFF_TEXT_CAP) {
    text = text.slice(0, DIFF_TEXT_CAP);
    return { text, truncated: true };
  }
  return { text, truncated: false };
}

// ============================================================================
// 解析器：parseReflog（v2 §2.2）
//   输入：git reflog -z --format=%H%x1f%h%x1f%gD%x1f%gs%x1f%ct（记录 \0 分隔）
//   输出 reflogEntry：{ sha, short, selector, message, at }
// ============================================================================

const REFLOG_FMT = "%H%x1f%h%x1f%gD%x1f%gs%x1f%ct";

export function parseReflog(text) {
  const out = [];
  if (!text) return out;
  for (const rec of text.split("\0")) {
    if (rec.length === 0) continue;
    const parts = rec.split("\x1f");
    if (parts.length < 5) continue;
    const [sha, short, selector, message, at] = parts;
    out.push({ sha, short, selector, message, at: Number(at) || 0 });
  }
  return out;
}

export async function getReflog(cwd, opts = {}) {
  let limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit <= 0) limit = 50;
  if (limit > 5000) limit = 5000;
  let raw;
  try {
    raw = await runGit(cwd, ["reflog", "-z", "--format=" + REFLOG_FMT, "-n", String(limit)]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") {
      const msg = (e.stderr || e.message || "").toLowerCase();
      if (/does not have any commits|unknown revision|no reflog/.test(msg)) {
        return { entries: [] };
      }
      throw e;
    }
    throw e;
  }
  return { entries: parseReflog(raw.stdout) };
}

// ============================================================================
// P3-A（§8.1/§8.2）：交互式 rebase 全家 + 状态分派
//
// GIT_SEQUENCE_EDITOR / GIT_EDITOR 机制：git 用 `sh -c '<editor> "$@"' <editor> <file>`
// 启动编辑器，editor 值天然是 sh 命令串。我们只构造「带引号的解释器 + 脚本 + 模式」
// 三段固定形态（shQuote 只做双引号转义，无任何 shell 逻辑拼接），脚本本体是写到
// tmpdir 的 node 脚本，业务数据全走环境变量与文件：
//   seq 模式：把 DSH_GM_TODO_SRC 指向的 todo 文件复制到 git-rebase-todo（替换默认 todo）
//   msg 模式：从 DSH_GM_MSG_QUEUE 队列取下一条 message 覆盖提交信息文件，
//             非空才覆盖（空/越界保留 git 默认合并文本）——squash+message 替换语义
// 队列文件放 gitDir（跨进程存活）：冲突解决后 mergeContinue 重新挂载同一队列，
// 多条 squash 消息按 todo 顺序依次消费（Lead 裁决 Q2）。
// ============================================================================

const REBASE_EDITOR_SCRIPT = [
  'import { readFileSync, writeFileSync, copyFileSync } from "node:fs";',
  "const mode = process.argv[2];",
  "const target = process.argv[process.argv.length - 1];",
  'if (mode === "seq") {',
  "  copyFileSync(process.env.DSH_GM_TODO_SRC, target);",
  '} else if (mode === "msg") {',
  "  try {",
  '    const q = JSON.parse(readFileSync(process.env.DSH_GM_MSG_QUEUE, "utf8"));',
  "    const i = q.cursor | 0;",
  "    q.cursor = i + 1;",
  '    writeFileSync(process.env.DSH_GM_MSG_QUEUE, JSON.stringify(q), "utf8");',
  "    const m = q.messages[i];",
  '    if (typeof m === "string" && m.length > 0) writeFileSync(target, m.replace(/\\r\\n/g, "\\n"), "utf8");',
  "  } catch (e) { /* 队列缺失/损坏：保留 git 默认消息 */ }",
  "}",
  "process.exit(0);",
].join("\n");

const REBASE_QUEUE_FILE = "dsh-gm-msg-queue.json";

// sh 双引号转义：\ 与 " $ ` 前加反斜杠（sh 双引号内 \\ → \，路径往返无损）
function shQuote(s) {
  return '"' + String(s).replace(/(["$`\\])/g, "\\$1") + '"';
}

// 构造 editor 值：解释器 + 脚本 + 模式（mode 为固定字面量 seq|msg）
export function buildEditorCommand(scriptPath, mode) {
  return shQuote(process.execPath) + " " + shQuote(scriptPath) + " " + mode;
}

function isRebasing(gitDirAbs) {
  return existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply"));
}

async function cleanupRebaseQueue(gitDirAbs) {
  try { await rm(join(gitDirAbs, REBASE_QUEUE_FILE), { force: true }); } catch (_) { /* noop */ }
}

// 队列落盘到 gitDir（跨进程存活）；messages 与 squash 步骤一一对应
async function armMessageQueue(gitDirAbs, messages) {
  const queuePath = join(gitDirAbs, REBASE_QUEUE_FILE);
  await writeFile(queuePath, JSON.stringify({ messages, cursor: 0 }), "utf8");
  return queuePath;
}

// mergeContinue 续跑时重新挂载队列：队列文件在则写一个新脚本并返回 env
async function rebaseMessageQueueEnv(gitDirAbs) {
  const queuePath = join(gitDirAbs, REBASE_QUEUE_FILE);
  if (!existsSync(queuePath)) return { env: {}, scriptPath: null };
  const scriptPath = join(tmpdir(), "dsh-gm-editor-" + process.pid + "-" + randomBytes(6).toString("hex") + ".mjs");
  await writeFile(scriptPath, REBASE_EDITOR_SCRIPT, "utf8");
  return {
    env: { GIT_EDITOR: buildEditorCommand(scriptPath, "msg"), DSH_GM_MSG_QUEUE: queuePath },
    scriptPath,
  };
}

// todo 条目校验（防 todo 注入：action 枚举 + 纯 hex sha + subject 去控制字符）
export const REBASE_ACTIONS = ["pick", "squash", "fixup", "drop", "edit"];

export function normalizeRebaseEntry(entry, label) {
  const at = label || "rebase";
  if (!entry || typeof entry !== "object") throw new GitError("exit", at + " 的 todo 条目非法");
  const action = typeof entry.action === "string" ? entry.action : "";
  if (!REBASE_ACTIONS.includes(action)) {
    throw new GitError("exit", at + " 非法 action：" + action);
  }
  const sha = typeof entry.sha === "string" ? entry.sha : "";
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new GitError("exit", at + " 非法 sha：" + sha);
  }
  // subject 只是 todo 的注释部分：去换行/控制字符并截断，防止注入额外 todo 行
  const subject = String(entry.subject == null ? "" : entry.subject)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .slice(0, 120);
  const out = { sha, subject, action };
  // message 仅 squash 生效（替换合并后的提交信息）；fixup 忽略（Lead 裁决 Q2）
  const message = typeof entry.message === "string" ? entry.message.replace(/\r\n/g, "\n") : "";
  if (action === "squash" && message.length > 0) out.message = message;
  return out;
}

// 纯函数：entries → todo 文本（每行 "action sha subject"，subject 为注释）
export function buildRebaseTodo(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new GitError("exit", "rebaseRun 需要 entries（base..HEAD 的 todo 列表）");
  }
  const lines = [];
  for (const e of entries) {
    const n = normalizeRebaseEntry(e, "rebaseRun");
    lines.push(n.action + " " + n.sha + (n.subject ? " " + n.subject : ""));
  }
  return lines.join("\n") + "\n";
}

// 解析器：parseRebasePlan（git log --reverse -z --format=%H%x1f%h%x1f%s 输出）
//   输出 rebaseTodo：{ sha, short, subject, action:"pick" }（应用顺序最旧在前）
export function parseRebasePlan(text) {
  const out = [];
  if (!text) return out;
  for (const rec of text.split("\0")) {
    if (rec.length === 0) continue;
    const parts = rec.split("\x1f");
    if (parts.length < 3) continue;
    const [sha, short, subject] = parts;
    out.push({ sha, short, subject, action: "pick" });
  }
  return out;
}

// 查询：rebasePlan —— base..HEAD（不含 base）的 todo 候选，最旧在前
export async function rebasePlan(cwd, base) {
  const b = checkRev(base, "rebasePlan");
  let raw;
  try {
    raw = await runGit(cwd, ["log", "--reverse", "-z", "--format=%H%x1f%h%x1f%s", b + "..HEAD"]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit" && /does not have any commits/.test(e.stderr || "")) {
      return { entries: [] };
    }
    throw e;
  }
  return { entries: parseRebasePlan(raw.stdout) };
}

// 变更：rebaseRun —— 写 todo + GIT_SEQUENCE_EDITOR 替换 + git rebase -i --autosquash
//   冲突/ edit 停驻都不抛错：返回 { done:false, status }，仓库进 rebase 态
export async function rebaseRun(cwd, base, entries) {
  const b = checkRev(base, "rebaseRun");
  // 先整体校验，任何一条非法都不落任何文件/不启动 rebase
  const norm = (Array.isArray(entries) && entries.length > 0)
    ? entries.map((e) => normalizeRebaseEntry(e, "rebaseRun"))
    : (() => { throw new GitError("exit", "rebaseRun 需要 entries（base..HEAD 的 todo 列表）"); })();
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "rebaseRun：仓库不可用");
  const gitDirAbs = resolve(cwd, probe.gitDir);

  const stamp = process.pid + "-" + randomBytes(6).toString("hex");
  const todoSrc = join(tmpdir(), "dsh-gm-todo-" + stamp + ".txt");
  const scriptPath = join(tmpdir(), "dsh-gm-editor-" + stamp + ".mjs");
  const env = {
    GIT_SEQUENCE_EDITOR: buildEditorCommand(scriptPath, "seq"),
    DSH_GM_TODO_SRC: todoSrc,
  };
  try {
    await writeFile(todoSrc, buildRebaseTodo(norm), "utf8");
    await writeFile(scriptPath, REBASE_EDITOR_SCRIPT, "utf8");
    const squashes = norm.filter((e) => e.action === "squash");
    if (squashes.length > 0) {
      // 队列 = squash 步骤的消息（含空串=保留默认），落 gitDir 供冲突后续挂载
      env.GIT_EDITOR = buildEditorCommand(scriptPath, "msg");
      env.DSH_GM_MSG_QUEUE = await armMessageQueue(gitDirAbs, squashes.map((e) => e.message || ""));
    }
    let err = null;
    try {
      await runGit(cwd, ["rebase", "-i", "--autosquash", b], { env });
    } catch (e) {
      if (e instanceof GitError && e.kind === "exit") err = e;
      else throw e;
    }
    const status = await getStatus(cwd);
    // done 判定按状态文件：edit 动作 exit 0 但停在 rebase 中（实测）
    const done = !isRebasing(gitDirAbs);
    if (done) {
      await cleanupRebaseQueue(gitDirAbs);
      if (err) throw err; // 失败且未进 rebase 态 = 非冲突错误（坏 base/脏工作区等）
    }
    return { done, status };
  } finally {
    await rm(todoSrc, { force: true });
    await rm(scriptPath, { force: true });
  }
}

// 变更：fixupCommit —— 用暂存改动修正任意历史提交（改写历史，UI 二次确认）
//   git commit --fixup/--squash=<sha> → git rebase -i --autosquash <sha>^
//   （root 提交退化 --root；GIT_SEQUENCE_EDITOR=true 保留 git 生成的 autosquash todo）
export async function fixupCommit(cwd, sha, mode, message) {
  const s = checkRev(sha, "fixupCommit");
  const m = mode == null || mode === "" ? "fixup" : mode;
  if (m !== "fixup" && m !== "squash") {
    throw new GitError("exit", "fixupCommit mode 只允许 fixup|squash，收到：" + mode);
  }
  const msg = typeof message === "string" ? message.replace(/\r\n/g, "\n") : "";
  // fixup+message 忽略（fixup 保留原提交信息，要改信息用 squash）——Lead 裁决 Q2
  await runGit(cwd, ["commit", m === "squash" ? "--squash=" + s : "--fixup=" + s]);

  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "fixupCommit：仓库不可用");
  const gitDirAbs = resolve(cwd, probe.gitDir);

  // base = <sha>^；root 提交没有 ^ → --root
  let base = null;
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", s + "^"]);
    base = s + "^";
  } catch (_) { base = null; }

  // squash+message = 替换合并后的提交信息（消息队列）；fixup 不建队列
  const queue = m === "squash" && msg.length > 0 ? [msg] : [];
  const stamp = process.pid + "-" + randomBytes(6).toString("hex");
  const scriptPath = queue.length > 0
    ? join(tmpdir(), "dsh-gm-editor-" + stamp + ".mjs")
    : null;
  const env = { GIT_SEQUENCE_EDITOR: "true" }; // 保留 git 生成的 autosquash todo
  try {
    if (scriptPath) {
      await writeFile(scriptPath, REBASE_EDITOR_SCRIPT, "utf8");
      env.GIT_EDITOR = buildEditorCommand(scriptPath, "msg");
      env.DSH_GM_MSG_QUEUE = await armMessageQueue(gitDirAbs, queue);
    }
    let err = null;
    try {
      await runGit(cwd, base
        ? ["rebase", "-i", "--autosquash", base]
        : ["rebase", "-i", "--autosquash", "--root"], { env });
    } catch (e) {
      if (e instanceof GitError && e.kind === "exit") err = e;
      else throw e;
    }
    const status = await getStatus(cwd);
    const done = !isRebasing(gitDirAbs);
    if (done) {
      await cleanupRebaseQueue(gitDirAbs);
      if (err) throw err;
    }
    return { done, status };
  } finally {
    if (scriptPath) await rm(scriptPath, { force: true });
  }
}

// 变更：rebaseBranch —— 当前分支 rebase 到 branch 之上（git rebase <branch>）
//   冲突不抛错：{ done:false, status } + rebase 态，走 mergeContinue/abortMerge 分派
export async function rebaseBranch(cwd, branch) {
  const b = checkRev(branch, "rebaseBranch");
  const probe = await probeRepo(cwd);
  if (!probe.isRepo) throw new GitError("not-a-repo", "rebaseBranch：仓库不可用");
  const gitDirAbs = resolve(cwd, probe.gitDir);
  let err = null;
  try {
    await runGit(cwd, ["rebase", b]);
  } catch (e) {
    if (e instanceof GitError && e.kind === "exit") err = e;
    else throw e;
  }
  const status = await getStatus(cwd);
  const done = !isRebasing(gitDirAbs);
  if (done && err) throw err;
  return { done, status };
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
  // v2 §2.2：refSpec 扩展（push tag 用，如 refs/tags/v1.0）。
  // 白名单校验（禁 "-" 开头/空白/元字符），传 git push 的 refspec 位置参数。
  if (typeof opts.refSpec === "string" && opts.refSpec.length > 0) {
    checkRev(opts.refSpec, "push");
    args.push(opts.refSpec);
  } else if (opts.branch) {
    args.push(opts.branch);
  }
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

// ============================================================================
// P2（v2 §2.3）：remote 增删改 / config 读写
// ============================================================================

export async function addRemote(cwd, name, url, pushUrl) {
  checkRemoteName(name, "remoteAdd");
  if (typeof url !== "string" || url.length === 0 || url.startsWith("-")) {
    throw new GitError("exit", "remoteAdd 需要合法 url");
  }
  if (pushUrl != null && pushUrl !== "" && (typeof pushUrl !== "string" || pushUrl.startsWith("-"))) {
    throw new GitError("exit", "remoteAdd pushUrl 非法");
  }
  await runGit(cwd, ["remote", "add", name, url]);
  if (typeof pushUrl === "string" && pushUrl.length > 0) {
    await runGit(cwd, ["remote", "set-url", "--push", name, pushUrl]);
  }
  return { remotes: await getRemotes(cwd) };
}

export async function removeRemote(cwd, name) {
  checkRemoteName(name, "remoteRemove");
  await runGit(cwd, ["remote", "remove", name]);
  return { remotes: await getRemotes(cwd) };
}

export async function renameRemote(cwd, oldName, newName) {
  checkRemoteName(oldName, "remoteRename");
  checkRemoteName(newName, "remoteRename");
  await runGit(cwd, ["remote", "rename", oldName, newName]);
  return { remotes: await getRemotes(cwd) };
}

// 解析器：parseConfigList
//   输入：git config -z --list（每条 "key\nvalue"，记录以 \0 分隔；
//   value 可含换行 → 按第一个 \n 切 key/value）
//   输出 configEntry：{ key, value }
export function parseConfigList(text) {
  const out = [];
  if (!text) return out;
  for (const rec of text.split("\0")) {
    if (rec.length === 0) continue;
    const idx = rec.indexOf("\n");
    if (idx < 0) continue;
    out.push({ key: rec.slice(0, idx), value: rec.slice(idx + 1) });
  }
  return out;
}

// config key 校验：section.subsection.key 形态，禁 "-" 开头与空白
function checkConfigKey(key, label) {
  if (typeof key !== "string" || key.length === 0) {
    throw new GitError("exit", (label || "config") + " 需要 key");
  }
  if (key.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw new GitError("exit", (label || "config") + " 非法 key：" + key);
  }
  return key;
}

function configScopeArgs(global) {
  return [global ? "--global" : "--local"];
}

export async function getConfig(cwd, global) {
  const args = ["config", "-z", "--list"].concat(configScopeArgs(!!global));
  const r = await runGit(cwd, args);
  return { entries: parseConfigList(r.stdout) };
}

export async function setConfig(cwd, key, value, global) {
  checkConfigKey(key, "configSet");
  if (typeof value !== "string") throw new GitError("exit", "configSet 需要 value");
  await runGit(cwd, ["config"].concat(configScopeArgs(!!global)).concat([key, value]));
  return getConfig(cwd, global);
}

export async function unsetConfig(cwd, key, global) {
  checkConfigKey(key, "configUnset");
  await runGit(cwd, ["config"].concat(configScopeArgs(!!global)).concat(["--unset-all", key]));
  return getConfig(cwd, global);
}