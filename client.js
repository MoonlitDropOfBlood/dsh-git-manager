/**
 * dsh-git-manager — Client half (web bundle).
 *
 * 由 DSH web shell 通过 `window.__ModuleLoader__.load` 加载。本 bundle：
 *   1. 自挂载 `gitManager` Remote 命名空间（dsh-api-remotes 只硬编码挂载官方命名空间）
 *   2. 注册 `conversation.session.header.actions` 槽 → 头部分支徽章（session 作用域）
 *   3. 注册 `shell.overlay` 槽 → 同一 React 树里根据状态渲染
 *      - 未开会话（hero 视图）：右下角悬浮按钮 GitFab
 *      - 已开会话：FAB 隐藏（header 徽章接管）
 *      - 面板打开：全屏面板 GitPanel（用 ReactDOM.createPortal 落 body，绕开 stacking context）
 *
 * 面板本体 GitPanel 是统一的组件，包含五个 Tab（变更 / 分支 / 历史 / 冲突 / Worktree）。
 *
 * IMPORTANT: 所有 React 组件在 bundle 作用域定义一次，函数身份稳定；
 * 绝不在 render 里 inline 创建组件类型（每次新身份会让 React 卸载/重挂子树，丢输入态）。
 */

window.__ModuleLoader__.load({
  id: "@duke-dsh-plugins/dsh-git-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const ReactDOM = require("react-dom");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    // ---- CSS（gm- 前缀，颜色全部走 dsw 主题令牌以适配明暗） ----
    const CSS = `
.gm-overlay{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;padding:24px}
.gm-panel{width:min(1180px,94vw);max-height:90vh;display:flex;flex-direction:column;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:16px;box-shadow:var(--dsw-shadow-lv2,0 12px 40px rgba(0,0,0,.25));overflow:hidden}
.gm-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}
.gm-head-title{font-size:14px;font-weight:600;flex:none}
.gm-head-spacer{flex:1}
.gm-head-actions{display:flex;gap:6px;flex:none;align-items:center}
.gm-banner{padding:10px 14px;background:rgba(245,185,66,.12);color:#c97a00;font-size:12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}
.gm-banner-danger{padding:10px 14px;background:rgba(229,72,77,.10);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}
.gm-main{flex:1;display:flex;min-height:0}
.gm-tabs{display:flex;flex-direction:column;width:140px;flex:none;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));padding:8px 6px;gap:2px;background:var(--dsw-alias-bg-layer-1)}
.gm-tab{appearance:none;background:transparent;border:none;cursor:pointer;text-align:left;padding:8px 12px;border-radius:8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.gm-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));color:var(--dsw-alias-label-primary)}
.gm-tab-active{background:var(--dsw-alias-interactive-bg-hover,rgba(74,125,255,.16));color:var(--dsw-alias-brand-primary,#4a7dff);font-weight:500}
.gm-tab-badge{margin-left:auto;font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;min-width:14px;text-align:center}
.gm-content{flex:1;min-width:0;overflow:auto;padding:14px 16px}
.gm-error{padding:8px 14px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.08));color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;margin-bottom:10px;white-space:pre-wrap}
.gm-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-top-color:var(--dsw-alias-brand-primary,#4a7dff);animation:gm-spin .8s linear infinite;flex:none;display:inline-block;vertical-align:middle}
@keyframes gm-spin{to{transform:rotate(360deg)}}
.gm-empty{padding:36px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}

/* FAB */
.gm-fab-root{position:fixed;right:24px;bottom:80px;z-index:1000}
.gm-fab{width:48px;height:48px;border-radius:50%;border:none;background:var(--dsw-alias-brand-primary,#4a7dff);color:#fff;cursor:pointer;box-shadow:var(--dsw-shadow-lv2,0 4px 14px rgba(0,0,0,.18));display:flex;align-items:center;justify-content:center;transition:transform .12s ease}
.gm-fab:hover{transform:scale(1.06)}
.gm-fab:active{transform:scale(.97)}
.gm-fab-tooltip{position:absolute;right:58px;top:50%;transform:translateY(-50%);background:var(--dsw-alias-bg-layer-2,#1f1f23);color:#fff;padding:4px 10px;border-radius:6px;font-size:12px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s}
.gm-fab-root:hover .gm-fab-tooltip{opacity:1}

/* Header badge */
.gm-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;line-height:18px}
.gm-badge:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.gm-badge-detached{font-family:ui-monospace,monospace;font-size:11px}
.gm-badge-dirty{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4a7dff)}
.gm-badge-ahead{color:var(--dsw-alias-state-success-primary,#2fb37d);font-weight:500}
.gm-badge-behind{color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:500}

/* Repo select + header controls */
.gm-select{box-sizing:border-box;height:30px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;padding:0 8px;outline:none;max-width:280px}
.gm-input{box-sizing:border-box;height:30px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;padding:0 10px;outline:none}
.gm-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.gm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.gm-btn-primary{background:var(--dsw-alias-brand-primary,#4a7dff);color:#fff;border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.gm-btn-primary:hover{filter:brightness(.95);background:var(--dsw-alias-brand-primary,#4a7dff)}
.gm-btn-danger{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:rgba(229,72,77,.3)}
.gm-btn:disabled{opacity:.5;cursor:not-allowed}

/* File list (Changes tab) */
.gm-filegroup{padding:8px 0}
.gm-filegroup-head{display:flex;align-items:center;gap:8px;font-weight:500;font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));margin-bottom:6px}
.gm-file{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:13px}
.gm-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.gm-file-active{background:var(--dsw-alias-interactive-bg-hover,rgba(74,125,255,.12))}
.gm-file-kind{font-size:10px;padding:0 6px;border-radius:999px;background:rgba(128,128,128,.12);color:var(--dsw-alias-label-secondary);text-transform:uppercase;line-height:16px;flex:none}
.gm-file-kind-modified{background:rgba(74,125,255,.16);color:var(--dsw-alias-brand-primary,#4a7dff)}
.gm-file-kind-added{background:rgba(62,207,142,.16);color:#2fb37d}
.gm-file-kind-deleted{background:rgba(229,72,77,.16);color:#e5484d}
.gm-file-kind-renamed{background:rgba(167,139,250,.16);color:#9b7ff0}
.gm-file-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-file-old{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:4px}

/* Diff view */
.gm-diff{background:var(--dsw-alias-bg-layer-2,#f7f7f9);border-radius:10px;padding:10px 14px;margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-x:auto;max-height:60vh}
.gm-diff-file{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}
.gm-diff-file:last-child{border-bottom:none}
.gm-diff-fileh{font-family:var(--dsw-font-sans,inherit);font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);padding:4px 0;cursor:pointer;display:flex;align-items:center;gap:8px}
.gm-diff-fileh:hover{color:var(--dsw-alias-brand-primary,#4a7dff)}
.gm-diff-hunk{color:#888;font-size:11px;padding:2px 0}
.gm-diff-line{white-space:pre;padding:0 6px}
.gm-diff-add{background:rgba(62,207,142,.18);color:#1f7a4d}
.gm-diff-del{background:rgba(229,72,77,.16);color:#a31c20}
.gm-diff-ctx{color:var(--dsw-alias-label-secondary)}
.gm-diff-meta{color:#888}
.gm-diff-trunc{padding:8px 0;font-family:var(--dsw-font-sans,inherit);font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic}

/* Commit box */
.gm-commit{margin-top:14px;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.gm-textarea{box-sizing:border-box;width:100%;min-height:60px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,#fafafc);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;padding:8px;outline:none;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.gm-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.gm-checkbox input{accent-color:var(--dsw-alias-brand-primary,#4a7dff)}

/* Confirm dialog */
.gm-confirm{position:fixed;inset:0;z-index:1100;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center}
.gm-confirm-modal{width:min(420px,90vw);padding:18px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:12px;box-shadow:var(--dsw-shadow-lv2)}
.gm-confirm-title{font-size:14px;font-weight:600;margin-bottom:8px}
.gm-confirm-msg{font-size:13px;color:var(--dsw-alias-label-secondary);margin-bottom:14px;white-space:pre-wrap}
.gm-confirm-actions{display:flex;justify-content:flex-end;gap:8px}
`;

    // ---- Client Remote 自挂载 ----
    const passthrough = () => ({ parse: (v) => v });
    const method = (m) => ({
      id: "dsh-git-manager#gitManager/" + m,
      service: "gitManager", namespace: "gitManager", method: m,
      invocation: { kind: "direct" },
      parameters: [{ name: "request", wire: "request", source: "json",
        codec: { mode: "strict", typeSymbol: "dsh-git-manager#GitManager" + m + "Request", schema: passthrough() } }],
      result: { mode: "strict", typeSymbol: "dsh-git-manager#GitManager" + m + "Result", schema: passthrough() },
    });
    // 27 个 Remote 方法（与 index.js + typert.host.js 一致；Task 12 自测已校验）
    const CLIENT_METHODS = [
      "probe","overview","status","diff","log","branches","remotes","worktrees",
      "conflictContent","stage","unstage","discard","commit","branchCreate",
      "checkout","branchDelete","branchRename","merge","mergeAbort","mergeContinue",
      "resolveConflict","fetch","pull","push","worktreeAdd","worktreeRemove",
      "worktreePrune","init",
    ];
    const CLIENT_REMOTE = {
      package: "dsh-git-manager",
      descriptors: CLIENT_METHODS.map(method),
    };

    // 解包网关响应包络（archive-manager 同款；DSH 插件间曾出现过两种形态，赌形态必翻车）
    function unwrap(res) {
      if (!res || res.ok !== true) {
        return { ok: false, error: (res && res.error) || { code: "transport", message: "调用失败" } };
      }
      const v = res.value;
      if (v && typeof v === "object" && typeof v.ok === "boolean") return v;
      return { ok: true, value: v };
    }

    // ---- 模块级状态（面板开关、目标路径） ----
    let openState = { open: false, targetPath: undefined };
    const listeners = new Set();
    function setOpen(open, targetPath) {
      openState = { open: !!open, targetPath: targetPath === undefined ? (openState.targetPath || null) : targetPath };
      listeners.forEach((f) => f());
    }
    function useOpen() {
      return React.useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => openState.open,
      );
    }
    function useTargetPath() {
      return React.useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => openState.targetPath,
      );
    }

    // ---- helpers ----
    function shortMsg(e) {
      if (e && typeof e === "object" && e.error) {
        return (e.error.message || e.error.code || "操作失败");
      }
      return "操作失败";
    }

    // ---- FAB（bundle 作用域定义一次） ----
    function GitFab(props) {
      const onClick = props.onClick;
      return React.createElement("div", { className: "gm-fab-root" },
        React.createElement("span", { className: "gm-fab-tooltip" }, "Git 管理面板"),
        React.createElement("button", {
          type: "button",
          className: "gm-fab",
          onClick: onClick,
          title: "打开 Git 管理面板",
          "aria-label": "Git",
        },
          // git-branch 图标（Lucide 24×24）
          React.createElement("svg", { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
            React.createElement("path", { d: "M6 3v12" }),
            React.createElement("circle", { cx: 18, cy: 6, r: 3 }),
            React.createElement("circle", { cx: 6, cy: 18, r: 3 }),
            React.createElement("path", { d: "M18 9a9 9 0 0 1-9 9" }),
          ),
        ),
      );
    }

    // ---- Header badge ----
    // 仅在 session 作用域内渲染；接受 props.useSessions（来自 framework session kit）
    function HeaderGitBadge(props) {
      // session-kit 注入（见 conversation.session.header.actions slot 契约）
      // 此处 props 可能含 sessionId / cwd；保守做法是直接从 sessions store 读
      const useSessions = props && props.useSessions;
      const current = useSessions ? useSessions((s) => s.current) : undefined;
      const cwd = useSessions ? useSessions((s) => (s.current && s.byId[s.current] ? s.byId[s.current].cwd : null)) : null;
      const [probe, setProbe] = React.useState(null);
      const [overview, setOverview] = React.useState(null);
      const [tick, setTick] = React.useState(0);

      // 组件挂载 + 每 60s 拉一次 overview（仅在 cwd 是仓库时显示）
      React.useEffect(() => {
        let alive = true;
        let interval = null;
        async function refresh() {
          if (!cwd) { setProbe({ isRepo: false }); setOverview(null); return; }
          const r = await unwrap(await remote.overview({ path: cwd }));
          if (!alive) return;
          if (r.ok && r.value) {
            setProbe(r.value.probe);
            setOverview(r.value.status);
          } else {
            setProbe({ isRepo: false });
            setOverview(null);
          }
        }
        refresh();
        interval = setInterval(refresh, 60000);
        return () => { alive = false; if (interval) clearInterval(interval); };
      }, [cwd, tick]);

      if (!probe || probe.isRepo === false) return null;
      if (!current) return null;

      const branchLabel = probe.detached
        ? (probe.headShort || "detached")
        : (probe.branch || "(no branch)");
      const dirty = (overview && (overview.staged.length > 0 || overview.unstaged.length > 0 || overview.untracked.length > 0)) ? true : false;
      const ahead = overview ? overview.ahead : 0;
      const behind = overview ? overview.behind : 0;
      return React.createElement("button", {
        type: "button",
        className: "gm-badge" + (probe.detached ? " gm-badge-detached" : ""),
        title: cwd + "\n点击打开 Git 管理面板",
        onClick: () => { setOpen(true, cwd); setTick((x) => x + 1); },
      },
        React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true },
          React.createElement("path", { d: "M6 3v12" }),
          React.createElement("circle", { cx: 18, cy: 6, r: 3 }),
          React.createElement("circle", { cx: 6, cy: 18, r: 3 }),
          React.createElement("path", { d: "M18 9a9 9 0 0 1-9 9" }),
        ),
        React.createElement("span", null, branchLabel),
        dirty ? React.createElement("span", { className: "gm-badge-dirty", "aria-label": "有未提交变更" }) : null,
        ahead > 0 ? React.createElement("span", { className: "gm-badge-ahead" }, "↑" + ahead) : null,
        behind > 0 ? React.createElement("span", { className: "gm-badge-behind" }, "↓" + behind) : null,
      );
    }

    // ---- GitPanel（Task 14-17 填五个 Tab 的内容；此处先搭壳） ----
    function GitPanel(props) {
      const remote = props.remote;
      const onClose = props.onClose;
      const targetPath = useTargetPath();
      const slotProps = props.slotProps || {};
      const useSessions = slotProps.useSessions;
      const useWorkspaces = slotProps.useWorkspaces;

      // 仓库候选：当前会话 cwd + workspaces + 手动输入
      const currentSessionCwd = useSessions ? useSessions((s) => (s.current && s.byId[s.current] ? s.byId[s.current].cwd : null)) : null;
      const workspaces = useWorkspaces ? useWorkspaces((s) => s.items) : [];

      const [repoPath, setRepoPath] = React.useState(() => targetPath || currentSessionCwd || (workspaces[0] && workspaces[0].path) || "");
      const [probe, setProbe] = React.useState(null);
      const [status, setStatus] = React.useState(null);
      const [remotes, setRemotes] = React.useState([]);
      const [tab, setTab] = React.useState("changes");
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null); // 正在执行的操作标签

      // 重新选 repo 时探活
      React.useEffect(() => {
        let alive = true;
        async function probe1() {
          if (!repoPath) { setProbe({ isRepo: false }); setStatus(null); setRemotes([]); return; }
          setError(null);
          const r = await unwrap(await remote.overview({ path: repoPath }));
          if (!alive) return;
          if (r.ok) {
            setProbe(r.value.probe);
            setStatus(r.value.status);
            setRemotes(r.value.remotes);
          } else {
            setProbe({ isRepo: false });
            setStatus(null);
            setError(r.error.message || r.error.code);
          }
        }
        probe1();
        return () => { alive = false; };
      }, [repoPath]);

      // 15s 静默轮询
      React.useEffect(() => {
        if (!probe || !probe.isRepo) return;
        const t = setInterval(async () => {
          const r = await unwrap(await remote.status({ path: repoPath }));
          if (r.ok) setStatus(r.value);
        }, 15000);
        return () => clearInterval(t);
      }, [probe && probe.isRepo, repoPath]);

      // 通用 mutation 包装
      const act = async (label, fn) => {
        setBusy(label); setError(null);
        try {
          const r = await fn();
          if (!r.ok) { setError(r.error.message || r.error.code); return; }
          // 变更方法都返回 { status } / { worktrees } / commit 等，按约定刷新
          if (r.value && r.value.status) setStatus(r.value.status);
          return r.value;
        } catch (e) {
          setError(String(e && e.message || e));
        } finally { setBusy(null); }
      };

      const head = React.createElement("div", { className: "gm-head" },
        React.createElement("span", { className: "gm-head-title" }, "Git 管理"),
        React.createElement("select", {
          className: "gm-select",
          value: repoPath,
          onChange: (e) => setRepoPath(e.target.value),
          title: "选择仓库目录",
        },
          currentSessionCwd ? React.createElement("option", { key: "cwd", value: currentSessionCwd }, "当前会话：" + currentSessionCwd) : null,
          workspaces.map((w) => React.createElement("option", { key: w.workspaceId, value: w.path }, "Workspace: " + (w.title || w.path))),
          remotes.map((r) => React.createElement("option", { key: r.name + "-f", value: repoPath }, r.name + ": " + (r.fetchUrl || ""))).slice(0, 0),
        ),
        React.createElement("span", { className: "gm-head-spacer" }),
        React.createElement("div", { className: "gm-head-actions" },
          status && probe && !probe.detached ? React.createElement("span", { className: "gm-badge" + (status.ahead > 0 || status.behind > 0 ? "" : ""), style: { fontSize: 12 } },
            status.ahead > 0 ? React.createElement("span", { className: "gm-badge-ahead" }, "↑" + status.ahead) : null,
            " ",
            status.behind > 0 ? React.createElement("span", { className: "gm-badge-behind" }, "↓" + status.behind) : null,
          ) : null,
          React.createElement("button", { className: "gm-btn", onClick: async () => { const r = await unwrap(await remote.fetch({ path: repoPath })); if (!r.ok) setError(r.error.message); else { setStatus(r.value.status); setRemotes(r.value.remotes || remotes); } }, disabled: !!busy }, "Fetch"),
          React.createElement("button", { className: "gm-btn", onClick: async () => { const r = await act("Pull", () => remote.pull({ path: repoPath })); }, disabled: !!busy }, "Pull"),
          React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: async () => { const r = await act("Push", () => remote.push({ path: repoPath })); }, disabled: !!busy }, "Push"),
          React.createElement("button", { className: "gm-btn", onClick: () => setOpen(false), title: "关闭" }, "✕"),
        ),
      );

      const banner = (() => {
        if (!probe) return null;
        if (!probe.isRepo) {
          return React.createElement("div", { className: "gm-banner-danger" },
            React.createElement("span", null, "该目录不是 Git 仓库"),
            React.createElement("button", {
              className: "gm-btn gm-btn-primary",
              disabled: !!busy,
              onClick: async () => {
                const r = await unwrap(await remote.init({ path: repoPath }));
                if (r.ok) {
                  setProbe(r.value.probe);
                  setStatus(null);
                } else {
                  setError(r.error.message || r.error.code);
                }
              },
            }, "初始化为 git 仓库 (main)"),
          );
        }
        if (status && status.merging) {
          return React.createElement("div", { className: "gm-banner" },
            React.createElement("span", null, "⚠ 合并进行中"),
            React.createElement("button", { className: "gm-btn", disabled: !!busy, onClick: async () => { const r = await act("mergeContinue", () => remote.mergeContinue({ path: repoPath })); if (r && r.value && r.value.status) setStatus(r.value.status); } }, "继续"),
            React.createElement("button", { className: "gm-btn gm-btn-danger", disabled: !!busy, onClick: async () => { await act("mergeAbort", () => remote.mergeAbort({ path: repoPath })); setTab("conflicts"); } }, "中止"),
          );
        }
        if (status && status.rebasing) {
          return React.createElement("div", { className: "gm-banner" },
            React.createElement("span", null, "⚠ 变基进行中"),
          );
        }
        return null;
      })();

      const conflictedCount = (status && status.conflicted) ? status.conflicted.length : 0;

      const tabNav = React.createElement("nav", { className: "gm-tabs" },
        [
          ["changes", "变更"],
          ["branches", "分支"],
          ["history", "历史"],
          ["conflicts", "冲突"],
          ["worktree", "Worktree"],
        ].map(([k, label]) => React.createElement("button", {
          key: k,
          type: "button",
          className: "gm-tab" + (tab === k ? " gm-tab-active" : ""),
          onClick: () => setTab(k),
        },
          label,
          k === "changes" && status && (status.staged.length + status.unstaged.length + status.untracked.length) > 0 ? React.createElement("span", { className: "gm-tab-badge" }, String(status.staged.length + status.unstaged.length + status.untracked.length)) : null,
          k === "conflicts" && conflictedCount > 0 ? React.createElement("span", { className: "gm-tab-badge" }, String(conflictedCount)) : null,
        )),
      );

      // Tab content：每个 Tab 内容在 Task 14-17 填充。当前显示占位。
      const tabContent = (() => {
        if (!probe || !probe.isRepo) {
          return React.createElement("div", { className: "gm-empty" }, "该目录不是 Git 仓库。点击上方「初始化为 git 仓库」开始，或选择其他目录。");
        }
        const placeholder = (name) => React.createElement("div", { className: "gm-empty" }, "「" + name + "」Tab 将在后续任务填充。当前 Git 路径：" + repoPath + "\n当前分支：" + (status ? (status.detached ? "(detached) " + status.headSha : status.branch || "(无)") : "(加载中)"));
        switch (tab) {
          case "changes": return placeholder("变更");
          case "branches": return placeholder("分支");
          case "history": return placeholder("历史");
          case "conflicts": return placeholder("冲突");
          case "worktree": return placeholder("Worktree");
          default: return placeholder("?");
        }
      })();

      const errBar = error ? React.createElement("div", { className: "gm-error" }, error) : null;

      return React.createElement("div", { className: "gm-panel", onClick: (e) => e.stopPropagation() },
        head,
        banner,
        React.createElement("div", { className: "gm-main" },
          tabNav,
          React.createElement("div", { className: "gm-content" },
            errBar,
            tabContent,
          ),
        ),
      );
    }

    // ---- apply ----
    async function apply(ctx) {
      await ctx.remote.$mount(CLIENT_REMOTE);

      // 样式注入（动态 HMR 不可用，正式插件的样式走手动 style 标签）
      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // ctx.get 不受 inject 属性守卫限制（与 archive-manager 同款）
      const remote = ctx.get("remote.gitManager");

      // ① 头部徽章（session 作用域）
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        { name: "conversation.session.header.actions", id: "git-manager", order: 100, label: () => "Git" },
        HeaderGitBadge,
      ));

      // ② shell.overlay 注册：根据面板状态 + 会话状态渲染 FAB 或 Panel
      //    DOM 用 ReactDOM.createPortal 落到 body（z-index 1000），绕开
      //    shell.overlay 槽位宿主 stacking context 的 z-index 锁死。
      //    React 树仍属于 shell.overlay 槽（生命周期完整），只是 DOM 出口换了。
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "git-manager", order: 150 },
        (props) => {
          const isOpen = useOpen();
          if (isOpen) {
            const close = () => setOpen(false);
            return ReactDOM.createPortal(
              React.createElement("div", { className: "gm-overlay", onClick: close },
                React.createElement(GitPanel, { slotProps: props, remote, onClose: close }),
              ),
              document.body,
            );
          }
          // 关闭状态：FAB 仅在无 current 会话时显示（hero 视图）。会话开启后头部徽章接管。
          const current = props.useSessions ? props.useSessions((s) => s.current) : undefined;
          if (current) return null;
          return ReactDOM.createPortal(
            React.createElement(GitFab, { onClick: () => setOpen(true, undefined) }),
            document.body,
          );
        },
      ));
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});