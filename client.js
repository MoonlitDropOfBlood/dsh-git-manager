/**
 * dsh-git-manager — Client half (web bundle).
 *
 * 由 DSH web shell 通过 `window.__ModuleLoader__.load` 加载。本 bundle：
 *   1. 自挂载 `gitManager` Remote 命名空间（dsh-api-remotes 只硬编码挂载官方命名空间）
 *   2. 注册 `conversation.input.left` 槽 → composer 工具行（模式/access-mode 选择器旁）
 *      的 Git 入口按钮（session 作用域；hero 空白会话的 composer 同样渲染这一行，
 *      一个槽位同时覆盖 hero 与会话内；仅当目标目录是 git 仓库时显示）
 *   3. 注册 `shell.overlay` 槽 → 面板打开时渲染 GitPanel 弹窗
 *      （用 ReactDOM.createPortal 落 body，绕开 stacking context；
 *      尺寸/遮罩/Esc 关闭行为与「设置」面板一致）
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

    // ---- CSS（gm- 前缀，颜色全部走 dsw 主题令牌以适配明暗；弹窗尺寸/结构与设置面板一致） ----
    const CSS = `
.gm-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}
.gm-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.gm-panel{position:relative;z-index:1;width:800px;max-width:calc(100vw - 48px);height:min(800px,100vh - 48px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:24px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden}
.gm-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-head-title{font-size:14px;font-weight:600;flex:none}
.gm-head-spacer{flex:1}
.gm-head-actions{display:flex;gap:6px;flex:none;align-items:center}
.gm-banner{padding:10px 14px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font-size:12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-banner-danger{padding:10px 14px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-main{flex:1;display:flex;min-height:0}
.gm-tabs{display:flex;flex-direction:column;width:140px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);padding:8px 6px;gap:2px}
.gm-tab{appearance:none;background:transparent;border:none;cursor:pointer;text-align:left;padding:8px 12px;border-radius:10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}
.gm-tab:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.gm-tab-active{background:var(--dsw-specific-sidebar-nav-item-active);font-weight:500}
.gm-tab-badge{margin-left:auto;font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-inverted);min-width:14px;text-align:center}
.gm-content{flex:1;min-width:0;overflow:auto;padding:14px 16px}
.gm-error{padding:8px 14px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;margin-bottom:10px;white-space:pre-wrap}
.gm-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:gm-spin .8s linear infinite;flex:none;display:inline-block;vertical-align:middle}
@keyframes gm-spin{to{transform:rotate(360deg)}}
.gm-empty{padding:36px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}

/* Composer 工具行入口按钮（模式/access-mode 选择器旁，conversation.input.left） */
.gm-toolbtn{display:inline-flex;align-items:center;gap:5px;height:28px;margin-left:-4px;padding:0 7px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;line-height:1}
.gm-toolbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gm-toolbtn svg{flex:none}
.gm-toolbtn-label{max-width:140px;overflow:hidden;text-overflow:ellipsis}

/* 面板头部 ahead/behind 只读徽章 */
.gm-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-primary);line-height:18px}
.gm-badge-ahead{color:var(--dsw-alias-state-success-primary);font-weight:500}
.gm-badge-behind{color:var(--dsw-alias-state-error-primary);font-weight:500}

/* Repo select + header controls */
.gm-head-path{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-input{box-sizing:border-box;height:30px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none}
.gm-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.gm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gm-btn-icon{width:30px;padding:0}
.gm-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent}
.gm-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.gm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.gm-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.gm-btn:disabled{opacity:.5;cursor:not-allowed}

/* File list (Changes tab) */
.gm-filegroup{padding:8px 0}
.gm-filegroup-head{display:flex;align-items:center;gap:8px;font-weight:500;font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:6px}
.gm-file{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}
.gm-file:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gm-file-active{background:var(--dsw-alias-interactive-bg-active)}
.gm-file-kind{font-size:10px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);text-transform:uppercase;line-height:16px;flex:none}
.gm-file-kind-modified{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary)}
.gm-file-kind-added{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.gm-file-kind-deleted{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.gm-file-kind-renamed{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent);color:var(--dsw-alias-state-business-primary)}
.gm-file-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-file-old{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:4px}

/* Diff view */
.gm-diff{background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 14px;margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-x:auto;max-height:60vh}
.gm-diff-file{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-diff-file:last-child{border-bottom:none}
.gm-diff-fileh{font-family:var(--dsw-font-sans,inherit);font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);padding:4px 0;cursor:pointer;display:flex;align-items:center;gap:8px}
.gm-diff-fileh:hover{color:var(--dsw-alias-brand-primary)}
.gm-diff-hunk{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:2px 0}
.gm-diff-line{white-space:pre;padding:0 6px}
.gm-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.gm-diff-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.gm-diff-ctx{color:var(--dsw-alias-label-secondary)}
.gm-diff-meta{color:var(--dsw-alias-label-tertiary)}
.gm-diff-trunc{padding:8px 0;font-family:var(--dsw-font-sans,inherit);font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic}

/* Commit box */
.gm-commit{margin-top:14px;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.gm-textarea{box-sizing:border-box;width:100%;min-height:60px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;outline:none;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.gm-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.gm-checkbox input{accent-color:var(--dsw-alias-brand-primary)}

/* Confirm dialog */
.gm-confirm{position:fixed;inset:0;z-index:1100;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);display:flex;align-items:center;justify-content:center}
.gm-confirm-modal{width:min(420px,90vw);padding:18px;background:var(--dsw-alias-bg-layer-2);border-radius:16px;box-shadow:var(--dsw-shadow-lv3)}
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

    // ---- Composer 工具行入口按钮（conversation.input.left，模式/access-mode 选择器旁） ----
    // 该槽是 session 作用域 list 槽，framework 注入完整标准 kit（sessionId / useSessions /
    // useWorkspaces / useInput / inputActions，见 InputZone owner props）；hero 空白会话的
    // composer 同样渲染这一行，一个槽位同时覆盖 hero 与会话内。
    // 仅当目标目录是 git 仓库时显示（probe 结果 60s 轮询刷新；非仓库返回 null 不占位）。
    function ComposerGitButton(props) {
      const remote = props && props.remote;
      const sessionId = props && props.sessionId;
      const useSessions = props && props.useSessions;
      // sessionId 优先级：framework kit 显式传的 props.sessionId > list.current（兜底）
      const cwd = useSessions
        ? useSessions((s) => {
            const id = sessionId || (s && s.current);
            const sum = id && s && s.byId ? s.byId[id] : undefined;
            return (sum && sum.cwd) || null;
          })
        : null;
      const [probe, setProbe] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        async function run() {
          if (!remote || !cwd) { setProbe(null); return; }
          try {
            const r = unwrap(await remote.probe({ path: cwd }));
            if (!alive) return;
            setProbe(r.ok && r.value ? r.value : { isRepo: false });
          } catch (_) {
            if (alive) setProbe({ isRepo: false });
          }
        }
        run();
        const t = setInterval(run, 60000);
        return () => { alive = false; clearInterval(t); };
      }, [cwd, remote]);

      if (!cwd || !probe || !probe.isRepo) return null;

      const label = probe.detached
        ? (probe.headShort || "detached")
        : (probe.branch || "");
      return React.createElement("button", {
        type: "button",
        className: "gm-toolbtn",
        title: "Git 管理面板\n" + cwd,
        "aria-label": "打开 Git 管理面板",
        onClick: () => setOpen(true, cwd),
      },
        // git-branch 图标（Lucide 24×24）
        React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
          React.createElement("path", { d: "M6 3v12" }),
          React.createElement("circle", { cx: 18, cy: 6, r: 3 }),
          React.createElement("circle", { cx: 6, cy: 18, r: 3 }),
          React.createElement("path", { d: "M18 9a9 9 0 0 1-9 9" }),
        ),
        label ? React.createElement("span", { className: "gm-toolbtn-label" }, label) : null,
      );
    }

    // ---- GitPanel（五个 Tab 的内容；此处是壳） ----
    function GitPanel(props) {
      const remote = props.remote;
      const onClose = props.onClose;
      const targetPath = useTargetPath();
      const slotProps = props.slotProps || {};
      const useSessions = slotProps.useSessions;

      // 面板绑定打开它的那个会话目录（targetPath 在点击入口时捕获），不提供切换——
      // 从哪个会话的入口点开就管哪个仓库（用户反馈：可切换不符合直觉）。
      const currentSessionCwd = useSessions ? useSessions((s) => (s.current && s.byId[s.current] ? s.byId[s.current].cwd : null)) : null;
      const repoPath = targetPath || currentSessionCwd || "";
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
        React.createElement("span", { className: "gm-head-path", title: repoPath }, repoPath),
        React.createElement("span", { className: "gm-head-spacer" }),
        React.createElement("div", { className: "gm-head-actions" },
          status && probe && !probe.detached && (status.ahead > 0 || status.behind > 0) ? React.createElement("span", { className: "gm-badge", style: { fontSize: 12 }, title: "与远端的差距：↑ 本地领先提交数，↓ 本地落后提交数" },
            status.ahead > 0 ? React.createElement("span", { className: "gm-badge-ahead" }, "↑" + status.ahead) : null,
            status.ahead > 0 && status.behind > 0 ? " " : null,
            status.behind > 0 ? React.createElement("span", { className: "gm-badge-behind" }, "↓" + status.behind) : null,
          ) : null,
          React.createElement("button", { className: "gm-btn", onClick: async () => { const r = await unwrap(await remote.fetch({ path: repoPath })); if (!r.ok) setError(r.error.message); else { setStatus(r.value.status); setRemotes(r.value.remotes || remotes); } }, disabled: !!busy }, "Fetch"),
          React.createElement("button", { className: "gm-btn", onClick: async () => { const r = await act("Pull", () => remote.pull({ path: repoPath })); }, disabled: !!busy }, "Pull"),
          React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: async () => { const r = await act("Push", () => remote.push({ path: repoPath })); }, disabled: !!busy }, "Push"),
          React.createElement("button", { className: "gm-btn gm-btn-icon", onClick: () => setOpen(false), title: "关闭（Esc）", "aria-label": "关闭 Git 管理面板" },
            React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true },
              React.createElement("path", { d: "M18 6 6 18" }),
              React.createElement("path", { d: "m6 6 12 12" }),
            ),
          ),
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

      // Tab content：每个 Tab 的真实实现（Tasks 14-17）
      const tabProps = { remote, repoPath, status, act, setError, onStatus: setStatus, onSwitchTab: setTab };
      const tabContent = (() => {
        if (!probe || !probe.isRepo) {
          return React.createElement("div", { className: "gm-empty" }, "该目录不是 Git 仓库。点击上方「初始化为 git 仓库」开始，或选择其他目录。");
        }
        switch (tab) {
          case "changes": return React.createElement(ChangesTab, tabProps);
          case "branches": return React.createElement(BranchesTab, tabProps);
          case "history": return React.createElement(HistoryTab, tabProps);
          case "conflicts": return React.createElement(ConflictsTab, tabProps);
          case "worktree": return React.createElement(WorktreesTab, tabProps);
          default: return React.createElement("div", { className: "gm-empty" }, "未知 Tab");
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

    // ============================================================================
    // 通用小组件
    // ============================================================================

    // 通用二次确认弹窗（discard / 删分支 / force push / abort merge 等危险操作）
    function ConfirmDialog(props) {
      if (!props.open) return null;
      return React.createElement("div", { className: "gm-confirm", onClick: (e) => e.stopPropagation() },
        React.createElement("div", { className: "gm-confirm-modal" },
          React.createElement("div", { className: "gm-confirm-title" }, props.title),
          React.createElement("div", { className: "gm-confirm-msg" }, props.message),
          React.createElement("div", { className: "gm-confirm-actions" },
            React.createElement("button", { className: "gm-btn", onClick: props.onCancel }, "取消"),
            React.createElement("button", { className: "gm-btn " + (props.danger ? "gm-btn-danger" : "gm-btn-primary"), onClick: props.onConfirm }, props.confirmLabel || "确认"),
          ),
        ),
      );
    }

    // 简单相对时间
    function fmtTime(unix) {
      if (!unix) return "";
      const d = Date.now() - Number(unix) * 1000;
      const m = 60, h = 3600, D = 86400;
      if (d < m) return "刚刚";
      if (d < h) return Math.floor(d / m) + " 分钟前";
      if (d < D) return Math.floor(d / h) + " 小时前";
      if (d < 30 * D) return Math.floor(d / D) + " 天前";
      const dt = new Date(Number(unix) * 1000);
      return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
    }

    // ============================================================================
    // DiffView：自绘统一 diff 渲染器
    //   parseUnifiedDiff(text) → [{ file, header, hunks, addCount, delCount, truncated }]
    // ============================================================================
    function parseUnifiedDiff(text) {
      if (!text) return [];
      const files = [];
      const lines = text.split("\n");
      let cur = null;
      let curHunk = null;
      let lineNoOld = 0, lineNoNew = 0;
      for (const raw of lines) {
        const line = raw;
        if (line.startsWith("diff --git ")) {
          if (cur) files.push(cur);
          cur = { file: line.slice("diff --git ".length), header: line, hunks: [], addCount: 0, delCount: 0 };
          curHunk = null;
        } else if (line.startsWith("--- ")) {
          if (cur) cur.oldPath = line.slice(4);
        } else if (line.startsWith("+++ ")) {
          if (cur) cur.newPath = line.slice(4);
        } else if (line.startsWith("@@")) {
          const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          lineNoOld = m ? Number(m[1]) : 0;
          lineNoNew = m ? Number(m[2]) : 0;
          curHunk = { header: line, lines: [] };
          if (cur) cur.hunks.push(curHunk);
        } else if (curHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\"))) {
          const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("\\") ? "meta" : "ctx";
          curHunk.lines.push({ kind, text: line });
          if (kind === "add") { cur.addCount++; lineNoNew++; }
          else if (kind === "del") { cur.delCount++; lineNoOld++; }
          else if (kind === "ctx") { lineNoOld++; lineNoNew++; }
        }
      }
      if (cur) files.push(cur);
      return files;
    }

    function DiffView(props) {
      const files = parseUnifiedDiff(props.text);
      if (files.length === 0) {
        return React.createElement("div", { className: "gm-diff" },
          React.createElement("div", { className: "gm-diff-meta" }, "(空差异)"),
        );
      }
      return React.createElement("div", { className: "gm-diff" },
        props.truncated ? React.createElement("div", { className: "gm-diff-trunc" }, "差异过大，已截断。请指定单文件以查看完整内容。") : null,
        files.map((f, i) => {
          const filePath = (f.newPath || f.oldPath || f.file || "").replace(/^[ab]\//, "").replace(/^"/, "").replace(/"$/, "");
          return React.createElement("div", { key: i, className: "gm-diff-file" },
            React.createElement("div", { className: "gm-diff-fileh" }, filePath + "  ",
              React.createElement("span", { className: "gm-file-kind gm-file-kind-added" }, "+" + f.addCount),
              " ",
              React.createElement("span", { className: "gm-file-kind gm-file-kind-deleted" }, "-" + f.delCount),
            ),
            f.hunks.map((h, j) => React.createElement("div", { key: j },
              React.createElement("div", { className: "gm-diff-hunk" }, h.header),
              h.lines.map((ln, k) => React.createElement("div", {
                key: k,
                className: "gm-diff-line gm-diff-" + ln.kind,
              }, ln.text)),
            )),
          );
        }),
      );
    }

    // ============================================================================
    // ChangesTab
    // ============================================================================
    function ChangesTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const status = props.status;
      const act = props.act;
      const setError = props.setError;
      const [diffText, setDiffText] = React.useState(null);
      const [diffTruncated, setDiffTruncated] = React.useState(false);
      const [diffScope, setDiffScope] = React.useState("worktree");
      const [activeFile, setActiveFile] = React.useState(null);
      const [busy, setBusyLocal] = React.useState(null);
      const [confirming, setConfirming] = React.useState(null);
      const [commitMsg, setCommitMsg] = React.useState("");
      const [amend, setAmend] = React.useState(false);
      const [stageAll, setStageAll] = React.useState(false);

      const refresh = async () => {
        const r = await unwrap(await remote.status({ path: repoPath }));
        if (r.ok && props.onStatus) props.onStatus(r.value);
      };

      const loadDiff = async (file, scope) => {
        const s = scope || diffScope;
        if (!file) {
          setDiffText(""); setDiffTruncated(false); setActiveFile(null); return;
        }
        const r = await unwrap(await remote.diff({ path: repoPath, scope: s, file }));
        if (r.ok) {
          setDiffText(r.value.text); setDiffTruncated(r.value.truncated); setActiveFile(file); setDiffScope(s);
        } else {
          setError(r.error.message || r.error.code);
        }
      };

      const renderGroup = (label, entries, kind, scope) => {
        if (!entries || entries.length === 0) return null;
        return React.createElement("div", { key: kind, className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" },
            React.createElement("span", null, label + " (" + entries.length + ")"),
            kind === "staged" ? React.createElement("button", { className: "gm-btn", disabled: !!busy, onClick: async () => { await act("unstage-all", () => remote.unstage({ path: repoPath, files: entries.map((e) => e.path) })); } }, "全部 unstage") : null,
            kind === "unstaged" ? React.createElement("button", { className: "gm-btn", disabled: !!busy, onClick: async () => { await act("stage-all", () => remote.stage({ path: repoPath, files: entries.map((e) => e.path) })); } }, "全部 stage") : null,
            kind === "untracked" ? React.createElement("button", { className: "gm-btn", disabled: !!busy, onClick: async () => { await act("discard-untracked", () => remote.discard({ path: repoPath, files: entries.map((e) => e), includeUntracked: true })); } }, "删除全部") : null,
          ),
          entries.map((e) => {
            const entry = typeof e === "string" ? { path: e } : e;
            const kindClass = (entry.kind && ("gm-file-kind-" + entry.kind)) || "";
            const isActive = activeFile === entry.path && diffScope === scope;
            return React.createElement("div", {
              key: entry.path,
              className: "gm-file" + (isActive ? " gm-file-active" : ""),
              onClick: () => loadDiff(entry.path, scope),
            },
              React.createElement("span", { className: "gm-file-kind " + kindClass }, entry.kind || "new"),
              React.createElement("span", { className: "gm-file-path" }, entry.path),
              entry.oldPath ? React.createElement("span", { className: "gm-file-old" }, "← " + entry.oldPath) : null,
              scope === "staged" ? React.createElement("button", { className: "gm-btn", disabled: !!busy, onClick: (ev) => { ev.stopPropagation(); act("unstage", () => remote.unstage({ path: repoPath, files: [entry.path] })); } }, "unstage") : null,
              scope === "unstaged" ? React.createElement("button", { className: "gm-btn", disabled: !!busy, onClick: (ev) => { ev.stopPropagation(); act("stage", () => remote.stage({ path: repoPath, files: [entry.path] })); } }, "stage") : null,
              scope === "unstaged" || scope === "untracked" ? React.createElement("button", {
                className: "gm-btn gm-btn-danger",
                disabled: !!busy,
                onClick: (ev) => { ev.stopPropagation(); setConfirming({ kind: "discard", entry, scope }); },
              }, "discard") : null,
            );
          }),
        );
      };

      const onConfirmDiscard = async () => {
        const c = confirming;
        setConfirming(null);
        if (c.kind === "discard") {
          await act("discard", () => remote.discard({ path: repoPath, files: [c.entry.path || c.entry], includeUntracked: c.scope === "untracked" }));
        }
      };

      const submitCommit = async () => {
        if (!commitMsg.trim()) { setError("提交信息不能为空"); return; }
        if (stageAll) {
          await act("stage-all", () => remote.stage({ path: repoPath, files: [], all: true }));
        }
        const r = await act("commit", () => remote.commit({ path: repoPath, message: commitMsg, amend }));
        if (r) { setCommitMsg(""); setAmend(false); setStageAll(false); setActiveFile(null); setDiffText(null); }
      };

      return React.createElement(React.Fragment, null,
        renderGroup("Staged", status && status.staged, "staged", "staged"),
        renderGroup("Unstaged", status && status.unstaged, "unstaged", "worktree"),
        renderGroup("Untracked", status && status.untracked, "untracked", "untracked"),
        !status || (status.staged.length + status.unstaged.length + status.untracked.length === 0)
          ? React.createElement("div", { className: "gm-empty" }, "工作区干净。")
          : null,
        React.createElement(DiffView, { text: diffText || "", truncated: !!diffTruncated }),
        status && status.staged.length > 0 || (status && status.staged.length === 0 && status.unstaged.length > 0 && stageAll)
          ? React.createElement("div", { className: "gm-commit" },
              React.createElement("textarea", { className: "gm-textarea", placeholder: "提交信息…", value: commitMsg, onChange: (e) => setCommitMsg(e.target.value) }),
              React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "center" } },
                React.createElement("label", { className: "gm-checkbox" },
                  React.createElement("input", { type: "checkbox", checked: amend, onChange: (e) => setAmend(e.target.checked) }),
                  "Amend",
                ),
                React.createElement("label", { className: "gm-checkbox" },
                  React.createElement("input", { type: "checkbox", checked: stageAll, onChange: (e) => setStageAll(e.target.checked) }),
                  "Stage 全部 + 提交",
                ),
                React.createElement("span", { style: { flex: 1 } }),
                React.createElement("button", { className: "gm-btn gm-btn-primary", disabled: !!busy || !commitMsg.trim(), onClick: submitCommit }, "Commit"),
              ),
            )
          : null,
        React.createElement(ConfirmDialog, {
          open: !!confirming,
          title: "放弃变更？",
          message: "此操作会丢弃对以下文件的所有本地改动，无法撤销：\n\n" + (confirming ? (confirming.entry.path || confirming.entry) : ""),
          danger: true,
          confirmLabel: "确认丢弃",
          onCancel: () => setConfirming(null),
          onConfirm: onConfirmDiscard,
        }),
      );
    }

    // ============================================================================
    // BranchesTab
    // ============================================================================
    function BranchesTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const status = props.status;
      const act = props.act;
      const setError = props.setError;
      const [branches, setBranches] = React.useState(null);
      const [remotes, setRemotes] = React.useState([]);
      const [creating, setCreating] = React.useState({ name: "", start: "" });
      const [confirming, setConfirming] = React.useState(null);

      const refresh = async () => {
        const [b, r] = await Promise.all([
          unwrap(await remote.branches({ path: repoPath })),
          unwrap(await remote.remotes({ path: repoPath })),
        ]);
        if (b.ok) setBranches(b.value);
        if (r.ok) setRemotes(r.value);
      };

      React.useEffect(() => { refresh(); }, [repoPath]);

      const createNew = async () => {
        if (!creating.name.trim()) return;
        const payload = { path: repoPath, name: creating.name };
        if (creating.start) payload.startPoint = creating.start;
        await act("createBranch", () => remote.branchCreate(payload));
        setCreating({ name: "", start: "" });
        refresh();
      };

      const doCheckout = async (name) => {
        await act("checkout", () => remote.checkout({ path: repoPath, name }));
        refresh();
      };
      const doMerge = async (name) => {
        const r = await act("merge", () => remote.merge({ path: repoPath, branch: name }));
        if (r && r.merged === false && status && status.conflicted.length > 0) {
          // 切到冲突 tab
          if (props.onSwitchTab) props.onSwitchTab("conflicts");
        }
      };
      const doRename = async (oldName, newName) => {
        if (!newName || newName === oldName) return;
        await act("renameBranch", () => remote.branchRename({ path: repoPath, oldName, newName }));
        refresh();
      };
      const doDelete = async (name, force) => {
        setConfirming(null);
        await act("deleteBranch", () => remote.branchDelete({ path: repoPath, name, force: !!force }));
        refresh();
      };

      const renderRow = (b, isRemote) => React.createElement("div", {
        key: b.refname,
        className: "gm-file" + (b.current ? " gm-file-active" : ""),
      },
        React.createElement("span", { className: "gm-file-kind " + (b.current ? "gm-file-kind-added" : "") }, b.current ? "★" : (isRemote ? "R" : "L")),
        React.createElement("span", { className: "gm-file-path" }, b.name),
        React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", fontFamily: "ui-monospace,monospace" } }, b.shortSha),
        b.upstream ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, " ↑" + (b.ahead || 0) + " ↓" + (b.behind || 0) + (b.upstreamGone ? " gone" : "")) : null,
        React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 8, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, b.subject),
        isRemote
          ? React.createElement("button", { className: "gm-btn", onClick: () => createNew({ name: b.name.replace(/^[^/]+\//, ""), start: b.name }) }, "基于它建本地")
          : React.createElement(React.Fragment, null,
              b.current ? null : React.createElement("button", { className: "gm-btn", onClick: () => doCheckout(b.name) }, "切换"),
              b.current || b.name === "main" ? null : React.createElement("button", { className: "gm-btn", onClick: () => doMerge(b.name) }, "合并"),
              b.current ? null : React.createElement("button", { className: "gm-btn gm-btn-danger", onClick: () => setConfirming({ kind: "delete", name: b.name }) }, "删除"),
            ),
      );

      if (!branches) return React.createElement("div", { className: "gm-empty" }, "加载分支…");

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" }, React.createElement("span", null, "本地 (" + branches.locals.length + ")"))),
        branches.locals.map((b) => renderRow(b, false)),
        branches.remotes.length > 0 ? React.createElement("div", { className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" }, React.createElement("span", null, "远程 (" + branches.remotes.length + ")"))) : null,
        branches.remotes.map((b) => renderRow(b, true)),
        React.createElement("div", { className: "gm-commit", style: { marginTop: 14 } },
          React.createElement("div", { style: { fontSize: 12, fontWeight: 500 } }, "新建分支"),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("input", { className: "gm-input", placeholder: "分支名", value: creating.name, onChange: (e) => setCreating((s) => ({ ...s, name: e.target.value })) }),
            React.createElement("input", { className: "gm-input", placeholder: "起点（可选，commit-ish 或 origin/x）", value: creating.start, onChange: (e) => setCreating((s) => ({ ...s, start: e.target.value })) }),
            React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: createNew }, "新建"),
          ),
        ),
        React.createElement(ConfirmDialog, {
          open: !!confirming,
          title: "删除分支？",
          message: "确认删除分支 \"" + (confirming && confirming.name) + "\"？若未合并且无 -D，将失败。",
          danger: true,
          confirmLabel: "删除（未合并则失败）",
          onCancel: () => setConfirming(null),
          onConfirm: () => doDelete(confirming && confirming.name, false),
        }),
      );
    }

    // ============================================================================
    // HistoryTab（含分支线 SVG）
    // ============================================================================
    function HistoryTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const act = props.act;
      const setError = props.setError;
      const [log, setLog] = React.useState(null); // { commits, graph, hasMore }
      const [allRefs, setAllRefs] = React.useState(true);
      const [maxCount, setMaxCount] = React.useState(200);
      const [selected, setSelected] = React.useState(null); // sha for detail
      const [commitDiff, setCommitDiff] = React.useState(null);

      const refresh = async () => {
        const r = await unwrap(await remote.log({ path: repoPath, maxCount, all: allRefs }));
        if (r.ok) setLog(r.value);
        else setError(r.error.message || r.error.code);
      };

      React.useEffect(() => { refresh(); }, [repoPath, maxCount, allRefs]);

      const loadCommitDiff = async (sha) => {
        setSelected(sha);
        const r = await unwrap(await remote.diff({ path: repoPath, scope: "commit", sha }));
        if (r.ok) setCommitDiff(r.value);
        else setError(r.error.message || r.error.code);
      };

      if (!log) return React.createElement("div", { className: "gm-empty" }, "加载历史…");

      const { commits, graph, hasMore } = log;
      const ROW_H = 32, COL_W = 14, PAD = 16;
      const PALETTE = ["#5b8cff","#2fb37d","#d99a1f","#9b7ff0","#e5484d","#18a0fb","#f76b15","#12a594","#e93d82","#8e4ec6","#6d7c8f","#a18072"];
      const width = Math.max(80, (graph.laneCount || 1) * COL_W + PAD);
      const totalH = commits.length * ROW_H;

      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 10 } },
          React.createElement("label", { className: "gm-checkbox" },
            React.createElement("input", { type: "checkbox", checked: allRefs, onChange: (e) => setAllRefs(e.target.checked) }),
            "所有分支",
          ),
          React.createElement("span", { style: { flex: 1 } }),
          hasMore ? React.createElement("button", { className: "gm-btn", onClick: () => setMaxCount((c) => c + 200) }, "加载更多 (" + maxCount + " / " + (commits.length + 200) + ")") : React.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "共 " + commits.length + " 个提交"),
        ),
        React.createElement("div", { style: { position: "relative", border: "1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" } },
          React.createElement("svg", {
            width, height: totalH,
            style: { position: "absolute", left: 0, top: 0, pointerEvents: "none" },
            "aria-hidden": true,
          },
            graph.links.map((l, i) => {
              const x1 = PAD / 2 + l.fromCol * COL_W;
              const x2 = PAD / 2 + l.toCol * COL_W;
              const y1 = l.fromRow * ROW_H + ROW_H / 2;
              const y2 = (l.toRow === null ? totalH : l.toRow * ROW_H + ROW_H / 2);
              const color = PALETTE[l.color % PALETTE.length];
              if (l.kind === "collapse" || (l.fromCol === l.toCol && (l.toRow === l.fromRow + 1 || l.toRow === null))) {
                // 简单竖线（无需 c-curve）
                return React.createElement("path", {
                  key: i,
                  d: "M " + x1 + " " + y1 + " L " + x2 + " " + y2,
                  stroke: color,
                  strokeWidth: 1.5,
                  fill: "none",
                  opacity: 0.7,
                });
              }
              if (l.fromCol === l.toCol) {
                return React.createElement("path", {
                  key: i,
                  d: "M " + x1 + " " + y1 + " L " + x2 + " " + y2,
                  stroke: color,
                  strokeWidth: 1.5,
                  fill: "none",
                  opacity: 0.7,
                });
              }
              // 跨列用 cubic bezier
              const midY = (y1 + y2) / 2;
              return React.createElement("path", {
                key: i,
                d: "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + ROW_H) + ", " + x2 + " " + (y2 - ROW_H) + ", " + x2 + " " + y2,
                stroke: color,
                strokeWidth: 1.5,
                fill: "none",
                opacity: 0.7,
              });
            }),
            graph.nodes.map((n, i) => React.createElement("circle", {
              key: "n" + i,
              cx: PAD / 2 + n.col * COL_W,
              cy: i * ROW_H + ROW_H / 2,
              r: 4,
              fill: PALETTE[n.color % PALETTE.length],
            })),
          ),
          commits.map((c, i) => React.createElement("div", {
            key: c.sha,
            className: "gm-file" + (selected === c.sha ? " gm-file-active" : ""),
            style: { paddingLeft: width + 8, height: ROW_H, lineHeight: ROW_H + "px", boxSizing: "border-box" },
            onClick: () => loadCommitDiff(c.sha),
          },
            React.createElement("span", { style: { fontFamily: "ui-monospace,monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginRight: 8 } }, c.short),
            c.refs ? React.createElement("span", { style: { fontSize: 10, padding: "0 6px", borderRadius: 999, background: "color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)", color: "var(--dsw-alias-brand-primary)", marginRight: 8 } }, c.refs) : null,
            React.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.subject),
            React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 } }, c.author),
            React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 } }, fmtTime(c.at)),
          )),
        ),
        selected && commitDiff ? React.createElement("div", { style: { marginTop: 14 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 500, marginBottom: 6 } }, "Commit " + selected.slice(0, 12)),
          React.createElement(DiffView, { text: commitDiff.text, truncated: commitDiff.truncated }),
          React.createElement("button", { className: "gm-btn", style: { marginTop: 8 }, onClick: () => { setSelected(null); setCommitDiff(null); } }, "关闭详情"),
        ) : null,
      );
    }

    // ============================================================================
    // ConflictsTab
    // ============================================================================
    function ConflictsTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const status = props.status;
      const act = props.act;
      const setError = props.setError;
      const [editing, setEditing] = React.useState(null); // { file, content }
      const [confirming, setConfirming] = React.useState(null);

      React.useEffect(() => {
        if (editing && status && !status.conflicted.find((c) => c.path === editing.file)) {
          setEditing(null);
        }
      }, [status]);

      const startEdit = async (file) => {
        const r = await unwrap(await remote.conflictContent({ path: repoPath, file }));
        if (r.ok) setEditing({ file, content: (r.value.worktree !== undefined ? r.value.worktree : "") });
        else setError(r.error.message || r.error.code);
      };

      const resolveOurs = (file) => act("resolveOurs", () => remote.resolveConflict({ path: repoPath, file, strategy: "ours" }));
      const resolveTheirs = (file) => act("resolveTheirs", () => remote.resolveConflict({ path: repoPath, file, strategy: "theirs" }));
      const resolveCustom = async (file, content) => act("resolveCustom", () => remote.resolveConflict({ path: repoPath, file, strategy: "custom", content }));
      const doAbort = () => { setConfirming(null); act("mergeAbort", () => remote.mergeAbort({ path: repoPath })); };

      if (!status) return React.createElement("div", { className: "gm-empty" }, "加载冲突…");
      if (status.conflicted.length === 0) {
        return React.createElement("div", { className: "gm-empty" }, "当前没有冲突。");
      }
      return React.createElement(React.Fragment, null,
        status.conflicted.map((c) => React.createElement("div", { key: c.path, className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" },
            React.createElement("span", null, c.path),
            React.createElement("span", { className: "gm-file-kind gm-file-kind-renamed" }, c.xy),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-btn", onClick: () => resolveOurs(c.path) }, "用我们的"),
            React.createElement("button", { className: "gm-btn", onClick: () => resolveTheirs(c.path) }, "用他们的"),
            React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: () => startEdit(c.path) }, "手动编辑"),
          ),
        )),
        React.createElement("div", { style: { marginTop: 14, display: "flex", gap: 8 } },
          React.createElement("button", { className: "gm-btn", onClick: async () => { await act("mergeContinue", () => remote.mergeContinue({ path: repoPath })); } }, "继续合并（git commit --no-edit）"),
          React.createElement("button", { className: "gm-btn gm-btn-danger", onClick: () => setConfirming({ kind: "abortMerge" }) }, "中止合并"),
        ),
        editing ? React.createElement("div", { className: "gm-overlay", onClick: () => setEditing(null) },
          React.createElement("div", { className: "gm-panel", style: { width: "min(900px,94vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }, onClick: (e) => e.stopPropagation() },
            React.createElement("div", { className: "gm-head" },
              React.createElement("span", { className: "gm-head-title" }, "手动解决 — " + editing.file),
              React.createElement("span", { style: { flex: 1 } }),
              React.createElement("button", { className: "gm-btn", onClick: () => setEditing(null) }, "取消"),
            ),
            React.createElement("div", { className: "gm-content" },
              React.createElement("textarea", {
                className: "gm-textarea",
                style: { minHeight: 320, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" },
                value: editing.content,
                onChange: (e) => setEditing({ ...editing, content: e.target.value }),
              }),
            ),
            React.createElement("div", { className: "gm-head" },
              React.createElement("span", { style: { flex: 1 } }),
              React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: async () => { await resolveCustom(editing.file, editing.content); setEditing(null); } }, "保存并标记已解决"),
            ),
          ),
        ) : null,
        React.createElement(ConfirmDialog, {
          open: !!confirming,
          title: "中止合并？",
          message: "合并会被中止，所有冲突解决作废。",
          danger: true,
          confirmLabel: "中止",
          onCancel: () => setConfirming(null),
          onConfirm: doAbort,
        }),
      );
    }

    // ============================================================================
    // WorktreesTab
    // ============================================================================
    function WorktreesTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const act = props.act;
      const setError = props.setError;
      const [worktrees, setWorktrees] = React.useState(null);
      const [adding, setAdding] = React.useState({ path: "", newBranch: "" });
      const [confirming, setConfirming] = React.useState(null);

      const refresh = async () => {
        const r = await unwrap(await remote.worktrees({ path: repoPath }));
        if (r.ok) setWorktrees(r.value.worktrees);
      };

      React.useEffect(() => { refresh(); }, [repoPath]);

      const doAdd = async () => {
        if (!adding.path) return;
        await act("worktreeAdd", () => remote.worktreeAdd({
          path: repoPath,
          worktreePath: adding.path,
          newBranch: adding.newBranch || undefined,
        }));
        setAdding({ path: "", newBranch: "" });
      };
      const doRemove = async (wtPath, force) => {
        setConfirming(null);
        await act("worktreeRemove", () => remote.worktreeRemove({ path: repoPath, worktreePath: wtPath, force: !!force }));
        refresh();
      };
      const doPrune = async () => {
        await act("worktreePrune", () => remote.worktreePrune({ path: repoPath }));
        refresh();
      };

      if (!worktrees) return React.createElement("div", { className: "gm-empty" }, "加载 Worktree…");

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" },
            React.createElement("span", null, "Worktree (" + worktrees.length + ")"),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-btn", onClick: doPrune }, "Prune"),
          ),
          worktrees.map((w) => React.createElement("div", { key: w.path, className: "gm-file" },
            React.createElement("span", { className: "gm-file-kind " + (w.current ? "gm-file-kind-added" : (w.bare ? "gm-file-kind-renamed" : "")) }, w.current ? "★" : (w.bare ? "B" : "L")),
            React.createElement("span", { className: "gm-file-path" }, w.path),
            React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, w.bare ? "(bare)" : (w.detached ? "(detached " + (w.headSha || "").slice(0, 7) + ")" : (w.branch || "(?)"))),
            React.createElement("span", { style: { flex: 1 } }),
            w.current ? null : React.createElement("button", { className: "gm-btn gm-btn-danger", onClick: () => setConfirming({ kind: "remove", path: w.path }) }, "删除"),
          )),
        ),
        React.createElement("div", { className: "gm-commit", style: { marginTop: 14 } },
          React.createElement("div", { style: { fontSize: 12, fontWeight: 500 } }, "添加 Worktree"),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("input", { className: "gm-input", placeholder: "Worktree 绝对路径", value: adding.path, onChange: (e) => setAdding((s) => ({ ...s, path: e.target.value })), style: { flex: 1 } }),
            React.createElement("input", { className: "gm-input", placeholder: "新分支名（可选）", value: adding.newBranch, onChange: (e) => setAdding((s) => ({ ...s, newBranch: e.target.value })) }),
            React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: doAdd }, "添加"),
          ),
        ),
        React.createElement(ConfirmDialog, {
          open: !!confirming,
          title: "删除 Worktree？",
          message: "确认删除 Worktree " + (confirming && confirming.path) + "？如含未提交改动需 force。",
          danger: true,
          confirmLabel: "删除",
          onCancel: () => setConfirming(null),
          onConfirm: () => doRemove(confirming && confirming.path, false),
        }),
      );
    }

    // ---- apply ----
    async function apply(ctx) {
      await ctx.remote.$mount(CLIENT_REMOTE);

      // 诊断冒烟：若浏览器控制台出现这行，说明 client bundle 已加载并进入 apply。
      // 找不到入口时先看这行在不在，区分"bundle 没加载" vs "槽位/组件 bug"。
      try { console.log("[dsh-git-manager] client apply() ran, mounting UI"); } catch (_) { /* noop */ }

      // 样式注入（动态 HMR 不可用，正式插件的样式走手动 style 标签）
      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // ctx.get 不受 inject 属性守卫限制（与 archive-manager 同款）
      const remote = ctx.get("remote.gitManager");

      // ① Composer 工具行入口（conversation.input.left，模式/access-mode 选择器旁）
      //    该槽有完整标准 kit（含 useSessions），只需注入 remote。
      //    hero 空白会话的 composer 同样渲染这一行，一个槽位同时覆盖 hero 与会话内。
      function ComposerGitButtonSlot(props) {
        return React.createElement(ComposerGitButton, Object.assign({}, props, { remote }));
      }
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
        { name: "conversation.input.left", id: "git-manager", order: 100, label: () => "Git" },
        ComposerGitButtonSlot,
      ));

      // ② shell.overlay 注册：仅承担全屏面板（唯一入口在 composer 工具行）。
      //    DOM 用 ReactDOM.createPortal 落到 body（z-index 1000），绕开
      //    shell.overlay 槽位宿主 stacking context 的 z-index 锁死。
      //    React 树仍属于 shell.overlay 槽（生命周期完整），只是 DOM 出口换了。
      //    结构与设置面板一致：mask 点击关闭 + document 级 Esc 关闭。
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "git-manager", order: 150 },
        (props) => {
          const isOpen = useOpen();
          React.useEffect(() => {
            if (!isOpen) return;
            const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
            document.addEventListener("keydown", onKey);
            return () => document.removeEventListener("keydown", onKey);
          }, [isOpen]);
          if (!isOpen) return null;
          const close = () => setOpen(false);
          return ReactDOM.createPortal(
            React.createElement("div", { className: "gm-overlay", role: "presentation" },
              React.createElement("div", { className: "gm-mask", "aria-hidden": true, onClick: close }),
              React.createElement(GitPanel, { slotProps: props, remote, onClose: close }),
            ),
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