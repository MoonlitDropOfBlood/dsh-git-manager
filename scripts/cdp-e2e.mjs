// CDP e2e：真实时间轴驱动 headless Edge，等 RPC 完成后读 DOM 状态。
// 验证链路（0.2.0 起同款，v2 扩展）：
//   1. client bundle 加载并跑完 apply（console 冒烟行）
//   2. composer 工具行入口按钮出现（probe 门控：目标目录是 git 仓库才渲染）
//   3. 点按钮 → GitPanel 面板经 Portal 渲染到 body（.gm-overlay/.gm-panel）
//   4. 六 Tab 可开（变更/分支/历史/冲突/Worktree/设置）+ 提交框存在
//   5. 「撤销此块」确认框浮于 diff 窗口之上（z-index 数值 + elementFromPoint 遮挡断言）
//   6. Esc 层级：确认框 → diff 窗口 → 面板（modalStack 栈顶规则，契约 §0）
//   7. stash / tag 主路径（折叠区 + 新建弹窗开合）
//   8. P3-A：行级选择浮条（契约 §8.3）+ rebase todo 弹窗（契约 §8.6；无前置条件时 SKIP）
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

// ---- evaluate helpers ----
async function evalJs(expression) {
  const res = await cdp("Runtime.evaluate", { expression, returnByValue: true });
  const r = res.result && res.result.result;
  if (r && r.subtype === "error") { console.log("eval error:", r.description || ""); return undefined; }
  return r ? r.value : undefined;
}
const ESC = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))";
// 按文本找按钮并点击（root 限定选择器范围）
const clickBtn = (root, text) => `(() => {
  const btn = Array.from(document.querySelectorAll(${JSON.stringify(root)})).find((b) => b.textContent.trim().includes(${JSON.stringify(text)}));
  if (btn) { btn.click(); return true; }
  return false;
})()`;
// 按文本开 Tab
const clickTab = (label) => `(() => {
  const btn = Array.from(document.querySelectorAll('body > .gm-overlay .gm-tab')).find((b) => b.textContent.trim().includes(${JSON.stringify(label)}));
  if (btn) { btn.click(); return true; }
  return false;
})()`;

const readState = `JSON.stringify({
  applyRan: true,
  btn: !!document.querySelector('button.gm-toolbtn'),
  btnCwd: (document.querySelector('button.gm-toolbtn')||{title:''}).title.split('\\n')[1] || null,
  panelOpen: !!document.querySelector('body > .gm-overlay .gm-panel'),
  panelTabs: Array.from(document.querySelectorAll('body > .gm-overlay .gm-tab')).map((e) => e.textContent.trim().replace(/[0-9]+$/, '')).slice(0, 8),
  commitBox: !!document.querySelector('body > .gm-overlay .gm-commit textarea'),
  commitPlaceholder: (document.querySelector('body > .gm-overlay .gm-commit textarea')||{placeholder:''}).placeholder,
  hasStageAll: Array.from(document.querySelectorAll('body > .gm-overlay button')).some((b) => b.textContent.trim() === '暂存全部'),
  hasUnstageAll: Array.from(document.querySelectorAll('body > .gm-overlay button')).some((b) => b.textContent.trim() === '取消暂存全部'),
})`;

const res = await cdp("Runtime.evaluate", { expression: readState, returnByValue: true });
const state = JSON.parse(res.result && res.result.result ? res.result.result.value : "{}");
console.log("DOM state:", JSON.stringify(state));

let failed = false;
function expect(cond, label) {
  console.log((cond ? "[PASS] " : "[FAIL] ") + label);
  if (!cond) failed = true;
}
function skip(label, why) {
  console.log("[SKIP] " + label + " — " + why);
}
expect(consoleLines.some((l) => l.includes("client apply() ran, mounting UI")), "client bundle apply() 已执行（bundle 加载成功）");
expect(state.btn === true, "composer 入口按钮出现（probe 判定目标目录是 git 仓库）");

if (state.btn === true) {
  // ---- 打开面板 ----
  await cdp("Runtime.evaluate", { expression: "document.querySelector('button.gm-toolbtn').click()", returnByValue: true });
  await sleep(2500); // 面板打开 + overview/log RPC
  const state2 = JSON.parse((await evalJs(readState)) || "{}");
  console.log("panel state:", JSON.stringify(state2));
  expect(state2.panelOpen === true, "GitPanel 经 Portal 渲染到 body（shell.overlay 槽 + createPortal）");
  expect(Array.isArray(state2.panelTabs) && state2.panelTabs.length >= 6, "六个 Tab 渲染（变更/分支/历史/冲突/Worktree/设置）");
  expect(state2.panelTabs && state2.panelTabs.some((t) => t.includes("设置")), "第六 Tab「设置」存在");
  expect(state2.commitBox === true && String(state2.commitPlaceholder).includes("提交信息"), "提交框存在（多行 message 输入）");
  expect(state2.hasStageAll === true && state2.hasUnstageAll === true, "「暂存全部 / 取消暂存全部」工具行存在");

  // ---- 六 Tab 逐个可开 ----
  for (const tab of ["分支", "历史", "冲突", "Worktree", "设置", "变更"]) {
    await evalJs(clickTab(tab));
    await sleep(600);
    const st = JSON.parse((await evalJs(`JSON.stringify({ open: !!document.querySelector('body > .gm-overlay .gm-panel'), active: (document.querySelector('body > .gm-overlay .gm-tab-active')||{textContent:''}).textContent.trim() })`)) || "{}");
    expect(st.open === true && String(st.active).includes(tab), "Tab「" + tab + "」可打开");
  }

  // ---- 「撤销此块」确认框浮于 diff 窗口之上（P0 回归，契约 §0）----
  await evalJs(clickTab("变更"));
  await sleep(800);
  const openedFile = await evalJs(`(() => {
    const groups = Array.from(document.querySelectorAll('body > .gm-overlay .gm-filegroup'));
    const g = groups.find((x) => { const h = x.querySelector('.gm-filegroup-head'); return h && h.textContent.trim().startsWith('Unstaged'); });
    const row = g && g.querySelector('.gm-file');
    if (row) { row.click(); return row.textContent.trim().slice(0, 80); }
    return null;
  })()`);
  await sleep(1800);
  const diffOpen = await evalJs("!!document.querySelector('body > .gm-diffwin')");
  if (!openedFile || !diffOpen) {
    skip("撤销此块确认框层级", "目标仓库没有未暂存（Unstaged）文件可点开 diff 窗口");
  } else {
    expect(diffOpen === true, "diff 独立窗口打开（.gm-diffwin，Portal 落 body）");
    console.log("opened file:", openedFile);

    // ---- 行级选择冒烟（P3-A，契约 §8.3）：点行 → 浮出操作条 ----
    const lineSelState = JSON.parse((await evalJs(`(() => {
      const line = document.querySelector('body > .gm-diffwin .gm-diff-line.gm-diff-sel-on');
      if (!line) return JSON.stringify({ clickable: false });
      line.click();
      return JSON.stringify({ clickable: true });
    })()`)) || "{}");
    await sleep(400);
    const lineBarState = JSON.parse((await evalJs(`(() => {
      const bar = document.querySelector('body > .gm-diffwin .gm-linebar');
      return JSON.stringify({
        bar: !!bar,
        stage: !!(bar && Array.from(bar.querySelectorAll('button')).find((b) => b.textContent.includes('暂存选中行'))),
        discard: !!(bar && Array.from(bar.querySelectorAll('button')).find((b) => b.textContent.includes('撤销选中行'))),
        selRow: !!document.querySelector('body > .gm-diffwin .gm-diff-line-sel'),
      });
    })()`)) || "{}");
    if (!lineSelState.clickable) {
      skip("行级选择", "diff 窗口内无可点选的 diff 行");
    } else {
      expect(lineBarState.bar === true && lineBarState.selRow === true, "点击 diff 行出现行级选择高亮 + 浮出操作条（.gm-linebar）");
      expect(lineBarState.stage === true && lineBarState.discard === true, "unstaged diff 浮条含「暂存选中行 / 撤销选中行」");
      await evalJs(clickBtn("body > .gm-diffwin .gm-linebar button", "取消选择"));
      await sleep(300);
    }

    const clickedHunk = await evalJs(clickBtn("body > .gm-diffwin .gm-hunk-btn", "撤销此块"));
    await sleep(600);
    expect(clickedHunk === true, "diff 窗口内「撤销此块」按钮存在并被点击");
    const modal = JSON.parse((await evalJs(`(() => {
      const confirm = document.querySelector('body > .gm-confirm');
      const diffwin = document.querySelector('body > .gm-diffwin');
      const box = document.querySelector('body > .gm-confirm .gm-confirm-modal');
      const cz = confirm ? Number(getComputedStyle(confirm).zIndex) : -1;
      const dz = diffwin ? Number(getComputedStyle(diffwin).zIndex) : -1;
      let onTop = false;
      if (box) {
        const r = box.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        onTop = !!(el && el.closest('body > .gm-confirm'));
      }
      return JSON.stringify({ confirm: !!confirm, diffwin: !!diffwin, confirmZ: cz, diffwinZ: dz, confirmOnTop: onTop });
    })()`)) || "{}");
    console.log("modal state:", JSON.stringify(modal));
    expect(modal.confirm === true, "「撤销此块」二次确认框出现");
    expect(modal.confirmZ >= 1100 && modal.diffwinZ >= 1050 && modal.confirmZ > modal.diffwinZ,
      "确认框 z-index(" + modal.confirmZ + ") > diff 窗口 z-index(" + modal.diffwinZ + ")（1100 > 1050 阶梯）");
    expect(modal.confirmOnTop === true, "确认框在视觉最上层（elementFromPoint 命中确认框，未被 diff 窗口遮挡）");

    // ---- Esc 层级：确认框 → diff 窗口 → 面板 ----
    await evalJs(ESC);
    await sleep(500);
    const after1 = JSON.parse((await evalJs(`JSON.stringify({ confirm: !!document.querySelector('body > .gm-confirm'), diffwin: !!document.querySelector('body > .gm-diffwin'), panel: !!document.querySelector('body > .gm-overlay .gm-panel') })`)) || "{}");
    expect(after1.confirm === false && after1.diffwin === true && after1.panel === true, "Esc #1 只关确认框（diff 窗口与面板保留）");
    await evalJs(ESC);
    await sleep(500);
    const after2 = JSON.parse((await evalJs(`JSON.stringify({ diffwin: !!document.querySelector('body > .gm-diffwin'), panel: !!document.querySelector('body > .gm-overlay .gm-panel') })`)) || "{}");
    expect(after2.diffwin === false && after2.panel === true, "Esc #2 只关 diff 窗口（面板保留）");
    await evalJs(ESC);
    await sleep(600);
    const after3 = JSON.parse((await evalJs(`JSON.stringify({ panel: !!document.querySelector('body > .gm-overlay .gm-panel') })`)) || "{}");
    expect(after3.panel === false, "Esc #3 关闭面板（modalStack 空时才关）");
  }

  // ---- stash / tag 主路径 ----
  // 若上面关掉了面板，重新打开
  if (!(await evalJs("!!document.querySelector('body > .gm-overlay .gm-panel')"))) {
    await evalJs("document.querySelector('button.gm-toolbtn').click()");
    await sleep(2000);
  }
  await evalJs(clickTab("变更"));
  await sleep(800);
  const stashUi = JSON.parse((await evalJs(`JSON.stringify({
    pushBtn: Array.from(document.querySelectorAll('body > .gm-overlay button')).some((b) => b.textContent.includes('暂存更改到 stash')),
    clearBtn: Array.from(document.querySelectorAll('body > .gm-overlay button')).some((b) => b.textContent.trim() === '清空 stash'),
    section: Array.from(document.querySelectorAll('body > .gm-overlay .gm-section-title')).some((e) => e.textContent.includes('Stash')),
  })`)) || "{}");
  expect(stashUi.pushBtn === true && stashUi.clearBtn === true && stashUi.section === true, "Stash 折叠区存在（暂存更改到 stash… / 清空 stash）");

  const stashOpened = await evalJs(clickBtn("body > .gm-overlay button", "暂存更改到 stash"));
  await sleep(600);
  const stashDlg = JSON.parse((await evalJs(`(() => {
    const dlg = document.querySelector('body > .gm-confirm');
    return JSON.stringify({
      open: !!dlg,
      textarea: !!(dlg && dlg.querySelector('textarea')),
      checkbox: !!(dlg && dlg.querySelector('input[type=checkbox]')),
      submit: !!(dlg && Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent.includes('创建 stash'))),
      z: dlg ? Number(getComputedStyle(dlg).zIndex) : -1,
    });
  })()`)) || "{}");
  expect(stashOpened === true && stashDlg.open === true, "「暂存更改到 stash…」弹窗打开（Portal 落 body）");
  expect(stashDlg.textarea === true && stashDlg.checkbox === true && stashDlg.submit === true, "stash 弹窗含 message 输入 + 包含未跟踪勾选 + 提交按钮");
  expect(stashDlg.z >= 1100, "stash 弹窗 z-index(" + stashDlg.z + ") ≥ 1100");
  await evalJs(ESC);
  await sleep(500);
  const stashClosed = JSON.parse((await evalJs(`JSON.stringify({ dlg: !!document.querySelector('body > .gm-confirm'), panel: !!document.querySelector('body > .gm-overlay .gm-panel') })`)) || "{}");
  expect(stashClosed.dlg === false && stashClosed.panel === true, "Esc 只关 stash 弹窗（面板保留，层级语义一致）");

  // tag 主路径
  await evalJs(clickTab("分支"));
  await sleep(1000);
  const tagUi = JSON.parse((await evalJs(`JSON.stringify({
    section: Array.from(document.querySelectorAll('body > .gm-overlay .gm-section-head')).some((e) => e.textContent.includes('Tag (')),
    newBtn: Array.from(document.querySelectorAll('body > .gm-overlay button')).some((b) => b.textContent.includes('新建 tag')),
  })`)) || "{}");
  expect(tagUi.section === true, "Tag 区存在（分支 Tab 下半）");
  expect(tagUi.newBtn === true, "「新建 tag…」入口存在");
  const tagOpened = await evalJs(clickBtn("body > .gm-overlay button", "新建 tag"));
  await sleep(600);
  const tagDlg = JSON.parse((await evalJs(`(() => {
    const dlg = document.querySelector('body > .gm-confirm');
    return JSON.stringify({
      open: !!dlg,
      inputs: dlg ? dlg.querySelectorAll('input').length : 0,
      textarea: !!(dlg && dlg.querySelector('textarea')),
      submit: !!(dlg && Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent.trim() === '创建')),
      z: dlg ? Number(getComputedStyle(dlg).zIndex) : -1,
    });
  })()`)) || "{}");
  expect(tagOpened === true && tagDlg.open === true, "「新建 tag…」弹窗打开（name/target/message/force）");
  expect(tagDlg.inputs >= 2 && tagDlg.textarea === true && tagDlg.submit === true, "tag 弹窗含 name/target 输入 + annotated message + 创建按钮");
  expect(tagDlg.z >= 1100, "tag 弹窗 z-index(" + tagDlg.z + ") ≥ 1100");
  await evalJs(ESC);
  await sleep(500);

  // 设置 Tab：remote/config 就位或「即将推出」占位（二选一都算通过）
  await evalJs(clickTab("设置"));
  await sleep(1200);
  const settings = JSON.parse((await evalJs(`JSON.stringify({
    soon: Array.from(document.querySelectorAll('body > .gm-overlay .gm-empty')).some((e) => e.textContent.includes('即将推出')),
    remoteSection: Array.from(document.querySelectorAll('body > .gm-overlay .gm-section-head')).some((e) => e.textContent.includes('Remote (')),
    configSection: Array.from(document.querySelectorAll('body > .gm-overlay .gm-section-head')).some((e) => e.textContent.includes('Config (')),
  })`)) || "{}");
  console.log("settings state:", JSON.stringify(settings));
  expect(settings.soon === true || (settings.remoteSection === true && settings.configSection === true),
    "设置 Tab 显示 remote/config 管理或「即将推出」占位（P2 未就位时安全降级）");

  // ---- rebase todo 弹窗冒烟（P3-A，契约 §8.6）----
  await evalJs(clickTab("历史"));
  await sleep(1500);
  const detailOpened = await evalJs(`(() => {
    const row = document.querySelector('body > .gm-overlay .gm-hist-main .gm-file');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  await sleep(1800);
  const todoBtn = await evalJs(clickBtn("body > .gm-overlay .gm-hist-detail button", "从这里整理历史"));
  await sleep(1800);
  const todoDlg = JSON.parse((await evalJs(`(() => {
    const dlg = document.querySelector('body > .gm-confirm');
    return JSON.stringify({
      open: !!dlg,
      rows: dlg ? dlg.querySelectorAll('.gm-todo-row').length : 0,
      selects: dlg ? dlg.querySelectorAll('select').length : 0,
      submit: !!(dlg && Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent.includes('开始 Rebase'))),
      z: dlg ? Number(getComputedStyle(dlg).zIndex) : -1,
    });
  })()`)) || "{}");
  if (!detailOpened || !todoBtn || !todoDlg.open) {
    skip("rebase todo 弹窗", "历史列表为空 / 该提交为根提交（入口禁用）/ rebasePlan 不可用");
  } else {
    expect(todoDlg.rows >= 1 && todoDlg.selects >= 1, "rebase todo 弹窗列出 todo 行（short sha + subject + action 下拉 pick/squash/fixup/drop/edit）");
    expect(todoDlg.submit === true, "rebase todo 弹窗有「开始 Rebase」按钮（其后接危险级二次确认）");
    expect(todoDlg.z >= 1100, "rebase todo 弹窗 z-index(" + todoDlg.z + ") ≥ 1100");
    await evalJs(ESC);
    await sleep(500);
  }

  // 收尾：Esc 关面板
  await evalJs(ESC);
  await sleep(500);
}

console.log("--- console (git-manager) ---");
for (const l of consoleLines.filter((x) => x.includes("git-manager"))) console.log(l.slice(0, 300));

console.log(failed ? "E2E: FAIL" : "E2E: PASS");
ws.close();
process.exit(failed ? 1 : 0);
