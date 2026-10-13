// CDP e2e（P1 子仓库下钻）：真实时间轴驱动 headless 浏览器，验证四条链路：
//   A. 变更 Tab 仓库分组聚合（主仓库 + submodule「指针不符」+ 嵌套仓库）+ 指针 diff「指针 a → b」
//      + 「在子仓库中查看 a..b」跳转（revExists 门控 → 切作用域 → 切历史 Tab → 自动范围对比）
//   B. 指针冲突流：脚本用 git 现场制造 gitlink both-modified → 冲突 Tab「子模块指针」行
//      → 「用我们的指针」→ 「继续」完成 merge（MERGE_HEAD 清除）
//   C. 未跟踪目录丢弃：plain-dir/（含子目录）走「删除」+ 确认 → 磁盘整体消失
// 前置（Lead 的 pwsh 编排负责，脚本不做）：
//   - DSH 临时实例已启动，pageUrl 带 token；headless 浏览器已开 <cdpPort>
//   - fixture 已预置在默认工作区（P1_SUPER 环境变量 = super 仓库绝对路径）：
//       base-src/      : 3 commits（a.txt v1/v2/v3）——submodule 的源（master=v3）
//       libs/base      : submodule（add 时 recorded=v3，checkout 在 v1 → 指针漂移）
//       vendor-tool/   : 嵌套独立仓库（有自己的 .git）
//       plain-dir/p.txt + plain-dir/sub/deep.txt : 未跟踪
//       s.txt          : 已提交 + 未暂存修改
// 用法: node scripts/cdp-e2e-p1.mjs <pageUrl> [cdpPort] [waitMs]
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pageUrl = process.argv[2] || "http://127.0.0.1:3465/";
const cdpPort = Number(process.argv[3] || 9223);
const waitMs = Number(process.argv[4] || 12000);
const SUPER = process.env.P1_SUPER || "";
if (!SUPER || !existsSync(SUPER)) { console.log("FAIL: P1_SUPER 未设置或目录不存在"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, opts = {}) => {
  try {
    return execFileSync("git", args, { cwd: SUPER, encoding: "utf8", ...opts });
  } catch (e) {
    if (opts.allowFail) return String(e.stdout || "") + String(e.stderr || "");
    throw e;
  }
};
const gitIn = (cwd, args, opts = {}) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", ...opts });
  } catch (e) {
    if (opts.allowFail) return String(e.stdout || "") + String(e.stderr || "");
    throw e;
  }
};

// ---- CDP 连接（与 v2 cdp-e2e.mjs 同款）----
let version = null;
for (let i = 0; i < 40; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; }
  catch { await sleep(500); }
}
if (!version) { console.log("FAIL: CDP not reachable"); process.exit(1); }
let target = null;
for (let i = 0; i < 20; i++) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  target = list.find((t) => t.type === "page" && t.url.startsWith(pageUrl.replace(/\/$/, "")))
        || list.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  if (target) break;
  await sleep(500);
}
if (!target) { console.log("FAIL: no page target"); process.exit(1); }
console.log("target url:", target.url);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") {
    consoleLines.push((msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || "")).join(" "));
  }
};
function cdp(method, params) {
  const id = nextId++;
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
await cdp("Runtime.enable", {});
await cdp("Page.enable", {});
if (!target.url.startsWith(pageUrl.replace(/\/$/, ""))) await cdp("Page.navigate", { url: pageUrl });
await sleep(waitMs);

async function evalJs(expression) {
  const res = await cdp("Runtime.evaluate", { expression, returnByValue: true });
  const r = res.result && res.result.result;
  if (r && r.subtype === "error") { console.log("eval error:", r.description || ""); return undefined; }
  return r ? r.value : undefined;
}
const js = (v) => JSON.parse(v === undefined || v === null ? "{}" : v);
let failed = false;
const expect = (cond, label) => { console.log((cond ? "[PASS] " : "[FAIL] ") + label); if (!cond) failed = true; };
const PANEL = "body > .gm-overlay";
// 轮询等待：stateExpr 每 500ms 求值一次，predJs（页面内布尔表达式）为真即返回最新状态
async function waitState(stateExpr, predJs, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let s = {};
  while (Date.now() < end) {
    s = js(await evalJs(stateExpr));
    let ok = false;
    try { ok = (await evalJs(predJs)) === true; } catch (_) { ok = false; }
    if (ok) return s;
    await sleep(500);
  }
  return s;
}
const sleepOpenPanel = async () => {
  await evalJs("document.querySelector('button.gm-toolbtn') && document.querySelector('button.gm-toolbtn').click()");
  await sleep(1500);
};
const clickTab = async (label) => {
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll('${PANEL} .gm-tab')).find((x) => x.textContent.trim().includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  await sleep(900);
};

// ---- 通用状态 ----
const baseState = `JSON.stringify({
  btn: !!document.querySelector('button.gm-toolbtn'),
  panelOpen: !!document.querySelector('${PANEL} .gm-panel'),
  tabs: Array.from(document.querySelectorAll('${PANEL} .gm-tab')).map((e) => e.textContent.trim().replace(/[0-9]+$/, '')).slice(0, 8),
  activeTab: (document.querySelector('${PANEL} .gm-tab-active')||{textContent:''}).textContent.trim(),
  groupNames: Array.from(document.querySelectorAll('${PANEL} .gm-repogroup-name')).map((e) => e.textContent.trim()),
  subBadges: Array.from(document.querySelectorAll('${PANEL} .gm-repogroup-head .gm-sub-badge')).map((e) => e.textContent.trim()),
  chips: Array.from(document.querySelectorAll('${PANEL} .gm-repo-chip-name')).map((e) => e.textContent.trim()),
  activeChip: (document.querySelector('${PANEL} .gm-repo-chip-active .gm-repo-chip-name')||{textContent:''}).textContent.trim(),
  diffwin: !!document.querySelector('body > .gm-diffwin'),
  diffwinTitle: (document.querySelector('body > .gm-diffwin')||{textContent:''}).textContent.slice(0, 200),
  jumpBtn: (() => { const b = Array.from(document.querySelectorAll('body > .gm-diffwin button')).find((x) => x.textContent.includes('在子仓库中查看')); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })(),
})`;
const groupsReady = `document.querySelectorAll('${PANEL} .gm-repogroup-name').length >= 3`;
const jumpReady = `(() => { const b = Array.from(document.querySelectorAll('body > .gm-diffwin button')).find((x) => x.textContent.includes('在子仓库中查看')); return !!b && b.disabled === false; })()`;

// ================= Phase 0：fixture 幂等重置（可重复跑） =================
console.log("---- Phase 0: fixture 幂等重置 ----");
const fs = await import("node:fs");
const pathMod = await import("node:path");
git(["merge", "--abort"], { allowFail: true });
git(["rebase", "--abort"], { allowFail: true });
git(["checkout", "-q", "master"], { allowFail: true });
git(["branch", "-qD", "brA"], { allowFail: true });
git(["reset", "-q", "--hard"], { allowFail: true }); // gitlink 不随 super --hard 递归，子仓库工作区不受影响
// base-src 三提交 sha（master=v3）
const shaV3 = gitIn(SUPER + "/base-src", ["rev-parse", "master"]).trim();
const shaV2 = gitIn(SUPER + "/base-src", ["rev-parse", "master~1"]).trim();
const shaV1 = gitIn(SUPER + "/base-src", ["rev-parse", "master~2"]).trim();
// 指针漂移：worktree ≠ recorded（挑一个不等于当前记录的提交）
const recorded0 = git(["rev-parse", "--verify", ":libs/base"], { allowFail: true }).trim().split("\n")[0] || shaV3;
const driftSha = [shaV1, shaV2, shaV3].find((s) => s !== recorded0) || shaV1;
gitIn(SUPER + "/libs/base", ["checkout", "-q", driftSha], { allowFail: true });
console.log("recorded=" + recorded0.slice(0, 7) + " drift->" + driftSha.slice(0, 7));
// 未跟踪目录与未暂存修改（覆盖写，幂等）
fs.rmSync(SUPER + "/plain-dir", { recursive: true, force: true });
fs.mkdirSync(SUPER + "/plain-dir/sub", { recursive: true });
fs.writeFileSync(SUPER + "/plain-dir/p.txt", "p\n");
fs.writeFileSync(SUPER + "/plain-dir/sub/deep.txt", "d\n");
fs.writeFileSync(SUPER + "/s.txt", "s1\ns2\n");
const driftNow = gitIn(SUPER + "/libs/base", ["rev-parse", "HEAD"], {}).trim();
expect(driftNow !== recorded0, "前置：指针漂移就位（worktree " + driftNow.slice(0, 7) + " ≠ recorded " + recorded0.slice(0, 7) + "）");

// ================= Phase A：聚合分组 + 指针 diff + a..b 跳转 =================
console.log("---- Phase A: 聚合分组 / 指针 diff / a..b 跳转 ----");
// 重置页面状态（脚本可能重复跑：上一轮可能留着打开的面板/弹窗）
await evalJs("location.reload()");
await sleep(Math.max(6000, waitMs / 2));
const s1 = js(await evalJs(baseState));
expect(s1.btn === true, "composer 入口按钮出现（probe 判定 fixture 是 git 仓库）");
if (s1.btn) {
  await sleepOpenPanel();
  // 等 repoTree RPC 落地（分组 ≥3：主仓库 + submodule + 嵌套）
  const s2 = await waitState(baseState, groupsReady, 25000);
  expect(s2.panelOpen === true, "GitPanel 打开");
  expect(s2.tabs.length >= 6, "六 Tab 渲染");
  const gNames = s2.groupNames.join("|");
  expect(/主仓库/.test(gNames), "变更 Tab 有主仓库组（实际: " + gNames + "）");
  expect(/libs\/base|base/.test(gNames), "变更 Tab 有 submodule 组 libs/base");
  expect(/vendor-tool/.test(gNames), "变更 Tab 有嵌套仓库组 vendor-tool");
  expect(s2.subBadges.some((t) => t.includes("指针不符")), "submodule 组头带「指针不符」徽标（指针漂移态）");

  // root 组 unstaged 里点 libs/base 指针行 → diff 窗口（ptr 由子节点 submodule 态补全）
  const rowClicked = await evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('${PANEL} .gm-file'));
    const row = rows.find((x) => x.textContent.includes('libs/base'));
    if (!row) return null;
    row.click();
    return row.textContent.trim().slice(0, 60);
  })()`);
  await sleep(1200);
  const s3 = await waitState(baseState, jumpReady, 15000);
  expect(!!rowClicked && s3.diffwin === true, "点击 libs/base 指针行打开 diff 窗口（" + String(rowClicked).slice(0, 30) + "）");
  expect(/指针 [0-9a-f]{7} → [0-9a-f]{7}/.test(s3.diffwinTitle), "diff 窗口头部显示「指针 abc1234 → def5678」（实际: " + s3.diffwinTitle.slice(0, 90) + "）");
  expect(!!s3.jumpBtn, "「在子仓库中查看 a..b」按钮存在");
  expect(s3.jumpBtn && s3.jumpBtn.disabled === false, "revExists 核验通过（按钮可用；fixture 里两个指针提交都在子仓库对象库）");

  // 跳转：切作用域 + 切历史 + 自动范围对比
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll('body > .gm-diffwin button')).find((x) => x.textContent.includes('在子仓库中查看')); if (b && !b.disabled) b.click(); return !!b; })()`);
  const s4 = await waitState(baseState,
    `(() => { const c = document.querySelector('${PANEL} .gm-repo-chip-active .gm-repo-chip-name'); return !!c && /base/.test(c.textContent) && !!document.querySelector('body > .gm-diffwin'); })()`, 15000);
  expect(/base/.test(s4.activeChip), "跳转后作用域切到子仓库（active chip=" + s4.activeChip + "）");
  expect(s4.activeTab.includes("历史"), "跳转后切到历史 Tab");
  expect(s4.diffwin === true, "自动发起 a..b 范围对比（对比弹窗已打开）");
  // 关对比窗 + diff 窗 + 面板（Esc 逐层）
  for (let i = 0; i < 3; i++) {
    await evalJs("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(450);
  }
} else {
  failed = true;
}

// ================= Phase B：指针冲突（脚本现场制造） =================
console.log("---- Phase B: gitlink 冲突现场制造 + 指针冲突解决 ----");
// 在 submodule 里从 v2 分叉出两个互不为祖先的提交（D/F 实测：线性历史上任意两点
// 互为祖先，git 会对 gitlink 指针 fast-forward 自动和解，根本不进冲突态）
const ts = Date.now();
gitIn(SUPER + "/libs/base", ["checkout", "-q", "-B", "pA", shaV2]);
fs.writeFileSync(SUPER + "/libs/base/b1.txt", "pA " + ts + "\n");
gitIn(SUPER + "/libs/base", ["add", "b1.txt"]);
gitIn(SUPER + "/libs/base", ["commit", "-qm", "pA divergent"]);
const shaA = gitIn(SUPER + "/libs/base", ["rev-parse", "pA"]).trim();
gitIn(SUPER + "/libs/base", ["checkout", "-q", "-B", "pB", shaV2]);
fs.writeFileSync(SUPER + "/libs/base/b2.txt", "pB " + ts + "\n");
gitIn(SUPER + "/libs/base", ["add", "b2.txt"]);
gitIn(SUPER + "/libs/base", ["commit", "-qm", "pB divergent"]);
const shaB = gitIn(SUPER + "/libs/base", ["rev-parse", "pB"]).trim();
console.log("divergent: pA=" + shaA.slice(0, 7) + " pB=" + shaB.slice(0, 7));
// super：master 记 shaA、brA 记 shaB，merge → both modified（必冲突）
git(["checkout", "-q", "-b", "brA"]);
gitIn(SUPER + "/libs/base", ["checkout", "-q", shaB]);
git(["add", "libs/base"]);
git(["commit", "-qm", "P1 e2e: brA pointer -> pB"]);
git(["checkout", "-q", "master"]);
gitIn(SUPER + "/libs/base", ["checkout", "-q", shaA]);
git(["add", "libs/base"]);
git(["commit", "-qm", "P1 e2e: master pointer -> pA"]);
git(["merge", "brA", "--no-edit"], { allowFail: true });
const conflicted = git(["ls-files", "-u", "libs/base"], { allowFail: true });
expect(/160000/.test(conflicted) && conflicted.trim().length > 0, "gitlink 冲突已制造（ls-files -u 出现 160000 两个 stage）");

// 刷新页面 → 重开面板（等仓库树落地）→ 冲突 Tab
await evalJs("location.reload()");
await sleep(Math.max(6000, waitMs / 2));
const rb = js(await evalJs(baseState));
expect(rb.btn === true, "刷新后入口按钮仍在（probe 缓存重建）");
await sleepOpenPanel();
await waitState(baseState, groupsReady, 25000);
await clickTab("冲突");
const cState = js(await evalJs(`JSON.stringify({
  pointerBadge: (Array.from(document.querySelectorAll('${PANEL} .gm-sub-badge')).find((e) => e.textContent.includes('子模块指针'))||{textContent:''}).textContent,
  oursBtn: !!Array.from(document.querySelectorAll('${PANEL} button')).find((b) => b.textContent.includes('用我们的指针')),
  theirsBtn: !!Array.from(document.querySelectorAll('${PANEL} button')).find((b) => b.textContent.includes('用他们的指针')),
  editBtn: (() => { const rows = Array.from(document.querySelectorAll('${PANEL} .gm-file')); const r = rows.find((x) => x.textContent.includes('libs/base')); return !!(r && Array.from(r.querySelectorAll('button')).find((b) => b.textContent.includes('手动编辑'))); })(),
})`));
expect(cState.pointerBadge.includes("子模块指针"), "冲突 Tab 显示「子模块指针」徽标");
expect(cState.oursBtn === true && cState.theirsBtn === true, "指针冲突行提供「用我们的指针 / 用他们的指针」");
expect(cState.editBtn === false, "指针冲突行不提供「手动编辑」");

// 用我们的指针（= master 侧 v1）→ 继续（完成 merge）
await evalJs(`(() => { const b = Array.from(document.querySelectorAll('${PANEL} button')).find((x) => x.textContent.includes('用我们的指针')); if (b) b.click(); return !!b; })()`);
await sleep(2500);
await evalJs(`(() => { const b = Array.from(document.querySelectorAll('${PANEL} button')).find((x) => x.textContent.trim() === '继续'); if (b) { b.click(); return true; } return false; })()`);
await sleep(2500);
const afterResolve = js(await evalJs(`JSON.stringify({
  pointerBadge: !!Array.from(document.querySelectorAll('${PANEL} .gm-sub-badge')).find((e) => e.textContent.includes('子模块指针')),
  mergeBanner: (document.querySelector('${PANEL}')||{textContent:''}).textContent.includes('合并进行中'),
})`));
expect(afterResolve.pointerBadge === false, "解决后「子模块指针」徽标消失");
expect(afterResolve.mergeBanner === false, "「继续」后合并横幅消失（MERGE_HEAD 清除）");
const stageAfter = git(["ls-files", "-u", "libs/base"], { allowFail: true }).trim();
const recorded = git(["rev-parse", "--verify", ":libs/base"], { allowFail: true }).trim().split("\n")[0];
expect(stageAfter === "", "index 无残留未合并条目");
expect(recorded === shaA, "ours 侧指针已记录（rev-parse libs/base == pA " + shaA.slice(0, 7) + "）");
const mergeHeadGone = !existsSync(SUPER + "/.git/MERGE_HEAD");
expect(mergeHeadGone === true, "MERGE_HEAD 已清除（merge 真正完成）");

// ================= Phase C：未跟踪目录递归丢弃 =================
console.log("---- Phase C: 未跟踪目录丢弃 ----");
await clickTab("变更");
const beforeC = existsSync(SUPER + "/plain-dir");
expect(beforeC === true, "前置：plain-dir/ 在磁盘上存在");
const rowClicked = await evalJs(`(() => {
  const rows = Array.from(document.querySelectorAll('${PANEL} .gm-file'));
  const row = rows.find((x) => x.textContent.includes('plain-dir'));
  if (!row) return null;
  const btn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '删除');
  if (!btn) return null;
  btn.click();
  return row.textContent.trim().slice(0, 50);
})()`);
await sleep(900);
expect(!!rowClicked, "点击 plain-dir/ 行的「删除」按钮");
const confirmOn = await evalJs(`(() => { const b = Array.from(document.querySelectorAll('body > .gm-confirm button')).find((x) => x.textContent.includes('确认丢弃')); if (b) { b.click(); return true; } return false; })()`);
await sleep(2500);
expect(confirmOn === true, "确认弹窗「确认丢弃」已点击");
const dirGone = !existsSync(SUPER + "/plain-dir");
expect(dirGone === true, "plain-dir/（含子目录）已从磁盘递归删除");
// 行消失可能晚于磁盘删除（refresh RPC 往返），轮询等待
await waitState(baseState,
  `!Array.from(document.querySelectorAll('${PANEL} .gm-file')).some((x) => x.textContent.includes('plain-dir'))`, 12000);
const rowGone = await evalJs(`JSON.stringify({ gone: !Array.from(document.querySelectorAll('${PANEL} .gm-file')).some((x) => x.textContent.includes('plain-dir')) })`);
expect(js(rowGone).gone === true, "变更列表里 plain-dir/ 行消失（状态已刷新）");
const vendorKept = existsSync(SUPER + "/vendor-tool/.git");
expect(vendorKept === true, "嵌套仓库 vendor-tool 未被波及（防护仍在）");

console.log(failed ? "\nP1 E2E: FAIL" : "\nP1 E2E: ALL PASS");
process.exit(failed ? 1 : 0);
