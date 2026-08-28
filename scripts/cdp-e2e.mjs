// 临时 CDP e2e：真实时间轴驱动 headless Edge，等 RPC 完成后读 DOM 状态
// 用法: node .debug-cdp.mjs <pageUrl> <cdpPort> [waitMs]
const pageUrl = process.argv[2] || "http://127.0.0.1:3465/";
const cdpPort = Number(process.argv[3] || 9223);
const waitMs = Number(process.argv[4] || 8000);

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

const expr = `JSON.stringify({
  marker: document.querySelector('.gm-debug') ? document.querySelector('.gm-debug').getAttribute('data-probe') : null,
  markerCwd: document.querySelector('.gm-debug') ? document.querySelector('.gm-debug').getAttribute('data-cwd') : null,
  btn: !!document.querySelector('button.gm-toolbtn'),
  btnHtml: (document.querySelector('button.gm-toolbtn')||{}).outerHTML ? document.querySelector('button.gm-toolbtn').outerHTML.slice(0,300) : null,
  badge: !!document.querySelector('.gm-badge'),
  fab: !!document.querySelector('.gm-fab'),
  phase: (document.querySelector('[data-phase]')||{}).dataset ? document.querySelector('[data-phase]').dataset.phase : null,
})`;
const res = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log("DOM state:", res.result && res.result.result ? res.result.result.value : JSON.stringify(res));

console.log("--- console (git-manager) ---");
for (const l of consoleLines.filter((x) => x.includes("git-manager"))) console.log(l.slice(0, 300));

ws.close();
process.exit(0);
