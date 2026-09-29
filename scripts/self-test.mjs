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
  eq("c0 body 无正文挂空串", commits[0].body, "");
  eq("c1 parents", commits[1].parents, []);
});

test("parseLogText: body 多行正文（amend 预填用，尾随换行剥掉）", () => {
  const fixture =
    "abc\x1fabc\x1f\x1fAlice\x1fa@e\x1f1700000000\x1f\x1fsubject line\x1fbody para1\nbody para2\n\0" +
    "def\x1fdef\x1f\x1fBob\x1fb@e\x1f1699999999\x1f\x1fsingle\x1f\0";
  const commits = core.parseLogText(fixture);
  eq("count", commits.length, 2);
  eq("多行 body 保留内部换行", commits[0].body, "body para1\nbody para2");
  eq("无 body 挂空串", commits[1].body, "");
  eq("subject 照常", commits[0].subject, "subject line");
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
// extractHunkPatch：从完整 diff 中提取单文件单 hunk 的最小补丁（纯函数 fixture）
// ============================================================================

test("extractHunkPatch: 多文件多 hunk 中精确提取指定块", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "index 1111111..2222222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " a1",
    "-a2",
    "+a2x",
    " a3",
    "diff --git a/b.txt b/b.txt",
    "index 3333333..4444444 100644",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1,2 +1,2 @@",
    " b1",
    "-b2",
    "+b2x",
    "@@ -10,2 +10,2 @@",
    " b10",
    "-b11",
    "+b11x",
    "",
  ].join("\n");
  const p0 = core.extractHunkPatch(diff, "b.txt", 0);
  check("含完整文件头", p0.includes("diff --git a/b.txt b/b.txt") && p0.includes("index 3333333") && p0.includes("--- a/b.txt") && p0.includes("+++ b/b.txt"));
  check("只含第一个 hunk", p0.includes("@@ -1,2 +1,2 @@") && !p0.includes("@@ -10,2 +10,2 @@"));
  check("不串到别的文件", !p0.includes("a2x"));
  const p1 = core.extractHunkPatch(diff, "b.txt", 1);
  check("第二个 hunk", p1.includes("@@ -10,2 +10,2 @@") && !p1.includes("b2x"));
  check("补丁以换行结尾", p1.endsWith("\n"));
  let threw = false;
  try { core.extractHunkPatch(diff, "nope.txt", 0); } catch (_) { threw = true; }
  check("未知文件抛错", threw);
  threw = false;
  try { core.extractHunkPatch(diff, "b.txt", 5); } catch (_) { threw = true; }
  check("hunkIndex 越界抛错", threw);
});

live("applyHunk: worktree 撤销指定块 / staged 取消暂存指定块", async (tmp) => {
  // 造两个相距足够远的 hunk（行 2 与行 18，context 3 不会合并）
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push("line" + i);
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");
  await runShell(tmp, ["git", "add", "multi.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "multi"]);
  lines[1] = "line2-changed";
  lines[17] = "line18-changed";
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");

  // worktree：撤销第 0 块（line2），line18 改动必须保留
  let st = await core.applyHunk(tmp, { scope: "worktree", file: "multi.txt", hunkIndex: 0 });
  // 归一化行尾：autocrlf=true 的机器上 git apply 会按 smudge 过滤器写出 CRLF，
  // 内容语义不变，断言必须对行尾不敏感。
  const after = (await readFile(join(tmp, "multi.txt"), "utf8")).replace(/\r\n/g, "\n").split("\n");
  check("第 0 块已撤销（line2 还原）", after[1] === "line2");
  check("第 1 块保留（line18 还是改动后）", after[17] === "line18-changed");
  check("文件仍在 unstaged（还剩一块）", st.unstaged.some((e) => e.path === "multi.txt"));

  // staged：先把 line2 改回去让暂存 diff 含两个块（此时 index 里只有 line18），
  // 再整体 stage 后把第 0 块移出暂存区（改动回到 unstaged，内容不丢）
  lines[1] = "line2-changed";
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");
  await runShell(tmp, ["git", "add", "multi.txt"]);
  st = await core.applyHunk(tmp, { scope: "staged", file: "multi.txt", hunkIndex: 0 });
  check("取消暂存后该块出现在 unstaged", st.unstaged.some((e) => e.path === "multi.txt"));
  check("另一块仍在 staged", st.staged.some((e) => e.path === "multi.txt"));
  const after2 = (await readFile(join(tmp, "multi.txt"), "utf8")).replace(/\r\n/g, "\n").split("\n");
  check("worktree 内容未被动（line18 仍改动）", after2[17] === "line18-changed");
  check("worktree 内容未被动（line2 仍改动）", after2[1] === "line2-changed");
});

live("cherryPick: 干净拣选 + 冲突后 abort / continue 全链路", async (tmp) => {
  // main 上已有 initial commit。造 side 分支提交一个独立文件，回 main 拣选。
  await runShell(tmp, ["git", "switch", "-c", "side"]);
  await writeFile(join(tmp, "side.txt"), "from side\n");
  await runShell(tmp, ["git", "add", "side.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "side commit"]);
  const sideSha = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();
  await runShell(tmp, ["git", "switch", "main"]);
  await writeFile(join(tmp, "main.txt"), "from main\n");
  await runShell(tmp, ["git", "add", "main.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "main commit"]);

  // 1) 干净 cherry-pick
  const r1 = await core.cherryPickCommit(tmp, sideSha);
  check("干净拣选 picked=true", r1.picked === true);
  check("side.txt 落到 main", existsSync(join(tmp, "side.txt")));
  const log1 = await core.getLog(tmp, { maxCount: 10 });
  check("历史出现 side commit 副本", log1.commits.some((c) => c.subject === "side commit"));

  // 2) 冲突拣选：c.txt 在两条分支各改同一行 → picked=false + CHERRY_PICK_HEAD 在场
  await writeFile(join(tmp, "c.txt"), "base\n");
  await runShell(tmp, ["git", "add", "c.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add c"]);
  await runShell(tmp, ["git", "switch", "-c", "conflict-side"]);
  await writeFile(join(tmp, "c.txt"), "side\n");
  await runShell(tmp, ["git", "commit", "-am", "side edits c"]);
  const confSha = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();
  await runShell(tmp, ["git", "switch", "main"]);
  await writeFile(join(tmp, "c.txt"), "main\n");
  await runShell(tmp, ["git", "commit", "-am", "main edits c"]);

  const r2 = await core.cherryPickCommit(tmp, confSha);
  check("冲突拣选 picked=false", r2.picked === false);
  check("c.txt 在冲突清单", r2.status.conflicted.some((e) => e.path === "c.txt"));
  const gitDirAbs = resolve(tmp, ".git");
  check("CHERRY_PICK_HEAD 在场", existsSync(join(gitDirAbs, "CHERRY_PICK_HEAD")));

  // 2a) abort：回到拣选前（c.txt 恢复 main 版本，状态文件清除）
  await core.abortMerge(tmp);
  check("abort 后 CHERRY_PICK_HEAD 清除", !existsSync(join(gitDirAbs, "CHERRY_PICK_HEAD")));
  const afterAbort = (await readFile(join(tmp, "c.txt"), "utf8")).replace(/\r\n/g, "\n");
  check("abort 后 c.txt 恢复 main 版本", afterAbort === "main\n");

  // 2b) 再次拣选 → 手动解决 → continueMerge 完成 pick（守门必须认 CHERRY_PICK_HEAD）
  const r3 = await core.cherryPickCommit(tmp, confSha);
  check("再次拣选仍冲突", r3.picked === false);
  await writeFile(join(tmp, "c.txt"), "resolved\n");
  await runShell(tmp, ["git", "add", "c.txt"]);
  const r4 = await core.continueMerge(tmp);
  check("continue 后冲突清空", r4.conflicted.length === 0);
  check("continue 后 CHERRY_PICK_HEAD 清除", !existsSync(join(gitDirAbs, "CHERRY_PICK_HEAD")));
  const log2 = await core.getLog(tmp, { maxCount: 10 });
  check("pick 以原始提交信息落账", log2.commits[0].subject === "side edits c");
  const finalC = (await readFile(join(tmp, "c.txt"), "utf8")).replace(/\r\n/g, "\n");
  check("解决内容保留", finalC === "resolved\n");
});

// ============================================================================
// v2（§2.2/§2.3）解析器 fixture：parseStashList / parseTagList / parseBlame /
// parseReflog / parseConfigList + 入参白名单校验
// ============================================================================

test("parseStashList: 多条 + 字段映射", () => {
  const fixture =
    "stash@{0}\x1fOn main: stash msg one\x1f1700000000\x00" +
    "stash@{1}\x1fWIP on feature: abc1234 add x\x1f1699999999\x00";
  const r = core.parseStashList(fixture);
  eq("count", r.length, 2);
  eq("index0", r[0].index, 0);
  eq("ref0", r[0].ref, "stash@{0}");
  eq("subject0", r[0].subject, "On main: stash msg one");
  eq("at0", r[0].at, 1700000000);
  eq("index1", r[1].index, 1);
  eq("subject1", r[1].subject, "WIP on feature: abc1234 add x");
  eq("empty", core.parseStashList(""), []);
});

test("parseTagList: lightweight + annotated（%00 分组、contents 可多行）", () => {
  // 与 git for-each-ref --format=<TAG_FMT> 实测形态一致：字段 \0 分隔、
  // 条目以换行收尾（换行前缀落在下一条 name chunk 上）
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const fixture =
    "light\x00" + shaA + "\x00commit\x00\x001700000000\x00first commit\x00first commit\n\x00\n" +
    "v1.0\x00" + shaB + "\x00tag\x00" + shaA + "\x001700000100\x00annotated msg second line\x00annotated msg\nsecond line\n\x00\n";
  const r = core.parseTagList(fixture);
  eq("count", r.length, 2);
  eq("light name", r[0].name, "light");
  eq("light sha（commit）", r[0].sha, shaA);
  eq("light short", r[0].short, "aaaaaaa");
  eq("light annotated", r[0].annotated, false);
  check("light 无 message key", !("message" in r[0]));
  eq("light subject", r[0].subject, "first commit");
  eq("v1.0 name", r[1].name, "v1.0");
  eq("v1.0 sha（解引用到 commit）", r[1].sha, shaA);
  eq("v1.0 annotated", r[1].annotated, true);
  eq("v1.0 message 多行保留", r[1].message, "annotated msg\nsecond line");
  eq("v1.0 at", r[1].at, 1700000100);
  eq("empty", core.parseTagList(""), []);
});

test("parseBlame: 组头 + 组内续行 + boundary（元数据沿用组）", () => {
  const sha1 = "c".repeat(40);
  const sha2 = "d".repeat(40);
  const fixture = [
    sha1 + " 1 1 2",
    "author Alice",
    "author-mail <a@e>",
    "author-time 1700000000",
    "summary second commit",
    "filename f.txt",
    "\tl1x",
    sha1 + " 2 2",
    "\tl2",
    sha2 + " 3 3 1",
    "author Bob",
    "author-time 1699999999",
    "summary first commit",
    "boundary",
    "filename f.txt",
    "\tl3",
  ].join("\n") + "\n";
  const r = core.parseBlame(fixture);
  eq("count", r.length, 3);
  eq("line0 sha", r[0].sha, sha1);
  eq("line0 short", r[0].short, "ccccccc");
  eq("line0 author", r[0].author, "Alice");
  eq("line0 at", r[0].at, 1700000000);
  eq("line0 line#", r[0].line, 1);
  eq("line0 text", r[0].text, "l1x");
  eq("续行沿用组元数据", r[1].author, "Alice");
  eq("续行 line#", r[1].line, 2);
  eq("line2 author", r[2].author, "Bob");
  eq("line2 text", r[2].text, "l3");
  eq("empty", core.parseBlame(""), []);
});

test("parseReflog: 字段映射", () => {
  const fixture =
    "abcdef0123456789abcdef0123456789abcdef01\x1fabcdef0\x1fHEAD@{0}\x1freset: moving to HEAD\x1f1700000000\x00" +
    "1111111111111111111111111111111111111111\x1f1111111\x1fHEAD@{1}\x1fcommit: init\x1f1699999999\x00";
  const r = core.parseReflog(fixture);
  eq("count", r.length, 2);
  eq("selector", r[0].selector, "HEAD@{0}");
  eq("message", r[0].message, "reset: moving to HEAD");
  eq("short", r[0].short, "abcdef0");
  eq("at", r[0].at, 1700000000);
  eq("empty", core.parseReflog(""), []);
});

test("parseConfigList: key\\nvalue + NUL 分隔 + value 含换行", () => {
  const fixture = "user.name\nT\x00user.email\nt@e.com\x00core.multi\nline1\nline2\x00";
  const r = core.parseConfigList(fixture);
  eq("count", r.length, 3);
  eq("key0", r[0], { key: "user.name", value: "T" });
  eq("value 含换行取第一个 \\n 后全部", r[2], { key: "core.multi", value: "line1\nline2" });
  eq("empty", core.parseConfigList(""), []);
});

test("白名单校验：checkRev / checkResetTarget / checkRefName / checkStashIndex", () => {
  // checkRev：合法形态放行，"-" 开头 / 空白 / 元字符拒绝
  eq("HEAD~1", core.checkRev("HEAD~1", "t"), "HEAD~1");
  eq("sha", core.checkRev("abc123f", "t"), "abc123f");
  eq("branch", core.checkRev("feature/x", "t"), "feature/x");
  for (const evil of ["-x", "--upload-pack=evil", "a b", "a;b", "a|b", ""]) {
    let caught;
    try { core.checkRev(evil, "t"); } catch (e) { caught = e; }
    check("checkRev 拒绝 " + JSON.stringify(evil), caught instanceof core.GitError);
  }
  // checkResetTarget：sha / HEAD / HEAD~n / @{...} 白名单
  eq("target 缺省 HEAD", core.checkResetTarget(null), "HEAD");
  eq("target HEAD", core.checkResetTarget("HEAD"), "HEAD");
  eq("target HEAD~3", core.checkResetTarget("HEAD~3"), "HEAD~3");
  eq("target @{0}", core.checkResetTarget("@{0}"), "@{0}");
  eq("target @{upstream}", core.checkResetTarget("@{upstream}"), "@{upstream}");
  for (const evil of ["--soft", "HEAD@{yesterday}", "main", "HEAD~x", "a b", "HEAD;x"]) {
    let caught;
    try { core.checkResetTarget(evil); } catch (e) { caught = e; }
    check("checkResetTarget 拒绝 " + JSON.stringify(evil), caught instanceof core.GitError);
  }
  // checkRefName
  eq("v1.0", core.checkRefName("v1.0", "t"), "v1.0");
  for (const evil of ["-f", "a..b", "a b", "a//b", "x@{1}", "a.lock", "end."]) {
    let caught;
    try { core.checkRefName(evil, "t"); } catch (e) { caught = e; }
    check("checkRefName 拒绝 " + JSON.stringify(evil), caught instanceof core.GitError);
  }
  // checkStashIndex
  eq("缺省 0", core.checkStashIndex(null), 0);
  eq("数字", core.checkStashIndex(3), 3);
  for (const evil of [-1, 1.5, "x", 10000]) {
    let caught;
    try { core.checkStashIndex(evil); } catch (e) { caught = e; }
    check("checkStashIndex 拒绝 " + JSON.stringify(evil), caught instanceof core.GitError);
  }
});

// ============================================================================
// v2 live：stageHunk / stash 全家 / tag 全家 / reset / revert / blame /
// diffRange / reflog / log 过滤 / push refSpec / remote / config
// ============================================================================

live("stageHunkFile: 只暂存指定块（status + staged diff 校验）", async (tmp) => {
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push("line" + i);
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");
  await runShell(tmp, ["git", "add", "multi.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "multi"]);
  lines[1] = "line2-changed";
  lines[17] = "line18-changed";
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");

  const st = await core.stageHunkFile(tmp, { file: "multi.txt", hunkIndex: 0 });
  check("multi.txt 进入 staged", st.staged.some((e) => e.path === "multi.txt"));
  check("multi.txt 仍在 unstaged（第 1 块未暂存）", st.unstaged.some((e) => e.path === "multi.txt"));
  const sd = await core.getDiff(tmp, { scope: "staged", file: "multi.txt" });
  check("staged diff 含 line2-changed", sd.text.includes("line2-changed"));
  check("staged diff 不含 line18-changed", !sd.text.includes("line18-changed"));
  const content = (await readFile(join(tmp, "multi.txt"), "utf8")).replace(/\r\n/g, "\n");
  check("工作区文件内容未被改动", content.includes("line2-changed") && content.includes("line18-changed"));
  wireCheck("stageHunk", { status: st });

  let caught;
  try { await core.stageHunkFile(tmp, { file: "../escape.txt", hunkIndex: 0 }); } catch (e) { caught = e; }
  check("越界 file 抛 GitError", caught instanceof core.GitError);
});

live("stash 全家: push/list/apply/pop/drop/clear", async (tmp) => {
  await writeFile(join(tmp, "README.md"), "# init\nchanged\n");
  await writeFile(join(tmp, "s1.txt"), "one\n");

  const pushed = await core.stashPush(tmp, "my stash", true);
  eq("push 后 1 条", pushed.stashes.length, 1);
  check("subject 含 message", pushed.stashes[0].subject.includes("my stash"));
  eq("stashEntry index", pushed.stashes[0].index, 0);
  check("stashEntry at 是时间戳", pushed.stashes[0].at > 0);
  wireCheck("stashPush", pushed);
  const stAfterPush = await core.getStatus(tmp);
  eq("push 后工作区干净", stAfterPush.staged.length + stAfterPush.unstaged.length + stAfterPush.untracked.length, 0);

  const list = await core.getStashes(tmp);
  eq("stashList 1 条", list.stashes.length, 1);
  wireCheck("stashList", list);

  const applied = await core.stashApply(tmp, 0);
  check("apply 恢复修改", applied.unstaged.some((e) => e.path === "README.md"));
  check("apply 恢复未跟踪", applied.untracked.includes("s1.txt"));
  eq("apply 不消耗 stash 条目", (await core.getStashes(tmp)).stashes.length, 1);
  wireCheck("stashApply", { status: applied });

  await core.discardFiles(tmp, ["README.md", "s1.txt"], true);
  const popped = await core.stashPop(tmp, 0);
  check("pop 恢复修改", popped.unstaged.some((e) => e.path === "README.md"));
  eq("pop 消耗 stash 条目", (await core.getStashes(tmp)).stashes.length, 0);
  wireCheck("stashPop", { status: popped });

  await core.discardFiles(tmp, ["README.md", "s1.txt"], true);
  // 两次 stash 之间必须真的制造改动——干净树上 stash push 不会建条目
  await writeFile(join(tmp, "s2.txt"), "two\n");
  await core.stashPush(tmp, "a", true);
  await writeFile(join(tmp, "s3.txt"), "three\n");
  await core.stashPush(tmp, "b", true);
  eq("两条 stash", (await core.getStashes(tmp)).stashes.length, 2);
  const dropped = await core.stashDrop(tmp, 0);
  eq("drop 后剩 1 条", dropped.stashes.length, 1);
  wireCheck("stashDrop", dropped);
  const cleared = await core.stashClear(tmp);
  eq("clear 后 0 条", cleared.stashes.length, 0);
  wireCheck("stashClear", cleared);
});

live("stashPop 冲突不抛错 + abortMerge 兜底中止（干净文件改动保留、stash 条目保留）", async (tmp) => {
  // c.txt 会冲突；d.txt 干净套用 —— 验证 Lead 裁决的兜底语义
  await writeFile(join(tmp, "c.txt"), "base\n");
  await writeFile(join(tmp, "d.txt"), "dbase\n");
  await runShell(tmp, ["git", "add", "-A"]);
  await runShell(tmp, ["git", "commit", "-m", "add c d"]);
  await writeFile(join(tmp, "c.txt"), "stashed version\n");
  await writeFile(join(tmp, "d.txt"), "dstashed\n");
  await core.stashPush(tmp, "conflict stash", false);
  await writeFile(join(tmp, "c.txt"), "main version\n");
  await runShell(tmp, ["git", "commit", "-am", "main edits c"]);

  const popRes = await core.stashPop(tmp, 0);
  eq("pop 冲突不抛错", popRes.conflicted.some((e) => e.path === "c.txt"), true);
  wireCheck("stashPop", { status: popRes });
  eq("冲突 pop 后 stash 条目保留", (await core.getStashes(tmp)).stashes.length, 1);

  // abortMerge 兜底：冲突文件 restore 回 HEAD，干净套用的 d.txt 保留，stash 条目保留
  const ab = await core.abortMerge(tmp);
  eq("abort 后无冲突", ab.conflicted, []);
  const cAfter = (await readFile(join(tmp, "c.txt"), "utf8")).replace(/\r\n/g, "\n");
  eq("c.txt 恢复 HEAD 版本", cAfter, "main version\n");
  const dAfter = (await readFile(join(tmp, "d.txt"), "utf8")).replace(/\r\n/g, "\n");
  eq("d.txt 干净套用的改动保留", dAfter, "dstashed\n");
  eq("abort 后 stash 条目仍在", (await core.getStashes(tmp)).stashes.length, 1);
});

live("abortMerge: 无 unmerged 且无操作 HEAD 时照旧抛错（守门）", async (tmp) => {
  let caught;
  try { await core.abortMerge(tmp); } catch (e) { caught = e; }
  check("抛 GitError", caught instanceof core.GitError);
  check("message 说明无可中止操作", /可中止/.test(caught && caught.message));
});

live("tagCreate/tagDelete: annotated + force + lightweight + 指定 sha", async (tmp) => {
  await writeFile(join(tmp, "x.txt"), "x\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add x"]);
  const sha1 = (await runShell(tmp, ["git", "rev-parse", "HEAD~1"])).stdout.trim();

  let tg = await core.createTag(tmp, "v1.0", null, "annotated message\nline2", false);
  const t = tg.tags.find((x) => x.name === "v1.0");
  eq("annotated=true", t.annotated, true);
  eq("message 多行保留", t.message, "annotated message\nline2");
  check("sha 是 commit", /^[0-9a-f]{40}$/.test(t.sha));
  eq("short 7 位", t.short, t.sha.slice(0, 7));
  wireCheck("tagCreate", tg);

  tg = await core.createTag(tmp, "v1.0", null, "forced update", true);
  eq("force 覆盖 message", tg.tags.find((x) => x.name === "v1.0").message, "forced update");

  tg = await core.createTag(tmp, "light", sha1, null, false);
  const t2 = tg.tags.find((x) => x.name === "light");
  eq("lightweight annotated=false", t2.annotated, false);
  check("lightweight 无 message key", !("message" in t2));
  eq("指定 sha 生效", t2.sha, sha1);

  const listed = await core.getTags(tmp);
  eq("tags 2 条", listed.tags.length, 2);
  wireCheck("tags", listed);

  tg = await core.deleteTag(tmp, "light");
  eq("删除后 1 条", tg.tags.length, 1);
  eq("剩 v1.0", tg.tags[0].name, "v1.0");
  wireCheck("tagDelete", tg);

  let caught;
  try { await core.createTag(tmp, "-f", null, null, false); } catch (e) { caught = e; }
  check("非法 tag 名拒绝", caught instanceof core.GitError);
});

live("resetRepo: soft/mixed/hard 三模式 + 白名单拒绝", async (tmp) => {
  await writeFile(join(tmp, "x.txt"), "x\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add x"]);
  const sha1 = (await runShell(tmp, ["git", "rev-parse", "HEAD~1"])).stdout.trim();
  const sha2 = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();

  let st = await core.resetRepo(tmp, "soft", sha1);
  eq("soft：HEAD 回退", st.headSha, sha1);
  check("soft：x.txt 仍在 staged", st.staged.some((e) => e.path === "x.txt"));
  eq("soft：工作区不动", st.unstaged, []);
  wireCheck("reset", { status: st });

  st = await core.resetRepo(tmp, "hard", sha2);
  eq("hard：回到 sha2", st.headSha, sha2);
  eq("hard：干净", st.staged.length + st.unstaged.length, 0);

  st = await core.resetRepo(tmp, "mixed", sha1);
  eq("mixed：HEAD 回退", st.headSha, sha1);
  eq("mixed：staged 清空", st.staged, []);
  check("mixed：x.txt 变未跟踪（内容保留）", st.untracked.includes("x.txt"));
  const content = (await readFile(join(tmp, "x.txt"), "utf8")).replace(/\r\n/g, "\n");
  eq("mixed：文件内容保留", content, "x\n");

  st = await core.resetRepo(tmp, "hard", null);
  eq("target 缺省 HEAD（mixed 后 HEAD 仍在 sha1，不移动）", st.headSha, sha1);

  for (const [mode, target] of [["nuke", "HEAD"], ["hard", "--soft"], ["hard", "main"], ["hard", "HEAD@{yesterday}"]]) {
    let caught;
    try { await core.resetRepo(tmp, mode, target); } catch (e) { caught = e; }
    check("拒绝 mode=" + mode + " target=" + target, caught instanceof core.GitError);
  }
});

live("revert: 干净 + 冲突（REVERT_HEAD → abort / continue 全链路）", async (tmp) => {
  await writeFile(join(tmp, "x.txt"), "v1\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "c1 v1"]);
  const shaA = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(tmp, "x.txt"), "v2\n");
  await runShell(tmp, ["git", "commit", "-am", "c2 v2"]);
  await writeFile(join(tmp, "y.txt"), "y\n");
  await runShell(tmp, ["git", "add", "y.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "c3 add y"]);
  const shaC = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();

  // 干净 revert（撤掉 c3）
  const rv = await core.revertCommit(tmp, shaC);
  eq("干净 revert reverted=true", rv.reverted, true);
  eq("无冲突", rv.status.conflicted, []);
  eq("y.txt 已删除", existsSync(join(tmp, "y.txt")), false);
  wireCheck("revert", rv);
  const log1 = await core.getLog(tmp, { maxCount: 5 });
  check("revert 提交落账", log1.commits[0].subject.includes("Revert"));

  // 冲突 revert：撤 c1（x.txt 被 c2 改过）→ 冲突进 REVERT_HEAD
  const rv2 = await core.revertCommit(tmp, shaA);
  eq("冲突 revert 不抛错 reverted=false", rv2.reverted, false);
  check("conflicted 含 x.txt", rv2.status.conflicted.some((e) => e.path === "x.txt"));
  wireCheck("revert", rv2);
  const gitDirAbs = resolve(tmp, ".git");
  check("REVERT_HEAD 在场", existsSync(join(gitDirAbs, "REVERT_HEAD")));

  // abort：revert --abort 分支恢复
  await core.abortMerge(tmp);
  check("abort 后 REVERT_HEAD 清除", !existsSync(join(gitDirAbs, "REVERT_HEAD")));
  eq("abort 后无冲突", (await core.getStatus(tmp)).conflicted, []);

  // 再次冲突 → 手动解决（custom 内容，保证 revert 提交非空）→ mergeContinue 完成
  const rv3 = await core.revertCommit(tmp, shaA);
  eq("再次冲突", rv3.reverted, false);
  await writeFile(join(tmp, "x.txt"), "resolved\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  const done = await core.continueMerge(tmp);
  eq("continue 后冲突清空", done.conflicted, []);
  check("continue 后 REVERT_HEAD 清除", !existsSync(join(gitDirAbs, "REVERT_HEAD")));
  const log2 = await core.getLog(tmp, { maxCount: 5 });
  check("revert 以原提交信息落账", /Revert "c1 v1"/.test(log2.commits[0].subject));
  const finalX = (await readFile(join(tmp, "x.txt"), "utf8")).replace(/\r\n/g, "\n");
  eq("解决内容保留", finalX, "resolved\n");
});

live("getBlame: 全量 + 行区间 + ref 参数", async (tmp) => {
  const lines = [];
  for (let i = 1; i <= 10; i++) lines.push("line" + i);
  await writeFile(join(tmp, "f.txt"), lines.join("\n") + "\n");
  await runShell(tmp, ["git", "add", "f.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add f"]);
  lines[0] = "line1-changed";
  await writeFile(join(tmp, "f.txt"), lines.join("\n") + "\n");
  await runShell(tmp, ["git", "commit", "-am", "edit line1"]);

  const b = await core.getBlame(tmp, { file: "f.txt" });
  eq("行数=10", b.lines.length, 10);
  eq("truncated=false", b.truncated, false);
  eq("首行 text", b.lines[0].text, "line1-changed");
  check("首行 sha 40 位", /^[0-9a-f]{40}$/.test(b.lines[0].sha));
  eq("行号 1..10", b.lines.map((l) => l.line), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("author 非空", b.lines[0].author.length > 0);
  check("at 是时间戳", b.lines[0].at > 0);
  wireCheck("blame", b);

  const b2 = await core.getBlame(tmp, { file: "f.txt", start: 2, end: 4 });
  eq("区间 3 行", b2.lines.length, 3);
  eq("区间起始行号", b2.lines[0].line, 2);
  wireCheck("blame", b2);

  const b3 = await core.getBlame(tmp, { file: "f.txt", ref: "HEAD~1" });
  eq("ref=HEAD~1 时首行是旧内容", b3.lines[0].text, "line1");

  let caught;
  try { await core.getBlame(tmp, { file: "../escape.txt" }); } catch (e) { caught = e; }
  check("越界 file 拒绝", caught instanceof core.GitError);
  caught = undefined;
  try { await core.getBlame(tmp, { file: "f.txt", start: 5, end: 2 }); } catch (e) { caught = e; }
  check("start>end 拒绝", caught instanceof core.GitError);
});

live("getDiffRange: patch/stat + file 过滤", async (tmp) => {
  await writeFile(join(tmp, "a.txt"), "a1\n");
  await writeFile(join(tmp, "b.txt"), "b1\n");
  await runShell(tmp, ["git", "add", "-A"]);
  await runShell(tmp, ["git", "commit", "-m", "add a b"]);
  await writeFile(join(tmp, "a.txt"), "a2\n");
  await writeFile(join(tmp, "b.txt"), "b2\n");
  await runShell(tmp, ["git", "commit", "-am", "edit a b"]);
  const sha1 = (await runShell(tmp, ["git", "rev-parse", "HEAD~1"])).stdout.trim();
  const sha2 = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();

  const stat = await core.getDiffRange(tmp, { from: sha1, to: sha2, kind: "stat" });
  check("stat 含 file changed", /file[s]? changed/.test(stat.text));
  eq("stat truncated=false", stat.truncated, false);
  wireCheck("diffRange", stat);

  const patch = await core.getDiffRange(tmp, { from: sha1, to: sha2 });
  check("patch 含 diff --git", patch.text.includes("diff --git"));
  check("patch 含两个文件", patch.text.includes("a.txt") && patch.text.includes("b.txt"));
  wireCheck("diffRange", patch);

  const one = await core.getDiffRange(tmp, { from: sha1, to: sha2, file: "a.txt" });
  check("file 过滤只剩 a.txt", one.text.includes("a.txt") && !one.text.includes("b.txt"));

  let caught;
  try { await core.getDiffRange(tmp, { from: "--output=/tmp/evil" }); } catch (e) { caught = e; }
  check("非法 from 拒绝", caught instanceof core.GitError);
});

live("getReflog: entries 解析 + limit", async (tmp) => {
  await writeFile(join(tmp, "z.txt"), "z\n");
  await runShell(tmp, ["git", "add", "z.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add z"]);
  const r = await core.getReflog(tmp, { limit: 10 });
  check("至少 2 条", r.entries.length >= 2, "got=" + r.entries.length);
  check("selector 是 HEAD@{n}", /^HEAD@\{\d+\}$/.test(r.entries[0].selector));
  check("message 含 commit", /commit/.test(r.entries[0].message));
  check("sha 40 位", /^[0-9a-f]{40}$/.test(r.entries[0].sha));
  check("at 是时间戳", r.entries[0].at > 0);
  wireCheck("reflog", r);
  const r2 = await core.getReflog(tmp, { limit: 1 });
  eq("limit 生效", r2.entries.length, 1);
});

live("getLog: ref/file/author/grep/since/until 过滤", async (tmp) => {
  await writeFile(join(tmp, "f.txt"), "f\n");
  await runShell(tmp, ["git", "add", "f.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "feat: add f"]);
  await runShell(tmp, ["git", "-c", "user.name=Other", "-c", "user.email=o@e.com", "commit", "--allow-empty", "-m", "chore: empty by other"]);

  // ref 过滤 = 从该 ref 开始的历史遍历（HEAD~1 含它自己的祖先）
  const byRef = await core.getLog(tmp, { maxCount: 10, ref: "HEAD~1" });
  eq("ref=HEAD~1 遍历 2 条（feat + initial）", byRef.commits.length, 2);
  eq("ref=HEAD~1 顶端是 feat: add f", byRef.commits[0].subject, "feat: add f");
  wireCheck("log", Object.assign({}, byRef, { graph: computeGraph(byRef.commits) }));

  const byFile = await core.getLog(tmp, { maxCount: 10, file: "f.txt" });
  eq("file 过滤只 1 条", byFile.commits.length, 1);
  eq("file 过滤命中 feat: add f", byFile.commits[0].subject, "feat: add f");

  const byAuthor = await core.getLog(tmp, { maxCount: 10, author: "Other" });
  eq("author 过滤只 1 条", byAuthor.commits.length, 1);
  eq("author 命中 chore", byAuthor.commits[0].subject, "chore: empty by other");
  wireCheck("log", Object.assign({}, byAuthor, { graph: computeGraph(byAuthor.commits) }));

  const byGrep = await core.getLog(tmp, { maxCount: 10, grep: "chore" });
  eq("grep 过滤只 1 条", byGrep.commits.length, 1);

  const bySince = await core.getLog(tmp, { maxCount: 10, since: "1990-01-01" });
  eq("since=1990 全部命中（initial + feat + chore）", bySince.commits.length, 3);
  // 注意：until 不用远未来日期（如 2100）——git approxidate 在 2038 时间戳边界
  // 处会解析出负值导致结果为空（上游行为），测试只用 2035 以内的日期。
  const byUntil = await core.getLog(tmp, { maxCount: 10, until: "1990-01-01" });
  eq("until=1990 全部排除", byUntil.commits.length, 0);
  const byBoth = await core.getLog(tmp, { maxCount: 10, since: "1990-01-01", until: "2035-01-01" });
  eq("since+until 组合", byBoth.commits.length, 3);
});

live("getLog: body 多行正文带出（amend 预填）", async (tmp) => {
  await writeFile(join(tmp, "b.txt"), "b\n");
  await runShell(tmp, ["git", "add", "b.txt"]);
  // commitStaged 单 argv -m 传多行 message（与客户端提交框同路径）
  const c = await core.commitStaged(tmp, "subject line\n\nbody para1\nbody para2", false);
  check("commit 返回短 sha", /^[0-9a-f]{7,}$/.test(c.commit));
  const r = await core.getLog(tmp, { maxCount: 5 });
  eq("body 多行解析", r.commits[0].body, "body para1\nbody para2");
  eq("subject 只取首行", r.commits[0].subject, "subject line");
  eq("无正文挂空串", r.commits[1].body, "");
  wireCheck("log", Object.assign({}, r, { graph: computeGraph(r.commits) }));
});

test("pushBranch: refSpec 推送 tag 到本地 bare remote（wire 守卫）", async () => {
  if (!GIT_AVAILABLE) return;
  const tmpRoot = await mkdtemp(join(tmpdir(), "dsh-git-tagpush-"));
  const bare = join(tmpRoot, "origin.git");
  const work = join(tmpRoot, "work");
  try {
    await runShell(tmpRoot, ["git", "init", "--bare", "-b", "main", bare]);
    await runShell(tmpRoot, ["git", "clone", bare, work]);
    await runShell(work, ["git", "config", "user.email", "test@example.com"]);
    await runShell(work, ["git", "config", "user.name", "T"]);
    await runShell(work, ["git", "config", "commit.gpgsign", "false"]);
    await writeFile(join(work, "a.txt"), "a\n");
    await runShell(work, ["git", "add", "a.txt"]);
    await runShell(work, ["git", "commit", "-m", "initial"]);
    await runShell(work, ["git", "push", "-u", "origin", "main"]);

    await core.createTag(work, "v1.0", null, "release v1.0", true);
    // pushBranch 拼装为 git push [--force-with-lease] <remote> <refSpec>：
    // refSpec 落在 refspec 位置参数、绝不在 repository 位置参数
    const r = await core.pushBranch(work, { remote: "origin", refSpec: "refs/tags/v1.0" });
    check("output 字符串", typeof r.output === "string");
    eq("status 干净", r.status.unstaged.length + r.status.untracked.length, 0);
    wireCheck("push", r);
    const showRef = await runShell(bare, ["git", "show-ref", "--tags"]);
    check("bare remote 已有 v1.0", /refs\/tags\/v1\.0/.test(showRef.stdout));
    // 远端 ls-remote 视角复核（契约 §6 push refSpec 核对项）
    const ls = await runShell(work, ["git", "ls-remote", "--tags", "origin"]);
    check("ls-remote 能看到 refs/tags/v1.0", /refs\/tags\/v1\.0/.test(ls.stdout));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

live("remoteAdd/remoteRename/remoteRemove: 返回新列表 + 白名单", async (tmp) => {
  let r = await core.addRemote(tmp, "origin", "https://example.com/x.git", "git@example.com:x.git");
  eq("1 个 remote", r.remotes.length, 1);
  eq("fetchUrl", r.remotes[0].fetchUrl, "https://example.com/x.git");
  eq("pushUrl", r.remotes[0].pushUrl, "git@example.com:x.git");
  wireCheck("remoteAdd", r);

  r = await core.addRemote(tmp, "backup", "https://example.com/backup.git", null);
  eq("2 个 remote", r.remotes.length, 2);
  wireCheck("remoteAdd", r);

  r = await core.renameRemote(tmp, "origin", "upstream");
  check("rename 生效", r.remotes.some((x) => x.name === "upstream") && !r.remotes.some((x) => x.name === "origin"));
  wireCheck("remoteRename", r);

  r = await core.removeRemote(tmp, "backup");
  eq("remove 后 1 个", r.remotes.length, 1);
  wireCheck("remoteRemove", r);

  let caught;
  try { await core.addRemote(tmp, "-x", "https://e.com/x.git", null); } catch (e) { caught = e; }
  check("非法 remote 名拒绝", caught instanceof core.GitError);
  caught = undefined;
  try { await core.addRemote(tmp, "ok", "-evil", null); } catch (e) { caught = e; }
  check("非法 url 拒绝", caught instanceof core.GitError);
});

test("configList/configSet/configUnset: local + global（GIT_CONFIG_GLOBAL 临时全局，不碰真实配置）", async () => {
  if (!GIT_AVAILABLE) return;
  const tmp = await makeRepo();
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const globalCfgDir = await mkdtemp(join(tmpdir(), "dsh-git-globalcfg-"));
  process.env.GIT_CONFIG_GLOBAL = join(globalCfgDir, "gitconfig");
  try {
    // local
    let e = await core.setConfig(tmp, "test.key", "hello", false);
    let entry = e.entries.find((x) => x.key === "test.key");
    eq("local set 返回新列表", entry, { key: "test.key", value: "hello" });
    wireCheck("configSet", e);
    e = await core.getConfig(tmp, false);
    check("local list 含 test.key", e.entries.some((x) => x.key === "test.key" && x.value === "hello"));
    wireCheck("configList", e);
    e = await core.unsetConfig(tmp, "test.key", false);
    check("local unset 生效", !e.entries.some((x) => x.key === "test.key"));
    wireCheck("configUnset", e);

    // global（GIT_CONFIG_GLOBAL 指向临时文件）
    e = await core.setConfig(tmp, "g.key", "gval", true);
    check("global set", e.entries.some((x) => x.key === "g.key" && x.value === "gval"));
    wireCheck("configSet", e);
    e = await core.getConfig(tmp, true);
    wireCheck("configList", e);
    e = await core.unsetConfig(tmp, "g.key", true);
    check("global unset 生效", !e.entries.some((x) => x.key === "g.key"));
    wireCheck("configUnset", e);

    let caught;
    try { await core.setConfig(tmp, "-evil", "v", false); } catch (e2) { caught = e2; }
    check("非法 key 拒绝", caught instanceof core.GitError);
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    await rm(globalCfgDir, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// v2 wire 合规（live）：每个新增/扩展 Remote 方法的真实返回结构过两道网关校验
// （strict schema parse + assertJsonSafe 复刻）。组装方式与 index.js 逐字段一致。
// ============================================================================

live("wire: v2 新增 Remote 方法返回值过 strict schema + JSON-safe", async (tmp) => {
  // stageHunk
  await writeFile(join(tmp, "m.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
  await runShell(tmp, ["git", "add", "m.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add m"]);
  const stgLines = ["l1x", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10x"];
  await writeFile(join(tmp, "m.txt"), stgLines.join("\n") + "\n");
  wireCheck("stageHunk", { status: await core.stageHunkFile(tmp, { file: "m.txt", hunkIndex: 0 }) });
  await core.resetRepo(tmp, "hard", "HEAD");

  // stash 全家（push → list → apply → pop → push → drop → clear）
  await writeFile(join(tmp, "u.txt"), "u\n");
  wireCheck("stashPush", await core.stashPush(tmp, "wire stash", true));
  wireCheck("stashList", await core.getStashes(tmp));
  wireCheck("stashApply", { status: await core.stashApply(tmp, 0) });
  await core.discardFiles(tmp, ["u.txt"], true);
  wireCheck("stashPop", { status: await core.stashPop(tmp, 0) });
  await core.discardFiles(tmp, ["u.txt"], true);
  await writeFile(join(tmp, "u.txt"), "u2\n"); // 干净树上 stash push 不建条目，必须有改动
  await core.stashPush(tmp, "wire stash 2", true);
  wireCheck("stashDrop", await core.stashDrop(tmp, 0));
  wireCheck("stashClear", await core.stashClear(tmp));

  // tag 全家
  wireCheck("tagCreate", await core.createTag(tmp, "v1.0", null, "annotated msg", true));
  wireCheck("tags", await core.getTags(tmp));
  wireCheck("tagDelete", await core.deleteTag(tmp, "v1.0"));

  // blame / diffRange / reflog / log 过滤（放在 revert 之前：revert 会删掉 m.txt）
  const shaHead = (await core.getLog(tmp, { maxCount: 1 })).commits[0].sha;
  const shaPrev = (await core.getLog(tmp, { maxCount: 2 })).commits[1].sha;
  wireCheck("blame", await core.getBlame(tmp, { file: "m.txt" }));
  wireCheck("diffRange", await core.getDiffRange(tmp, { from: shaPrev, to: shaHead, kind: "stat" }));
  wireCheck("diffRange", await core.getDiffRange(tmp, { from: shaPrev, to: shaHead }));
  wireCheck("reflog", await core.getReflog(tmp, { limit: 20 }));
  const filtered = await core.getLog(tmp, { maxCount: 20, author: "Test User", grep: "commit", since: "1990-01-01", until: "2035-01-01", file: "README.md" });
  wireCheck("log", Object.assign({}, filtered, { graph: computeGraph(filtered.commits) }));

  // remote / config（local；global 路径在 config 测试里覆盖）
  wireCheck("remoteAdd", await core.addRemote(tmp, "wire-remote", "https://example.com/wire.git", null));
  wireCheck("remoteRename", await core.renameRemote(tmp, "wire-remote", "wire-remote2"));
  wireCheck("remoteRemove", await core.removeRemote(tmp, "wire-remote2"));
  wireCheck("configSet", await core.setConfig(tmp, "wire.key", "wireval", false));
  wireCheck("configList", await core.getConfig(tmp, false));
  wireCheck("configUnset", await core.unsetConfig(tmp, "wire.key", false));

  // reset / revert（放最后：revert 会改/删文件）
  wireCheck("reset", { status: await core.resetRepo(tmp, "soft", "HEAD") });
  wireCheck("revert", await core.revertCommit(tmp, shaHead));
  // 冲突形状（reverted=false + status 带 conflicted）在 revert live 测试里 wireCheck
});

// ============================================================================
// P3-A（§8.3）extractLinePatch fixture 矩阵 + rebase 纯函数 fixture
// ============================================================================

const LINE_DIFF = [
  "diff --git a/f.txt b/f.txt",
  "index 1111111..2222222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -10,5 +10,6 @@ hint-here",
  " a1",
  " a2",
  "-b1",
  "+B1",
  "+B2",
  " a3",
  " a4",
  "@@ -20,3 +20,3 @@ tail",
  " q1",
  "-q2",
  "+Q2",
  " q3",
  "",
].join("\n");
// hunk0 可寻址行（0 基）：0=" a1" 1=" a2" 2="-b1" 3="+B1" 4="+B2" 5=" a3" 6=" a4"
// hunk1 可寻址行：0=" q1" 1="-q2" 2="+Q2" 3=" q3"

test("extractLinePatch: 中段混合区间（ctx+del+add）+ @@ 头重写", () => {
  const p = core.extractLinePatch(LINE_DIFF, "f.txt", 0, 2, 3);
  eq("中段 [2,3]", p, [
    "diff --git a/f.txt b/f.txt",
    "index 1111111..2222222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -12 +12 @@ hint-here",
    "-b1",
    "+B1",
    "",
  ].join("\n"));
});

test("extractLinePatch: 纯 add 区间（旧侧 count=0 → start=插入点前一行）", () => {
  const p = core.extractLinePatch(LINE_DIFF, "f.txt", 0, 3, 4);
  check("头 -12,0 +12,2", p.includes("@@ -12,0 +12,2 @@ hint-here"));
  check("只含 +B1/+B2", p.includes("+B1") && p.includes("+B2") && !p.includes("-b1"));
});

test("extractLinePatch: 纯 del 区间（新侧 count=0）", () => {
  const p = core.extractLinePatch(LINE_DIFF, "f.txt", 0, 2, 2);
  check("头 -12 +11,0", p.includes("@@ -12 +11,0 @@ hint-here"));
  check("只含 -b1", p.includes("-b1") && !p.includes("+B1"));
});

test("extractLinePatch: 开头/结尾区间", () => {
  const pStart = core.extractLinePatch(LINE_DIFF, "f.txt", 0, 0, 1);
  check("开头 [0,1] 头", pStart.includes("@@ -10,2 +10,2 @@ hint-here"));
  check("开头行", pStart.includes(" a1") && pStart.includes(" a2") && !pStart.includes("-b1"));
  const pEnd = core.extractLinePatch(LINE_DIFF, "f.txt", 0, 5, 6);
  check("结尾 [5,6] 头", pEnd.includes("@@ -13,2 +14,2 @@ hint-here"));
  check("结尾行", pEnd.includes(" a3") && pEnd.includes(" a4") && !pEnd.includes(" a1"));
});

test("extractLinePatch: 覆盖整个 hunk 与 extractHunkPatch 逐字节一致", () => {
  for (const [h, rows] of [[0, 6], [1, 3]]) {
    const full = core.extractLinePatch(LINE_DIFF, "f.txt", h, 0, rows);
    eq("hunk " + h + " 整段 === extractHunkPatch", full, core.extractHunkPatch(LINE_DIFF, "f.txt", h));
  }
});

test("extractLinePatch: 多 hunk 文件只切指定块", () => {
  const p = core.extractLinePatch(LINE_DIFF, "f.txt", 1, 1, 2);
  check("头 -21 +21", p.includes("@@ -21 +21 @@ tail"));
  check("含 hunk1 行", p.includes("-q2") && p.includes("+Q2"));
  check("不含 hunk0 行", !p.includes("B1") && !p.includes("b1"));
});

test("extractLinePatch: \\ No newline 标记随选中行带出、不计下标", () => {
  const diff = [
    "diff --git a/n.txt b/n.txt",
    "--- a/n.txt",
    "+++ b/n.txt",
    "@@ -1,2 +1,2 @@",
    " x",
    "-y",
    "+Y",
    "\\ No newline at end of file",
  ].join("\n");
  const p = core.extractLinePatch(diff, "n.txt", 0, 2, 2);
  check("含 +Y 与标记行", p.includes("+Y") && p.includes("\\ No newline at end of file"));
  check("不含 -y", !p.includes("-y"));
  check("头 -2,0 +2", p.includes("@@ -2,0 +2 @@"));
});

test("extractLinePatch: 非法输入全部抛 GitError", () => {
  const cases = [
    ["rowStart>rowEnd", () => core.extractLinePatch(LINE_DIFF, "f.txt", 0, 3, 2)],
    ["行越界", () => core.extractLinePatch(LINE_DIFF, "f.txt", 0, 0, 99)],
    ["负下标", () => core.extractLinePatch(LINE_DIFF, "f.txt", 0, -1, 1)],
    ["hunkIndex 越界", () => core.extractLinePatch(LINE_DIFF, "f.txt", 5, 0, 1)],
    ["未知文件", () => core.extractLinePatch(LINE_DIFF, "nope.txt", 0, 0, 1)],
    ["空 diff", () => core.extractLinePatch("", "f.txt", 0, 0, 1)],
    ["非整数下标", () => core.extractLinePatch(LINE_DIFF, "f.txt", 0, "a", 1)],
  ];
  for (const [label, fn] of cases) {
    let caught;
    try { fn(); } catch (e) { caught = e; }
    check("抛 GitError：" + label, caught instanceof core.GitError);
  }
});

test("rebase 纯函数: buildRebaseTodo / normalizeRebaseEntry（防 todo 注入）", () => {
  const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
  const todo = core.buildRebaseTodo([
    { action: "pick", sha: A, subject: "first" },
    { action: "squash", sha: B, subject: "second", message: "MSG" },
    { action: "drop", sha: C, subject: "evil\nexec touch pwned" },
    { action: "fixup", sha: D, subject: "fourth", message: "IGNORED" },
  ]);
  const lines = todo.split("\n");
  eq("4 行 + 尾换行", lines.length, 5);
  eq("pick 行", lines[0], "pick " + A + " first");
  eq("squash 行", lines[1], "squash " + B + " second");
  eq("subject 换行被压平（防注入 exec 行）", lines[2], "drop " + C + " evil exec touch pwned");
  eq("fixup 行", lines[3], "fixup " + D + " fourth");
  // message 归一化：squash 保留、fixup 忽略（Lead 裁决 Q2）
  const nSquash = core.normalizeRebaseEntry({ action: "squash", sha: B, subject: "s", message: "M" });
  eq("squash+message 保留", nSquash.message, "M");
  const nFixup = core.normalizeRebaseEntry({ action: "fixup", sha: B, subject: "s", message: "M" });
  check("fixup+message 被忽略", !("message" in nFixup));
  for (const bad of [
    { action: "exec", sha: A, subject: "x" },              // action 枚举
    { action: "pick", sha: "--output=evil", subject: "x" }, // sha 白名单
    { action: "pick", sha: "abc;rm -rf", subject: "x" },
    null,
  ]) {
    let caught;
    try { core.normalizeRebaseEntry(bad, "t"); } catch (e) { caught = e; }
    check("拒绝非法条目 " + JSON.stringify(bad), caught instanceof core.GitError);
  }
  let caught;
  try { core.buildRebaseTodo([]); } catch (e) { caught = e; }
  check("空 entries 抛错", caught instanceof core.GitError);
});

test("rebase 纯函数: parseRebasePlan + buildEditorCommand", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const r = core.parseRebasePlan(A + "\x1faaaaaaa\x1foldest first\0" + B + "\x1fbbbbbbb\x1fsecond\0");
  eq("count", r.length, 2);
  eq("最旧在前保序", r.map((e) => e.subject), ["oldest first", "second"]);
  eq("action=pick", r[0].action, "pick");
  eq("sha", r[0].sha, A);
  check("无 message key（JSON-safe）", !("message" in r[0]));
  eq("empty", core.parseRebasePlan(""), []);

  const cmd = core.buildEditorCommand("C:\\path with space\\ed it.mjs", "seq");
  check("以模式收尾", / seq$/.test(cmd));
  check("解释器与脚本双引号包裹", cmd.split('"').length - 1 >= 4);
  check("空格路径整体保留在引号内", cmd.includes("path with space"));
});

// ============================================================================
// P3-A live（§8.7）：lineApply 三模式 / rebase 全家 / fixupCommit / rebaseBranch /
// mergeContinue+abortMerge rebase 分派
// ============================================================================

live("lineApply: stage/unstage/discard 三模式（含跨 ctx/+/- 混合区间）", async (tmp) => {
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push("line" + i);
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");
  await runShell(tmp, ["git", "add", "multi.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "multi"]);
  lines[1] = "line2-changed";
  lines[17] = "line18-changed";
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");
  // hunk0（context 3）addr 行：0=" line1" 1="-line2" 2="+line2-changed" 3..5=ctx

  // 1) discard：只选 -/+ 对（rows 1..2）→ 只回退 line2
  let st = await core.applyLine(tmp, { file: "multi.txt", scope: "unstaged", mode: "discard", hunkIndex: 0, rowStart: 1, rowEnd: 2 });
  let after = (await readFile(join(tmp, "multi.txt"), "utf8")).replace(/\r\n/g, "\n").split("\n");
  eq("discard 行区间只回退 line2", after[1], "line2");
  eq("line18 改动保留", after[17], "line18-changed");
  wireCheck("lineApply", { status: st });

  // 2) stage：混合区间（含 ctx，rows 0..2）→ 暂存 line2 改动
  lines[1] = "line2-changed";
  await writeFile(join(tmp, "multi.txt"), lines.join("\n") + "\n");
  st = await core.applyLine(tmp, { file: "multi.txt", scope: "unstaged", mode: "stage", hunkIndex: 0, rowStart: 0, rowEnd: 2 });
  check("stage 后 multi.txt 在 staged", st.staged.some((e) => e.path === "multi.txt"));
  check("仍在 unstaged（剩 line18 块）", st.unstaged.some((e) => e.path === "multi.txt"));
  const sd = await core.getDiff(tmp, { scope: "staged", file: "multi.txt" });
  check("staged diff 含 line2-changed", sd.text.includes("line2-changed"));
  check("staged diff 不含 line18-changed", !sd.text.includes("line18-changed"));
  wireCheck("lineApply", { status: st });

  // 3) unstage：staged diff 的 -/+ 对（rows 1..2）→ 改动移回工作区
  st = await core.applyLine(tmp, { file: "multi.txt", scope: "staged", mode: "unstage", hunkIndex: 0, rowStart: 1, rowEnd: 2 });
  check("unstage 后 staged 清空", !st.staged.some((e) => e.path === "multi.txt"));
  check("改动回到 unstaged", st.unstaged.some((e) => e.path === "multi.txt"));
  after = (await readFile(join(tmp, "multi.txt"), "utf8")).replace(/\r\n/g, "\n").split("\n");
  eq("unstage 不丢内容（line2-changed 保留）", after[1], "line2-changed");
  wireCheck("lineApply", { status: st });

  // 非法组合/区间拒绝
  for (const [label, opts] of [
    ["scope/mode 组合非法", { file: "multi.txt", scope: "staged", mode: "discard", hunkIndex: 0, rowStart: 0, rowEnd: 1 }],
    ["rowStart>rowEnd", { file: "multi.txt", scope: "unstaged", mode: "stage", hunkIndex: 0, rowStart: 3, rowEnd: 1 }],
  ]) {
    let caught;
    try { await core.applyLine(tmp, opts); } catch (e) { caught = e; }
    check("拒绝：" + label, caught instanceof core.GitError);
  }
});

live("lineApply: 覆盖整个 hunk 与 hunkApply 等价（同型双文件对照）", async (tmp) => {
  for (const name of ["hunkA.txt", "hunkB.txt"]) {
    const lines = [];
    for (let i = 1; i <= 20; i++) lines.push("line" + i);
    await writeFile(join(tmp, name), lines.join("\n") + "\n");
  }
  await runShell(tmp, ["git", "add", "-A"]);
  await runShell(tmp, ["git", "commit", "-m", "two files"]);
  for (const name of ["hunkA.txt", "hunkB.txt"]) {
    const lines = [];
    for (let i = 1; i <= 20; i++) lines.push("line" + i);
    lines[1] = "line2-changed";
    await writeFile(join(tmp, name), lines.join("\n") + "\n");
  }
  await core.applyHunk(tmp, { scope: "worktree", file: "hunkA.txt", hunkIndex: 0 });
  await core.applyLine(tmp, { file: "hunkB.txt", scope: "unstaged", mode: "discard", hunkIndex: 0, rowStart: 0, rowEnd: 5 });
  const a = (await readFile(join(tmp, "hunkA.txt"), "utf8")).replace(/\r\n/g, "\n");
  const b = (await readFile(join(tmp, "hunkB.txt"), "utf8")).replace(/\r\n/g, "\n");
  eq("整 hunk lineApply 结果 === hunkApply 结果", b, a);
  eq("两者都已回退 line2", a.split("\n")[1], "line2");
});

live("rebasePlan/rebaseRun: drop + reorder", async (tmp) => {
  for (const n of ["f1", "f2", "f3", "f4"]) {
    await writeFile(join(tmp, n + ".txt"), n + "\n");
    await runShell(tmp, ["git", "add", n + ".txt"]);
    await runShell(tmp, ["git", "commit", "-m", "add " + n]);
  }
  const base = (await runShell(tmp, ["git", "rev-parse", "HEAD~4"])).stdout.trim();
  const plan = await core.rebasePlan(tmp, base);
  eq("plan 4 条（base..HEAD 不含 base）", plan.entries.length, 4);
  eq("最旧在前", plan.entries.map((e) => e.subject), ["add f1", "add f2", "add f3", "add f4"]);
  check("action 全 pick", plan.entries.every((e) => e.action === "pick"));
  wireCheck("rebasePlan", plan);

  const [e1, e2, e3, e4] = plan.entries;
  const run = await core.rebaseRun(tmp, base, [
    { action: "pick", sha: e3.sha, subject: e3.subject },
    { action: "pick", sha: e1.sha, subject: e1.subject },
    { action: "drop", sha: e2.sha, subject: e2.subject },
    { action: "pick", sha: e4.sha, subject: e4.subject },
  ]);
  eq("done=true", run.done, true);
  eq("无冲突", run.status.conflicted, []);
  wireCheck("rebaseRun", run);
  const subjects = (await core.getLog(tmp, { maxCount: 10 })).commits.map((c) => c.subject);
  eq("历史=initial,f3,f1,f4（f2 drop、f3 提前）", subjects, ["add f4", "add f1", "add f3", "initial commit"]);
  eq("f2.txt 已随 drop 消失", existsSync(join(tmp, "f2.txt")), false);
});

live("rebaseRun: squash+message 替换 + 多 squash 队列按序消费", async (tmp) => {
  for (const n of ["a", "b", "c", "d"]) {
    await writeFile(join(tmp, n + ".txt"), n + "\n");
    await runShell(tmp, ["git", "add", n + ".txt"]);
    await runShell(tmp, ["git", "commit", "-m", "add " + n]);
  }
  const base = (await runShell(tmp, ["git", "rev-parse", "HEAD~4"])).stdout.trim();
  const plan = await core.rebasePlan(tmp, base);
  const [e1, e2, e3, e4] = plan.entries;
  const run = await core.rebaseRun(tmp, base, [
    { action: "pick", sha: e1.sha, subject: e1.subject },
    { action: "squash", sha: e2.sha, subject: e2.subject, message: "SQUASH MSG A" },
    { action: "pick", sha: e3.sha, subject: e3.subject },
    { action: "squash", sha: e4.sha, subject: e4.subject, message: "SQUASH MSG B" },
  ]);
  eq("done=true", run.done, true);
  wireCheck("rebaseRun", run);
  const subjects = (await core.getLog(tmp, { maxCount: 10 })).commits.map((c) => c.subject);
  eq("两组 squash 各自合并并替换信息", subjects, ["SQUASH MSG B", "SQUASH MSG A", "initial commit"]);
});

live("rebaseRun: fixup 带 message 被忽略 + edit 停驻 done=false → mergeContinue（rebase 分派）完成", async (tmp) => {
  for (const n of ["a", "b", "c"]) {
    await writeFile(join(tmp, n + ".txt"), n + "\n");
    await runShell(tmp, ["git", "add", n + ".txt"]);
    await runShell(tmp, ["git", "commit", "-m", "add " + n]);
  }
  const base = (await runShell(tmp, ["git", "rev-parse", "HEAD~3"])).stdout.trim();
  const plan = await core.rebasePlan(tmp, base);
  const [e1, e2, e3] = plan.entries;
  const run = await core.rebaseRun(tmp, base, [
    { action: "pick", sha: e1.sha, subject: e1.subject },
    { action: "fixup", sha: e2.sha, subject: e2.subject, message: "SHOULD NOT APPEAR" },
    { action: "edit", sha: e3.sha, subject: e3.subject },
  ]);
  eq("edit 停驻 done=false", run.done, false);
  eq("停驻非冲突（conflicted 空）", run.status.conflicted, []);
  wireCheck("rebaseRun", run);
  const gitDirAbs = resolve(tmp, ".git");
  check("rebase 态在场", existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply")));

  const done = await core.continueMerge(tmp); // rebase 分派：git rebase --continue
  eq("continue 后冲突清空", done.conflicted, []);
  check("rebase 完成", !existsSync(join(gitDirAbs, "rebase-merge")) && !existsSync(join(gitDirAbs, "rebase-apply")));
  wireCheck("mergeContinue", { status: done });
  const log = await core.getLog(tmp, { maxCount: 10 });
  eq("历史 = combined(a+b), c, initial", log.commits.map((c) => c.subject), ["add c", "add a", "initial commit"]);
  const allMsg = (await runShell(tmp, ["git", "log", "--format=%B"])).stdout;
  check("fixup 的 message 被忽略", !allMsg.includes("SHOULD NOT APPEAR"));
});

live("rebaseRun: 冲突 done=false → abortMerge（rebase 分派）中止 / 解决后 mergeContinue 完成（队列跨进程）", async (tmp) => {
  await writeFile(join(tmp, "README.md"), "version A\n");
  await runShell(tmp, ["git", "commit", "-am", "edit A"]);
  await writeFile(join(tmp, "README.md"), "version B\n");
  await runShell(tmp, ["git", "commit", "-am", "edit B"]);
  await writeFile(join(tmp, "y.txt"), "y\n");
  await runShell(tmp, ["git", "add", "y.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "side y"]);
  const base = (await runShell(tmp, ["git", "rev-parse", "HEAD~3"])).stdout.trim();
  const plan = await core.rebasePlan(tmp, base);
  eq("plan 3 条", plan.entries.length, 3);
  const [eA, eB, eC] = plan.entries;
  const gitDirAbs = resolve(tmp, ".git");

  // 阶段 1：reorder（pick B 跨过 A）必冲突 → abort 恢复
  const run1 = await core.rebaseRun(tmp, base, [
    { action: "pick", sha: eB.sha, subject: eB.subject },
    { action: "drop", sha: eA.sha, subject: eA.subject },
    { action: "drop", sha: eC.sha, subject: eC.subject },
  ]);
  eq("冲突 done=false", run1.done, false);
  check("conflicted 非空", run1.status.conflicted.length > 0);
  wireCheck("rebaseRun", run1);
  const ab = await core.abortMerge(tmp);
  eq("abort 后冲突清空", ab.conflicted, []);
  wireCheck("mergeAbort", { status: ab });
  check("abort 后 rebase 态清除", !existsSync(join(gitDirAbs, "rebase-merge")));
  eq("历史恢复原样", (await core.getLog(tmp, { maxCount: 10 })).commits.map((c) => c.subject),
    ["side y", "edit B", "edit A", "initial commit"]);

  // 阶段 2：同冲突 + 后随 squash（带 message）→ 解决 → mergeContinue →
  // squash 步骤的消息队列在 continue 进程里重新挂载并生效
  const run2 = await core.rebaseRun(tmp, base, [
    { action: "pick", sha: eB.sha, subject: eB.subject },
    { action: "drop", sha: eA.sha, subject: eA.subject },
    { action: "squash", sha: eC.sha, subject: eC.subject, message: "MSG AFTER CONFLICT" },
  ]);
  eq("再次冲突 done=false", run2.done, false);
  await writeFile(join(tmp, "README.md"), "resolved\n");
  await runShell(tmp, ["git", "add", "README.md"]);
  const done = await core.continueMerge(tmp);
  eq("continue 后冲突清空", done.conflicted, []);
  check("rebase 完成", !existsSync(join(gitDirAbs, "rebase-merge")));
  const log = await core.getLog(tmp, { maxCount: 5 });
  eq("squash 消息跨进程生效", log.commits[0].subject, "MSG AFTER CONFLICT");
  check("squash 合并了 y.txt", existsSync(join(tmp, "y.txt")));
  const resolved = (await readFile(join(tmp, "README.md"), "utf8")).replace(/\r\n/g, "\n");
  eq("解决内容保留", resolved, "resolved\n");
});

live("fixupCommit: fixup / squash+message / 冲突路径", async (tmp) => {
  await writeFile(join(tmp, "x.txt"), "line1\nline2\nline3\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add x"]);
  await writeFile(join(tmp, "x.txt"), "line1\nCHANGED2\nline3\n");
  await runShell(tmp, ["git", "commit", "-am", "edit x middle"]);
  await writeFile(join(tmp, "y.txt"), "y\n");
  await runShell(tmp, ["git", "add", "y.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "add y"]);

  // 1) fixup 模式（非冲突）：x.txt 顶部加行 → 并入 "add x"（不同区域，重放干净）
  const shaAddX = (await runShell(tmp, ["git", "rev-parse", "HEAD~2"])).stdout.trim();
  await writeFile(join(tmp, "x.txt"), "line0\nline1\nCHANGED2\nline3\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  const r1 = await core.fixupCommit(tmp, shaAddX, "fixup", "IGNORED MSG");
  eq("fixup done=true", r1.done, true);
  wireCheck("fixupCommit", r1);
  const log1 = (await runShell(tmp, ["git", "log", "--format=%s"])).stdout.trim().split("\n");
  // initial + add x(合并 fixup) + edit x middle + add y = 4 条（fixup 并入目标、总数不变）
  eq("fixup 合并后总数不变 4 条", log1.length, 4);
  eq("合并进目标提交 add x", log1[2], "add x");
  check("fixup message 被忽略", !(await runShell(tmp, ["git", "log", "--format=%B"])).stdout.includes("IGNORED MSG"));

  // 2) squash+message（提交信息替换）
  const shaAddY = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(tmp, "y.txt"), "y-fixed\n");
  await runShell(tmp, ["git", "add", "y.txt"]);
  const r2 = await core.fixupCommit(tmp, shaAddY, "squash", "SQUASH FIXUP MSG");
  eq("squash done=true", r2.done, true);
  wireCheck("fixupCommit", r2);
  const headMsg = (await runShell(tmp, ["git", "log", "-1", "--format=%s"])).stdout.trim();
  eq("squash+message 替换合并信息", headMsg, "SQUASH FIXUP MSG");
  eq("squash 合并后总数不变 4 条", (await runShell(tmp, ["git", "log", "--format=%s"])).stdout.trim().split("\n").length, 4);

  // 3) 冲突路径：fixup 更早提交的同一区域 → autosquash 冲突
  const shaAddX2 = (await runShell(tmp, ["git", "rev-parse", "HEAD~2"])).stdout.trim();
  await writeFile(join(tmp, "x.txt"), "line0\nline1\nCONFLICT2\nline3\n");
  await runShell(tmp, ["git", "add", "x.txt"]);
  const r3 = await core.fixupCommit(tmp, shaAddX2, "fixup", null);
  eq("冲突路径 done=false", r3.done, false);
  check("conflicted 非空", r3.status.conflicted.length > 0);
  wireCheck("fixupCommit", r3);
  await core.abortMerge(tmp);
  check("abort 后干净", (await core.getStatus(tmp)).conflicted.length === 0);
});

live("rebaseBranch: 干净 + 冲突（done/status 契约）", async (tmp) => {
  // 干净：feat 提交独立文件，main 前进独立文件 → rebase 到 main 之上
  await runShell(tmp, ["git", "checkout", "-b", "feat"]);
  await writeFile(join(tmp, "f.txt"), "f\n");
  await runShell(tmp, ["git", "add", "f.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "feat f"]);
  await runShell(tmp, ["git", "checkout", "main"]);
  await writeFile(join(tmp, "m.txt"), "m\n");
  await runShell(tmp, ["git", "add", "m.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "main m"]);
  await runShell(tmp, ["git", "checkout", "feat"]);

  const r1 = await core.rebaseBranch(tmp, "main");
  eq("干净 done=true", r1.done, true);
  eq("无冲突", r1.status.conflicted, []);
  wireCheck("rebaseBranch", r1);
  const subjects = (await core.getLog(tmp, { maxCount: 10 })).commits.map((c) => c.subject);
  eq("feat 重放到 main 之上", subjects, ["feat f", "main m", "initial commit"]);
  check("两文件共存", existsSync(join(tmp, "f.txt")) && existsSync(join(tmp, "m.txt")));

  // 冲突：两边改 README 不同内容
  await writeFile(join(tmp, "README.md"), "feat line\n");
  await runShell(tmp, ["git", "commit", "-am", "feat edits README"]);
  await runShell(tmp, ["git", "checkout", "main"]);
  await writeFile(join(tmp, "README.md"), "main line\n");
  await runShell(tmp, ["git", "commit", "-am", "main edits README"]);
  await runShell(tmp, ["git", "checkout", "feat"]);

  const r2 = await core.rebaseBranch(tmp, "main");
  eq("冲突 done=false", r2.done, false);
  check("conflicted 含 README.md", r2.status.conflicted.some((e) => e.path === "README.md"));
  wireCheck("rebaseBranch", r2);
  const gitDirAbs = resolve(tmp, ".git");
  check("rebase 态在场", existsSync(join(gitDirAbs, "rebase-merge")) || existsSync(join(gitDirAbs, "rebase-apply")));
  await core.abortMerge(tmp); // abortMerge rebase 分派第二例
  check("abort 后 rebase 态清除", !existsSync(join(gitDirAbs, "rebase-merge")));
  eq("abort 后无冲突", (await core.getStatus(tmp)).conflicted, []);
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

test("static: 56 个 Remote 方法在两边都存在", () => {
  const indexSrc = readFileSync(join(__projectRoot, "index.js"), "utf8");
  const typertSrc = readFileSync(join(__projectRoot, "typert.host.js"), "utf8");
  const expected = [
    "probe","overview","status","diff","log","branches","remotes","worktrees",
    "conflictContent","stage","unstage","discard","commit","branchCreate",
    "checkout","branchDelete","branchRename","merge","mergeAbort","mergeContinue",
    "resolveConflict","fetch","pull","push","worktreeAdd","worktreeRemove",
    "worktreePrune","init","hunkApply","cherryPick",
    // v2 §2.1/§2.2/§2.3
    "stageHunk","stashList","stashPush","stashPop","stashApply","stashDrop","stashClear",
    "tags","tagCreate","tagDelete","reset","revert","blame","diffRange","reflog",
    "remoteAdd","remoteRemove","remoteRename","configList","configSet","configUnset",
    // P3-A §8.1/§8.3
    "rebasePlan","rebaseRun","fixupCommit","rebaseBranch","lineApply",
  ];
  eq("方法总数 56", expected.length, 56);
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
// 跨版本 strict codec 双形态 + 宿主版本声明（2026-09-24 实测 21 个 typert-loader 版本矩阵）
//   - ≤0.1.6-alpha.1：loader/registry/gateway 校验并使用 codec.schema（zod .parse）
//   - ≥0.1.6-alpha.2（含 0.1.7-rc.x）：校验 codec.create() 工厂，网关解码 codec.create().parse()
// 两代校验各看一个键、互不检查对方——只写一边，另一端 ctx.remote.$mount 注册直接抛
// "strict codec has no create() factory"，client apply 整个失败、槽位不注册、入口不出现。
// engines.dsh 双位置同值声明是 dshmarket 宿主要求显示/筛选/安装阻断的数据源。
// ============================================================================

test("static: strict codec 双形态（schema + create 并存，跨 0.1.5/0.1.7）", () => {
  check("TYPERT 有 invocation", TYPERT.invocations.length > 0);
  for (const inv of TYPERT.invocations) {
    const codecs = [["result", inv.result], ...inv.parameters.map((p, i) => ["param[" + i + "]", p.codec])];
    for (const [label, codec] of codecs) {
      const at = inv.id + " " + label;
      check(at + " mode=strict", codec && codec.mode === "strict");
      check(at + " 有 schema.parse（≤0.1.6 校验）", codec && typeof codec.schema === "object" && typeof codec.schema.parse === "function");
      check(at + " 有 create() 工厂（≥0.1.6-alpha.2 校验）", codec && typeof codec.create === "function");
      if (codec && typeof codec.create === "function") {
        check(at + " create() 返回可 parse 对象", typeof codec.create().parse === "function");
      }
    }
  }
  // client.js 的 CLIENT_REMOTE 是 bundle 内联字面量，只能源码级守卫
  const clientSrc = readFileSync(join(__projectRoot, "client.js"), "utf8");
  const methodBlock = clientSrc.match(/const method = \(m\) => \(\{[\s\S]*?\}\);/);
  check("client.js 找到 method() 描述符构造", !!methodBlock);
  if (methodBlock) {
    check("client codec 同时有 schema: passthrough()", /schema: passthrough\(\)/.test(methodBlock[0]));
    check("client codec 同时有 create: passthrough（0.1.7 registry 校验）", /create: passthrough/.test(methodBlock[0]));
  }
});

test("static: engines.dsh 宿主版本声明（dshmarket 显示/筛选/阻断数据源）", () => {
  const pkg = JSON.parse(readFileSync(join(__projectRoot, "package.json"), "utf8"));
  const top = pkg.engines && pkg.engines.dsh;
  const nested = pkg.dsh && pkg.dsh.engines && pkg.dsh.engines.dsh;
  check("顶层 engines.dsh 是非空字符串", typeof top === "string" && top.length > 0);
  check("dsh.engines.dsh 是非空字符串（dshmarket 两处都读、顶层优先）", typeof nested === "string" && nested.length > 0);
  check("两位置同值", top === nested);
  // 与 peer 对齐：dshmarket 显示全部声明的交集，同值才不会显示成 "A ∩ B"
  const peer = pkg.peerDependencies && pkg.peerDependencies["@deepseek-ai/dsh-typert-protocol"];
  check("engines 与 dsh-typert-protocol peer 同 range（市场交集显示单条）", typeof peer === "string" && top === peer);
  // 0.1.7-rc.1 与 0.2.0-rc.1 都必须落在 range 内。
  // dshmarket 的显示/筛选以 includePrerelease 求值；0.2.0 起安装与 boot 还有
  // dsh-app-boot.evaluatePluginCompatibility 硬门：peerDependencies 里每个
  // @deepseek-ai/dsh* 都要 semver.satisfies(runtime, range, {includePrerelease:true})，
  // 不满足直接拒装/跳过加载（"插件在 0.2.0 无法加载"的根因，2026-09-29 实测）。
  if (typeof top === "string") {
    // 复刻 dshmarket satisfiesRange(v, range, {includePrerelease:true}) 的语义做冒烟：
    // 每个 "||" 候选形如 "^x.y.z-rc.n"，展开为 >=x.y.z-rc.n <x.(y+1).0
    const alts = top.split("||").map((s) => s.trim());
    check(
      "range 每个 || 候选形如 ^x.y.z-rc.n（rc 预发布落在区间内）",
      alts.length >= 1 && alts.every((a) => /^\^\d+\.\d+\.\d+-rc\.\d+$/.test(a)),
    );
    const caretContains = (candidate, version) => {
      const lo = candidate.match(/^\^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/);
      const hi = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
      if (!lo || !hi) return false;
      const n = (x) => Number(x);
      // [major, minor, patch, rc]；同号下正式版（rc=∞）> 一切 rc
      const lower = [n(lo[1]), n(lo[2]), n(lo[3]), n(lo[4])];
      const ver = [n(hi[1]), n(hi[2]), n(hi[3]), hi[4] === undefined ? Infinity : n(hi[4])];
      // >= x.y.z-rc.n
      for (let i = 0; i < 3; i++) { if (ver[i] !== lower[i]) return ver[i] > lower[i]; }
      if (ver[3] < lower[3]) return false;
      // < x.(y+1).0 ⇔ major/minor 与下界同号（patch 相等已在上面确立）
      return ver[0] === lower[0] && ver[1] === lower[1];
    };
    check(
      "0.2.0-rc.1 落在 range 内（boot 兼容硬门需要，否则拒装）",
      alts.some((a) => caretContains(a, "0.2.0-rc.1")),
    );
  }
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

  // hunkApply：撤销 README 的 unstaged 改动；envelope value 形状 { status }
  const hunkStatus = await core.applyHunk(tmp, { scope: "worktree", file: "README.md", hunkIndex: 0 });
  wireCheck("hunkApply", { status: hunkStatus });

  // cherryPick 成功路径（envelope value = { picked, status }）：
  // 从 HEAD 拉 side 分支提交一个文件，回 main 拣选回来
  await runShell(tmp, ["git", "switch", "-c", "wire-side"]);
  await writeFile(join(tmp, "wire-side.txt"), "side\n");
  await runShell(tmp, ["git", "add", "wire-side.txt"]);
  await runShell(tmp, ["git", "commit", "-m", "wire side"]);
  const wireSideSha = (await runShell(tmp, ["git", "rev-parse", "HEAD"])).stdout.trim();
  await runShell(tmp, ["git", "switch", "main"]);
  const pickRes = await core.cherryPickCommit(tmp, wireSideSha);
  check("wire: cherryPick picked=true", pickRes.picked === true);
  wireCheck("cherryPick", pickRes);
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