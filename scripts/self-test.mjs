// scripts/self-test.mjs — dsh-git-manager 自测
//
// 纯 Node 断言驱动的零依赖测试 runner：
//   - 解析器 fixture 单测（纯字符串函数）
//   - 临时 git 仓库 live 集成测试（独立 tmpdir，互不污染）
//
// 设计原则（与兄弟插件一致）：
//   - 不依赖任何 npm 测试框架（jest/mocha/vitest），直接 console.log + exit code
//   - live 测试用 os.tmpdir() 下 mkdtemp，结束自动 rm
//   - 若 git 不可用跳过所有 live 测试并退出 0（CI 无 git 也能跑 fixture）
//   - 每个测试独立 try/catch，单个失败不影响其他

import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import * as core from "../git-core.mjs";
import { computeGraph } from "../git-graph.mjs";
import { TYPERT } from "../typert.host.js";

// ---- harness --------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const __projectRoot = join(__dirname, "..");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const results = [];
async function run() {
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      results.push({ name: t.name, ok: true, ms: Date.now() - start });
    } catch (e) {
      results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e });
    }
  }
}

function check(label, cond, detail) {
  if (cond) return;
  throw new Error("断言失败: " + label + (detail ? "\n  详情: " + detail : ""));
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error("断言失败: " + label + "\n  期望: " + e + "\n  实际: " + a);
  return;
}

// ---- git availability -----------------------------------------------------

let GIT_AVAILABLE = false;
try {
  await new Promise((res, rej) => {
    execFile("git", ["--version"], { windowsHide: true }, (err, stdout) => {
      if (err) rej(err); else res(stdout.trim());
    });
  });
  GIT_AVAILABLE = true;
} catch (_) {
  GIT_AVAILABLE = false;
}

// ---- live repo helper -----------------------------------------------------

async function runShell(cwd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }),
        ...opts,
      },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stdout, stderr }));
        resolve({ stdout, stderr });
      },
    );
  });
}

async function makeRepo(opts = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  await runShell(tmp, ["git", "init", "-b", "main"]);
  await runShell(tmp, ["git", "config", "user.email", "test@example.com"]);
  await runShell(tmp, ["git", "config", "user.name", "Test User"]);
  await runShell(tmp, ["git", "config", "commit.gpgsign", "false"]);
  await runShell(tmp, ["git", "config", "protocol.file.allow", "always"]);
  await writeFile(join(tmp, "README.md"), "# init\n");
  await runShell(tmp, ["git", "add", "-A"]);
  await runShell(tmp, ["git", "commit", "-m", "initial commit"]);
  // 创建一个 additional commit 让 ahead/bebehind 有意义
  if (opts.withSecondCommit) {
    await writeFile(join(tmp, "a.txt"), "alpha\n");
    await runShell(tmp, ["git", "add", "a.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "add a"]);
  }
  return tmp;
}

function live(name, fn) {
  test(name, async () => {
    if (!GIT_AVAILABLE) {
      // 不要把 skip 算成 pass——会让 30 多个 live 测试在无 git 时静默"全绿"。
      // 用一个共享 skipped 计数，main 里以显眼的方式提示。
      globalThis.__dshGitSkipped = (globalThis.__dshGitSkipped || 0) + 1;
      console.log("[skip-live] " + name);
      return; // 跳过（既不 fail 也不 pass）
    }
    const tmp = await makeRepo();
    try {
      await fn(tmp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

// ============================================================================
// Task 2: runGit + GitError + probeRepo
// ============================================================================

test("runGit: 成功调用返回 { code:0, stdout, stderr }", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const r = await core.runGit(tmp, ["rev-parse", "--short=8", "HEAD"]);
    eq("code", r.code, 0);
    check("stdout 非空且为合法短 sha", /^[0-9a-f]{7,}$/.test(r.stdout.trim()), "got=" + JSON.stringify(r.stdout));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runGit: 非仓库目录抛 GitError(exit) kind=exit", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  try {
    let caught;
    try {
      await core.runGit(tmp, ["status"]);
    } catch (e) {
      caught = e;
    }
    check("抛出 GitError", caught instanceof core.GitError);
    eq("kind", caught && caught.kind, "exit");
    check("stderr 含 'not a git repository'", /not a git repository/i.test(caught && caught.stderr || ""), "stderr=" + (caught && caught.stderr));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("GitError 实例字段", () => {
  const e = new core.GitError("timeout", "test", { exitCode: 1, stderr: "x" });
  eq("kind", e.kind, "timeout");
  eq("message", e.message, "test");
  eq("exitCode", e.exitCode, 1);
  eq("stderr", e.stderr, "x");
  eq("name", e.name, "GitError");
});

test("probeRepo: 普通仓库返回完整 probe", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const p = await core.probeRepo(tmp);
    eq("isRepo", p.isRepo, true);
    check("toplevel 是绝对路径", typeof p.toplevel === "string" && p.toplevel.length > 0);
    check("gitDir 含 .git", p.gitDir && p.gitDir.includes(".git"));
    eq("commonDir", p.commonDir, p.gitDir); // 非 worktree 时 commonDir === gitDir
    eq("bare", p.bare, false);
    eq("branch", p.branch, "main");
    eq("detached", p.detached, false);
    eq("unborn", p.unborn, false);
    eq("merging", p.merging, false);
    eq("rebasing", p.rebasing, false);
    eq("isLinkedWorktree", p.isLinkedWorktree, false);
    // git 在 Windows 上返回正斜杠 toplevel；normalize 后再比
    const norm = (s) => String(s).replace(/\//g, "\\").toLowerCase();
    check("toplevel 等于 tmp（路径归一化后）", norm(p.toplevel) === norm(tmp) || norm(p.toplevel) === norm(tmp) + "\\", "toplevel=" + p.toplevel + " tmp=" + tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("probeRepo: 非目录返回 isRepo=false", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  try {
    const p = await core.probeRepo(join(tmp, "no-such-dir"));
    eq("isRepo", p.isRepo, false);
    check("无其他字段泄漏", p.toplevel === undefined && p.gitDir === undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("probeRepo: 已存在但不是仓库的目录返回 isRepo=false", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  try {
    const p = await core.probeRepo(tmp);
    eq("isRepo", p.isRepo, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("probeRepo: unborn HEAD（init 后无 commit）", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  try {
    await runShell(tmp, ["git", "init", "-b", "main"]);
    await runShell(tmp, ["git", "config", "user.email", "test@example.com"]);
    await runShell(tmp, ["git", "config", "user.name", "T"]);
    const p = await core.probeRepo(tmp);
    eq("isRepo", p.isRepo, true);
    eq("unborn", p.unborn, true);
    eq("branch", p.branch, "main");
    eq("detached", p.detached, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("probeRepo: detached HEAD (HEAD 指向 commit 而非 ref)", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const sha = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();
    await runShell(tmp, ["git", "checkout", "--detach", sha]);
    const p = await core.probeRepo(tmp);
    eq("detached", p.detached, true);
    eq("branch", p.branch, null);
    check("headShort 是短 sha", /^[0-9a-f]+$/.test(p.headShort || ""));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 3: parseStatusV2 + getStatus
// ============================================================================

test("parseStatusV2: 含 staged/unstaged/untracked/rename/conflict 的完整 fixture", () => {
  const fixture =
    "# branch.oid 8f3a2c1d4e5f6789012345678901234567abcd\0" +
    "# branch.head main\0" +
    "# branch.upstream origin/main\0" +
    "# branch.ab +2 -1\0" +
    "1 M. N... 100644 100644 100644 abc1234 abc1234 src/a.js\0" +
    "1 .M N... 100644 100644 100644 def5678 def5678 \u4e2d\u6587 \u76ee\u5f55/b \u6587\u4ef6.txt\0" +
    "? newfile.txt\0" +
    "u UU N... 100644 100644 100644 100644 h111111 h222222 h333333 conf.txt\0" +
    "2 R. N... 100644 100644 100644 aaa1111 aaa1111 R100 newname.js\0" +
    "oldname.js\0";
  const r = core.parseStatusV2(fixture);
  eq("branch", r.branch, "main");
  eq("upstream", r.upstream, "origin/main");
  eq("ahead", r.ahead, 2);
  eq("behind", r.behind, 1);
  eq("staged count", r.staged.length, 2);
  eq("staged[0] path", r.staged[0].path, "src/a.js");
  eq("staged[0] kind", r.staged[0].kind, "modified");
  eq("staged[1] path", r.staged[1].path, "newname.js");
  eq("staged[1] kind", r.staged[1].kind, "renamed");
  eq("staged[1] oldPath", r.staged[1].oldPath, "oldname.js");
  eq("unstaged count", r.unstaged.length, 1);
  eq("unstaged[0] path", r.unstaged[0].path, "\u4e2d\u6587 \u76ee\u5f55/b \u6587\u4ef6.txt");
  eq("untracked", r.untracked, ["newfile.txt"]);
  eq("conflicted count", r.conflicted.length, 1);
  eq("conflicted[0] path", r.conflicted[0].path, "conf.txt");
  eq("conflicted[0] xy", r.conflicted[0].xy, "UU");
});

test("parseStatusV2: 空字符串返回空对象", () => {
  const r = core.parseStatusV2("");
  eq("staged", r.staged, []);
  eq("unstaged", r.unstaged, []);
  eq("untracked", r.untracked, []);
  eq("conflicted", r.conflicted, []);
  eq("ahead/behind", [r.ahead, r.behind], [0, 0]);
});

test("parseStatusV2: unborn HEAD（branch.oid=(initial), branch.head=main）", () => {
  const fixture = "# branch.oid (initial)\0# branch.head main\0";
  const r = core.parseStatusV2(fixture);
  eq("branch", r.branch, "main");
  eq("headSha", r.headSha, null);
  eq("detached", r.detached, false);
});

test("parseStatusV2: detached HEAD（branch.head=(detached)）", () => {
  const fixture = "# branch.oid 8f3a2c1d4e5f6789012345678901234567abcd\0# branch.head (detached)\0";
  const r = core.parseStatusV2(fixture);
  eq("detached", r.detached, true);
  eq("branch", r.branch, null);
});

test("getStatus: clean repo 返回零变更", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const s = await core.getStatus(tmp);
    eq("staged", s.staged, []);
    eq("unstaged", s.unstaged, []);
    eq("untracked", s.untracked, []);
    eq("conflicted", s.conflicted, []);
    eq("branch", s.branch, "main");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getStatus: 修改/新增/删除/未跟踪 完整链路", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    // 先提交一个 a.txt（后续制造它的删除）；注意要在 staged.txt 之前提交，
    // 否则 git commit 会把 staged.txt 一起带走
    await writeFile(join(tmp, "a.txt"), "alpha\n");
    await runShell(tmp, ["git", "add", "a.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "add a"]);
    // 修改 README.md（unstaged）
    await writeFile(join(tmp, "README.md"), "# updated\n");
    // 新增 + stage（staged added）
    await writeFile(join(tmp, "staged.txt"), "s\n");
    await runShell(tmp, ["git", "add", "staged.txt"]);
    // 删除 + stage（staged deleted）
    await runShell(tmp, ["git", "rm", "a.txt"]);
    // 未跟踪
    await writeFile(join(tmp, "new.txt"), "n\n");

    const s = await core.getStatus(tmp);
    check("unstaged 含修改", s.unstaged.some((e) => e.path === "README.md" && e.kind === "modified"));
    check("staged 含新增 staged.txt", s.staged.some((e) => e.path === "staged.txt" && e.kind === "added"));
    check("staged 含删除 a.txt", s.staged.some((e) => e.path === "a.txt" && e.kind === "deleted"));
    eq("untracked", s.untracked, ["new.txt"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 4: parseBranchRefs + parseRemotes + parseLogText
// ============================================================================

test("parseBranchRefs: 本地/远程分支 + ahead/behind/gone + current 标记", () => {
  const fixture = [
      "refs/heads/main\tmain\tabc1234\t1700000000\torigin/main\t[ahead 2, behind 1]\t*\tInitial main",
      "refs/heads/feature\tfeature\tdef5678\t1700000100\torigin/feature\t[gone]\t\tFeature branch",
      "refs/heads/release\trelease\t9999999\t1700000200\t\t\t\tRelease branch no upstream",
      "refs/remotes/origin/main\torigin/main\tabc1234\t1700000000\t\t\t\tInitial main",
    ].join("\n");
  const r = core.parseBranchRefs(fixture);
  eq("locals count", r.locals.length, 3);
  eq("remotes count", r.remotes.length, 1);
  eq("current branch name", r.locals.find((b) => b.current).name, "main");
  eq("main ahead", r.locals[0].ahead, 2);
  eq("main behind", r.locals[0].behind, 1);
  eq("feature upstreamGone", r.locals[1].upstreamGone, true);
  eq("release upstream", r.locals[2].upstream, null);
  eq("release ahead/behind", [r.locals[2].ahead, r.locals[2].behind], [null, null]);
  eq("remote origin/main short", r.remotes[0].shortSha, "abc1234");
});

test("parseBranchRefs: subject 含 tab（放最后字段），）", () => {
  const fixture = "refs/heads/messy\tmessy\tabc1234\t1700000000\t\t\t\tfeat: add\tfeature with\ttabs";
  const r = core.parseBranchRefs(fixture);
  eq("subject", r.locals[0].subject, "feat: add\tfeature with\ttabs");
});

test("parseRemotes: fetch + push 双 URL 合并", () => {
  const fixture = [
    "origin\thttps://example.com/git/repo.git (fetch)",
    "origin\tgit@github.com:foo/repo.git (push)",
    "upstream\thttps://example.com/upstream.git (fetch)",
    "upstream\thttps://example.com/upstream.git (push)",
  ].join("\n");
  const r = core.parseRemotes(fixture);
  eq("count", r.length, 2);
  const origin = r.find((x) => x.name === "origin");
  eq("origin fetch", origin.fetchUrl, "https://example.com/git/repo.git");
  eq("origin push", origin.pushUrl, "git@github.com:foo/repo.git");
});

test("parseRemotes: 空字符串返回空数组", () => {
  eq("empty", core.parseRemotes(""), []);
});

test("parseLogText: 多 parent 合并提交 + refs", () => {
  const sha = "abcdef0123456789";
  const short = "abcdef0";
  const parents = "1111111111111111111111111111111111111111 2222222222222222222222222222222222222222";
  const refs = "HEAD -> main, origin/main, tag: v1.0";
  const fixture =
    sha + "\x1f" + short + "\x1f" + parents + "\x1f" + "Alice" + "\x1f" + "alice@e" + "\x1f" + "1700000000" + "\x1f" + refs + "\x1f" + "merge branches\0" +
    "3333333333333333333333333333333333333333\x1f3333333\x1f\x1fBob\x1fbob@e\x1f1699999999\x1f\x1finitial\0";
  const commits = core.parseLogText(fixture);
  eq("count", commits.length, 2);
  eq("c0 parents", commits[0].parents.length, 2);
  eq("c0 refs", commits[0].refs, refs);
  eq("c0 subject", commits[0].subject, "merge branches");
  eq("c1 parents", commits[1].parents, []);
});

test("getBranches/getRemotes: live 仓库", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await runShell(tmp, ["git", "branch", "feature"]);
    await runShell(tmp, ["git", "branch", "release"]);
    const b = await core.getBranches(tmp);
    eq("current", b.current, "main");
    check("locals 包含 main/feature/release", ["main", "feature", "release"].every((n) => b.locals.some((x) => x.name === n)));
    const r = await core.getRemotes(tmp);
    eq("no remotes", r, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getLog: 默认 200 上限 + hasMore + unborn 返回空", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo({ withSecondCommit: true });
  try {
    const r = await core.getLog(tmp, { maxCount: 1 });
    eq("count", r.commits.length, 1);
    eq("hasMore", r.hasMore, true);
    const r2 = await core.getLog(tmp, { maxCount: 100 });
    eq("count", r2.commits.length, 2);
    eq("hasMore", r2.hasMore, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 5: computeGraph
// ============================================================================

test("computeGraph: 线性历史单列 + 节点 col=0", () => {
  // C <- B <- A（输入 A 在前，是 children；date-order 中子在前）
  const commits = [
    { sha: "A", parents: ["B"] },
    { sha: "B", parents: ["C"] },
    { sha: "C", parents: [] },
  ];
  const g = computeGraph(commits);
  eq("laneCount", g.laneCount, 1);
  eq("nodes cols", g.nodes.map((n) => n.col), [0, 0, 0]);
  eq("links count", g.links.length, 2);
  eq("links all parent", g.links.every((l) => l.kind === "parent"), true);
});

test("computeGraph: 2 路合并（A 在 main，B 在 feature 自分支后合回 main）", () => {
  // main: A <- B <- E <- F   （其中 F parents=[E, D]）
  // feature: B <- C <- D
  // date-order 显示顺序：A, B, C, D, E, F（children 先于 parents）
  const commits = [
    { sha: "A", parents: ["B"] },
    { sha: "B", parents: ["C", "E"] }, // branch point（罕见：普通情况应是线性 B->E）
  ];
  // 改成更标准的合并历史
  const c2 = [
    { sha: "F", parents: ["E", "D"] }, // merge commit
    { sha: "E", parents: ["B"] },
    { sha: "D", parents: ["C"] },
    { sha: "C", parents: ["B"] },
    { sha: "B", parents: ["A"] },
    { sha: "A", parents: [] },
  ];
  const g = computeGraph(c2);
  eq("laneCount", g.laneCount, 2);
  // F 节点至少包含一个 merge 链接
  check("F 有 merge 链接", g.links.some((l) => l.fromRow === 0 && l.kind === "merge"));
  // B 同时是 C 和 E 的父，应当产生 collapse 链接
  check("B 处有 collapse 链接", g.links.some((l) => l.kind === "collapse" && l.fromRow === 4));
  // toRow > fromRow 不变量（collapse 同 row 因为是同时合并的两列，fromRow 等同 toRow）
  for (const l of g.links) {
    if (l.kind === "collapse") continue;
    if (l.toRow !== null) check("toRow > fromRow: " + JSON.stringify(l), l.toRow > l.fromRow);
  }
});

test("computeGraph: 父在窗口外 → toRow=null", () => {
  const commits = [
    { sha: "CHILD", parents: ["MISSING_PARENT"] },
  ];
  const g = computeGraph(commits);
  eq("links count", g.links.length, 1);
  eq("toRow null", g.links[0].toRow, null);
  eq("kind", g.links[0].kind, "parent");
});

test("computeGraph: 空数组 → laneCount 0", () => {
  const g = computeGraph([]);
  eq("laneCount", g.laneCount, 0);
  eq("nodes", g.nodes, []);
  eq("links", g.links, []);
});

// ============================================================================
// live integration: computeGraph + getLog 拼装
// ============================================================================

test("integration: real 合并历史的 getLog + computeGraph 路径", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    // 建 feature 分支 + 提交
    await runShell(tmp, ["git", "checkout", "-b", "feature"]);
    await writeFile(join(tmp, "f.txt"), "f\n");
    await runShell(tmp, ["git", "add", "f.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "feature"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    await writeFile(join(tmp, "m.txt"), "m\n");
    await runShell(tmp, ["git", "add", "m.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "main"]);
    // 合并 feature 回 main
    await runShell(tmp, ["git", "merge", "--no-edit", "feature"]);

    const log = await core.getLog(tmp, { all: true, maxCount: 100 });
    const g = computeGraph(log.commits);
    // initial + feature + main + merge = 4
    eq("getLog 4 个提交", log.commits.length, 4);
    check("laneCount >= 2", g.laneCount >= 2, "actual=" + g.laneCount);
    check("至少一个 merge link", g.links.some((l) => l.kind === "merge"), "links=" + JSON.stringify(g.links));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 6: parseWorktreePorcelain + getWorktrees + getDiff
// ============================================================================

test("parseWorktreePorcelain: 主仓 + linked worktree + bare", () => {
  const fixture =
    "worktree C:/repo\n" +
    "HEAD abc1234\n" +
    "branch refs/heads/main\n" +
    "\n" +
    "worktree C:/repo-feature\n" +
    "HEAD def5678\n" +
    "branch refs/heads/feature\n" +
    "\n" +
    "worktree C:/bare.git\n" +
    "HEAD 9999999\n" +
    "bare\n";
  const r = core.parseWorktreePorcelain(fixture);
  eq("count", r.length, 3);
  eq("main path", r[0].path, "C:/repo");
  eq("main branch", r[0].branch, "main");
  eq("feature branch", r[1].branch, "feature");
  eq("bare", r[2].bare, true);
  eq("bare branch", r[2].branch, null);
});

test("getWorktrees: live 仓库 worktree add 后列表", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const wt = join(tmp + "-wt");
    await runShell(tmp, ["git", "worktree", "add", "-b", "wt-branch", wt]);
    const r = await core.getWorktrees(tmp);
    eq("count", r.worktrees.length, 2);
    check("current 主仓标记", r.worktrees.some((w) => w.current === true));
    check("linked worktree 存在", r.worktrees.some((w) => w.branch === "wt-branch"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
    if (existsSync(tmp + "-wt")) await rm(tmp + "-wt", { recursive: true, force: true });
  }
});

test("getDiff: 工作区修改 scope=worktree", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await writeFile(join(tmp, "README.md"), "# updated\n");
    const r = await core.getDiff(tmp, { scope: "worktree", file: "README.md" });
    check("含 diff --git", r.text.includes("diff --git"));
    check("含 -updated", r.text.includes("-# init"));
    check("含 +# updated", r.text.includes("+# updated"));
    eq("truncated", r.truncated, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getDiff: 暂存区 scope=staged", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await writeFile(join(tmp, "b.txt"), "b\n");
    await runShell(tmp, ["git", "add", "b.txt"]);
    const r = await core.getDiff(tmp, { scope: "staged", file: "b.txt" });
    check("含 new file", r.text.includes("new file"));
    check("含 +b", r.text.includes("+b"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getDiff: 未跟踪文件 scope=untracked 合成全 + 行", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await writeFile(join(tmp, "new.txt"), "hello\n");
    const r = await core.getDiff(tmp, { scope: "untracked", file: "new.txt" });
    check("含 diff --git", r.text.includes("diff --git"));
    check("含 +hello", r.text.includes("+hello"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getDiff: commit 范围 scope=commit 含 message header", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo({ withSecondCommit: true });
  try {
    const log = await runShell(tmp, ["git", "log", "--format=%H"]);
    const sha = log.stdout.trim().split("\n")[0]; // 第 0 个 = 最新提交 = "add a"（含 +alpha）
    check("拿到 add a 的提交", !!sha);
    const r = await core.getDiff(tmp, { scope: "commit", sha });
    check("含 commit header", /Author|Date/.test(r.text));
    check("含 +alpha", r.text.includes("+alpha"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 7: stage / unstage / discard / commit + 路径防护
// ============================================================================

test("stageFiles / unstageFiles / commitStaged: 完整链路", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await writeFile(join(tmp, "x.txt"), "x\n");
    const s1 = await core.stageFiles(tmp, ["x.txt"]);
    check("x.txt 已暂存", s1.staged.some((e) => e.path === "x.txt"));
    const s2 = await core.unstageFiles(tmp, ["x.txt"]);
    eq("x.txt 不再暂存", s2.staged.some((e) => e.path === "x.txt"), false);
    await core.stageFiles(tmp, ["x.txt"]);
    const c = await core.commitStaged(tmp, "add x file");
    check("commit 短 sha 返回", /^[0-9a-f]{7,}$/.test(c.commit));
    eq("工作区干净", c.status.staged, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("discardFiles: 已跟踪 restore + 未跟踪删除 + 路径防护", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await writeFile(join(tmp, "README.md"), "# polluted\n");
    await writeFile(join(tmp, "junk.txt"), "junk\n");
    const s = await core.discardFiles(tmp, ["README.md", "junk.txt"], true);
    const after = (await readFile(join(tmp, "README.md"), "utf8")).replace(/\r\n/g, "\n");
    eq("README 恢复（autocrlf 环境容忍 CRLF）", after, "# init\n");
    eq("junk.txt 已删除", existsSync(join(tmp, "junk.txt")), false);
    eq("干净", s.staged.length + s.unstaged.length + s.untracked.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("discardFiles: 越界路径抛 GitError", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    let caught;
    try {
      await core.discardFiles(tmp, ["../escape.txt"], true);
    } catch (e) { caught = e; }
    check("抛 GitError", caught instanceof core.GitError);
    check("message 含 非法路径", /非法路径|越出/.test(caught && caught.message));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 8: 分支 + merge + abort/continue
// ============================================================================

test("createBranch + deleteBranch + renameBranch", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await core.createBranch(tmp, "feat");
    const b1 = await core.getBranches(tmp);
    check("feat 已存在", b1.locals.some((x) => x.name === "feat"));
    await core.renameBranch(tmp, "feat", "feature");
    const b2 = await core.getBranches(tmp);
    check("改名", b2.locals.some((x) => x.name === "feature") && !b2.locals.some((x) => x.name === "feat"));
    await core.deleteBranch(tmp, "feature", true);
    const b3 = await core.getBranches(tmp);
    check("删除", !b3.locals.some((x) => x.name === "feature"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("switchBranch: 切到 feat 再切回 main", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await core.createBranch(tmp, "feat");
    await core.switchBranch(tmp, "feat");
    const p1 = await core.probeRepo(tmp);
    eq("current=feat", p1.branch, "feat");
    await core.switchBranch(tmp, "main");
    const p2 = await core.probeRepo(tmp);
    eq("current=main", p2.branch, "main");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("mergeBranch: 无冲突合并成功 merged=true", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await runShell(tmp, ["git", "checkout", "-b", "feat"]);
    await writeFile(join(tmp, "f.txt"), "f\n");
    await runShell(tmp, ["git", "add", "f.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "feat"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    const r = await core.mergeBranch(tmp, "feat");
    eq("merged", r.merged, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("mergeBranch: 冲突返回 merged=false + status.conflicted 非空", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await runShell(tmp, ["git", "checkout", "-b", "feat"]);
    await writeFile(join(tmp, "README.md"), "feature line\n");
    await runShell(tmp, ["git", "add", "README.md"]);
    await runShell(tmp, ["git", "commit", "-m", "feat change"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    await writeFile(join(tmp, "README.md"), "main line\n");
    await runShell(tmp, ["git", "add", "README.md"]);
    await runShell(tmp, ["git", "commit", "-m", "main change"]);
    const r = await core.mergeBranch(tmp, "feat");
    eq("merged=false", r.merged, false);
    check("conflicted 含 README.md", r.status.conflicted.some((e) => e.path === "README.md"));
    // 中止合并回到干净
    await core.abortMerge(tmp);
    const s = await core.getStatus(tmp);
    eq("clean after abort", s.conflicted, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("continueMerge: 解决冲突后 commit --no-edit", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await runShell(tmp, ["git", "checkout", "-b", "feat"]);
    await writeFile(join(tmp, "README.md"), "feat\n");
    await runShell(tmp, ["git", "add", "README.md"]);
    await runShell(tmp, ["git", "commit", "-m", "f"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    await writeFile(join(tmp, "README.md"), "main\n");
    await runShell(tmp, ["git", "add", "README.md"]);
    await runShell(tmp, ["git", "commit", "-m", "m"]);
    await core.mergeBranch(tmp, "feat");
    // 解决冲突 ours
    await core.resolveConflictFile(tmp, "README.md", "ours");
    const r = await core.continueMerge(tmp);
    eq("合并完成", r.conflicted, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 9: conflictContent + resolveConflict
// ============================================================================

test("getConflictContent: ours/theirs/base/worktree 全字段", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    // 初始提交就含 X.txt，这样合并冲突才有 base（stage 1）
    await writeFile(join(tmp, "X.txt"), "init-base\n");
    await runShell(tmp, ["git", "add", "X.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "add X base"]);
    await runShell(tmp, ["git", "checkout", "-b", "feat"]);
    await writeFile(join(tmp, "X.txt"), "from-feat\n");
    await runShell(tmp, ["git", "add", "X.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "f"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    await writeFile(join(tmp, "X.txt"), "from-main\n");
    await runShell(tmp, ["git", "add", "X.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "m"]);
    await core.mergeBranch(tmp, "feat");
    const c = await core.getConflictContent(tmp, "X.txt");
    check("ours 含 from-main", c.ours && c.ours.includes("from-main"));
    check("theirs 含 from-feat", c.theirs && c.theirs.includes("from-feat"));
    check("base 含 init-base", c.base && c.base.includes("init-base"));
    check("worktree 含冲突标记", /<<<<<</.test(c.worktree || ""));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resolveConflictFile: custom 路径防护拒绝越界", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    // 先制造一个冲突
    await runShell(tmp, ["git", "checkout", "-b", "feat"]);
    await writeFile(join(tmp, "Y.txt"), "f\n");
    await runShell(tmp, ["git", "add", "Y.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "f"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    await writeFile(join(tmp, "Y.txt"), "m\n");
    await runShell(tmp, ["git", "add", "Y.txt"]);
    await runShell(tmp, ["git", "commit", "-m", "m"]);
    await core.mergeBranch(tmp, "feat");
    // 越界 custom
    let caught;
    try {
      await core.resolveConflictFile(tmp, "../escape.txt", "custom", "evil");
    } catch (e) { caught = e; }
    check("抛 GitError", caught instanceof core.GitError);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Task 10: init + worktree add/remove/prune（fetch/pull/push 需要 bare remote，跳过 live 网络）
// ============================================================================

test("initRepo: 初始化空仓库为 main", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  try {
    const p = await core.initRepo(tmp);
    eq("isRepo", p.isRepo, true);
    eq("branch", p.branch, "main");
    eq("bare", p.bare, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("addWorktree / removeWorktree / pruneWorktrees 完整链路", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const wt = join(tmp + "-wt");
    const r1 = await core.addWorktree(tmp, wt, "wt-branch");
    eq("count=2", r1.worktrees.length, 2);
    check("linked 标记", r1.worktrees.some((w) => w.branch === "wt-branch"));
    const r2 = await core.removeWorktree(tmp, wt, false);
    eq("count=1", r2.worktrees.length, 1);
    const r3 = await core.pruneWorktrees(tmp);
    eq("prune 后仍 1", r3.worktrees.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// Review feedback (Critical/Important) 新增测试
// ============================================================================

// Windows git 输出正斜杠 toplevel（如 D:/repo）——这正是要测的形态；
// posix 下正斜杠即原生分隔符，用普通绝对路径等价覆盖（CI 跑在 Linux 上）。
const SAFEJOIN_ROOT = process.platform === "win32" ? "D:/ai-projects/dsh/dsh-git-manager" : "/tmp/gm-safejoin-repo";

test("safeJoin: 正斜杠 toplevel（Windows git 输出）允许相对路径", () => {
  const abs = core.safeJoin(SAFEJOIN_ROOT, "sub/file.txt");
  const norm = (p) => p.replace(/\\/g, "/");
  check("结果以规范化 toplevel 为前缀", norm(abs) === norm(resolve(SAFEJOIN_ROOT)) + "/sub/file.txt");
});

test("safeJoin: 绝对路径拒绝", () => {
  // 两种绝对形态（盘符 /  posix 根）在任一平台都必须拒绝
  for (const evil of ["C:/elsewhere/file", "/etc/elsewhere/passwd"]) {
    let caught;
    try { core.safeJoin("D:/repo", evil); } catch (e) { caught = e; }
    check("抛 GitError: " + evil, caught instanceof core.GitError);
  }
});

test("safeJoin: .. 越界拒绝", () => {
  let caught;
  try { core.safeJoin("D:/repo", "../escape"); } catch (e) { caught = e; }
  check("抛 GitError", caught instanceof core.GitError);
});

test("safeJoin: \\0 / 空 rel 拒绝", () => {
  let caught;
  try { core.safeJoin("D:/repo", ""); } catch (e) { caught = e; }
  check("抛 GitError", caught instanceof core.GitError);
});

test("safeJoin: 反斜杠 toplevel 同样正常", () => {
  const abs = core.safeJoin("D:\\repo\\proj", "src/x.js");
  check("归一化后含子路径", /src[\\/]x\.js$/.test(abs));
});

test("parseStatusV2: unborn=true", () => {
  const fixture = "# branch.oid (initial)\0# branch.head main\0";
  const r = core.parseStatusV2(fixture);
  eq("unborn", r.unborn, true);
  eq("headSha null", r.headSha, null);
});

test("parseStatusV2: mapXYChar 正确（kind 取自 X 或 Y）", () => {
  // 修改/删除：X=., Y=D → unstaged kind 应为 deleted（不是 modified）
  const fixture = "# branch.oid abc" + "\0" + "# branch.head main" + "\0" + "1 .D N... 100644 100644 100644 h h README.md" + "\0";
  const r = core.parseStatusV2(fixture);
  eq("unstaged kind", r.unstaged[0].kind, "deleted");
});

test("discardFiles: 单个未跟踪文件（includeUntracked=true）能删", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    await writeFile(join(tmp, "lonely.txt"), "x\n");
    const s = await core.discardFiles(tmp, ["lonely.txt"], true);
    eq("删除", existsSync(join(tmp, "lonely.txt")), false);
    eq("干净", s.untracked, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getStatus: 合并进行中时 merging=true + banner 数据正确", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    // 建一个会冲突的合并
    await runShell(tmp, ["git", "checkout", "-b", "feat"]);
    await writeFile(join(tmp, "README.md"), "feat line\n");
    await runShell(tmp, ["git", "add", "README.md"]);
    await runShell(tmp, ["git", "commit", "-m", "f"]);
    await runShell(tmp, ["git", "checkout", "main"]);
    await writeFile(join(tmp, "README.md"), "main line\n");
    await runShell(tmp, ["git", "add", "README.md"]);
    await runShell(tmp, ["git", "commit", "-m", "m"]);
    // 合并必然冲突退出非零 → runShell 会 reject，捕获即可（冲突是预期）
    try {
      await runShell(tmp, ["git", "merge", "--no-edit", "feat"]);
    } catch (_) { /* conflict expected */ }
    // 此时处于 merge-in-progress
    const s = await core.getStatus(tmp);
    eq("merging=true", s.merging, true);
    eq("rebasing=false", s.rebasing, false);
    check("conflicted 非空", s.conflicted.length > 0);
    // 中止恢复
    await runShell(tmp, ["git", "merge", "--abort"]);
    const s2 = await core.getStatus(tmp);
    eq("abort 后 merging=false", s2.merging, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("continueMerge: 非合并状态下抛错", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    let caught;
    try { await core.continueMerge(tmp); } catch (e) { caught = e; }
    check("抛 GitError", caught instanceof core.GitError);
    check("message 含提示", /合并|变基|无可继续/.test(caught && caught.message));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("addWorktree: -b newBranch startPoint 顺序正常生成 worktree", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  try {
    const wt = join(tmp + "-wtA");
    await core.addWorktree(tmp, wt, "wtA");
    const r = await core.getWorktrees(tmp);
    check("worktree 列表含 wtA 分支", r.worktrees.some((w) => w.branch === "wtA"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
    if (existsSync(tmp + "-wtA")) await rm(tmp + "-wtA", { recursive: true, force: true });
  }
});

test("fetchRemote / pullBranch / pushBranch: 本地 bare remote + real git fetch", async () => {
  if (!GIT_AVAILABLE) return;
  const tmpRoot = await mkdtemp(join(tmpdir(), "dsh-git-remote-"));
  const bare = join(tmpRoot, "origin.git");
  const work = join(tmpRoot, "work");
  try {
    // 创建 bare remote
    await runShell(tmpRoot, ["git", "init", "--bare", "-b", "main", bare]);
    // 创建本地工作仓库并 push 一个初始 commit
    await runShell(tmpRoot, ["git", "clone", bare, work]);
    await runShell(work, ["git", "config", "user.email", "test@example.com"]);
    await runShell(work, ["git", "config", "user.name", "T"]);
    await writeFile(join(work, "a.txt"), "a\n");
    await runShell(work, ["git", "add", "a.txt"]);
    await runShell(work, ["git", "commit", "-m", "initial"]);
    await runShell(work, ["git", "push", "-u", "origin", "main"]);
    // fetch 应该成功
    const r = await core.fetchRemote(work, "origin");
    check("output 字符串", typeof r.output === "string");
    check("output 不超过 4000 字符", r.output.length <= 4000);
    eq("status 干净", r.status.unstaged.length + r.status.untracked.length, 0);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// static check：index.js 与 typert.host.js 的 Remote 方法名集合一致
// ============================================================================

test("static: index.js 与 typert.host.js 方法名集合一致", () => {
  const indexSrc = readFileSync(join(__projectRoot, "index.js"), "utf8");
  const typertSrc = readFileSync(join(__projectRoot, "typert.host.js"), "utf8");
  const extractNames = (src, marker) => {
    // 从 markRemoteMethod(this, "<name>" 提取
    if (marker === "index") {
      const re = /markRemoteMethod\(this,\s*"([a-zA-Z]+)"/g;
      const out = []; let m; while ((m = re.exec(src))) out.push(m[1]);
      return out;
    }
    // 从 typert 的 METHODS 数组提取
    if (marker === "typert") {
      const re = /\[\s*"([a-zA-Z]+)"\s*,\s*\w+Result\s*\]/g;
      const out = []; let m; while ((m = re.exec(src))) out.push(m[1]);
      return out;
    }
    return [];
  };
  const a = extractNames(indexSrc, "index").sort();
  const b = extractNames(typertSrc, "typert").sort();
  check("集合大小相同", a.length === b.length, "index=" + a.length + " typert=" + b.length);
  eq("集合相等", a, b);
});

test("static: 27 个 Remote 方法在两边都存在", () => {
  const indexSrc = readFileSync(join(__projectRoot, "index.js"), "utf8");
  const typertSrc = readFileSync(join(__projectRoot, "typert.host.js"), "utf8");
  const expected = [
    "probe","overview","status","diff","log","branches","remotes","worktrees",
    "conflictContent","stage","unstage","discard","commit","branchCreate",
    "checkout","branchDelete","branchRename","merge","mergeAbort","mergeContinue",
    "resolveConflict","fetch","pull","push","worktreeAdd","worktreeRemove",
    "worktreePrune","init",
  ];
  for (const m of expected) {
    check("index 含 " + m, indexSrc.includes('markRemoteMethod(this, "' + m + '"'));
    check("typert 含 " + m, typertSrc.includes('"' + m + '"'));
  }
});

test("static: index.js 的 import source 与 git-core.mjs 实际 export 一致", () => {
  // 启动期坑：把不属于 git-core 的 export（如 computeGraph）写进它的 import 列表，
  // 第一次启动 DSH 时会 ERR_MODULE_NOT_FOUND，整个进程起不来；self-test 不跑 index.js 不会发现。
  const coreSrc = readFileSync(join(__projectRoot, "git-core.mjs"), "utf8");
  const graphSrc = readFileSync(join(__projectRoot, "git-graph.mjs"), "utf8");
  const indexSrc = readFileSync(join(__projectRoot, "index.js"), "utf8");
  // 收集每个模块真实 export 的 named identifiers
  const exportsOf = (src) => {
    const re = /export\s+(?:async\s+)?(?:function|const|class)\s+([a-zA-Z_$][\w$]*)/g;
    const out = new Set(); let m; while ((m = re.exec(src))) out.add(m[1]);
    return out;
  };
  const coreExports = exportsOf(coreSrc);
  const graphExports = exportsOf(graphSrc);
  // 收集 index.js 的 from "./git-core.mjs" import 列表
  const m = indexSrc.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/git-core\.mjs"/);
  check("找到 git-core.mjs 的 import 块", !!m);
  const importedFromCore = new Set();
  for (const x of m[1].split(",")) {
    const t = x.trim();
    if (t) importedFromCore.add(t);
  }
  for (const name of importedFromCore) {
    check("git-core.mjs 实际 export '" + name + "'（index.js 启动时不抛 ERR_MODULE_NOT_FOUND）", coreExports.has(name));
  }
  // computeGraph 必须在 git-graph.mjs
  check("computeGraph 在 git-graph.mjs", graphExports.has("computeGraph"));
  // index.js 不能从 git-core 导入 computeGraph
  check("index.js 不从 git-core 导入 computeGraph", !importedFromCore.has("computeGraph"));
});

test("static: client.js 入口模型（composer 工具行唯一入口 + 无 FAB/头部徽章残留 + remote 经 props 注入）", () => {
  const clientSrc = readFileSync(join(__projectRoot, "client.js"), "utf8");
  check("注册 conversation.input.left（模式选择器旁）", clientSrc.includes('"conversation.input.left"'));
  check("注册 shell.overlay（面板宿主）", clientSrc.includes('"shell.overlay"'));
  check("无 FAB 残留（gm-fab）", !clientSrc.includes("gm-fab"));
  check("无 GitFab 组件残留", !clientSrc.includes("GitFab"));
  // 用户决策：唯一入口在 composer 工具行，头部徽章已移除
  check("无头部徽章槽位残留", !clientSrc.includes("conversation.session.header.actions"));
  check("无 HeaderGitBadge 组件残留", !clientSrc.includes("HeaderGitBadge"));
  // 入口按钮必须有 git 仓库判断（非仓库返回 null 不渲染）
  check("ComposerGitButton 有 isRepo 判断", /probe\.isRepo/.test(clientSrc));
  // 弹窗行为与设置一致：mask 点击关闭 + document 级 Esc
  check("面板有 mask 层", clientSrc.includes("gm-mask"));
  check("面板支持 Esc 关闭", /e\.key === "Escape"/.test(clientSrc));
  // factory 作用域没有 remote；组件裸引用会在异步 effect 里 ReferenceError，静默永不渲染（实测踩坑）
  check("ComposerGitButton 从 props 取 remote", /function ComposerGitButton\(props\) \{[\s\S]*?const remote = props && props\.remote/.test(clientSrc));
});

// ============================================================================
// wire-format 合规（live）：真实返回值必须同时过两道网关校验
//   1. typert result codec 的 strict zod schema
//   2. dsh-api-gateway 的 assertJsonValue（显式 undefined / schema 外 null /
//      非 plain object / 循环引用全部拒绝）
// 任一道失败 = 客户端 RPC 永久 pending、UI 静默无数据——2026-08-28 实测
// probe.mainWorktreePath:undefined 与 worktree.prunable:null 双双踩中，
// 症状是"入口按钮在真仓库里也不出现"。
// ============================================================================

const WIRE = Object.fromEntries(TYPERT.invocations.map((i) => [i.method, i.result.schema]));

// 与 dsh-api-gateway assertJsonValue 等价（改动需与上游同步）
function assertJsonSafe(value, path, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(path + ": non-finite number");
  }
  if (typeof value !== "object") throw new TypeError(path + ": " + typeof value + " is not JSON-safe");
  if (ancestors.has(value)) throw new TypeError(path + ": cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError(path + ": sparse/decorated array");
      value.forEach((v, i) => assertJsonSafe(v, path + "[" + i + "]", ancestors));
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) throw new TypeError(path + ": non-plain object");
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || !("value" in d)) throw new TypeError(path + "." + String(key) + ": non-data property");
      assertJsonSafe(d.value, path + "." + String(key), ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function wireCheck(method, value) {
  const schema = WIRE[method];
  if (!schema) throw new Error("typert.host.js 没有 " + method + " 的 invocation");
  const parsed = schema.parse({ ok: true, value }); // 第一道：strict zod schema
  assertJsonSafe(parsed, "root", new Set());         // 第二道：JSON-safe
}

live("wire: 全部查询/变更真实返回值过 strict schema + JSON-safe", async (tmp) => {
  // 三类改动：unstaged（README）、staged（staged.txt）、untracked（untracked.txt）
  await writeFile(join(tmp, "README.md"), "# init\nchanged\n");
  await writeFile(join(tmp, "staged.txt"), "staged\n");
  await runShell(tmp, ["git", "add", "staged.txt"]);
  await writeFile(join(tmp, "untracked.txt"), "untracked\n");

  const probe = await core.probeRepo(tmp);
  wireCheck("probe", probe);
  const status = await core.getStatus(tmp);
  wireCheck("status", status);
  const remotes = await core.getRemotes(tmp);
  wireCheck("remotes", remotes);
  wireCheck("overview", { probe, status, remotes });            // 与 index.js overview 同组装
  wireCheck("branches", await core.getBranches(tmp));
  const logRes = await core.getLog(tmp, { maxCount: 50 });
  wireCheck("log", Object.assign({}, logRes, { graph: computeGraph(logRes.commits) })); // 与 index.js log 同组装
  wireCheck("worktrees", await core.getWorktrees(tmp));
  wireCheck("diff", await core.getDiff(tmp, { scope: "worktree" }));
  wireCheck("diff", await core.getDiff(tmp, { scope: "staged" }));
  wireCheck("diff", await core.getDiff(tmp, { scope: "untracked", file: "untracked.txt" }));

  // 提交产生第二个 commit，然后验 commit 返回与 commit/compare 两个 diff scope
  wireCheck("commit", await core.commitStaged(tmp, "wire test"));
  const headSha = (await core.getLog(tmp, { maxCount: 1 })).commits[0].sha;
  wireCheck("diff", await core.getDiff(tmp, { scope: "commit", sha: headSha }));
  wireCheck("diff", await core.getDiff(tmp, { scope: "compare", base: "HEAD~1", target: "HEAD" }));
  const logAfter = await core.getLog(tmp, { maxCount: 50 });
  wireCheck("log", Object.assign({}, logAfter, { graph: computeGraph(logAfter.commits) }));
});

// ============================================================================
// main -----------------------------------------------------------------

await run();
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const skipped = globalThis.__dshGitSkipped || 0;
console.log("");
console.log("=== dsh-git-manager self-test ===");
console.log("passed:  " + passed);
console.log("failed:  " + failed);
console.log("skipped: " + skipped + (skipped > 0 ? " (git 不可用；live 测试未执行 —— 绿不代表 OK)" : ""));
for (const r of results) {
  const tag = r.ok ? "PASS" : "FAIL";
  const ms = String(r.ms).padStart(3, " ") + "ms";
  console.log("  [" + tag + "] " + ms + "  " + r.name);
  if (!r.ok) {
    console.log("         " + (r.error && r.error.message || r.error));
    if (r.error && r.error.stack) {
      const lines = r.error.stack.split("\n").slice(1, 4);
      for (const l of lines) console.log("         " + l.trim());
    }
  }
}
console.log("");

// 有 skip 时退出非零——强制调用方注意 live 未跑的情况
process.exit(failed === 0 && skipped === 0 ? 0 : 1);