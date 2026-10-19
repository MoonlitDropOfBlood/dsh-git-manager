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

// ============================================================================
// 子仓库支持 P0（2026-10-13）：parseStatusV2 的 <sub> / gitlink 字段 +
//   statusSummary + validateRepoPath（纯函数，方案 §2.3 / §4.3 / §4.5）
// ============================================================================

// own key 判定（JSON-safe 铁律的正面表达：可选字段「有值才挂 key」；
// zod .optional() 会原样放行显式 undefined，网关 assertJsonValue 直接拒绝）
function hasKey(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

const SUB_SHA_A = "1111111111111111111111111111111111111111";
const SUB_SHA_B = "2222222222222222222222222222222222222222";
const SUB_SHA_C = "3333333333333333333333333333333333333333";

test("parseStatusV2: <sub> 字段挂 subState（SC../S.M./S..U/S...），N... 不挂", () => {
  // porcelain v2 的 <sub> 是 4 字符位置型标志（实测解码，勿猜文档字面）：
  //   pos1 S = 子模块有状态差异；pos2 C = 子仓库 HEAD≠index 指针（未暂存漂移）；
  //   pos3 M = 已跟踪内容脏；pos4 U = 有未跟踪内容。普通文件恒 N...
  const fixture = [
    "# branch.oid " + SUB_SHA_A + "\0",
    "# branch.head main\0",
    // 未暂存指针漂移：hH===hI（index 未变）→ 只有 subState，没有 gitlink
    "1 .M SC.. 160000 160000 160000 " + SUB_SHA_A + " " + SUB_SHA_A + " libs/base\0",
    // 子仓库已跟踪内容脏
    "1 .M S.M. 160000 160000 160000 " + SUB_SHA_B + " " + SUB_SHA_B + " libs/dirty\0",
    // 子仓库有未跟踪内容
    "1 .M S..U 160000 160000 160000 " + SUB_SHA_C + " " + SUB_SHA_C + " libs/untracked\0",
    // 已暂存指针变更：hH!==hI → 额外挂 gitlink
    "1 M. S... 160000 160000 160000 " + SUB_SHA_A + " " + SUB_SHA_B + " libs/staged\0",
    // 普通文件行
    "1 .M N... 100644 100644 100644 " + SUB_SHA_A + " " + SUB_SHA_C + " s.txt\0",
  ].join("");
  const r = core.parseStatusV2(fixture);
  const byPath = (arr) => Object.fromEntries(arr.map((e) => [e.path, e]));
  const unst = byPath(r.unstaged);
  const stg = byPath(r.staged);

  eq("未暂存漂移 <sub> 原样 SC..", unst["libs/base"].subState, "SC..");
  check("未暂存漂移不挂 gitlink（hH===hI）", !hasKey(unst["libs/base"], "gitlink"), JSON.stringify(unst["libs/base"]));
  eq("内容脏 <sub> 原样 S.M.", unst["libs/dirty"].subState, "S.M.");
  eq("未跟踪内容 <sub> 原样 S..U", unst["libs/untracked"].subState, "S..U");
  eq("已暂存指针 <sub> 原样 S...", stg["libs/staged"].subState, "S...");
  eq("gitlink fromSha（hH 旧指针）", stg["libs/staged"].gitlink.fromSha, SUB_SHA_A);
  eq("gitlink toSha（hI 新指针）", stg["libs/staged"].gitlink.toSha, SUB_SHA_B);
  eq("40 位完整 sha 保真（不截断）", stg["libs/staged"].gitlink.fromSha.length, 40);

  check("N... 不挂 subState", !hasKey(unst["s.txt"], "subState"), JSON.stringify(unst["s.txt"]));
  check("N... 行不挂 gitlink", !hasKey(unst["s.txt"], "gitlink"), JSON.stringify(unst["s.txt"]));
  // JSON-safe：条目里不得出现 undefined/null
  for (const e of [...r.staged, ...r.unstaged]) {
    for (const [k, v] of Object.entries(e)) {
      check(e.path + "." + k + " 不是 undefined", v !== undefined);
      check(e.path + "." + k + " 不是 null", v !== null);
    }
  }
});

test("parseStatusV2: gitlink 边界（hH===hI / 非 40 位小写 hex 不挂）+ type2 行同样生效", () => {
  const fixture = [
    // hH===hI → 不挂
    "1 M. S... 160000 160000 160000 " + SUB_SHA_A + " " + SUB_SHA_A + " libs/same\0",
    // 短 sha（porcelain 只给 7 位的情形）→ 不挂
    "1 M. S... 160000 160000 160000 abc1234 abc1234 libs/short\0",
    // 40 位但含大写 hex → 不挂（正则只收小写）
    "1 M. S... 160000 160000 160000 ABCDEF0123456789ABCDEF0123456789ABCDEF01 " + SUB_SHA_B + " libs/upper\0",
    // type2（rename）行同样解析 <sub>/hH/hI，列位整体右移一位（R<score>）
    "2 R. S... 160000 160000 160000 " + SUB_SHA_A + " " + SUB_SHA_C + " R100 libs/renamed\0",
    "libs/original\0",
    // type2 且 hH===hI → 不挂
    "2 R. N... 100644 100644 100644 " + SUB_SHA_A + " " + SUB_SHA_A + " R100 new.txt\0",
    "old.txt\0",
  ].join("");
  const r = core.parseStatusV2(fixture);
  const byPath = Object.fromEntries(r.staged.map((e) => [e.path, e]));

  check("hH===hI 不挂 gitlink", !hasKey(byPath["libs/same"], "gitlink"), JSON.stringify(byPath["libs/same"]));
  check("非 40 位 sha 不挂 gitlink", !hasKey(byPath["libs/short"], "gitlink"));
  check("大写 hex 不挂 gitlink", !hasKey(byPath["libs/upper"], "gitlink"));
  eq("type2 行 subState 同样生效", byPath["libs/renamed"].subState, "S...");
  eq("type2 行 gitlink fromSha", byPath["libs/renamed"].gitlink.fromSha, SUB_SHA_A);
  eq("type2 行 gitlink toSha", byPath["libs/renamed"].gitlink.toSha, SUB_SHA_C);
  eq("type2 行 oldPath 仍正确", byPath["libs/renamed"].oldPath, "libs/original");
  check("type2 行 N... 不挂 subState", !hasKey(byPath["new.txt"], "subState"));
  check("type2 行 hH===hI 不挂 gitlink", !hasKey(byPath["new.txt"], "gitlink"));
});

test("parseStatusV2: gitlink 按 mode 160000 收窄（普通已暂存文件不挂）", () => {
  // 2026-10-13 Lead 修复后钉住正确行为：attachSubFields 已加 mH/mI === "160000"
  // 判定——普通文件已暂存修改（blob sha 40 位且不等）不再误挂 gitlink，
  // 客户端不会再把普通已暂存文件渲染成「指针 a→b」行。修复前的偏差断言见
  // C 代理原版（git 记录），此处两条断言已按其注释要求反转。
  const fixture = [
    // 普通文件已暂存修改：mode 100644、hH!==hI
    "1 M. N... 100644 100644 100644 " + SUB_SHA_A + " " + SUB_SHA_B + " s.txt\0",
    // 新增文件：hH 是 40 个 0（porcelain v2 新增行），同样不应挂 gitlink
    "1 A. N... 100644 100644 100644 " + "0".repeat(40) + " " + SUB_SHA_C + " new.txt\0",
  ].join("");
  const r = core.parseStatusV2(fixture);
  const byPath = Object.fromEntries(r.staged.map((e) => [e.path, e]));
  check("普通已暂存文件不挂 gitlink", !hasKey(byPath["s.txt"], "gitlink"), JSON.stringify(byPath["s.txt"]));
  check("新增文件不挂 gitlink", !hasKey(byPath["new.txt"], "gitlink"), JSON.stringify(byPath["new.txt"]));
  check("两者都不该挂 subState（<sub> 是 N...）", !hasKey(byPath["s.txt"], "subState") && !hasKey(byPath["new.txt"], "subState"));
});

test("statusSummary: staged/unstaged/untracked/conflicted 四计数 + 空输入全 0", () => {
  const fixture = [
    "# branch.oid " + SUB_SHA_A + "\0",
    "# branch.head main\0",
    "1 M. N... 100644 100644 100644 " + SUB_SHA_A + " " + SUB_SHA_A + " a.js\0",
    "2 R. N... 100644 100644 100644 " + SUB_SHA_A + " " + SUB_SHA_A + " R100 newname.js\0",
    "oldname.js\0",
    "1 .M N... 100644 100644 100644 " + SUB_SHA_B + " " + SUB_SHA_B + " b.txt\0",
    "? newfile.txt\0",
    "u UU N... 100644 100644 100644 100644 h1 h2 h3 conf.txt\0",
  ].join("");
  eq("计数与 parseStatusV2 同口径", core.statusSummary(core.parseStatusV2(fixture)),
    { staged: 2, unstaged: 1, untracked: 1, conflicted: 1 });
  eq("空对象 → 全 0", core.statusSummary({}), { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  eq("null → 全 0", core.statusSummary(null), { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  eq("非数组/缺字段容忍 → 全 0", core.statusSummary({ staged: "x", unstaged: null }),
    { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  // 子仓库条目照常计入 unstaged（repoTree 每节点摘要与 status 同口径）
  const drift = core.parseStatusV2(
    "1 .M SC.. 160000 160000 160000 " + SUB_SHA_A + " " + SUB_SHA_A + " libs/base\0");
  eq("子仓库指针漂移计入 unstaged", core.statusSummary(drift),
    { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
});

test("validateRepoPath: 仓库内相对/绝对路径通过并归一化；越界抛 GitError(exit)", () => {
  const root = resolve(tmpdir());
  // 通过：相对路径 / 绝对路径 / root 自身 / "."
  eq("相对路径归一化为绝对路径", core.validateRepoPath(root, "libs/base"), resolve(root, "libs", "base"));
  eq("深层相对路径", core.validateRepoPath(root, "a/b/c/d.txt"), resolve(root, "a", "b", "c", "d.txt"));
  eq("仓库内绝对路径", core.validateRepoPath(root, join(root, "libs", "base")), resolve(root, "libs", "base"));
  eq("root 自身通过", core.validateRepoPath(root, root), resolve(root));
  eq("\".\" 归一到 root", core.validateRepoPath(root, "."), resolve(root));
  check("返回值是绝对路径（p === resolve(p)）", core.validateRepoPath(root, "x") === resolve(core.validateRepoPath(root, "x")));
  // Windows 大小写不敏感（方案 §5.3）：root 换大小写仍判为仓库内
  if (process.platform === "win32") {
    eq("win32 大小写不敏感（root 换大小写不误判越界）",
      core.validateRepoPath(root.toUpperCase(), "libs"), resolve(root.toUpperCase(), "libs"));
  } else {
    check("posix 大小写敏感（root 换大小写判为越界）", throwsExit(() => core.validateRepoPath(root, root.toUpperCase())));
  }
  // 越界：.. 穿越 / 盘符外绝对路径 / 空路径 / 空 root
  // 「..\escape」只在 win32 构成穿越：POSIX 反斜杠是合法文件名字符（不是分隔符），
  // 该平台上 resolve 后仍在 root 内 → 接受才是正确行为。此条 Windows 视角断言
  // 曾在 Linux CI 上必挂（2026-10-13 v1.4.0 首次发版实测），故平台条件化。
  const badPaths = ["..", "../escape", "a/../../escape", resolve(root, "..", "outside", "x.txt")];
  if (process.platform === "win32") badPaths.splice(2, 0, "..\\escape");
  for (const bad of badPaths) {
    check("越界拒绝: " + bad, throwsExit(() => core.validateRepoPath(root, bad)));
  }
  check("空路径拒绝", throwsExit(() => core.validateRepoPath(root, "")));
  check("空 root 拒绝", throwsExit(() => core.validateRepoPath("", "x")));

  function throwsExit(fn) {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof core.GitError && e.kind === "exit";
    }
  }
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
// 子仓库支持 P0 —— live：仓库树发现 + 嵌套仓库暂存/删除双重防护 + wire 守卫
//   （方案 docs/plans/2026-10-13-subrepo-support.md §2 / §5.1 / §6.3-6.4 / §6.8）
// ============================================================================

// fixture 的提交身份：不写进任何真实 git config，用环境变量钉死（沿用 tmp 仓库惯例）
const SUB_AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function gitIn(cwd, args) {
  // 注意 runShell 里 ...opts 在 env 之后展开，传 env 会整体替换——必须带上完整 env
  return runShell(cwd, ["git"].concat(args), {
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }, SUB_AUTHOR_ENV),
  });
}

// 子仓库 fixture（§6.1），全部建在 live() 给的 tmp 下（结束自动 rm）：
//   <tmp>/base-src            submodule 来源仓库（独立 init + 提交）
//   <tmp>/super               主仓库：含 libs/base（submodule）
//     ├─ libs/base/           子模块工作副本（opts.pointerMismatch 时已产生指针漂移）
//     ├─ vendor-tool/         嵌套独立仓库（自己的 .git）→ kind "nested"
//     └─ plain-dir/p.txt      普通未跟踪目录（无 .git）→ 负例，不应产生节点
// 新版 git 默认禁 file 协议，submodule add 本地仓库必须 -c protocol.file.allow=always。
async function makeSubFixture(root, opts = {}) {
  const initRepo = async (dir, file, content) => {
    await mkdir(dir, { recursive: true });
    await gitIn(dir, ["init", "-b", "main"]);
    // repo 本地身份：fixture 提交走 gitIn（env 身份），但**产品代码**（runGit 继承
    // process.env、无身份）在这些仓库里的 merge/cherry-pick 等提交路径需要身份；
    // CI runner 无全局 user.name/email（v1.4.0 发版实测：gitlink 冲突测试的
    // core.mergeBranch 报 "Committer identity unknown"）。env 身份不会传给产品
    // 进程（gitIn 仅作用于自身调用），故这里必须配 repo 本地 config。
    await gitIn(dir, ["config", "user.name", "sub-fixture"]);
    await gitIn(dir, ["config", "user.email", "sub-fixture@example.com"]);
    await writeFile(join(dir, file), content);
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "-qm", "init " + file]);
  };
  const baseSrc = join(root, "base-src");
  const sup = join(root, "super");
  await initRepo(baseSrc, "a.txt", "a1\n");
  await initRepo(sup, "s.txt", "s1\n");
  await gitIn(sup, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", baseSrc, "libs/base"]);
  await gitIn(sup, ["commit", "-qm", "add submodule"]);
  await initRepo(join(sup, "vendor-tool"), "n.txt", "n1\n");
  await mkdir(join(sup, "plain-dir"), { recursive: true });
  await writeFile(join(sup, "plain-dir", "p.txt"), "p1\n");
  if (opts.pointerMismatch !== false) {
    // 在子模块工作副本里提交 → 父仓库 index 记录的指针落后
    // → `git submodule status` 前缀 '+'、status 的 <sub> 位为 "SC.."
    await writeFile(join(sup, "libs", "base", "a.txt"), "a1\nb2\n");
    await gitIn(join(sup, "libs", "base"), ["commit", "-qam", "b2"]);
  }
  return { baseSrc, sup };
}

live("listSubRepos: root/submodule/nested 三节点齐 + 普通未跟踪目录不误报 + JSON-safe", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await writeFile(join(sup, "s.txt"), "s1\nmod\n"); // 普通未暂存改动
  const { repos } = await core.listSubRepos(sup);
  eq("三个节点，root 恒在 [0]，其余按 relPath 字典序", repos.map((n) => n.relPath), ["", "libs/base", "vendor-tool"]);

  const root = repos[0];
  eq("root kind", root.kind, "root");
  eq("root depth", root.depth, 0);
  eq("root id=relPath", root.id, "");
  eq("root initialized", root.initialized, true);
  check("root 不挂 submodule key", !hasKey(root, "submodule"), JSON.stringify(Object.keys(root)));
  eq("root 未暂存改动 2 条（s.txt + libs/base 指针漂移）", root.dirty.unstaged, 2);
  eq("root 未跟踪 2 个（plain-dir/ + vendor-tool/）", root.dirty.untracked, 2);

  const sub = repos[1];
  eq("submodule kind", sub.kind, "submodule");
  eq("submodule depth（relPath 段数）", sub.depth, 2);
  eq("submodule initialized", sub.initialized, true);
  eq("submodule name 取 .gitmodules 的 name", sub.name, "libs/base");
  eq("指针漂移 state", sub.submodule.state, "pointer-mismatch");
  check("sha 是 12 位", /^[0-9a-f]{12}$/.test(sub.submodule.sha), sub.submodule.sha);
  check("recordedSha 是 12 位", /^[0-9a-f]{12}$/.test(sub.submodule.recordedSha), sub.submodule.recordedSha);
  check("recordedSha ≠ sha（index 记录的指针落后于子模块 HEAD）", sub.submodule.recordedSha !== sub.submodule.sha,
    sub.submodule.recordedSha + " vs " + sub.submodule.sha);
  check("url 非空（.gitmodules 读出）", typeof sub.submodule.url === "string" && sub.submodule.url.length > 0, sub.submodule.url);
  eq("子模块自身工作区干净", sub.dirty, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });

  const nested = repos[2];
  eq("nested kind", nested.kind, "nested");
  eq("nested depth 1", nested.depth, 1);
  eq("nested name 取目录名", nested.name, "vendor-tool");
  check("nested 不挂 submodule key", !hasKey(nested, "submodule"), JSON.stringify(Object.keys(nested)));
  check("探测成功的节点不挂 error", !hasKey(nested, "error"));

  check("plain-dir 普通未跟踪目录不产生节点", !repos.some((n) => /plain-dir/.test(n.relPath)),
    JSON.stringify(repos.map((n) => n.relPath)));

  // JSON-safe 手检：可选 key 有值才挂（无 undefined/null），计数恒数字
  for (const n of repos) {
    for (const [k, v] of Object.entries(n)) {
      check(n.relPath + "." + k + " 不是 undefined", v !== undefined);
      check(n.relPath + "." + k + " 不是 null", v !== null);
    }
    for (const k of ["staged", "unstaged", "untracked", "conflicted"]) {
      check(n.relPath + ".dirty." + k + " 是数字", typeof n.dirty[k] === "number", JSON.stringify(n.dirty));
    }
  }
});

live("listSubRepos: 未初始化 submodule（deinit -f）仍列出且不挂 submodule key", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await gitIn(sup, ["submodule", "deinit", "-f", "libs/base"]);
  check("submodule status 是 '-' 前缀", /^-[0-9a-f]{40} libs\/base/m.test((await gitIn(sup, ["submodule", "status"])).stdout));

  const { repos } = await core.listSubRepos(sup);
  const sub = repos.find((n) => n.relPath === "libs/base");
  check("未初始化 submodule 仍在树里", !!sub, JSON.stringify(repos.map((n) => n.relPath)));
  eq("kind 仍是 submodule", sub.kind, "submodule");
  eq("initialized=false", sub.initialized, false);
  check("未初始化时不挂 submodule key", !hasKey(sub, "submodule"), JSON.stringify(Object.keys(sub)));
  eq("branch 空串（不是 null）", sub.branch, "");
  eq("headShort 空串", sub.headShort, "");
  eq("dirty 全 0", sub.dirty, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  eq("root 仍在 [0]", repos[0].kind, "root");
  check("嵌套仓库不受影响仍被发现", repos.some((n) => n.kind === "nested"));
});

live("stageFiles: all + exclude 挡住嵌套仓库被折成意外 gitlink（方案 §5.1）", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await writeFile(join(sup, "s.txt"), "s1\nmod\n");

  // 0) files 模式忽略 exclude：只 add 调用方给的路径
  const s0 = await core.stageFiles(sup, ["s.txt"], false, ["vendor-tool"]);
  check("files 模式暂存 s.txt", s0.staged.some((e) => e.path === "s.txt"));
  check("files 模式不消费 exclude（vendor-tool 仍未跟踪）", s0.untracked.indexOf("vendor-tool/") >= 0,
    JSON.stringify(s0.untracked));

  // 1) all + exclude：嵌套仓库目录保持未跟踪，其余照常暂存
  const s1 = await core.stageFiles(sup, [], true, ["vendor-tool"]);
  eq("exclude 后 vendor-tool 无 staged 条目", s1.staged.some((e) => e.path === "vendor-tool"), false);
  check("exclude 后 vendor-tool 仍未跟踪", s1.untracked.indexOf("vendor-tool/") >= 0, JSON.stringify(s1.untracked));
  check("其余改动正常暂存（s.txt）", s1.staged.some((e) => e.path === "s.txt"));
  const idx1 = (await gitIn(sup, ["ls-files", "-s"])).stdout;
  check("index 里没有 vendor-tool 条目", !/vendor-tool/.test(idx1), idx1);

  // 2) 对照组：不带 exclude → git add -A 把嵌套仓库折成 mode 160000 的意外 gitlink
  const s2 = await core.stageFiles(sup, [], true);
  check("无 exclude 时 vendor-tool 进 staged", s2.staged.some((e) => e.path === "vendor-tool"));
  const idx2 = (await gitIn(sup, ["ls-files", "-s"])).stdout;
  check("对照组 index 里 vendor-tool 是 mode 160000 gitlink（意外嵌入仓库）",
    /^160000 [0-9a-f]{40} 0\tvendor-tool$/m.test(idx2), idx2);
});

live("discardFiles: 含 .git 的路径跳过不删（skipped），普通未跟踪文件照删", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await writeFile(join(sup, "p.txt"), "top\n"); // 顶层未跟踪文件（git 不折叠它）
  const raw = await core.discardFiles(sup, ["p.txt", "vendor-tool/"], true);
  // status 的未跟踪清单来自 --untracked-files=normal，未跟踪目录是折叠形态（"dir/"），
  // 因此客户端传的也是折叠路径；嵌套仓库因含 .git 被跳过不删。
  eq("跳过列表含嵌套仓库目录", raw.skipped, ["vendor-tool/"]);
  eq("顶层未跟踪文件被删", existsSync(join(sup, "p.txt")), false);
  check("嵌套仓库内容仍在（历史不被 rm -rf 抹掉）", existsSync(join(sup, "vendor-tool", "n.txt")));
  check("嵌套仓库 .git 仍在", existsSync(join(sup, "vendor-tool", ".git")));
  check("skipped 挂 status 上（Host 入口再提到 envelope）", hasKey(raw, "skipped"));

  // includeUntracked=false：什么都不删，且 skipped 为空时不挂 key（JSON-safe）
  const raw2 = await core.discardFiles(sup, ["vendor-tool/"], false);
  check("includeUntracked=false 时不挂 skipped key", !hasKey(raw2, "skipped"), JSON.stringify(Object.keys(raw2)));
  check("未跟踪目录没被删", existsSync(join(sup, "vendor-tool", "n.txt")));
});

live("wire: repoTree 真实返回值过 strict schema + JSON-safe（root/submodule/nested 三形态）", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  // 与 index.js repoTree 同组装：请求 path 可以是仓库内子目录，Host 先 probeRepo 取
  // toplevel 再发现（git submodule status 对 cwd 敏感，必须在 root toplevel 跑），
  // 最后把 listSubRepos 的返回值原样包进 envelope。
  const probe = await core.probeRepo(join(sup, "plain-dir")); // 普通未跟踪子目录 → toplevel 归到 super
  eq("子目录请求归一到主仓库 toplevel", resolve(probe.toplevel).toLowerCase(), resolve(sup).toLowerCase());
  const tree = await core.listSubRepos(probe.toplevel);
  eq("三种节点形态齐（wire 守卫必须全覆盖）", tree.repos.map((n) => n.kind).sort(), ["nested", "root", "submodule"]);
  wireCheck("repoTree", tree);
});

live("wire: discard 组装 { status, skipped } 与 index.js 逐字段一致", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await writeFile(join(sup, "p.txt"), "top\n");
  // 镜像 index.js discard 的组装：status 先 copy raw，再把 skipped 提到 envelope（有值才挂），
  // 最后删掉 status 里的 skipped——status 必须严格对齐 statusSchema（否则 zod 会剥掉它）
  const raw = await core.discardFiles(sup, ["p.txt", "vendor-tool/"], true);
  const value = { status: Object.assign({}, raw) };
  if (Array.isArray(raw.skipped) && raw.skipped.length > 0) value.skipped = raw.skipped;
  delete value.status.skipped;
  check("skipped 被提到 envelope", value.skipped.length > 0);
  check("status 内不残留 skipped", !hasKey(value.status, "skipped"), JSON.stringify(Object.keys(value.status)));
  wireCheck("discard", value);

  // 无跳过路径：可选 key 不挂（显式 undefined 的 own key 会被网关 assertJsonValue 拒绝）
  const raw2 = await core.discardFiles(sup, ["plain-dir/", "vendor-tool/"], false);
  const value2 = { status: Object.assign({}, raw2) };
  if (Array.isArray(raw2.skipped) && raw2.skipped.length > 0) value2.skipped = raw2.skipped;
  delete value2.status.skipped;
  check("无跳过时不挂 skipped", !hasKey(value2, "skipped"));
  wireCheck("discard", value2);
});

live("wire: status 含子仓库条目（subState 未暂存漂移 + gitlink 已暂存指针两条路径）", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await writeFile(join(sup, "s.txt"), "s1\nmod\n");
  // 未暂存漂移：<sub> = "SC.."，hH===hI → 只有 subState
  const unstaged = await core.getStatus(sup);
  const drift = unstaged.unstaged.find((e) => e.path === "libs/base");
  check("指针漂移条目在 unstaged", !!drift, JSON.stringify(unstaged.unstaged));
  eq("<sub> 原样挂载 SC..", drift.subState, "SC..");
  check("未暂存漂移不挂 gitlink", !hasKey(drift, "gitlink"), JSON.stringify(drift));
  wireCheck("status", unstaged);

  // 暂存新指针：<sub> = "S..."，hH!==hI → 挂 gitlink
  await gitIn(sup, ["add", "libs/base"]);
  const staged = await core.getStatus(sup);
  const ptr = staged.staged.find((e) => e.path === "libs/base");
  check("已暂存指针条目在 staged", !!ptr, JSON.stringify(staged.staged));
  eq("暂存后 <sub> 是 S...", ptr.subState, "S...");
  check("挂 gitlink", hasKey(ptr, "gitlink"));
  check("gitlink 两侧是 40 位小写 sha 且不相等",
    /^[0-9a-f]{40}$/.test(ptr.gitlink.fromSha) && /^[0-9a-f]{40}$/.test(ptr.gitlink.toSha) && ptr.gitlink.fromSha !== ptr.gitlink.toSha,
    JSON.stringify(ptr.gitlink));
  wireCheck("status", staged);
});

// ============================================================================
// 子仓库支持 P1 —— live：revExists 门控 / gitlink 冲突分派 / discard 递归删目录
//   （方案 docs/plans/2026-10-13-subrepo-support.md §2.3 resolveConflict /
//     §3.6 历史 Tab 的「在子仓库中查看 a..b」可用性门控 /
//     §7 P1「未跟踪目录的 discard 删除支持」）
// ============================================================================

// ---- P1-1：revExists 入参白名单（本地校验，非法形态根本不发 git）------------
// 白名单 REV_EXISTS_SHA_RE = /^[0-9a-fA-F]{7,40}$/（git-core.mjs）。
// 判别「本地拒绝」与「git 报错」的两个互斥信号：
//   本地：message 形如 "revExists 非法 sha：…"，且没有 exitCode 字段
//   git：message 是 git 原文（"not a git repository"），且 exitCode=128
// 因此下面刻意把非法用例跑在**一个非仓库目录**上：拿到本地错误就证明校验发生在
// 发 git 之前（若是 git 报错，目录必须先是仓库才有意义）。
live("revExists: 入参白名单只收 7-40 位纯 hex（非法形态本地抛 GitError(exit)，不发 git）", async (tmp) => {
  const notRepo = await mkdtemp(join(tmpdir(), "dsh-git-revexists-notrepo-"));
  try {
    const illegal = [
      "",                                              // 空串
      "abc", "123456",                                 // 长度不足（<7）
      "abcdefg!", "g".repeat(40), "0x12345678",        // 非 hex 字符
      "HEAD", "master", "refs/heads/main", "@{yesterday}", // 引用名（checkRev 放行、这里不放行）
      "aaaaaaa..bbbbbbb",                              // 范围表达式
      "--upload-pack", "--upload-pack=x",              // argv 注入面（拼 ^{commit} 前缀也拦得住）
      "0123456789abcdef 0123456789abcdef0123456789abcdef0123456", // 含空格
      "0123456789abcdef0123456789abcdef0123456789",    // 41 位（超上界）
      "0123456789ABCDEF0123456789abcdef0123456789",    // 41 位纯 hex 混合大小写
    ];
    for (const bad of illegal) {
      let caught;
      try { await core.revExists(notRepo, [bad]); } catch (e) { caught = e; }
      check("非法 rev " + JSON.stringify(bad) + " 抛 GitError", caught instanceof core.GitError);
      eq("非法 rev " + JSON.stringify(bad) + " kind=exit", caught.kind, "exit");
      check("…消息来自本地白名单而非 git", /revExists 非法 sha/.test(caught.message), caught.message);
      check("…没有 exitCode（说明没跑过 git）", caught.exitCode === undefined, String(caught.exitCode));
    }
    // 非字符串元素同样被本地拒绝（与 checkRev 的宽容度刻意不同）
    for (const bad of [null, 123, {}, ["abc"]]) {
      let caught;
      try { await core.revExists(notRepo, [bad]); } catch (e) { caught = e; }
      check("非字符串元素 " + JSON.stringify(bad) + " 抛 GitError", caught instanceof core.GitError);
      eq("…kind=exit", caught.kind, "exit");
      check("…同样是本地白名单拦下", /revExists 非法 sha/.test(caught.message), caught.message);
    }

    // 对照：合法 hex 能过本地校验层，落到 git 后由 git 判定（在非仓库目录上 exit 128）
    let caught;
    try { await core.revExists(notRepo, ["abcdef1234567"]); } catch (e) { caught = e; }
    check("合法 hex 不被本地拒绝", caught instanceof core.GitError && !/非法 sha/.test(caught.message),
      caught && caught.message);
    eq("合法 hex 确实发到了 git（非仓库 → exit 128）", caught.exitCode, 128);

    // 合法 hex 在真仓库里：大小写都过校验层，ok 由 git 决定（实测 git 接受大写 sha）
    const head = (await gitIn(tmp, ["rev-parse", "HEAD"])).stdout.trim();
    const up = await core.revExists(tmp, [head.toUpperCase()]);
    eq("大写 hex 同样通过校验层且 git 认得", up.checks, [{ rev: head.toUpperCase(), ok: true }]);
  } finally {
    await rm(notRepo, { recursive: true, force: true });
  }
});

// ---- P1-2：revExists live（§3.6 跳转门控的数据来源）------------------------

live("revExists: 存在的 sha ok=true / 编造 sha ok=false / 与请求同序 / 空列表", async (tmp) => {
  await writeFile(join(tmp, "second.txt"), "s\n");
  await gitIn(tmp, ["add", "-A"]);
  await gitIn(tmp, ["commit", "-qm", "second"]);
  const head = (await gitIn(tmp, ["rev-parse", "HEAD"])).stdout.trim();      // 40 位
  const head12 = head.slice(0, 12);                                          // 12 位短 sha
  const prev = (await gitIn(tmp, ["rev-parse", "HEAD~1"])).stdout.trim();    // 另一个真实 commit
  const fakeA = "f".repeat(40);                                              // 40 位合法 hex，不存在
  const fakeB = "1234567890abcdef".repeat(2) + "12345678";                   // 同上，形态更像真 sha
  // 请求里刻意把「不存在的」夹在中间 → 顺序错位会被下面的同序断言抓住
  const revs = [fakeA, head, head12, fakeB, prev, head.toUpperCase()];
  const r = await core.revExists(tmp, revs);
  eq("checks 与请求逐项同序（不排序、不去重）", r.checks.map((c) => c.rev), revs);
  eq("ok 逐项由 git 判定", r.checks.map((c) => c.ok), [false, true, true, false, true, true]);
  eq("每个元素恒是 {rev, ok} 两字段", Object.keys(r.checks[0]), ["rev", "ok"]);

  // 空 / 非法类型入参 → 空 checks（schema 里恒为数组，客户端可直接 map）
  eq("空 revs → {checks:[]}", await core.revExists(tmp, []), { checks: [] });
  eq("非数组入参 → {checks:[]}", await core.revExists(tmp, undefined), { checks: [] });
  eq("空结果自身 JSON-safe（无 undefined/null）", JSON.stringify(await core.revExists(tmp, [])), '{"checks":[]}');

  // 请求 path 传仓库内普通子目录也可用（git 在子目录跑 rev-parse 一样认仓库）
  await mkdir(join(tmp, "sub"), { recursive: true });
  const inSub = await core.revExists(join(tmp, "sub"), [head, fakeA]);
  eq("子目录 path 结果一致", inSub.checks.map((c) => c.ok), [true, false]);
});

// ---- P1-3：resolveConflict 的 gitlink 分派（§2.3 / §5.2 冲突态）------------
//
// 实测前提（踩过的坑，写在这里免得后人重排 fixture 时踩回去）：
//   gitlink 冲突必须两侧指针**互不为祖先**才产生。若一侧是另一侧的祖先，git 直接
//   fast-forward 指针（"Fast-forwarding submodule libs/base to …"）、merged=true，
//   根本没有冲突态可测。所以下面在子模块里从同一 base 拉两条分叉分支造 shaY/shaZ。
//
// 为什么本测试断言「index 里记录的是选中侧的指针」而不是别的：实测 git 2.53 的
//   `git checkout --ours/--theirs -- <gitlink>` 对 mode 160000 未合并条目是**静默
//   空操作**（退出码 0、无输出、三个 stage 原样保留），随后 `git add` 记的是子
//   仓库工作区当前 HEAD ——「选他们的」会落成我们的指针。产品因此改用
//   update-index --cacheinfo 写 index + best-effort 同步子仓库工作区，下面逐项
//   断言这两半（选中侧指针进 index、子仓库工作区跟到同一指针、不留指针漂移）。
live("resolveConflictFile: gitlink（子模块指针）冲突分派 —— custom 拒绝 + ours/theirs + wire", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  const sub = join(sup, "libs", "base");
  // 子模块里造两个互不为祖先的提交
  await gitIn(sub, ["switch", "-q", "-c", "py"]);
  await writeFile(join(sub, "y.txt"), "y\n");
  await gitIn(sub, ["add", "-A"]);
  await gitIn(sub, ["commit", "-qm", "py"]);
  const shaY = (await gitIn(sub, ["rev-parse", "HEAD"])).stdout.trim();
  await gitIn(sub, ["switch", "-q", "main"]);
  await gitIn(sub, ["switch", "-q", "-c", "pz"]);
  await writeFile(join(sub, "z.txt"), "z\n");
  await gitIn(sub, ["add", "-A"]);
  await gitIn(sub, ["commit", "-qm", "pz"]);
  const shaZ = (await gitIn(sub, ["rev-parse", "HEAD"])).stdout.trim();
  check("两个指针互不为祖先（否则 git 会 fast-forward 不产生冲突）", shaY !== shaZ && shaY.length === 40 && shaZ.length === 40);
  const headOfSub = async () => (await gitIn(sub, ["rev-parse", "HEAD"])).stdout.trim();

  // super 侧两条分支各自把 gitlink 指到不同提交（子模块工作副本停在 ours=main 侧，
  // 这是「在 main 上合并」的常态）
  await gitIn(sup, ["switch", "-q", "-c", "brA"]);
  await gitIn(sub, ["checkout", "-q", shaY]);
  await gitIn(sup, ["add", "libs/base"]);
  await gitIn(sup, ["commit", "-qm", "brA ptr"]);
  await gitIn(sup, ["switch", "-q", "main"]);
  await gitIn(sub, ["checkout", "-q", shaZ]);
  await gitIn(sup, ["add", "libs/base"]);
  await gitIn(sup, ["commit", "-qm", "main ptr"]);

  const mergeToConflict = async () => {
    const m = await core.mergeBranch(sup, "brA");
    eq("合并未成功（merged=false）", m.merged, false);
    check("status.conflicted 含 libs/base",
      m.status.conflicted.some((e) => e.path === "libs/base"), JSON.stringify(m.status.conflicted));
    eq("conflicted 条目形如 {path, xy}", m.status.conflicted[0].xy, "UU");
    eq("merging=true（MERGE_HEAD 在）", m.status.merging, true);
    const u = (await gitIn(sup, ["ls-files", "-u", "--", "libs/base"])).stdout;
    check("index 是 3 阶段 mode 160000 的真 gitlink 冲突（不是文本冲突）",
      /^160000 [0-9a-f]{40} 1\tlibs\/base$/m.test(u) && /^160000 [0-9a-f]{40} 2\tlibs\/base$/m.test(u) &&
      /^160000 [0-9a-f]{40} 3\tlibs\/base$/m.test(u), u);
    return m;
  };
  const indexSha = async () => (await gitIn(sup, ["ls-files", "-s", "--", "libs/base"])).stdout.trim();

  await mergeToConflict();

  // 1) custom：指针冲突没有可编辑文本 → 直接拒绝，且不得顺手把冲突解掉
  let caught;
  try { await core.resolveConflictFile(sup, "libs/base", "custom", "whatever"); } catch (e) { caught = e; }
  check("custom 抛 GitError", caught instanceof core.GitError);
  eq("custom kind=exit", caught.kind, "exit");
  check("消息含「指针冲突」", /指针冲突/.test(caught.message), caught && caught.message);
  check("custom 没有把冲突解掉（仍在冲突态）",
    (await core.getStatus(sup)).conflicted.some((e) => e.path === "libs/base"));

  // 2) ours（= index stage2）：index 记我们的指针，子仓库工作区跟过去，不留漂移
  const oursStatus = await core.resolveConflictFile(sup, "libs/base", "ours");
  eq("ours 后 conflicted 清空", oursStatus.conflicted.length, 0);
  eq("index 只剩 stage 0 且是 ours 侧指针", await indexSha(), "160000 " + shaZ + " 0\tlibs/base");
  eq("子仓库工作区跟到同一指针（不留 modified: libs/base 漂移）", await headOfSub(), shaZ);
  check("status 里不再有 libs/base 条目", !oursStatus.unstaged.some((e) => e.path === "libs/base"),
    JSON.stringify(oursStatus.unstaged));
  eq("merged 态仍在（MERGE_HEAD 未清，UI 仍显示 banner）", oursStatus.merging, true);
  wireCheck("resolveConflict", { status: oursStatus }); // 与 index.js resolveConflict 同组装 {status}

  // 3) 重置冲突再测 theirs（merge --abort 清 MERGE_HEAD；重新合并得到同样 3 阶段冲突，
  //    子仓库工作副本仍在 ours 侧 → 才测得出「选 theirs」是否真的换了指针）
  await core.abortMerge(sup);
  await gitIn(sub, ["checkout", "-q", shaZ]);
  await mergeToConflict();

  const theirsStatus = await core.resolveConflictFile(sup, "libs/base", "theirs");
  eq("theirs 后 conflicted 清空", theirsStatus.conflicted.length, 0);
  eq("index 只剩 stage 0 且是 theirs 侧指针（不是 ours 侧！）",
    await indexSha(), "160000 " + shaY + " 0\tlibs/base");
  eq("子仓库工作区也切到 theirs 指针", await headOfSub(), shaY);
  check("theirs 后 status 里不再有 libs/base 漂移条目",
    !theirsStatus.unstaged.some((e) => e.path === "libs/base"), JSON.stringify(theirsStatus.unstaged));
  wireCheck("resolveConflict", { status: theirsStatus });

  // 4) 未知 strategy 仍报错（gitlink 分支不许把拼错的 strategy 静默当成 ours）
  await core.abortMerge(sup);
  await mergeToConflict();
  let caught2;
  try { await core.resolveConflictFile(sup, "libs/base", "sideways"); } catch (e) { caught2 = e; }
  check("未知 strategy 抛 GitError(exit)", caught2 instanceof core.GitError && caught2.kind === "exit");
  check("…消息含「未知 strategy」", /未知 strategy/.test(caught2.message), caught2 && caught2.message);
});

// ---- P1-4：discardFiles 递归删未跟踪目录（§7 P1）---------------------------
// P1 前 `rm(abs,{force:true})` 缺 recursive，未跟踪目录被吞错删不掉；
// 修复后 rm 带 recursive，同时 containsGitDir 防护仍**先于**删除判定。
live("discardFiles: 未跟踪目录递归删除（includeUntracked=true）+ 防护顺序不变", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  await mkdir(join(sup, "plain-dir", "sub"), { recursive: true });
  await writeFile(join(sup, "plain-dir", "sub", "deep.txt"), "deep\n");

  // includeUntracked=false：只做已跟踪 restore，未跟踪目录分毫不动；
  // 且没有跳过项时不挂 skipped key（显式 undefined 的 own key 会被网关拒绝）
  const keep = await core.discardFiles(sup, ["plain-dir/", "vendor-tool/"], false);
  check("includeUntracked=false 时未跟踪目录仍在", existsSync(join(sup, "plain-dir", "sub", "deep.txt")));
  check("…目录整棵还在", existsSync(join(sup, "plain-dir")));
  check("没走到删除分支 → 不挂 skipped key", !hasKey(keep, "skipped"), JSON.stringify(Object.keys(keep)));
  check("未跟踪清单仍含 plain-dir/", keep.untracked.indexOf("plain-dir/") >= 0, JSON.stringify(keep.untracked));

  // includeUntracked=true：整棵目录递归消失；含 .git 的嵌套仓库仍被防护跳过
  const gone = await core.discardFiles(sup, ["plain-dir/", "vendor-tool/"], true);
  eq("skipped 含嵌套仓库目录（containsGitDir 先于删除判定）", gone.skipped, ["vendor-tool/"]);
  eq("未跟踪目录整体消失", existsSync(join(sup, "plain-dir")), false);
  check("递归删除连子目录一起没了（不留残骸）", !existsSync(join(sup, "plain-dir", "sub")));
  check("状态里也不再列该目录", gone.untracked.indexOf("plain-dir/") < 0, JSON.stringify(gone.untracked));
  check("嵌套仓库内容仍在（历史不被 rm -rf 抹掉）", existsSync(join(sup, "vendor-tool", "n.txt")));
  check("嵌套仓库 .git 仍在", existsSync(join(sup, "vendor-tool", ".git")));
  check("嵌套仓库仍在未跟踪清单里", gone.untracked.indexOf("vendor-tool/") >= 0, JSON.stringify(gone.untracked));
});

// ---- P1-5：wire 守卫 —— revExists 真实返回值过 strict schema + JSON-safe ---

live("wire: revExists 真实返回值过 strict schema + JSON-safe（命中/未命中/空数组）", async (tmp) => {
  const head = (await gitIn(tmp, ["rev-parse", "HEAD"])).stdout.trim();
  const fake = "f".repeat(40);
  // 镜像 index.js revExists 的组装：value 就是 revExists 的返回值本身，不加壳
  const value = await core.revExists(tmp, [head, fake]);
  eq("返回值原样透传（index.js 不做二次组装）", value, {
    checks: [{ rev: head, ok: true }, { rev: fake, ok: false }],
  });
  wireCheck("revExists", value);
  // 空数组形态同样必须过 schema（客户端会直接 .map）
  const empty = await core.revExists(tmp, []);
  wireCheck("revExists", empty);
  check("checks 里不出现 undefined 字段（显式 undefined 会被网关 assertJsonValue 拒）",
    Object.keys(value.checks[0]).every((k) => value.checks[0][k] !== undefined), JSON.stringify(value));
});

// ============================================================================
// 子仓库支持 P2 —— submodule 管理五方法（init / update / sync / deinit / add）
//   （方案 docs/plans/2026-10-13-subrepo-support.md §2.2 + §7 P2）
//
// 契约要点（与 git-core.mjs 实装对齐）：
//   - 位置参数是**仓库内路径** subPath（相对 toplevel），不是 .gitmodules 注册名；
//     全部 subPath 过 safeJoin（拒绝对路径与 .. 越界）。
//   - add 的 url 是**用户在 UI 里显式输入/选择**的本地路径时，自动前置
//     `-c protocol.file.allow=always`（git 2.38.1+ 默认 protocol.file.allow=user，
//     不放行就 fatal: transport 'file' not allowed —— 见下面 add 那一步）。
//   - update / add 可能触发 clone（走网络）→ runGitNet；其余 runGit。
//   - deinit 必填 subPath：缺省会清空**全部**子模块，core 层直接抛错。
//   - 返回值：前四个 { status }，add 额外带新子仓库的 probe（客户端据此插入新节点）。
// ============================================================================

// ---- P2-0：checkSubmoduleName 白名单（纯函数，不跑 git）---------------------
// 只有 submoduleAdd 的 --name 用它。收紧依据：submodule name 会被当作 config key
// `submodule.<name>.path` / `.url` 的一段，git 的 config 解析比 check-ref-format 宽，
// 故按 checkRefName 同款规则收紧（非空；禁空白与 ~^:?*[\ ；禁 - 与 . 开头；禁 ..；
// 禁 / 结尾）。
test("checkSubmoduleName: submodule 注册名白名单（空/-./.. / 空白 / ~^:?*[\\ / 结尾全拒；libs/extra·base_2·a.b.c 放行）", () => {
  const illegal = [
    ["", "空串"],
    ["-x", "以 - 开头（会被 git 当选项）"],
    ["--upload-pack=x", "以 - 开头（选项注入面）"],
    [".x", "以 . 开头（保留的相对路径标记）"],
    ["a..b", "含 .."],
    ["a b", "含空格"],
    ["a\tb", "含制表符"],
    ["a\nb", "含换行"],
    ["a~b", "含 ~"],
    ["a^b", "含 ^"],
    ["a:b", "含 :"],
    ["a?b", "含 ?"],
    ["a*b", "含 *"],
    ["a[b", "含 ["],
    ["a\\b", "含反斜杠"],
    ["libs/", "以 / 结尾"],
    [null, "null"],
    [123, "非字符串"],
    [undefined, "undefined"],
  ];
  for (const [bad, why] of illegal) {
    let caught;
    try { core.checkSubmoduleName(bad, "submoduleAdd"); } catch (e) { caught = e; }
    check("非法名 " + JSON.stringify(bad) + "（" + why + "）抛 GitError", caught instanceof core.GitError);
    eq("…kind=exit", caught.kind, "exit");
    check("…消息带调用方 label（定位得到是谁抛的）", /^submoduleAdd/.test(caught.message), caught.message);
    check("…消息里能看到被拒的名字（空串/null 除外）",
      bad === "" || bad === null || bad === undefined || bad === 123 || caught.message.indexOf(String(bad)) >= 0,
      caught.message);
  }
  for (const ok of ["libs/extra", "base_2", "a.b.c", "vendor-tool"]) {
    eq("合法名 " + ok + " 原样返回（不改写）", core.checkSubmoduleName(ok, "submoduleAdd"), ok);
  }
  // label 缺省也有前缀（导出函数的默认路径）
  let caught;
  try { core.checkSubmoduleName(""); } catch (e) { caught = e; }
  check("label 缺省时消息仍有 submodule 前缀", /^submodule/.test(caught.message), caught && caught.message);
});

// ---- 共用：额外的 submodule 来源仓库（base2 / base3）------------------------
// 刻意**不**给仓库写 protocol.file.allow 配置：新版 git 默认禁 file 传输，
// 只有产品代码自动前置 -c protocol.file.allow=always 才能 clone 成功——
// 写进配置会让这条断言失去意义（AGENTS.md 已记：file 协议 fixture 必须放行）。
async function makeSrcRepo(root, name, file, content) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await gitIn(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, file), content);
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "-qm", "init " + name]);
  return dir;
}

// git 在 .gitmodules / config 里把本地路径规范成正斜杠形态
function gitPath(p) {
  return String(p).replace(/\\/g, "/");
}

// 路径等价比较（容忍 git 写 .gitmodules 时对 Windows 反斜杠做的 C 风格转义：
// 原值 C:\a\b 在文件里落成 C:\\a\\b，但 `git config --get` 读回时已还原）
function pathLooseEq(a, b) {
  const norm = (s) => {
    const v = String(s).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? v.toLowerCase() : v;
  };
  return norm(a) === norm(b);
}

// ---- P2-1：live 全生命周期（add → deinit → init → update → sync）------------
live("submodule 五方法: add(local url 自动放行) → deinit(无 force 拒/带 force 清空) → init(只注册) → update(检出) → sync(改 url) + 入参白名单", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  const base2 = await makeSrcRepo(tmp, "base2-src", "b.txt", "b1\n");
  const base3 = await makeSrcRepo(tmp, "base3-src", "c.txt", "c1\n");
  const subExtra = join(sup, "libs", "extra");

  // ---- 1) add：本地绝对路径 url（产品自动前置 protocol.file.allow=always）----
  const added = await core.submoduleAdd(sup, { url: base2, subPath: "libs/extra" });
  const gm = await readFile(join(sup, ".gitmodules"), "utf8");
  check(".gitmodules 里出现 libs/extra 条目", /\[submodule "libs\/extra"\]/.test(gm) && /path = libs\/extra/.test(gm), gm);
  // 用 git 自己的 config 读回比较：Windows 下 git 会把 C:\a\b 在文件里写成 C:\\a\\b
  // （C 风格转义），`git config --get` 读回时还原，因此按读回值比对而不是按原始文本
  const gmUrl = (await gitIn(sup, ["config", "-f", ".gitmodules", "--get", "submodule.libs/extra.url"])).stdout.trim();
  check(".gitmodules 记录的 url 指回 base2 绝对路径", pathLooseEq(gmUrl, base2), gmUrl + " vs " + base2);
  const lsExtra = (await gitIn(sup, ["ls-files", "-s", "--", "libs/extra"])).stdout.trim();
  check("index 里是 mode 160000 的 gitlink", /^160000 [0-9a-f]{40} 0\tlibs\/extra$/.test(lsExtra), lsExtra);
  check("子模块目录已 materialize（file 协议自动放行生效，否则 clone 会 fatal）",
    existsSync(join(subExtra, "b.txt")), subExtra);
  eq("返回值带 probe（客户端据此插入新树节点）", Object.keys(added).sort(), ["probe", "status"]);
  check("probe.isRepo", added.probe.isRepo === true, JSON.stringify(added.probe));
  check("probe.branch 非空（克隆到来源仓库的默认分支）",
    typeof added.probe.branch === "string" && added.probe.branch.length > 0, JSON.stringify(added.probe.branch));
  check("probe.toplevel 就是新子模块目录",
    resolve(added.probe.toplevel).toLowerCase() === resolve(subExtra).toLowerCase(), added.probe.toplevel);

  // ---- 2) deinit：子模块有改动时不带 force 必须被 git 拒绝 --------------------
  await writeFile(join(subExtra, "dirty.txt"), "d\n"); // 未跟踪内容即算「有改动」
  let caught;
  try { await core.submoduleDeinit(sup, "libs/extra"); } catch (e) { caught = e; }
  check("deinit 不带 force 且子模块有改动 → GitError", caught instanceof core.GitError, String(caught));
  eq("…kind=exit", caught.kind, "exit");
  check("…拒绝是原子的（工作副本内容没被动）", existsSync(join(subExtra, "dirty.txt")) && existsSync(join(subExtra, "b.txt")));
  let caught2;
  try { await core.submoduleDeinit(sup); } catch (e) { caught2 = e; }
  check("deinit 缺 subPath 抛 GitError（缺省会清空全部子模块）", caught2 instanceof core.GitError);
  check("…消息提到 subPath", /subPath/.test(caught2.message), caught2 && caught2.message);

  const deinitRes = await core.submoduleDeinit(sup, "libs/extra", true);
  check("带 force 后目录内容清空（b.txt / 未跟踪文件都没了）",
    !existsSync(join(subExtra, "b.txt")) && !existsSync(join(subExtra, "dirty.txt")), subExtra);
  // 「工作副本不再是仓库」的判据不能用 `rev-parse HEAD`：空目录仍落在**父仓库**内部，
  // git 会向上找到 super 并解析出父仓库的 HEAD（实测）。必须比对 --show-toplevel。
  const tlAfter = (await gitIn(subExtra, ["rev-parse", "--show-toplevel"])).stdout.trim();
  check("deinit 后 libs/extra 不再是仓库（--show-toplevel 落到父仓库）",
    resolve(tlAfter).toLowerCase() !== resolve(subExtra).toLowerCase(), tlAfter);
  let cfgUrl;
  try { cfgUrl = (await gitIn(sup, ["config", "--get", "submodule.libs/extra.url"])).stdout.trim(); }
  catch (_) { cfgUrl = ""; }
  eq("deinit 后本地 submodule.<name>.url 被注销（.gitmodules 条目保留）", cfgUrl, "");
  const nodeAfterDeinit = (await core.listSubRepos(sup)).repos.find((n) => n.relPath === "libs/extra");
  eq("listSubRepos：未初始化的 libs/extra 仍在树里", nodeAfterDeinit.kind, "submodule");
  eq("…initialized=false", nodeAfterDeinit.initialized, false);
  check("…未初始化节点不挂 submodule key", !hasKey(nodeAfterDeinit, "submodule"), JSON.stringify(Object.keys(nodeAfterDeinit)));
  check("deinit 返回 { status }（不带 probe）", hasKey(deinitRes, "status") && !hasKey(deinitRes, "probe"),
    JSON.stringify(Object.keys(deinitRes)));

  // ---- 3) init：只把 .gitmodules 落到本地 config，**不**检出工作副本 ----------
  //
  // 实测（git 2.53，与文档措辞不同，写在这里免得后人再踩）：`git submodule status`
  // 的 `-` 前缀跟踪的是**工作副本是否已 populate**（子目录里有 .git），而不是
  // 「.gitmodules 条目是否已注册进本地 config」—— `submodule init` 之后该行**仍是**
  // `-`，直到 update 检出内容才变成 ' '。所以「已注册」的正判据是本地 config 里
  // 出现了 submodule.<name>.url。
  // （行形态：未 populate = `-<sha> libs/extra`；已 populate = ` <sha> libs/extra (heads/main)`，
  //  故按 ` libs/extra` 后接空白/行尾来定位，不能用 $ 锚。）
  const stLineOf = async (relPath) => (await gitIn(sup, ["submodule", "status"])).stdout
    .split("\n").find((l) => new RegExp(" " + relPath + "(\\s|$)").test(l));
  const initRes = await core.submoduleInit(sup, "libs/extra");
  const cfgUrl1 = (await gitIn(sup, ["config", "--get", "submodule.libs/extra.url"])).stdout.trim();
  check("init 把 .gitmodules 的 url 注册进本地 config（『已注册』的可观测判据）",
    pathLooseEq(cfgUrl1, base2), cfgUrl1 + " vs " + base2);
  const stLine = await stLineOf("libs/extra");
  check("init 之后 submodule status 该行仍是 '-'（工作副本未 populate，git 2.53 实测语义）",
    !!stLine && stLine[0] === "-", String(stLine));
  check("init 不检出工作副本（目录仍空）", !existsSync(join(subExtra, "b.txt")));
  // 产品侧同款语义：initialized 跟着「工作副本在不在」走 → init 之后仍是 false。
  // 客户端必须 init+update **成对调用**才能让树里的节点变成可下钻状态（见 update 那步）。
  const nodeAfterInit = (await core.listSubRepos(sup)).repos.find((n) => n.relPath === "libs/extra");
  eq("listSubRepos：init 后 initialized 仍为 false（只有 update 检出后才翻转）",
    nodeAfterInit.initialized, false);
  check("init 返回 { status }", hasKey(initRes, "status") && !hasKey(initRes, "probe"), JSON.stringify(Object.keys(initRes)));

  // ---- 4) update --init --recursive：真正 clone + checkout -------------------
  const updRes = await core.submoduleUpdate(sup, { subPath: "libs/extra", init: true, recursive: true });
  check("update 后工作副本 materialize", existsSync(join(subExtra, "b.txt")));
  const subHead = (await gitIn(subExtra, ["rev-parse", "HEAD"])).stdout.trim();
  check("update 后子模块 HEAD 可解析（40 位 hex）", /^[0-9a-f]{40}$/.test(subHead), subHead);
  eq("index 指针与子模块 HEAD 一致（update 不留指针漂移）",
    (await gitIn(sup, ["ls-files", "-s", "--", "libs/extra"])).stdout.trim(), "160000 " + subHead + " 0\tlibs/extra");
  const stLine2 = await stLineOf("libs/extra");
  check("update 之后 submodule status 该行不再是 '-'（工作副本已 populate）",
    !!stLine2 && stLine2[0] !== "-", String(stLine2));
  const nodeAfterUpdate = (await core.listSubRepos(sup)).repos.find((n) => n.relPath === "libs/extra");
  eq("listSubRepos：update 后 initialized=true", nodeAfterUpdate.initialized, true);
  eq("…submodule.state = ok（index 指针 = 子模块 HEAD）", nodeAfterUpdate.submodule.state, "ok");
  check("update 返回 { status }", hasKey(updRes, "status") && !hasKey(updRes, "probe"), JSON.stringify(Object.keys(updRes)));

  // ---- 5) sync：把 .gitmodules 里的新 url 同步回 submodule.<name>.url --------
  await writeFile(join(sup, ".gitmodules"),
    '[submodule "libs/extra"]\n\tpath = libs/extra\n\turl = ' + gitPath(base3) + "\n");
  const syncRes = await core.submoduleSync(sup, "libs/extra");
  const cfgUrl2 = (await gitIn(sup, ["config", "--get", "submodule.libs/extra.url"])).stdout.trim();
  check("sync 后本地 config 的 url 已更新为 base3", pathLooseEq(cfgUrl2, base3), cfgUrl2 + " vs " + base3);
  check("url 确实变了（不是原值残留）", !pathLooseEq(cfgUrl2, base2), cfgUrl1 + " → " + cfgUrl2);
  check("sync 返回 { status }", hasKey(syncRes, "status") && !hasKey(syncRes, "probe"), JSON.stringify(Object.keys(syncRes)));
  // cwd 归一：git 的 submodule 子命令对 cwd 敏感，产品先 probeRepo 取 toplevel →
  // 从仓库内普通子目录发起也要能命中（subPath 仍按 toplevel 相对）
  const syncFromSub = await core.submoduleSync(join(sup, "plain-dir"), "libs/extra");
  check("从仓库内子目录发起也能命中（cwd 先归一到 toplevel）", hasKey(syncFromSub, "status"), JSON.stringify(Object.keys(syncFromSub)));

  // ---- 6) 入参白名单：url 与 subPath ----------------------------------------
  for (const [u, why] of [["-oArgs", "以 - 开头（选项注入面）"], ["with space", "含空白"], ["", "空串"], [null, "null"]]) {
    let c;
    try { await core.submoduleAdd(sup, { url: u, subPath: "libs/illegal" }); } catch (e) { c = e; }
    check("submoduleAdd url " + JSON.stringify(u) + "（" + why + "）抛 GitError", c instanceof core.GitError, String(c));
    eq("…kind=exit", c.kind, "exit");
  }
  check("非法 url 的 add 没有在仓库里留下任何痕迹", !existsSync(join(sup, "libs", "illegal")));
  for (const [p, why] of [["../escape", ".. 越界"], ["libs/../../escape", "中途 .. 越界"], ["/abs/path", "posix 绝对路径"], ["C:\\abs\\path", "Windows 绝对路径"], ["", "空串（subPath 必填）"]]) {
    let c;
    try { await core.submoduleAdd(sup, { url: base2, subPath: p }); } catch (e) { c = e; }
    check("submoduleAdd subPath " + JSON.stringify(p) + "（" + why + "）抛 GitError", c instanceof core.GitError, String(c));
  }
  for (const [p, why] of [["../escape", ".. 越界"], ["/abs/path", "绝对路径"]]) {
    let c;
    try { await core.submoduleUpdate(sup, { subPath: p }); } catch (e) { c = e; }
    check("submoduleUpdate subPath " + JSON.stringify(p) + "（" + why + "）被 safeJoin 拒绝", c instanceof core.GitError, String(c));
    let c2;
    try { await core.submoduleInit(sup, p); } catch (e) { c2 = e; }
    check("submoduleInit subPath " + JSON.stringify(p) + "（" + why + "）被 safeJoin 拒绝", c2 instanceof core.GitError, String(c2));
  }
  // 前置校验先于任何 git 调用：非法 url 在非仓库目录上也报同一条消息
  let c3;
  try { await core.submoduleAdd(join(tmpdir(), "definitely-not-a-repo-xyz"), { url: "-oArgs", subPath: "x" }); }
  catch (e) { c3 = e; }
  check("url 白名单先于 probeRepo 生效（非仓库目录上也报 url 错误）",
    c3 instanceof core.GitError && /需要合法 url/.test(c3.message), c3 && c3.message);
});

// ---- P2-2：wire 守卫 —— 五个方法的真实返回值过 strict schema + JSON-safe -----
// 与 index.js 逐字段一致：前四个 `value: await core.xxx(...)`（即 { status } 原样），
// submoduleAdd 也是原样透传（core 返回 { status, probe }，index 不做二次组装）。
live("wire: submodule 五方法真实返回值过 strict schema + JSON-safe（{status}×4 + {status, probe}）", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  const base2 = await makeSrcRepo(tmp, "base2-src", "b.txt", "b1\n");

  // add：唯一带 probe 的一个（客户端把新节点插进仓库树）
  const added = await core.submoduleAdd(sup, { url: base2, subPath: "libs/extra" });
  eq("submoduleAdd 返回值恰是 { status, probe }（与 typert.host.js submoduleAddValueSchema 同形）",
    Object.keys(added).sort(), ["probe", "status"]);
  wireCheck("submoduleAdd", added);

  // deinit -f → init → update → sync：四者都是 { status } 单键
  await writeFile(join(sup, "libs", "extra", "dirty.txt"), "d\n");
  const deinitVal = await core.submoduleDeinit(sup, "libs/extra", true);
  eq("submoduleDeinit 返回值恰是 { status }", Object.keys(deinitVal), ["status"]);
  wireCheck("submoduleDeinit", deinitVal);

  const initVal = await core.submoduleInit(sup, "libs/extra");
  eq("submoduleInit 返回值恰是 { status }", Object.keys(initVal), ["status"]);
  wireCheck("submoduleInit", initVal);

  const updateVal = await core.submoduleUpdate(sup, { subPath: "libs/extra", init: true, recursive: true });
  eq("submoduleUpdate 返回值恰是 { status }", Object.keys(updateVal), ["status"]);
  wireCheck("submoduleUpdate", updateVal);

  // sync 在「刚 update 完、url 未变」的状态下也必须过（幂等路径）
  const syncVal = await core.submoduleSync(sup, "libs/extra");
  eq("submoduleSync 返回值恰是 { status }", Object.keys(syncVal), ["status"]);
  wireCheck("submoduleSync", syncVal);

  // 探测钩子：显式 undefined / null / 非 plain object 会被网关 assertJsonValue 拒
  // （AGENTS.md 2026-08-28 实测：客户端 RPC 永久 pending、UI 静默无数据）
  const mutated = Object.assign({}, added);
  mutated.probe = Object.assign({}, added.probe, { mainWorktreePath: undefined });
  let rejected = false;
  try { assertJsonSafe(mutated, "root", new Set()); } catch (e) { rejected = /is not JSON-safe/.test(e.message); }
  check("网关会拒绝 own key = undefined 的 probe（本测试的正例返回值里不该出现）", rejected);
  wireCheck("submoduleAdd", added); // 对照：真实返回值必须一路干净
});

// ---- P2-3：repoTree 的 originUrl（客户端「嵌套仓库注册为 submodule」的数据源）-
live("repoTree: nested 节点带 originUrl（P2 转换数据源）+ 无 origin 不挂 key（JSON-safe）", async (tmp) => {
  const { sup, baseSrc } = await makeSubFixture(tmp);
  const vt = join(sup, "vendor-tool");
  const nodeOf = async (relPath) => (await core.listSubRepos(sup)).repos.find((n) => n.relPath === relPath);

  // 1) 负例：vendor-tool 还没配 origin → 节点不得挂 originUrl（可选字段有值才挂 key）
  const before = await nodeOf("vendor-tool");
  check("无 origin 的 nested 节点不挂 originUrl", !hasKey(before, "originUrl"), JSON.stringify(Object.keys(before)));

  // 2) 正例：给 vendor-tool 配一个 origin（本地路径）→ nested 节点带 originUrl
  const originTarget = await makeSrcRepo(tmp, "origin-src", "o.txt", "o1\n");
  await gitIn(vt, ["remote", "add", "origin", originTarget]);
  const after = await nodeOf("vendor-tool");
  eq("nested 节点带 originUrl（供客户端预填 submoduleAdd 的 url）", after.originUrl, originTarget);

  // 3) submodule / root 不挂（submodule 的 url 在 submodule.url；root 归设置 Tab 管）
  const subNode = await nodeOf("libs/base");
  check("submodule 节点不挂 originUrl", !hasKey(subNode, "originUrl"), JSON.stringify(Object.keys(subNode)));
  const rootNode = (await core.listSubRepos(sup)).repos[0];
  check("root 节点不挂 originUrl", !hasKey(rootNode, "originUrl"), JSON.stringify(Object.keys(rootNode)));
  // 负例素材自证：base-src 确实没有 origin remote（否则上面的 before 就失去意义）
  let baseOrigin = "";
  try { baseOrigin = (await gitIn(baseSrc, ["config", "--get", "remote.origin.url"])).stdout.trim(); } catch (_) { /* exit 1 = 无 */ }
  eq("base-src 自身没有 origin（负例素材成立）", baseOrigin, "");

  // originUrl 是 schema 的 optional 字段，带/不带两种形态都必须过 strict schema
  const tree = await core.listSubRepos(sup);
  wireCheck("repoTree", tree);
  check("带 originUrl 的节点确实存在于返回里",
    tree.repos.some((n) => n.relPath === "vendor-tool" && n.originUrl === originTarget),
    JSON.stringify(tree.repos.map((n) => [n.relPath, n.originUrl])));
});

// ---- P2 遗留（P1 的 --force-remove 分支）：选中侧 = 删除 ----------------------
// 覆盖 resolveGitlinkConflict 的另一半：选中的一侧**删掉了**这个子模块（index 里
// 没有该 stage）→ 不能写 cacheinfo（无 sha 可写），必须 `update-index --force-remove`
// 把 gitlink 条目从 index 摘掉。
//
// fixture 的坑（实测，写在这里免得后人重排时踩回去）：
//   1. 子模块内必须造**互不为祖先**的提交，否则 git 对 gitlink 指针 fast-forward 自动和解。
//   2. delete/modify 冲突的形态是「stage1 + stage3，**无 stage2**」：
//      ls-files -u 断言必须显式写出「无 stage2」，否则 --force-remove 分支根本没被走到
//      （走到的是与 P1-3 相同的 cacheinfo 分支）。
live("resolveConflictFile: gitlink 冲突「选中侧=删除」分支（--force-remove 把条目从 index 摘掉）+ 对照 theirs", async (tmp) => {
  const { sup } = await makeSubFixture(tmp);
  const sub = join(sup, "libs", "base");

  // 子模块内造两个互不为祖先的提交 pA / pB
  await gitIn(sub, ["switch", "-q", "-c", "pA"]);
  await writeFile(join(sub, "pa.txt"), "pa\n");
  await gitIn(sub, ["add", "-A"]);
  await gitIn(sub, ["commit", "-qm", "pA divergent"]);
  const shaA = (await gitIn(sub, ["rev-parse", "HEAD"])).stdout.trim();
  await gitIn(sub, ["switch", "-q", "main"]);
  await gitIn(sub, ["switch", "-q", "-c", "pB"]);
  await writeFile(join(sub, "pb.txt"), "pb\n");
  await gitIn(sub, ["add", "-A"]);
  await gitIn(sub, ["commit", "-qm", "pB divergent"]);
  const shaB = (await gitIn(sub, ["rev-parse", "HEAD"])).stdout.trim();
  check("pA/pB 是两个不同的 40 位提交（分叉成功）",
    /^[0-9a-f]{40}$/.test(shaA) && /^[0-9a-f]{40}$/.test(shaB) && shaA !== shaB, shaA + " / " + shaB);

  // brA：指针 → pB（"修改"的一侧）
  await gitIn(sup, ["switch", "-q", "-c", "brA"]);
  await gitIn(sub, ["checkout", "-q", shaB]);
  await gitIn(sup, ["add", "libs/base"]);
  await gitIn(sup, ["commit", "-qm", "brA ptr pB"]);
  // master：先把指针挪到 pA，再整个删掉 gitlink（"删除"的一侧）
  await gitIn(sup, ["switch", "-q", "main"]);
  await gitIn(sub, ["checkout", "-q", shaA]);
  await gitIn(sup, ["add", "libs/base"]);
  await gitIn(sup, ["commit", "-qm", "main ptr pA"]);
  await gitIn(sup, ["rm", "-q", "libs/base"]);
  await gitIn(sup, ["commit", "-qm", "main removes submodule"]);

  const mergeToConflict = async () => {
    const m = await core.mergeBranch(sup, "brA");
    eq("合并未成功（merged=false）", m.merged, false);
    const cf = m.status.conflicted.find((e) => e.path === "libs/base");
    check("status.conflicted 含 libs/base", !!cf, JSON.stringify(m.status.conflicted));
    eq("冲突态是 DU（删除/修改）", cf.xy, "DU");
    eq("merging=true（MERGE_HEAD 在）", m.status.merging, true);
    const u = (await gitIn(sup, ["ls-files", "-u", "--", "libs/base"])).stdout;
    const s1 = /^160000 ([0-9a-f]{40}) 1\tlibs\/base$/m.exec(u);
    const s3 = /^160000 ([0-9a-f]{40}) 3\tlibs\/base$/m.exec(u);
    check("stage1 存在（合并基线指针）", !!s1, u);
    check("stage3 = brA 侧的 pB", !!s3 && s3[1] === shaB, u);
    check("**无 stage2**（ours 侧是删除 → 下面 ours 会走 --force-remove）",
      !/^160000 [0-9a-f]{40} 2\tlibs\/base$/m.test(u), u);
    check("stage1 ≠ stage3（两侧确实分叉，不是 fast-forward）", s1[1] !== shaB, u);
    return m;
  };

  // ---- 对照：选 theirs（有 stage3）→ 走 cacheinfo 分支，写 stage0 = pB --------
  await mergeToConflict();
  const theirsStatus = await core.resolveConflictFile(sup, "libs/base", "theirs");
  eq("theirs 后 conflicted 清空", theirsStatus.conflicted.length, 0);
  eq("index stage0 = theirs 侧 pB（对照：同一冲突的「有 stage」分支）",
    (await gitIn(sup, ["ls-files", "-s", "--", "libs/base"])).stdout.trim(), "160000 " + shaB + " 0\tlibs/base");
  wireCheck("resolveConflict", { status: theirsStatus });

  // ---- 正题：选 ours（master 侧=删除，无 stage2）→ --force-remove -------------
  await core.abortMerge(sup);
  await mergeToConflict();
  const oursStatus = await core.resolveConflictFile(sup, "libs/base", "ours");
  eq("ours（选中侧=删除）后 conflicted 清空", oursStatus.conflicted.length, 0);
  eq("index 里已无 libs/base 条目（--force-remove 生效）",
    (await gitIn(sup, ["ls-files", "-s", "--", "libs/base"])).stdout.trim(), "");
  eq("ls-files -u 也已无未合并条目",
    (await gitIn(sup, ["ls-files", "-u", "--", "libs/base"])).stdout.trim(), "");
  check("status 里不再出现 libs/base（既非冲突也非暂存/未暂存）",
    !oursStatus.unstaged.some((e) => e.path === "libs/base")
    && !oursStatus.staged.some((e) => e.path === "libs/base")
    && !oursStatus.conflicted.some((e) => e.path === "libs/base"),
    JSON.stringify({ s: oursStatus.staged, u: oursStatus.unstaged, c: oursStatus.conflicted }));
  eq("merge 态仍在（MERGE_HEAD 未清，「继续」才提交）", oursStatus.merging, true);
  wireCheck("resolveConflict", { status: oursStatus });
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

test("static: 63 个 Remote 方法在两边都存在（repoTree/revExists/submodule 五方法在 METHODS 末尾同序）", () => {
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
    // 子仓库支持 P0（56 → 57）
    "repoTree",
    // 子仓库支持 P1（57 → 58）
    "revExists",
    // 子仓库支持 P2（58 → 63）：submodule 管理五方法
    "submoduleInit","submoduleUpdate","submoduleSync","submoduleDeinit","submoduleAdd",
  ];
  eq("方法总数 63", expected.length, 63);
  for (const m of expected) {
    check("index 含 " + m, indexSrc.includes('markRemoteMethod(this, "' + m + '"'));
    check("typert 含 " + m, typertSrc.includes('"' + m + '"'));
  }
  // 位置守卫：集合相等只防「少一个/多一个」，防不住「插队错位」——
  // AGENTS.md 关键机制 §2 要求 index.js markRemoteMethod 序列与 typert METHODS
  // 「同名同序」。子仓库支持的三轮新增（repoTree / revExists / submodule 五方法）
  // 都在序列末尾追加，因此守卫「末尾 7 项 = [repoTree, revExists, submoduleInit,
  // submoduleUpdate, submoduleSync, submoduleDeinit, submoduleAdd] 且顺序一致、
  // 各出现一次」：既挡住漏登记/重名，也挡住把新方法插到中间导致两边错位。
  const APPENDED = ["repoTree", "revExists", "submoduleInit", "submoduleUpdate", "submoduleSync", "submoduleDeinit", "submoduleAdd"];
  const indexOrder = [...indexSrc.matchAll(/markRemoteMethod\(this,\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  const typertOrder = [...typertSrc.matchAll(/\[\s*"([a-zA-Z]+)"\s*,\s*\w+Result\s*\]/g)].map((m) => m[1]);
  eq("index 序列长度 63", indexOrder.length, 63);
  eq("typert METHODS 长度 63", typertOrder.length, 63);
  eq("index 末尾 7 项是 [repoTree, revExists, submodule 五方法]（同序）", indexOrder.slice(-APPENDED.length), APPENDED);
  eq("typert METHODS 末尾 7 项是 [repoTree, revExists, submodule 五方法]（同序）", typertOrder.slice(-APPENDED.length), APPENDED);
  for (const m of APPENDED) {
    eq(m + " 各出现恰好一次（index / typert）",
      [indexOrder.filter((x) => x === m).length, typertOrder.filter((x) => x === m).length], [1, 1]);
  }
  eq("index 与 typert 同名同序", indexOrder, typertOrder);
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
  // client 侧 $mount 的 CLIENT_METHODS 是 bundle 内联字面量：漏登记一个新方法 = 客户端
  // 调不到（remote.* undefined），症状是「按钮/面板静默无数据」。与 typert METHODS 对齐。
  const clientMethods = clientSrc.match(/const CLIENT_METHODS = \[([\s\S]*?)\];/);
  check("client.js 找到 CLIENT_METHODS 列表", !!clientMethods);
  if (clientMethods) {
    const names = [...clientMethods[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
    check("CLIENT_METHODS 含 repoTree", names.indexOf("repoTree") >= 0, JSON.stringify(names.slice(-5)));
    check("CLIENT_METHODS 含 revExists（P1 sha 门控）", names.indexOf("revExists") >= 0, JSON.stringify(names.slice(-5)));
    // P2 的 submodule 管理五件套：漏登记任何一个 = 设置 Tab「子仓库」管理区 / 变更 Tab
    // 「初始化」按钮调用 undefined，症状是点了没反应
    for (const m of ["submoduleInit", "submoduleUpdate", "submoduleSync", "submoduleDeinit", "submoduleAdd"]) {
      check("CLIENT_METHODS 含 " + m + "（P2 submodule 管理）", names.indexOf(m) >= 0, JSON.stringify(names.slice(-8)));
    }
    eq("CLIENT_METHODS 与 typert METHODS 集合一致", names.slice().sort(), TYPERT.invocations.map((i) => i.method).sort());
    eq("CLIENT_METHODS 数量 63", names.length, 63);
  }
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
    // dshmarket 的 peer 诊断（src/check.ts satisfiesRange，不带 includePrerelease）
    // 按 npm 默认预发布准入求值：带预发布标签的版本只会被「同 [major,minor,patch]
    // tuple 且自身带预发布」的 || 候选接纳。profile 里 pnpm 会把 peer 解析到插件
    // 嵌套 node_modules 的 0.1.1-rc.2（被同 profile 其它插件的精确钉版促成），
    // range 缺同 tuple 候选时市场即警告
    // "peer range ... does not match resolved 0.1.1-rc.2"（2026-10-19 实测，修复=补 ^0.1.1-rc.0）。
    const npmAdmits = (candidate, version) => {
      const lo = candidate.match(/^\^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/);
      const hi = version.match(/^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/);
      if (!lo || !hi) return false;
      if (lo[1] !== hi[1] || lo[2] !== hi[2] || lo[3] !== hi[3]) return false;
      // >= 下界（同 tuple 下按 rc 序）；^ 上界在同 minor 内必然满足
      return Number(hi[4]) >= Number(lo[4]);
    };
    check(
      "0.2.0-rc.1 被 npm 默认准入语义接纳（同 tuple 候选存在）",
      alts.some((a) => npmAdmits(a, "0.2.0-rc.1")),
    );
    check(
      "0.1.1-rc.2 被 npm 默认准入语义接纳（dshmarket peer 诊断；2026-10-19 实测 profile 嵌套解析到 0.1.1-rc.2）",
      alts.some((a) => npmAdmits(a, "0.1.1-rc.2")),
    );
    check(
      "0.2.1-rc.2 被 npm 默认准入语义接纳（当前 runtime）",
      alts.some((a) => npmAdmits(a, "0.2.1-rc.2")),
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