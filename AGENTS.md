# AGENTS.md — dsh-git-manager

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：在 DSH Web UI 中提供完整的 Git 工作区管理面板。

- 未开会话（hero 页）右下角 FAB 入口；会话开启后头部操作行分支徽章接管，FAB 自动隐藏。
- 同一个 `shell.overlay` 全屏面板，五 Tab：变更 / 分支 / 历史 / 冲突 / Worktree。
- 历史 Tab 的分支线由 Host 侧 `git-graph.mjs` 的 `computeGraph` 算好 layout，Client 纯 SVG 渲染。
- 全屏面板用 `ReactDOM.createPortal(..., document.body)` 落到 body 层（z-index 1000），绕开 `shell.overlay` 槽位宿主 stacking context 的 z-index 锁死问题（详见注意事项 §1）。

## 目录结构

```
dsh-git-manager/
├── package.json
├── index.js              # Host 半：GitManagerService（TypertRemoteService 子类）
├── client.js             # Client 半：__ModuleLoader__ bundle（FAB + 全屏面板）
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
      // 注册两个槽：conversation.session.header.actions + shell.overlay
      // shell.overlay 注册的组件里用 ReactDOM.createPortal(panelContent, document.body)
      // 让面板 / FAB DOM 落在 body 层（z-index 1000），避开 shell.overlay 的 stacking context 锁死
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

- **弹窗层级**：本插件**不**直接用 `shell.overlay` 渲染 DOM——因为该槽宿主在 AppFrame 的 `.overlayLayer`（`position:absolute; z-index:20`）内，子元素 z-index 被 stacking context 锁死，dsh-better-sidebar（z-index:25）会把面板盖住。**修复**：FAB 与全屏面板用 `ReactDOM.createPortal(..., document.body)` 渲染到 body 层（`position:fixed; z-index:1000`），赢过一切页面层。注意 React 树仍属于 `shell.overlay` 槽（props / 生命周期完整），只是 DOM 出口换了。**绝不要**手动 `appendChild` 把 React 管理的 DOM 挪到 body（会偷走 React 节点导致下次调和 NotFoundError）——portal 才是官方逃生口。
- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（生成文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是 patch 数组：`- insert:` 新增、`- id:` 覆盖。
- `client.js` 用 `require("react")` 与 `require("react-dom")`（bundle 模块表提供），**不要** `import`；不用动态插件的 styles/host 全局。
- 组件类型全部 bundle 作用域定义一次（内联创建会导致 React 每次 remount 丢输入态）。
- typert result schema 是 strict：Host 返回结构与 schema 逐字段一致。
- 危险操作全部 UI 二次确认；force push 只用 `--force-with-lease`。
- 发布 npm 必须 `--registry=https://registry.npmjs.org`（本机默认 registry 被 npmmirror 覆盖）。