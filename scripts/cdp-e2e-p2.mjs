// CDP e2e（P2 submodule 管理）：真实时间轴驱动 headless 浏览器，验证：
//   A. 设置 Tab「子仓库」管理区渲染（子模块/嵌套分组、行按钮、originUrl 门控）
//   B. 卸载 → 未初始化徽标 → 变更 Tab「初始化并拉取」→ 恢复（生命周期闭环）
//   C. 「添加子模块」表单（本地路径 url 自动 file 放行）→ .gitmodules/gitlink/工作区
//   D. 嵌套仓库「注册为 submodule」（originUrl 就地注册）
//   E. 「Fetch 全部」跨仓库串行 + 成功/失败聚合 notice
// 前置（Lead 编排）：DSH 临时实例 + headless 浏览器 + 全新 fixture（P1_SUPER=super 绝对路径）。
// fixture 同 P1：base-src(3 commits) / libs/base(submodule) / vendor-tool(嵌套) / plain-dir / s.txt 修改。
// 用法: node scripts/cdp-e2e-p2.mjs <pageUrl> [cdpPort] [waitMs]
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pageUrl = process.argv[2] || "http://127.0.0.1:3465/";
const cdpPort = Number(process.argv[3] || 9223);
const waitMs = Number(process.argv[4] || 12000);
const SUPER = process.env.P1_SUPER || "";
if (!SUPER || !existsSync(SUPER)) { console.log("FAIL: P1_SUPER 未设置或目录不存在"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, opts = {}) => {
  try { return execFileSync("git", args, { cwd: SUPER, encoding: "utf8", ...opts }); }
  catch (e) { if (opts.allowFail) return String(e.stdout || "") + String(e.stderr || ""); throw e; }
};
const gitIn = (cwd, args, opts = {}) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", ...opts }); }
  catch (e) { if (opts.allowFail) return String(e.stdout || "") + String(e.stderr || ""); throw e; }
};

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
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
const SET_INPUT = (ph, val) => `(() => {
  // FormDialog 是 Portal 落 body——必须在 body 作用域找输入框（PANEL 子树里没有）。
  // 这里只做 focus；受控输入的 React onChange 只响应冒泡穿过应用 root 容器的受信
  // 事件——合成 input 事件打在 body 级 Portal 上 React 收不到，改用 CDP
  // Input.insertText 注入浏览器级真实文本（见 typeInto）。
  const el = Array.from(document.querySelectorAll('body .gm-input')).find((i) => (i.placeholder || '').includes(${JSON.stringify(ph)}));
  if (!el) return false;
  el.focus();
  return true;
})()`;
// Portal 受控输入的文本注入：focus + CDP Input.insertText（真实受信事件）
const typeInto = async (ph, text) => {
  const ok = await evalJs(SET_INPUT(ph, text));
  if (ok !== true) return false;
  await cdp("Input.insertText", { text });
  return true;
};
const clickBtnWith = (scopeSel, text, exact) => `(() => {
  const btn = Array.from(document.querySelectorAll(${JSON.stringify(scopeSel)})).find((b) => ${exact ? "b.textContent.trim() ===" : "b.textContent.includes("} ${JSON.stringify(text)}${exact ? "" : ")"});
  if (btn) { btn.click(); return true; }
  return false;
})()`;
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
const clickTab = async (label) => {
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll('${PANEL} .gm-tab')).find((x) => x.textContent.trim().includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  await sleep(900);
};

const subState = `JSON.stringify({
  panelOpen: !!document.querySelector('${PANEL} .gm-panel'),
  activeTab: (document.querySelector('${PANEL} .gm-tab-active')||{textContent:''}).textContent.trim(),
  subSection: (() => { const s = Array.from(document.querySelectorAll('${PANEL} .gm-section')).find((x) => x.textContent.includes('子仓库（子模块')); return s ? s.textContent : ''; })(),
  fetchAllBtn: !!Array.from(document.querySelectorAll('${PANEL} button')).find((b) => b.textContent.trim() === 'Fetch 全部'),
  pullAllBtn: !!Array.from(document.querySelectorAll('${PANEL} button')).find((b) => b.textContent.trim() === 'Pull 全部'),
  panelText: (document.querySelector('${PANEL}')||{textContent:''}).textContent.slice(0, 3000),
})`;
const groupsReady = `document.querySelectorAll('${PANEL} .gm-repogroup-name').length >= 3`;

// ---- Phase 0：fixture 全量确定性重建（任何历史状态都归零，可无限重跑）----
console.log("---- Phase 0: fixture 全量重建 ----");
const fs = await import("node:fs");
const pathMod = await import("node:path");
const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@e2e",
  GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@e2e",
});
const G = (args, cwd, opts = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, ...opts });
const urlPosix = SUPER.replace(/\\/g, "/");
// 沙盒禁止删除工作区根目录本身——清空其内容（children）再重建
for (const f of fs.readdirSync(SUPER)) {
  fs.rmSync(pathMod.join(SUPER, f), { recursive: true, force: true });
}
fs.mkdirSync(SUPER + "/base-src", { recursive: true });
G(["init", "-q", "."], SUPER + "/base-src");
fs.writeFileSync(SUPER + "/base-src/a.txt", "v1\n");
G(["add", "."], SUPER + "/base-src"); G(["commit", "-qm", "v1"], SUPER + "/base-src");
fs.writeFileSync(SUPER + "/base-src/a.txt", "v2\n");
G(["commit", "-qam", "v2"], SUPER + "/base-src");
fs.writeFileSync(SUPER + "/base-src/a.txt", "v3\n");
G(["commit", "-qam", "v3"], SUPER + "/base-src");
G(["init", "-q", "."], SUPER);
fs.writeFileSync(SUPER + "/s.txt", "s1\n");
G(["add", "s.txt"], SUPER); G(["commit", "-qm", "init super"], SUPER);
G(["-c", "protocol.file.allow=always", "submodule", "add", "-q", urlPosix + "/base-src", "libs/base"], SUPER);
G(["commit", "-qm", "add submodule libs/base"], SUPER);
fs.mkdirSync(SUPER + "/vendor-tool", { recursive: true });
G(["init", "-q", "."], SUPER + "/vendor-tool");
fs.writeFileSync(SUPER + "/vendor-tool/n.txt", "n1\n");
G(["add", "."], SUPER + "/vendor-tool"); G(["commit", "-qm", "init"], SUPER + "/vendor-tool");
G(["remote", "add", "origin", urlPosix + "/base-src"], SUPER + "/vendor-tool");
// 指针漂移：libs/base checkout v1（recorded=v3）
G(["checkout", "-q", G(["rev-parse", "HEAD~2"], SUPER + "/base-src").trim()], SUPER + "/libs/base");
// 未跟踪目录 + 未暂存修改
fs.mkdirSync(SUPER + "/plain-dir/sub", { recursive: true });
fs.writeFileSync(SUPER + "/plain-dir/p.txt", "p\n");
fs.writeFileSync(SUPER + "/plain-dir/sub/deep.txt", "d\n");
fs.writeFileSync(SUPER + "/s.txt", "s1\ns2\n");
expect(existsSync(SUPER + "/libs/base/a.txt"), "前置：libs/base 已 materialize（v1 漂移态）");

// ---- Phase A：设置 Tab 子仓库管理区 ----
console.log("---- Phase A: 设置 Tab 子仓库管理区 ----");
await evalJs("location.reload()");
await sleep(Math.max(6000, waitMs / 2));
await evalJs("document.querySelector('button.gm-toolbtn') && document.querySelector('button.gm-toolbtn').click()");
await sleep(1500);
await waitState(subState, groupsReady, 25000);
await clickTab("设置");
const s1 = await waitState(subState, `(() => { const s = Array.from(document.querySelectorAll('${PANEL} .gm-section')).find((x) => x.textContent.includes('子仓库（子模块')); return !!s && s.textContent.includes('libs/base'); })()`, 20000);
expect(/子仓库（子模块 1 \/ 嵌套 2）/.test(s1.subSection), "管理区渲染（实际头: " + (s1.subSection.slice(0, 40)) + "…）");
expect(s1.subSection.includes("更新") && s1.subSection.includes("同步 url") && s1.subSection.includes("卸载"), "libs/base 行提供 更新 / 同步 url / 卸载");
expect(s1.fetchAllBtn === true && s1.pullAllBtn === true, "头部「Fetch 全部 / Pull 全部」出现（多仓库时）");
const regBtns = js(await evalJs(`JSON.stringify((() => {
  const sec = Array.from(document.querySelectorAll('${PANEL} .gm-section')).find((x) => x.textContent.includes('子仓库（子模块'));
  const rows = Array.from(sec.querySelectorAll('button')).filter((b) => b.textContent.trim() === '注册为 submodule');
  return rows.map((b) => ({ disabled: b.disabled, title: b.title.slice(0, 20) }));
})())`));
expect(regBtns.length >= 1 && regBtns.some((b) => !b.disabled), "嵌套仓库「注册为 submodule」按钮存在且可用（vendor-tool 有 origin）");
expect(regBtns.some((b) => b.disabled === true), "无 origin 的嵌套仓库（base-src）注册按钮禁用");

// ---- Phase B：卸载 → 未初始化 → 变更 Tab 初始化并拉取 → 恢复 ----
console.log("---- Phase B: 卸载/初始化生命周期 ----");
await evalJs(clickBtnWith(`${PANEL} button`, "卸载", true));
await sleep(700);
const confirmed = await evalJs(`(() => { const b = Array.from(document.querySelectorAll('body > .gm-confirm button')).find((x) => x.textContent.trim() === '卸载'); if (b) { b.click(); return true; } return false; })()`);
await sleep(1500);
expect(confirmed === true, "卸载确认弹窗「卸载」已点击");
expect(!existsSync(SUPER + "/libs/base/a.txt"), "卸载后子仓库工作区内容被清空（a.txt 消失）");
// 徽标随 refreshTree 落地（轮询，防采样过早）
const uninitShown = await waitState(subState,
  `Array.from(document.querySelectorAll('${PANEL} .gm-sub-badge')).some((e) => e.textContent.includes('未初始化'))`, 15000);
expect(uninitShown.panelOpen !== undefined && (await evalJs(`JSON.stringify({ badge: Array.from(document.querySelectorAll('${PANEL} .gm-sub-badge')).some((e) => e.textContent.includes('未初始化')) })`) || "{}").includes("true"), "管理区出现「未初始化」徽标");
await clickTab("变更");
await waitState(subState, `(() => { const b = Array.from(document.querySelectorAll('${PANEL} button')).find((x) => x.textContent.trim() === '初始化'); return !!b; })()`, 15000);
// 稳健点击：React 重渲染窗口里一次性 click 可能打在已分离节点上 → 点+验证+重试
let backOK = false;
for (let i = 0; i < 4 && !backOK; i++) {
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll('${PANEL} button')).find((x) => x.textContent.trim() === '初始化'); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
  for (let j = 0; j < 8 && !backOK; j++) {
    if (existsSync(SUPER + "/libs/base/a.txt")) { backOK = true; break; }
    await sleep(800);
  }
}
expect(backOK === true, "变更 Tab 组头「初始化」后工作区恢复（a.txt 回来，点击重试模式）");
await clickTab("设置");
const badgeGone = await waitState(subState,
  `(() => { const sec = Array.from(document.querySelectorAll('${PANEL} .gm-section')).find((x) => x.textContent.includes('子仓库（子模块')); return !!sec && sec.textContent.includes('libs/base') && !sec.textContent.includes('未初始化'); })()`, 30000);
expect(badgeGone.subSection !== undefined && badgeGone.subSection.includes("libs/base") && !badgeGone.subSection.includes("未初始化"), "设置区「未初始化」徽标消失（非空洞断言：区存在且含 libs/base）");

// ---- Phase C：添加子模块（本地路径 url）----
console.log("---- Phase C: 添加子模块 ----");
// 稳健流：开表单（重试直到输入框出现）→ 填充（校验返回值）→ 提交 → 轮询磁盘
let addLanded = false;
let lastErr = "";
for (let i = 0; i < 3 && !addLanded; i++) {
  for (let k = 0; k < 6; k++) {
    const opened = await evalJs(`(() => {
      if (Array.from(document.querySelectorAll('body input')).some((x) => (x.placeholder || '').includes('本地绝对路径'))) return true;
      const b = Array.from(document.querySelectorAll('${PANEL} button')).find((x) => x.textContent.trim() === '添加子模块');
      if (b && !b.disabled) { b.click(); return false; }
      return false;
    })()`);
    if (opened === true) break;
    const diag = await evalJs(`JSON.stringify((() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      const b = q('body > .gm-overlay button').find((x) => x.textContent.trim() === '添加子模块');
      return {
        btnFound: !!b, btnDisabled: b ? b.disabled : null,
        inputNow: q('body input').some((x) => (x.placeholder || '').includes('本地绝对路径')),
        activeTab: (q('body > .gm-overlay .gm-tab-active')[0] || { textContent: '' }).textContent.trim(),
        confirms: q('body > .gm-confirm').length,
        notice: (q('body > .gm-overlay .gm-notice').map((e) => e.textContent).join("|") || "").slice(0, 40),
      };
    })())`);
    console.log("  [C] k=" + k + " 诊断: " + diag);
    await sleep(900);
  }
  const f1 = await typeInto("本地绝对路径", SUPER + "/base-src");
  const f2 = await typeInto("libs/extra", "libs/extra");
  const f3 = true; // 名称可选，留空
  const readBack = await evalJs(`(() => { const el = Array.from(document.querySelectorAll('body input')).find((i) => (i.placeholder || '').includes('本地绝对路径')); return el ? el.value.slice(0, 20) : "no-input"; })()`);
  const subDiag = await evalJs(`JSON.stringify((() => {
    const btns = Array.from(document.querySelectorAll('body button')).filter((b) => b.textContent.trim() === '添加');
    return { count: btns.length, states: btns.map((b) => b.disabled), urlLen: (Array.from(document.querySelectorAll('body input')).find((x) => (x.placeholder || '').includes('本地绝对路径')) || { value: "" }).value.length };
  })())`);
  console.log("  [C] 尝试 " + (i + 1) + ": 开框=" + (typeof f1 === "boolean" ? f1 : f1) + " 填充=" + [f1, f2, f3].join("/") + " 回读=" + readBack + " 提交钮=" + subDiag);
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('body button')).filter((b) => b.textContent.trim() === '添加' && !b.disabled).pop();
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  for (let j = 0; j < 20 && !addLanded; j++) {
    try {
      const t = git(["config", "-f", ".gitmodules", "--get-regexp", "path"], { allowFail: true }).toString();
      if (/libs\/extra/.test(t) && existsSync(SUPER + "/libs/extra/a.txt")) { addLanded = true; break; }
    } catch (_) { /* 轮询中 */ }
    await sleep(800);
  }
  if (!addLanded) {
    lastErr = String(await evalJs(`JSON.stringify({
      err: (Array.from(document.querySelectorAll('body > .gm-overlay .gm-errbar')).map((e) => e.textContent).join("|") || "").slice(0, 160),
      url: (Array.from(document.querySelectorAll('body input')).find((x) => (x.placeholder || '').includes('本地绝对路径'))||{value:''}).value,
    })`) || "{}");
    console.log("  尝试 " + (i + 1) + " 未生效，现场: " + lastErr);
    await evalJs("(() => { const b = Array.from(document.querySelectorAll('body button')).find((x) => x.textContent.trim() === '取消'); if (b) b.click(); return 1; })()");
    await sleep(600);
  }
}
await sleep(1200);
expect(addLanded === true, "添加子模块表单提交并生效（url=base-src 本地路径；.gitmodules + 工作区）" + (addLanded ? "" : "；最后现场: " + lastErr));
// 等 repoTree 刷新落地（管理区计数 1/2 → 2/2），再进 Phase D——避免对陈旧 UI 点击
const cnt2 = await waitState(subState,
  `(() => { const sec = Array.from(document.querySelectorAll('${PANEL} .gm-section')).find((x) => x.textContent.includes('子仓库（子模块')); return !!sec && /子模块 2 \\/ 嵌套 2/.test(sec.textContent); })()`, 30000);
expect(cnt2.subSection !== undefined && /子模块 2 \/ 嵌套 2/.test(cnt2.subSection), "管理区计数更新为「子模块 2 / 嵌套 2」（实际: " + cnt2.subSection.slice(0, 30) + "）");

// ---- Phase D：嵌套仓库就地注册 ----
console.log("---- Phase D: vendor-tool 注册为 submodule ----");
let regLanded = false;
let regErr = "";
for (let i = 0; i < 4 && !regLanded; i++) {
  // 精确点击 vendor-tool 行的注册按钮（页面上有多个「注册为 submodule」，base-src 的被禁用）
  await evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('${PANEL} .gm-sub-row')).filter((r) => r.textContent.includes('vendor-tool'));
    for (const r of rows) {
      const b = Array.from(r.querySelectorAll('button')).find((x) => x.textContent.trim() === '注册为 submodule');
      if (b && !b.disabled) { b.click(); return true; }
    }
    return false;
  })()`);
  for (let j = 0; j < 8 && !regLanded; j++) {
    try {
      const t = git(["config", "-f", ".gitmodules", "--get-regexp", "path"], { allowFail: true }).toString();
      if (/vendor-tool/.test(t)) { regLanded = true; break; }
    } catch (_) { /* 轮询中 */ }
    await sleep(700);
  }
  if (!regLanded) {
    regErr = String(await evalJs(`JSON.stringify({
      err: (Array.from(document.querySelectorAll('body > .gm-overlay .gm-errbar')).map((e) => e.textContent).join("|") || "").slice(0, 160),
      notice: (Array.from(document.querySelectorAll('body > .gm-overlay .gm-notice')).map((e) => e.textContent).join("|") || "").slice(0, 160),
      activeTab: (document.querySelector('body > .gm-overlay .gm-tab-active')||{textContent:''}).textContent.trim(),
      regBtn: (() => { const b = Array.from(document.querySelectorAll('body > .gm-overlay button')).find((x) => x.textContent.trim() === '注册为 submodule'); return b ? (b.disabled ? "disabled:" + b.title.slice(0, 30) : "enabled") : "not-found"; })(),
    })`) || "{}");
    console.log("  尝试 " + (i + 1) + " 未生效，现场: " + regErr);
  }
}
expect(regLanded === true, ".gitmodules 含 vendor-tool 条目（就地注册，内容不动）" + (regLanded ? "" : "；最后现场: " + regErr));
expect(existsSync(SUPER + "/vendor-tool/n.txt"), "vendor-tool 内容未受影响");
// 等 repoTree 刷新落地（管理区计数 2/2 → 3/1）
const cnt3 = await waitState(subState,
  `(() => { const sec = Array.from(document.querySelectorAll('${PANEL} .gm-section')).find((x) => x.textContent.includes('子仓库（子模块')); return !!sec && /子模块 3 \\/ 嵌套 1/.test(sec.textContent); })()`, 45000);
expect(cnt3.subSection !== undefined && /子模块 3 \/ 嵌套 1/.test(cnt3.subSection), "管理区计数更新为「子模块 3 / 嵌套 1」（实际: " + cnt3.subSection.slice(0, 30) + "）");

// ---- Phase E：Fetch 全部（串行 + 聚合 notice）----
console.log("---- Phase E: Fetch 全部 ----");
await evalJs(clickBtnWith(`${PANEL} button`, "Fetch 全部", true));
const s4 = await waitState(subState,
  `(() => { const p = document.querySelector('${PANEL}'); const t = p ? p.textContent : ''; return t.includes('Fetch 完成') || t.includes('Fetch 全部失败'); })()`, 30000);
const summary = /Fetch (完成|全部失败)[^"]{0,60}/.exec(s4.panelText);
expect(!!summary, "「Fetch 全部」聚合提示出现（实际: " + (summary ? summary[0] : "未找到") + "）");
expect(/成功 \d+/.test(s4.panelText), "聚合提示含成功计数（fixture 远端拓扑下的实际分布）");

console.log(failed ? "\nP2 E2E: FAIL" : "\nP2 E2E: ALL PASS");
process.exit(failed ? 1 : 0);
