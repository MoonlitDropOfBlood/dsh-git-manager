# AGENTS.md — dsh-git-manager

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：在 DSH Web UI 中提供完整的 Git 工作区管理面板。

- 唯一入口在 composer 工具行「模式」（access-mode）选择器旁（`conversation.input.left` 槽），hero 空白会话与会话内都渲染这一行；**仅当目标目录是 git 仓库时显示**（probe 60s 轮询缓存，非仓库返回 null）。顶部无其他入口（头部徽章已按用户决策移除）。
- 弹窗尺寸/结构与「设置」面板完全一致：`width:800px; max-width:calc(100vw - 48px); height:min(800px,100vh - 48px); border-radius:24px; background:--dsw-alias-bg-layer-2; box-shadow:--dsw-shadow-lv3`；mask 层 `--dsw-alias-bg-mask-1 + --dsw-mask-blur`，mask 点击与 document 级 Esc 都关闭。
- 同一个 `shell.overlay` 全屏面板，五 Tab：变更 / 分支 / 历史 / 冲突 / Worktree。
- 历史 Tab 的分支线由 Host 侧 `git-graph.mjs` 的 `computeGraph` 算好 layout，Client 纯 SVG 渲染。
- 全屏面板用 `ReactDOM.createPortal(..., document.body)` 落到 body 层（z-index 1000），绕开 `shell.overlay` 槽位宿主 stacking context 的 z-index 锁死问题（详见注意事项 §1）。

## 目录结构

```
dsh-git-manager/
├── package.json
├── index.js              # Host 半：GitManagerService（TypertRemoteService 子类）
├── client.js             # Client 半：__ModuleLoader__ bundle（composer 入口按钮 + 弹窗面板）
├── typert.host.js        # Typert manifest：gitManager 全方法的 zod schema
├── git-core.mjs          # 零依赖：runGit 封装 + 全部查询/变更函数 + 解析器
├── git-graph.mjs         # 零依赖：computeGraph 分支线布局（纯函数）
├── cordis.patch.yml
├── scripts/self-test.mjs # 解析器 fixture + 临时仓库 live 集成测试
├── .github/workflows/release.yml
├── AGENTS.md
├── README.md
└── LICENSE
```

## 关键机制

### 1. DSH 正式插件 = 三件套（Host / Client / Typert）

| 文件 | 作用 |
|---|---|
| `index.js` | Host half：Cordis **类插件**，导出 `GitManagerService`，服务键 `gitManager` |
| `client.js` | Client half：浏览器 UI bundle |
| `typert.host.js` | Host manifest：描述 `gitManager` 服务的 Remote 方法 wire schema |

**关键名字必须一致**：类名 `GitManagerService`、服务键 `gitManager`、invocation id `dsh-git-manager#gitManager/<method>`、`package.json` exports 含 `./package.json`。

### 2. Host 半：类插件 + Remote 方法

```js
export class GitManagerService extends TypertRemoteService {
  static inject = [];
  constructor(ctx, config) { super(ctx, "gitManager"); }
  [Service.init]() {
    markRemoteMethod(this, "probe", "probe");
    // ...全部 27 个方法
  }
  async probe(request) { /* runGit + 解析 → 返回 ok:true,value */ }
}
```

Node ESM 不支持装饰器，`markRemoteMethod(instance, method, exportName)` 手动驱动 `Remote(name)` 装饰器（在 `[Service.init]()` 调用）。

### 3. Client 半：bundle 格式 + 自挂载 Remote + Portal 渲染

```js
window.__ModuleLoader__.load({
  id: "@duke-dsh-plugins/dsh-git-manager",
  factory: (require) => {
    var module = { exports: {} };
    const React = require("react");
    const ReactDOM = require("react-dom");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");
    // ...
    const passthrough = () => ({ parse: (v) => v });
    const method = (m) => ({ /* ...typeSymbol: dsh-git-manager#GitManager<m>Request */ });
    const CLIENT_REMOTE = { package: "dsh-git-manager", descriptors: ["probe","overview",...].map(method) };
    async function apply(ctx) {
      await ctx.remote.$mount(CLIENT_REMOTE);
      // 挂样式、CSS
      // 注册两个槽：conversation.input.left（composer 工具行唯一入口）+ shell.overlay（面板宿主）
      // shell.overlay 注册的组件里用 ReactDOM.createPortal(panelContent, document.body)
      // 让面板 DOM 落在 body 层（z-index 1000），避开 shell.overlay 的 stacking context 锁死
    }
    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
```

### 4. git-core.mjs 核心约束

- 所有 git 调用走 `runGit(cwd, args, opts)`：`execFile("git", argv, { cwd, windowsHide:true, encoding:"utf8", timeout, maxBuffer, env })`，env 强制加 `GIT_TERMINAL_PROMPT=0` 与 `GIT_EDITOR=true`，BASE_ARGS 前置 `-c core.quotepath=false -c color.ui=false -c i18n.logoutputencoding=UTF-8`。
- **绝不** 拼接 shell 字符串。
- 路径防护（discard 未跟踪 / resolveConflict custom）：`resolve(toplevel, rel)` 后必须以前缀 `toplevel` 开头，否则抛 `GitError("exit", ...)`。
- 错误分类：`GitError.kind` ∈ `missing | timeout | too-large | exit`；`exit` 在 Host 入口再细分（`not-a-repo` / `dubious-ownership` / `auth-failed` / `git-failed`）。

### 5. git-graph.mjs computeGraph

纯函数，输入 `[{sha, parents:string[]}]`（`git log --all --date-order` 顺序），输出 `{ nodes, links, laneCount }`。

`--date-order` 保证父提交晚于子提交出现；toRow > fromRow 恒成立（单测断言）。

Client 渲染时：固定 `ROW_H=32, COL_W=14`，调色板 12 色写死；同列用竖线、跨列用 cubic bezier 曲线、`toRow=null`（窗口外父）画到 SVG 底部、节点圆 `fill=PALETTE[color]`。

## 开发 / 验证

```bash
npm run check            # 全部 JS 语法检查
npm test                 # 自测（解析器 fixture + live 集成）
dsh plugin --profile web add D:\ai-projects\dsh\dsh-git-manager   # 本地安装/重装
```

改插件后**必须重启 DSH** 生效。手动验证清单见 `docs/plans/2026-08-23-dsh-git-manager.md` §9。

## 常规注意事项

- **index.js 必须 `export default GitManagerService`（大坑，实测）**：cordis loader 的 `unwrapExports` 取 `exports.default ?? exports`——ESM 命名空间对象（只有命名导出、无 default）不是合法 plugin，registry 直接抛 `invalid plugin, expect function or object with an "apply" method, received object`，**整个 DSH 起不来**。memory-manager / archive-manager 都有 `export default <Service>`；方案文档最初漏了这行。**node --check 与 self-test 都发现不了**（都不校验模块形状），只有真实 boot 才暴露。
- **typert.host.js 必须导出 `TYPERT` 对象且 shape 严格（实测）**：dsh-typert-loader 的 `validateTypertManifest` 要求 `export const TYPERT = { package, face:"host", schemas:[], invocations:[...], model:{services:[...], events:[], objects:[]} }`。service 需 `key/exportName/members(数组, 每项 kind∈{method,property,...}+name+signature)/types(数组)/tags+description+summary+jsDoc`。缺 `model.events`/`model.objects` 数组、或只导出 model/invocations 而不导出 TYPERT，boot 报 `no TYPERT manifest object` / `TYPERT.model.events must be an array`。invocation 的 parameters/result codec 必须 `mode:"strict"` 且 schema 是 zod v4 实例。
- **profile package.json 绝不能写 BOM（大坑，实测）**：DSH 的 `readProfileManifest` 直接 `JSON.parse` profile 的 `package.json`；任何 UTF-8 BOM 都会让它抛 `Unexpected token '﻿'` 崩溃——**整个 profile 起不来**（dump-config 和真实启动都崩）。Windows PowerShell 的 `Set-Content -Encoding UTF8` 默认写 BOM；改 `~/.dsh/profiles/web/package.json` 必须用无 BOM 编码（`.NET WriteAllText + UTF8Encoding(false)`，或 `dsh plugin add` 官方路径）。
- **本地装完必须验证 boot manifest，而不是只信 `dsh plugin add` 成功**：`dsh --profile web --dump-config | findstr git-manager` 确认 entry 进组合树 → 起独立端口实例 → 抓 HTML 的 `__DSH_BOOT__` 看 `id:"@duke-dsh-plugins/dsh-git-manager"` 是否出现 → `curl http://127.0.0.1:PORT/plugins/@duke-dsh-plugins/dsh-git-manager/client.js` 是否 200。loader import 失败（如缺 default 导出）会**静默剔除 client bundle**（`processOne` 对 fiber 未挂载的 entry 直接 `table.delete`，不报错），表现为"Host 不崩但入口消失"。
- **弹窗层级**：本插件**不**直接用 `shell.overlay` 渲染 DOM——因为该槽宿主在 AppFrame 的 `.overlayLayer`（`position:absolute; z-index:20`）内，子元素 z-index 被 stacking context 锁死，dsh-better-sidebar（z-index:25）会把面板盖住。**修复**：面板用 `ReactDOM.createPortal(..., document.body)` 渲染到 body 层（`position:fixed; z-index:1000`），赢过一切页面层。注意 React 树仍属于 `shell.overlay` 槽（props / 生命周期完整），只是 DOM 出口换了。**绝不要**手动 `appendChild` 把 React 管理的 DOM 挪到 body（会偷走 React 节点导致下次调和 NotFoundError）——portal 才是官方逃生口。
- **颜色一律走 dsw token，禁止硬编码 hex/rgba（用户实测反馈）**：亮/暗主题下硬编码色必有一边翻车。映射规则：警示横幅 `state-warn-tertiary`/`state-warn-label`，错误 `state-error-primary`+`interactive-bg-hover-danger`，成功 `state-success-primary`，**主按钮用 `button-info-fill`/`button-info-hover`+`#fff`（与 composer 发送按钮完全一致，实测取自 InputBar.primary；`button-primary-fill` 是黑白反色对比风格，曾用错被用户指出）**，选中态 `specific-sidebar-nav-item-active`（与设置导航一致），次要文字 `label-secondary/tertiary`。需要"某颜色的 15% 透明底"时用 `color-mix(in srgb, var(--dsw-...) 15%, transparent)`（WebView2/Chromium ≥111 支持）。图标不依赖 ui-primitives 的 Icon 导出（共享模块表不保证有），一律内联 SVG（stroke=currentColor）。
- **会话头部槽位 kit**：`conversation.session.header.actions` 是 session-scope 槽，owner props 是空对象 `{}`，只有 framework 注入的 `sessionId`/`useSession`/`useProjection`——**没有** `useSessions`/`useWorkspaces`（那是 root-scope 槽才有）。要拿会话 cwd 用 `props.sessionId` + `ctx.sessions.list`（ObservableSnapshot: getSnapshot + subscribe，可直接喂 useSyncExternalStore）。
- **composer 工具行入口槽 `conversation.input.left`（实测）**：session-scope list 槽，位于 composer 卡片内工具行左端、紧跟常驻 chrome（access-mode/plan/attach）——即"模式选择器旁边"的正确挂载点（右下角 FAB 会与其他插件冲突，已废弃）。标准 kit **含** `useSessions`/`useWorkspaces`/`useInput`/`inputActions`，比 header.actions 全；hero 空白会话的 composer 同样渲染这一行，一个槽位覆盖两种上下文。同类还有 `conversation.input.right`（send 按钮左侧）。
- **factory 作用域没有 `remote`（实测踩坑）**：组件都定义在 bundle factory 作用域，而 `remote = ctx.get("remote.gitManager")` 是 `apply()` 的局部变量——组件里裸引用 `remote` 会 ReferenceError。若抛在**异步 effect** 里则不崩 React 树、组件只是静默永不渲染（曾有组件因此长期不可见且无任何报错）。规则：组件一律从 `props.remote` 取，由 apply 内 wrapper（`ComposerGitButtonSlot`）注入；self-test 有静态守卫。
- **路径归一化（review 教训）**：`safeJoin` 接收 `git rev-parse --show-toplevel` 输出的 toplevel；Windows git 输出**正斜杠**（如 `D:/repo`），而 `node:path.resolve` 归一为**反斜杠**（`D:\repo`）。如果直接 `startsWith(toplevel + sep)` 会永远 false，所有合法路径被误判越界。正确做法：`const root = resolve(toplevel)`，再用 `startsWith(root + sep)`。
- **MERGE_HEAD 路径（review 教训）**：`git rev-parse --git-dir` 在 cwd=toplevel 时返回相对路径 `.git`；`existsSync(join(gitDir, "MERGE_HEAD"))` 必须先 `resolve(cwd, gitDir)` 归一化到绝对路径，否则 MERGE_HEAD 检测落到 DSH 进程 cwd 上、永远 false，合并进行中 banner 不会出现。
- **continueMerge 守门**：MERGE_HEAD / rebase-merge / rebase-apply 任一不存在时**必须抛错**——否则 `git commit --no-edit` 会提交 staged 内容，得到一个意外的"空 commit"。`git-core.mjs:continueMerge` 已加守卫。
- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（生成文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是 patch 数组：`- insert:` 新增、`- id:` 覆盖。
- `client.js` 用 `require("react")` 与 `require("react-dom")`（bundle 模块表提供），**不要** `import`；不用动态插件的 styles/host 全局。
- 组件类型全部 bundle 作用域定义一次（内联创建会导致 React 每次 remount 丢输入态）。
- typert result schema 是 strict：Host 返回结构与 schema 逐字段一致。
- 危险操作全部 UI 二次确认；force push 只用 `--force-with-lease`。
- **skip-live 不算 PASS**：`scripts/self-test.mjs` 在 git 不可用时跳过 live 测试并以 exit 1 退出——把"绿"误读为通过会让静默跳过的 bug 上线。CI 跑测试必须用真实 git。
- **Remote 返回值必须「网关 JSON-safe」（大坑，实测）**：dsh-api-gateway 的 `decode()` 在 zod parse **之后**还跑 `assertJsonValue`——显式 `undefined` 的 own key（zod `.optional()` 会原样放行 parse 输出里的 undefined！）、schema 声明外的 `null`（如 `union(boolean,string)` 里塞 null）、非 plain object、循环引用，一律抛 `business result failed boundary validation`，**客户端 RPC 永久 pending、无任何报错，UI 静默无数据**（实测症状：入口按钮在真仓库里也不出现，因为 probe 响应被网关吞了）。规则：可选字段**有值才挂 key**（`if (x !== undefined) out.x = x`），union 里的空值用 `false`/`""` 不要用 `null`。self-test 的 `wire:` 守卫会用真实 git 仓库的返回值跑 strict schema + 等价 assertJsonSafe 复刻——**新增/修改 Remote 方法的返回结构必须过它**。
- **headless `--dump-dom` 抓不到"RPC 回来才渲染"的组件（实测）**：Edge headless 在 virtual-time 耗尽时 dump，不等真实 fetch 往返——像 ComposerGitButton 这种 probe 门控的组件在 dump 里永远缺席，stderr console 也有截断/丢失。验证这类 UI 用 CDP：`--remote-debugging-port=9223` 起 headless Edge，然后 `node scripts/cdp-e2e.mjs <pageUrl> 9223 8000`（Node 内置 fetch/WebSocket 连 `/json/list` 拿 target，真实 sleep 后 `Runtime.evaluate` 读 DOM 与 console）。
- **Remote RPC 可脱离浏览器直接 curl 测（实测）**：`POST http://127.0.0.1:<port>/api/<namespace>/<method>`，body `{"type":"client-request","rpcId":"<uuid>","method":"<namespace>/<method>","payload":{"args":{"request":{...}}}}`，返回 `{"type":"server-response","rpcId":...,"result":{"ok":true,"value":<方法返回值>}}`——注意 result.value 里还套着方法自己的 `{ok,value}` 包络（client 侧 `unwrap` 就是处理这个）。分层排障时先 curl 证明 Host 链路通，再查浏览器侧。
- 发布 npm 必须 `--registry=https://registry.npmjs.org`（本机默认 registry 被 npmmirror 覆盖）。