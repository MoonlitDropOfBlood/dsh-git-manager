// CDP e2e：真实时间轴驱动 headless Edge，等 RPC 完成后读 DOM 状态。
// 验证链路（0.2.0 起同款）：
//   1. client bundle 加载并跑完 apply（console 冒烟行）
//   2. composer 工具行入口按钮出现（probe 门控：目标目录是 git 仓库才渲染）
//   3. 点按钮 → GitPanel 面板经 Portal 渲染到 body（.gm-overlay/.gm-panel）
//   4. Esc 关闭面板
// 用法: node scripts/cdp-e2e.mjs <pageUrl> [cdpPort] [waitMs]
const pageUrl = process.argv[2] || "http://127.0.0.1:3465/";
const cdpPort = Number(process.argv[3] || 9223);
const waitMs = Number(process.argv[4] || 12000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等 CDP 起来
let version = null;
for (let i = 0; i < 40; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    break;
  } catch { await sleep(500); }
}
if (!version) { console.log("FAIL: CDP not reachable"); process.exit(1); }

// 找到页面 target（Edge 启动时已带 URL 打开）
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
    const text = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || "")).join(" ");
    consoleLines.push(text);
  }
};
function cdp(method, params) {
  const id = nextId++;
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}

await cdp("Runtime.enable", {});
await cdp("Page.enable", {});
// 若 target 打开的不是目标页，导航过去
if (!target.url.startsWith(pageUrl.replace(/\/$/, ""))) {
  await cdp("Page.navigate", { url: pageUrl });
}

await sleep(waitMs); // 真实等待：RPC 往返 + React 渲染

const readState = `JSON.stringify({
  applyRan: true,
  btn: !!document.querySelector('button.gm-toolbtn'),
  btnCwd: (document.querySelector('button.gm-toolbtn')||{title:''}).title.split('\\n')[1] || null,
  panelOpen: !!document.querySelector('body > .gm-overlay .gm-panel'),
  panelTabs: Array.from(document.querySelectorAll('body > .gm-overlay .gm-tab')).map((e) => e.textContent).slice(0, 5),
})`;

const res = await cdp("Runtime.evaluate", { expression: readState, returnByValue: true });
const state = JSON.parse(res.result && res.result.result ? res.result.result.value : "{}");
console.log("DOM state:", JSON.stringify(state));

let failed = false;
function expect(cond, label) {
  console.log((cond ? "[PASS] " : "[FAIL] ") + label);
  if (!cond) failed = true;
}
expect(consoleLines.some((l) => l.includes("client apply() ran, mounting UI")), "client bundle apply() 已执行（bundle 加载成功）");
expect(state.btn === true, "composer 入口按钮出现（probe 判定目标目录是 git 仓库）");

if (state.btn === true) {
  // 打开面板
  await cdp("Runtime.evaluate", { expression: "document.querySelector('button.gm-toolbtn').click()", returnByValue: true });
  await sleep(2500); // 面板打开 + overview/log RPC
  const res2 = await cdp("Runtime.evaluate", { expression: readState, returnByValue: true });
  const state2 = JSON.parse(res2.result && res2.result.result ? res2.result.result.value : "{}");
  console.log("panel state:", JSON.stringify(state2));
  expect(state2.panelOpen === true, "GitPanel 经 Portal 渲染到 body（shell.overlay 槽 + createPortal）");
  expect(Array.isArray(state2.panelTabs) && state2.panelTabs.length >= 5, "五个 Tab 渲染（变更/分支/历史/冲突/Worktree）");

  // Esc 关闭（diff 窗未开时 Esc 直接关面板）
  await cdp("Runtime.evaluate", { expression: "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))", returnByValue: true });
  await sleep(800);
  const res3 = await cdp("Runtime.evaluate", { expression: readState, returnByValue: true });
  const state3 = JSON.parse(res3.result && res3.result.result ? res3.result.result.value : "{}");
  expect(state3.panelOpen === false, "Esc 关闭面板");
}

console.log("--- console (git-manager) ---");
for (const l of consoleLines.filter((x) => x.includes("git-manager"))) console.log(l.slice(0, 300));

console.log(failed ? "E2E: FAIL" : "E2E: PASS");
ws.close();
process.exit(failed ? 1 : 0);
