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
 * 面板本体 GitPanel 是统一的组件，包含六个 Tab
 * （变更 / 分支 / 历史 / 冲突 / Worktree / 设置）。
 *
 * 弹层规范（契约 docs/plans/2026-09-29-full-git-manager-v2.md §0，P0 修复）：
 *   - 所有弹层（确认框、表单弹窗、diff 独立窗口、冲突编辑器）一律
 *     ReactDOM.createPortal(..., document.body)，绝不手动 appendChild 挪 React DOM；
 *   - z-index 阶梯：面板 1000 < diff 窗口 1050 < 确认/表单弹窗 1100（弹窗叠弹窗每层 +10）；
 *   - 模块级 modalStack（{close,kind,z} 栈）：document 级 Esc 与 mask 点击只关栈顶弹层，
 *     面板 Esc 仅在栈空时关面板。
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
.gm-notice{padding:8px 14px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);font-size:12px;margin-bottom:10px}
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
.gm-btn-primary{background:var(--dsw-alias-button-info-fill);color:#fff;border-color:transparent;background-clip:padding-box}
.gm-btn-primary:hover{background:var(--dsw-alias-button-info-hover)}
.gm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.gm-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.gm-btn:disabled{opacity:.5;cursor:not-allowed}
.gm-mini{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;flex:none}
.gm-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gm-mini-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.gm-mini-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.gm-mini:disabled{opacity:.5;cursor:not-allowed}

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
.gm-diff-hunk{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:2px 0;display:flex;align-items:center;gap:8px}
.gm-diff-hunk>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-diff-line{white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;padding:0 6px}
.gm-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.gm-diff-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.gm-diff-ctx{color:var(--dsw-alias-label-secondary)}
.gm-diff-meta{color:var(--dsw-alias-label-tertiary)}
.gm-diff-trunc{padding:8px 0;font-family:var(--dsw-font-sans,inherit);font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic}

/* Diff 独立窗口（盖在面板 z-index:1000 之上、确认框 z-index:1100 之下） */
.gm-diffwin{position:fixed;inset:0;z-index:1050;display:flex;align-items:center;justify-content:center}
.gm-diffwin-panel{position:relative;z-index:1;width:min(1080px,calc(100vw - 64px));height:min(780px,100vh - 96px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:16px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden}
.gm-diffwin-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.gm-diffwin-body .gm-diff{margin-top:0;max-height:none}

/* hunk 级操作按钮（IDEA 式逐块撤销/暂存/取消暂存） */
.gm-hunk-btn{flex:none;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.gm-hunk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gm-hunk-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.gm-hunk-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}

/* Commit box */
.gm-commit{margin-top:14px;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.gm-textarea{box-sizing:border-box;width:100%;min-height:60px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;outline:none;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.gm-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.gm-checkbox input{accent-color:var(--dsw-alias-brand-primary)}
.gm-radio{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;margin-right:14px}
.gm-radio input{accent-color:var(--dsw-alias-brand-primary)}

/* 折叠区（Stash / Tag / 设置） */
.gm-section{margin-top:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.gm-section-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.gm-section-title{cursor:pointer;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-weight:500}
.gm-section-title:hover{color:var(--dsw-alias-brand-primary)}
.gm-tag-badge{font-size:10px;padding:0 6px;border-radius:999px;line-height:16px;box-sizing:border-box;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-layer-2));border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);color:var(--dsw-alias-state-business-primary);flex:none}

/* Confirm / form dialog（Portal 落 body，z-index 由 modalStack 阶梯给出） */
.gm-confirm{position:fixed;inset:0;z-index:1100;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);display:flex;align-items:center;justify-content:center}
.gm-confirm-modal{width:min(420px,90vw);max-height:calc(100vh - 64px);overflow:auto;padding:18px;background:var(--dsw-alias-bg-layer-2);border-radius:16px;box-shadow:var(--dsw-shadow-lv3)}
.gm-confirm-title{font-size:14px;font-weight:600;margin-bottom:8px}
.gm-confirm-msg{font-size:13px;color:var(--dsw-alias-label-secondary);margin-bottom:14px;white-space:pre-wrap}
.gm-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.gm-form-row{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.gm-form-label{font-size:12px;color:var(--dsw-alias-label-secondary)}

/* 历史：过滤条 + 提交详情侧栏 */
.gm-filterbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.gm-hist-wrap{display:flex;gap:12px;align-items:flex-start}
.gm-hist-main{flex:1;min-width:0}
.gm-hist-detail{width:270px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;font-size:12px;overflow:auto;max-height:100%}
.gm-detail-msg{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);margin:6px 0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;max-height:220px;overflow:auto}
.gm-detail-file{display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
.gm-detail-file:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gm-detail-count{margin-left:auto;font-family:ui-monospace,monospace;font-size:10px;flex:none}
.gm-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}

/* 设置：config 表 */
.gm-cfg-row{display:flex;gap:6px;align-items:center;padding:4px 0}
.gm-cfg-row .gm-input{flex:1;min-width:0}

/* 模式切换按钮选中态（历史 Tab 提交 | Reflog） */
.gm-mini-on{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);border-color:transparent}

/* Blame 只读窗口（gutter 分组 + 行号 + 行内容） */
.gm-blame{background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 14px;margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-x:auto}
.gm-blame-grp{margin-bottom:2px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.gm-blame-head{display:flex;align-items:center;gap:8px;font-family:var(--dsw-font-sans,inherit);font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 8px}
.gm-blame-sha{color:var(--dsw-alias-brand-primary);font-family:ui-monospace,monospace}
.gm-blame-row{display:flex;gap:10px;align-items:baseline;padding:0 8px}
.gm-blame-no{flex:none;width:42px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11px;user-select:none}
.gm-blame-text{white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}

/* 行级选择（diff 窗口内点选 / shift 点选多行，契约 §8.3） */
.gm-diff-sel-on{cursor:pointer}
.gm-diff-sel-on:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.gm-diff-line-sel{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.gm-linebar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);z-index:2}

/* rebase todo 弹窗行 */
.gm-todo-row{display:flex;align-items:center;gap:6px;padding:3px 0}
.gm-todo-sha{flex:none;font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-todo-subject{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* toast（右下角轻提示，undo 的重做提示走这里） */
.gm-toast{position:fixed;right:24px;bottom:24px;z-index:1150;max-width:min(440px,calc(100vw - 48px));padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3);font-size:12px;color:var(--dsw-alias-label-primary);display:flex;gap:10px;align-items:flex-start}
.gm-toast-text{flex:1;white-space:pre-wrap;word-break:break-word}
`;

    // ---- Client Remote 自挂载 ----
    // strict codec 双形态（与 typert.host.js 同因）：0.1.5 客户端 registry 校验
    // `schema.parse`，0.1.7 校验 `create()` 工厂——只写一边会在另一端
    // ctx.remote.$mount 注册时抛错，插件整个 apply 失败、入口不出现。
    const passthrough = () => ({ parse: (v) => v });
    const method = (m) => ({
      id: "dsh-git-manager#gitManager/" + m,
      service: "gitManager", namespace: "gitManager", method: m,
      invocation: { kind: "direct" },
      parameters: [{ name: "request", wire: "request", source: "json",
        codec: { mode: "strict", typeSymbol: "dsh-git-manager#GitManager" + m + "Request", schema: passthrough(), create: passthrough } }],
      result: { mode: "strict", typeSymbol: "dsh-git-manager#GitManager" + m + "Result", schema: passthrough(), create: passthrough },
    });
    // Remote 方法（与 index.js + typert.host.js 一致；self-test 静态守卫校验）。
    // 前 30 个是 v1 方法，其后按契约顺序：stageHunk(P0) → P1 全家 → P2 全家 → P3-A 五个。
    const CLIENT_METHODS = [
      "probe","overview","status","diff","log","branches","remotes","worktrees",
      "conflictContent","stage","unstage","discard","hunkApply","commit","branchCreate",
      "checkout","branchDelete","branchRename","merge","mergeAbort","mergeContinue",
      "cherryPick","resolveConflict","fetch","pull","push","worktreeAdd","worktreeRemove",
      "worktreePrune","init",
      "stageHunk",
      "stashList","stashPush","stashPop","stashApply","stashDrop","stashClear",
      "tags","tagCreate","tagDelete",
      "reset","revert","blame","diffRange","reflog",
      "remoteAdd","remoteRemove","remoteRename","configList","configSet","configUnset",
      "rebasePlan","rebaseRun","fixupCommit","rebaseBranch","lineApply",
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

    // ---- 弹层栈（契约 §0 P0 修复） ----
    // modalStack：顶层弹层（diff 窗口 / 确认框 / 表单弹窗 / 冲突编辑器）注册 { close, kind, z }。
    // document 级 Esc 只关栈顶；面板 Esc 仅在栈空时关面板；mask 点击只关自身。
    // z-index 阶梯：面板 1000 < diffwin 1050 < dialog 1100（dialog 叠 dialog 每层 +10）。
    const modalStack = [];
    function useModalLayer(open, close, kind) {
      const closeRef = React.useRef(close);
      closeRef.current = close;
      const baseZ = kind === "diffwin" ? 1050 : 1100;
      const [z, setZ] = React.useState(baseZ);
      React.useEffect(() => {
        if (!open) return undefined;
        // dialog 叠 dialog 时每层 +10；diffwin 恒 1050
        const below = kind === "diffwin" ? 0 : modalStack.filter((m) => m.kind !== "diffwin").length;
        const entry = {
          kind,
          z: baseZ + 10 * below,
          close: () => { const f = closeRef.current; if (typeof f === "function") f(); },
        };
        modalStack.push(entry);
        setZ(entry.z);
        return () => {
          const i = modalStack.indexOf(entry);
          if (i >= 0) modalStack.splice(i, 1);
        };
      }, [open]);
      return z;
    }

    // ---- 冲突来源跟踪（冲突 Tab 底部按钮分流，契约 §3.5） ----
    // stash pop/apply 冲突不写 MERGE_HEAD，与 merge/cherry-pick/revert 冲突在 status 上
    // 不可区分（status 只有 merging=MERGE_HEAD / rebasing=rebase-*）——由发起操作的
    // UI 记录来源："stash" | "cherry" | "revert" | "merge" | null（会话外产生的未知态）。
    let conflictSource = null;
    let stashConflictIndex = 0;

    // ---- toast（右下角轻提示；undo/redo 提示走这里，契约 §8.5） ----
    let toastState = { text: "", id: 0 };
    const toastListeners = new Set();
    function showToast(text) {
      toastState = { text: String(text || ""), id: toastState.id + 1 };
      toastListeners.forEach((f) => f());
    }
    function useToast() {
      return React.useSyncExternalStore(
        (cb) => { toastListeners.add(cb); return () => toastListeners.delete(cb); },
        () => toastState,
      );
    }
    function Toast(props) {
      const t = useToast();
      React.useEffect(() => {
        if (!t.text) return undefined;
        const timer = setTimeout(() => showToast(""), 10000);
        return () => clearTimeout(timer);
      }, [t.id]);
      if (!t.text) return null;
      return ReactDOM.createPortal(
        React.createElement("div", { className: "gm-toast", role: "status" },
          React.createElement("span", { className: "gm-toast-text" }, t.text),
          React.createElement("button", { className: "gm-mini", title: "关闭", onClick: () => showToast("") }, "×"),
        ),
        document.body,
      );
    }

    // git 空树 sha（40 位纯 hex，checkRev 放行）：根提交（无父）逐版本 diff 的 from 兜底
    const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    // ---- helpers ----
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

    // 从 `git show --format=fuller` 文本里取出完整提交信息（subject + body）
    function parseShowMessage(text) {
      const idx = typeof text === "string" ? text.indexOf("\ndiff --git ") : -1;
      const head = idx >= 0 ? text.slice(0, idx) : (text || "");
      const out = [];
      let started = false;
      for (const line of head.split("\n")) {
        if (/^(commit|Author|AuthorDate|Commit|CommitDate|Merge|Date):/.test(line)) { started = true; continue; }
        if (!started) continue;
        out.push(line.replace(/^    /, ""));
      }
      return out.join("\n").trim();
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

    // ============================================================================
    // 通用弹层组件（全部 Portal 落 body + modalStack 注册，契约 §0）
    // ============================================================================

    // 通用二次确认弹窗（discard / 撤销 hunk / 删分支 / 中止 merge / 删 worktree /
    // 删 stash / 清空 stash / 删 tag / 删 remote / 删 config 等危险操作）
    function ConfirmDialog(props) {
      const z = useModalLayer(!!props.open, props.onCancel, "dialog");
      if (!props.open) return null;
      return ReactDOM.createPortal(
        React.createElement("div", {
          className: "gm-confirm",
          style: { zIndex: z },
          role: "dialog",
          "aria-modal": "true",
          onMouseDown: (e) => { if (e.target === e.currentTarget && props.onCancel) props.onCancel(); },
        },
          React.createElement("div", { className: "gm-confirm-modal" },
            React.createElement("div", { className: "gm-confirm-title" }, props.title),
            React.createElement("div", { className: "gm-confirm-msg" }, props.message),
            React.createElement("div", { className: "gm-confirm-actions" },
              React.createElement("button", { className: "gm-btn", onClick: props.onCancel }, "取消"),
              React.createElement("button", { className: "gm-btn " + (props.danger ? "gm-btn-danger" : "gm-btn-primary"), onClick: props.onConfirm }, props.confirmLabel || "确认"),
            ),
          ),
        ),
        document.body,
      );
    }

    // 通用表单弹窗（stash 新建 / tag 新建 / worktree 添加 / reset / remote / config 等）
    // children 是表单区（由各 Tab 用稳定的输入元素拼），actions 行固定「取消 + 提交」。
    function FormDialog(props) {
      const z = useModalLayer(!!props.open, props.onClose, "dialog");
      if (!props.open) return null;
      return ReactDOM.createPortal(
        React.createElement("div", {
          className: "gm-confirm",
          style: { zIndex: z },
          role: "dialog",
          "aria-modal": "true",
          onMouseDown: (e) => { if (e.target === e.currentTarget && props.onClose) props.onClose(); },
        },
          React.createElement("div", { className: "gm-confirm-modal", style: props.width ? { width: props.width } : null },
            React.createElement("div", { className: "gm-confirm-title" }, props.title),
            props.message ? React.createElement("div", { className: "gm-confirm-msg" }, props.message) : null,
            props.children || null,
            React.createElement("div", { className: "gm-confirm-actions" },
              React.createElement("button", { className: "gm-btn", onClick: props.onClose }, "取消"),
              React.createElement("button", {
                className: "gm-btn " + (props.danger ? "gm-btn-danger" : "gm-btn-primary"),
                onClick: props.onSubmit,
                disabled: !!props.submitDisabled,
              }, props.submitLabel || "确认"),
            ),
          ),
        ),
        document.body,
      );
    }

    // ============================================================================
    // DiffView：自绘统一 diff 渲染器
    //   parseUnifiedDiff(text) → [{ file, header, hunks, addCount, delCount, status, truncated }]
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
          cur = { file: line.slice("diff --git ".length), header: line, hunks: [], addCount: 0, delCount: 0, status: "modified" };
          curHunk = null;
        } else if (line.startsWith("--- ")) {
          if (cur) cur.oldPath = line.slice(4);
        } else if (line.startsWith("+++ ")) {
          if (cur) cur.newPath = line.slice(4);
        } else if (line.startsWith("new file mode")) {
          if (cur) cur.status = "added";
        } else if (line.startsWith("deleted file mode")) {
          if (cur) cur.status = "deleted";
        } else if (line.startsWith("rename from") || line.startsWith("copy from")) {
          if (cur) cur.status = line.startsWith("rename") ? "renamed" : "copied";
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

    // 单次渲染行数上限（契约 §3.7：禁止一次渲染 >5000 行，超出截断 + 提示）
    const RENDER_LINE_CAP = 5000;

    function DiffView(props) {
      const files = parseUnifiedDiff(props.text);
      if (files.length === 0) {
        return React.createElement("div", { className: "gm-diff" },
          React.createElement("div", { className: "gm-diff-meta" }, "(空差异)"),
        );
      }
      // hunkActions：每个代码块一排操作按钮（IDEA 式逐块操作）；
      // hunk 索引 = 该文件段内的序号（diff 窗口始终是单文件 diff）。
      const hunkActions = Array.isArray(props.hunkActions) ? props.hunkActions : [];
      let budget = RENDER_LINE_CAP;
      let overflow = false;
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
              React.createElement("div", { className: "gm-diff-hunk" },
                React.createElement("span", null, h.header),
                hunkActions.map((a, ai) => React.createElement("button", {
                  key: ai,
                  className: "gm-hunk-btn" + (a.danger ? " gm-hunk-btn-danger" : ""),
                  title: a.title || undefined,
                  onClick: () => a.onClick(j),
                }, a.label)),
              ),
              h.lines.map((ln, k) => {
                if (budget <= 0) { overflow = true; return null; }
                budget--;
                // 行级选择（契约 §8.3）：sel = { h: hunkIndex, a, b }（该 hunk 内 diff 行下标）
                const selected = !!(props.sel && props.sel.h === j
                  && k >= Math.min(props.sel.a, props.sel.b)
                  && k <= Math.max(props.sel.a, props.sel.b));
                return React.createElement("div", {
                  key: k,
                  className: "gm-diff-line gm-diff-" + ln.kind
                    + (props.onLineClick ? " gm-diff-sel-on" : "")
                    + (selected ? " gm-diff-line-sel" : ""),
                  onClick: props.onLineClick ? (e) => props.onLineClick(j, k, e.shiftKey) : undefined,
                }, ln.text);
              }),
            )),
          );
        }),
        overflow ? React.createElement("div", { className: "gm-diff-trunc" }, "内容超过 " + RENDER_LINE_CAP + " 行，仅显示前 " + RENDER_LINE_CAP + " 行。请指定单文件查看完整差异。") : null,
      );
    }

    // 纯文本输出（diffRange kind=stat 等非 unified diff 内容）
    function PlainText(props) {
      const all = (props.text || "").split("\n");
      const shown = all.slice(0, RENDER_LINE_CAP);
      return React.createElement("div", { className: "gm-diff" },
        props.truncated ? React.createElement("div", { className: "gm-diff-trunc" }, "输出过大，已截断。") : null,
        shown.map((l, i) => React.createElement("div", { key: i, className: "gm-diff-line gm-diff-ctx" }, l === "" ? " " : l)),
        all.length > RENDER_LINE_CAP ? React.createElement("div", { className: "gm-diff-trunc" }, "超过 " + RENDER_LINE_CAP + " 行，仅显示前 " + RENDER_LINE_CAP + " 行。") : null,
      );
    }

    // ============================================================================
    // DiffWindow：diff 独立窗口（Portal 落 body，z-index 1050 盖在面板之上；
    // Esc/mask 只关窗口本身——modalStack 栈顶规则，确认框等弹窗会叠在它上面）
    // ============================================================================
    function DiffWindow(props) {
      // { title, sub, loading, text, truncated, plain, onClose, onRefresh, actions,
      //   hunkActions: [{ label, danger, title, onClick(hunkIndex) }],
      //   sel, onLineClick, lineBar }
      useModalLayer(true, props.onClose, "diffwin");
      return ReactDOM.createPortal(
        React.createElement("div", { className: "gm-diffwin", role: "dialog", "aria-modal": "true" },
          React.createElement("div", { className: "gm-mask", onClick: props.onClose }),
          React.createElement("div", { className: "gm-diffwin-panel" },
            React.createElement("div", { className: "gm-head" },
              React.createElement("span", { className: "gm-head-title" }, props.title || "差异"),
              props.sub ? React.createElement("span", { className: "gm-head-path", title: props.sub }, props.sub) : null,
              React.createElement("span", { className: "gm-head-spacer" }),
              props.actions || null,
              props.onRefresh ? React.createElement("button", { className: "gm-btn", onClick: props.onRefresh, disabled: !!props.loading }, "刷新") : null,
              React.createElement("button", { className: "gm-btn gm-btn-icon", onClick: props.onClose, title: "关闭（Esc）", "aria-label": "关闭 diff 窗口" },
                React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true },
                  React.createElement("path", { d: "M18 6 6 18" }),
                  React.createElement("path", { d: "m6 6 12 12" }),
                ),
              ),
            ),
            React.createElement("div", { className: "gm-diffwin-body" },
              props.loading
                ? React.createElement("div", { className: "gm-empty" },
                    React.createElement("span", { className: "gm-spinner" }),
                    " 加载差异…",
                  )
                : props.plain
                  ? React.createElement(PlainText, { text: props.text || "", truncated: !!props.truncated })
                  : React.createElement(DiffView, {
                      text: props.text || "",
                      truncated: !!props.truncated,
                      hunkActions: props.hunkActions,
                      sel: props.sel,
                      onLineClick: props.onLineClick,
                    }),
            ),
            // 行级选择浮出操作条（由调用方构造；契约 §8.3）
            props.lineBar || null,
          ),
        ),
        document.body,
      );
    }

    // ============================================================================
    // BlameView / BlameWindow：只读 blame 窗口（契约 §3.4b）
    //   blameLine[] 按 sha 连续分组：gutter（short sha + author + 日期）+ 行号 + 行内容
    // ============================================================================
    function BlameView(props) {
      const lines = Array.isArray(props.lines) ? props.lines : [];
      // 按 sha 连续分组
      const groups = [];
      for (const ln of lines) {
        const last = groups.length > 0 ? groups[groups.length - 1] : null;
        if (last && last.sha === ln.sha) last.lines.push(ln);
        else groups.push({ sha: ln.sha, short: ln.short, author: ln.author, at: ln.at, lines: [ln] });
      }
      let budget = RENDER_LINE_CAP;
      let overflow = false;
      return React.createElement("div", { className: "gm-blame" },
        props.truncated ? React.createElement("div", { className: "gm-diff-trunc" }, "blame 数据过大，已截断。") : null,
        groups.map((g, i) => React.createElement("div", { key: i, className: "gm-blame-grp" },
          React.createElement("div", { className: "gm-blame-head" },
            React.createElement("span", { className: "gm-blame-sha" }, g.short || (g.sha || "").slice(0, 8)),
            React.createElement("span", null, g.author || ""),
            React.createElement("span", { className: "gm-meta" }, fmtTime(g.at)),
          ),
          g.lines.map((ln, k) => {
            if (budget <= 0) { overflow = true; return null; }
            budget--;
            return React.createElement("div", { key: k, className: "gm-blame-row" },
              React.createElement("span", { className: "gm-blame-no" }, String(ln.line)),
              React.createElement("span", { className: "gm-blame-text" }, ln.text === "" ? " " : ln.text),
            );
          }),
        )),
        overflow ? React.createElement("div", { className: "gm-diff-trunc" }, "超过 " + RENDER_LINE_CAP + " 行，仅显示前 " + RENDER_LINE_CAP + " 行。") : null,
      );
    }

    function BlameWindow(props) {
      // { title, sub, loading, lines, truncated, onClose, onRefresh }
      useModalLayer(true, props.onClose, "diffwin");
      return ReactDOM.createPortal(
        React.createElement("div", { className: "gm-diffwin", role: "dialog", "aria-modal": "true" },
          React.createElement("div", { className: "gm-mask", onClick: props.onClose }),
          React.createElement("div", { className: "gm-diffwin-panel" },
            React.createElement("div", { className: "gm-head" },
              React.createElement("span", { className: "gm-head-title" }, props.title || "Blame"),
              props.sub ? React.createElement("span", { className: "gm-head-path", title: props.sub }, props.sub) : null,
              React.createElement("span", { className: "gm-head-spacer" }),
              props.onRefresh ? React.createElement("button", { className: "gm-btn", onClick: props.onRefresh, disabled: !!props.loading }, "刷新") : null,
              React.createElement("button", { className: "gm-btn gm-btn-icon", onClick: props.onClose, title: "关闭（Esc）", "aria-label": "关闭 blame 窗口" },
                React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true },
                  React.createElement("path", { d: "M18 6 6 18" }),
                  React.createElement("path", { d: "m6 6 12 12" }),
                ),
              ),
            ),
            React.createElement("div", { className: "gm-diffwin-body" },
              props.loading
                ? React.createElement("div", { className: "gm-empty" },
                    React.createElement("span", { className: "gm-spinner" }),
                    " 加载 blame…",
                  )
                : React.createElement(BlameView, { lines: props.lines || [], truncated: !!props.truncated }),
            ),
          ),
        ),
        document.body,
      );
    }

    // ============================================================================
    // RebaseTodoDialog：rebase todo 弹窗（契约 §8.6）
    //   行 = ↑↓ + short sha + subject + action 下拉（pick/squash/fixup/drop/edit）；
    //   squash/fixup 可填 message；提交后由调用方接危险级二次确认再调 rebaseRun。
    // ============================================================================
    function RebaseTodoDialog(props) {
      // { entries, onClose, onSubmit(entries) }
      const [items, setItems] = React.useState(() => (props.entries || []).map((e) => ({
        sha: e.sha,
        short: e.short || (e.sha || "").slice(0, 8),
        subject: e.subject || "",
        action: e.action && ["pick", "squash", "fixup", "drop", "edit"].indexOf(e.action) >= 0 ? e.action : "pick",
        message: e.message || "",
      })));
      const move = (i, delta) => setItems((arr) => {
        const j = i + delta;
        if (j < 0 || j >= arr.length) return arr;
        const n = arr.slice();
        const t = n[i]; n[i] = n[j]; n[j] = t;
        return n;
      });
      const setField = (i, field, value) => setItems((arr) => arr.map((it, k) => (k === i ? Object.assign({}, it, { [field]: value }) : it)));
      const needMessage = items.some((it) => it.action === "squash" || it.action === "fixup");
      return React.createElement(FormDialog, {
        open: true,
        width: "min(560px,92vw)",
        title: "整理历史（rebase todo）",
        message: "调整提交顺序与合并方式；「开始 Rebase」会改写当前分支历史（提交 sha 会变化）。",
        submitLabel: "开始 Rebase",
        onClose: props.onClose,
        onSubmit: () => props.onSubmit(items),
        children: React.createElement(React.Fragment, null,
          items.length === 0
            ? React.createElement("div", { className: "gm-meta", style: { padding: "8px 0" } }, "没有可整理的提交。")
            : items.map((it, i) => React.createElement("div", { key: it.sha + "@" + i, className: "gm-todo-row" },
                React.createElement("button", { className: "gm-mini", disabled: i === 0, title: "上移", onClick: () => move(i, -1) }, "↑"),
                React.createElement("button", { className: "gm-mini", disabled: i === items.length - 1, title: "下移", onClick: () => move(i, 1) }, "↓"),
                React.createElement("span", { className: "gm-todo-sha", title: it.sha }, it.short),
                React.createElement("span", { className: "gm-todo-subject", title: it.subject }, it.subject),
                React.createElement("select", {
                  className: "gm-input",
                  style: { width: 86, height: 24, flex: "none" },
                  value: it.action,
                  onChange: (e) => setField(i, "action", e.target.value),
                },
                  ["pick", "squash", "fixup", "drop", "edit"].map((a) => React.createElement("option", { key: a, value: a }, a)),
                ),
              )),
          needMessage
            ? React.createElement("div", { style: { marginTop: 10 } },
                items.map((it, i) => (it.action === "squash" || it.action === "fixup")
                  ? React.createElement("div", { key: "msg" + it.sha + "@" + i, className: "gm-form-row" },
                      React.createElement("span", { className: "gm-form-label" }, it.short + " 的合并信息（可选，" + it.action + "）"),
                      React.createElement("input", {
                        className: "gm-input",
                        value: it.message,
                        placeholder: "留空则沿用 git 默认合并信息",
                        onChange: (e) => setField(i, "message", e.target.value),
                      }),
                    )
                  : null),
              )
            : null,
        ),
      });
    }

    // ============================================================================
    // FileHistoryWindow：只读文件历史视图（契约 §8.4，纯 Client）
    //   log({file}) 提交列表；点行开该版本 diff（diffRange from=父提交 to=该提交）。
    // ============================================================================
    function FileHistoryWindow(props) {
      // { file, loading, entries, onClose, onRefresh, onOpenCommit(entry) }
      useModalLayer(true, props.onClose, "diffwin");
      return ReactDOM.createPortal(
        React.createElement("div", { className: "gm-diffwin", role: "dialog", "aria-modal": "true" },
          React.createElement("div", { className: "gm-mask", onClick: props.onClose }),
          React.createElement("div", { className: "gm-diffwin-panel" },
            React.createElement("div", { className: "gm-head" },
              React.createElement("span", { className: "gm-head-title" }, "历史 — " + props.file),
              React.createElement("span", { className: "gm-head-spacer" }),
              props.onRefresh ? React.createElement("button", { className: "gm-btn", onClick: props.onRefresh, disabled: !!props.loading }, "刷新") : null,
              React.createElement("button", { className: "gm-btn gm-btn-icon", onClick: props.onClose, title: "关闭（Esc）", "aria-label": "关闭文件历史" },
                React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true },
                  React.createElement("path", { d: "M18 6 6 18" }),
                  React.createElement("path", { d: "m6 6 12 12" }),
                ),
              ),
            ),
            React.createElement("div", { className: "gm-diffwin-body" },
              props.loading
                ? React.createElement("div", { className: "gm-empty" },
                    React.createElement("span", { className: "gm-spinner" }),
                    " 加载文件历史…",
                  )
                : (props.entries || []).length === 0
                  ? React.createElement("div", { className: "gm-empty" }, "该文件没有历史（新文件或未跟踪）。")
                  : React.createElement("div", { style: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" } },
                      (props.entries || []).map((c) => React.createElement("div", {
                        key: c.sha,
                        className: "gm-file",
                        title: "点击查看该版本的差异",
                        onClick: () => props.onOpenCommit(c),
                      },
                        React.createElement("span", { style: { flex: "none", fontFamily: "ui-monospace,monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginRight: 8 } }, c.short),
                        React.createElement("span", { className: "gm-file-path" }, c.subject),
                        React.createElement("span", { className: "gm-meta" }, c.author),
                        React.createElement("span", { className: "gm-meta" }, fmtTime(c.at)),
                      )),
                    ),
            ),
          ),
        ),
        document.body,
      );
    }

    // ============================================================================
    // GitPanel（六个 Tab 的内容；此处是壳）
    // ============================================================================
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
          ["settings", "设置"],
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

      // Tab content：每个 Tab 的真实实现
      // worktreeAdd 成功后把新 worktree 注册为 DSH 工作区（host 侧按 canonical
      // 路径去重，重复注册安全）——这样它在 workspace-write 沙盒下天然可写
      // （writableRoots 只含 workspaceRoot + tmp，见 dsh-sandbox）。
      const workspacesService = props.workspaces;
      const registerWorkspace = async (wtPath) => {
        if (!workspacesService || typeof workspacesService.create !== "function") return null;
        try {
          const r = await workspacesService.create({ path: wtPath });
          if (r && r.ok === false) return null;
          return "已注册为 DSH 工作区（侧栏可直接打开，沙盒内可写）";
        } catch (_) {
          return null;
        }
      };

      const tabProps = { remote, repoPath, probe, status, busy, act, setError, onStatus: setStatus, onSwitchTab: setTab, registerWorkspace };
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
          case "settings": return React.createElement(SettingsTab, tabProps);
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
    // ChangesTab（提交框 / 暂存全部 / hunk 级操作 / Stash 区）
    // ============================================================================
    const SCOPE_LABEL = {
      worktree: "未暂存（工作区 vs 暂存区）",
      staged: "已暂存（暂存区 vs HEAD）",
      untracked: "未跟踪（完整内容）",
    };

    function ChangesTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const status = props.status;
      const act = props.act;
      const setError = props.setError;
      const [diffWin, setDiffWin] = React.useState(null); // { file, scope, loading, text, truncated }
      const [blameWin, setBlameWin] = React.useState(null); // { file, ref, loading, lines, truncated }
      const [lineSel, setLineSel] = React.useState(null); // { h, a, b }：diff 窗口内行级选择（hunk 内行下标）
      const [fileHist, setFileHist] = React.useState(null); // { file, loading, entries }
      const [histDiff, setHistDiff] = React.useState(null); // { title, sub, loading, text, truncated }
      const [confirming, setConfirming] = React.useState(null);
      const [hunkConfirm, setHunkConfirm] = React.useState(null); // { hunkIndex }（撤销此块，危险）
      const [commitMsg, setCommitMsg] = React.useState("");
      const [amend, setAmend] = React.useState(false);
      const [stashes, setStashes] = React.useState(null); // null=未加载
      const [stashOpen, setStashOpen] = React.useState(false);
      const [stashDlg, setStashDlg] = React.useState(false);
      const [stashMsg, setStashMsg] = React.useState("");
      const [stashUntracked, setStashUntracked] = React.useState(false);

      // 点击文件 → 独立 diff 窗口（不再挤在列表旁边/下面）
      const openDiff = async (file, scope) => {
        setLineSel(null);
        setDiffWin({ file, scope, loading: true, text: "", truncated: false });
        const r = await unwrap(await remote.diff({ path: repoPath, scope, file }));
        if (!r.ok) { setDiffWin(null); setError(r.error.message || r.error.code); return; }
        setDiffWin({ file, scope, loading: false, text: r.value.text, truncated: r.value.truncated });
      };

      const reloadDiff = async () => {
        if (!diffWin) return;
        const d = await unwrap(await remote.diff({ path: repoPath, scope: diffWin.scope, file: diffWin.file }));
        if (!d.ok) return;
        const empty = !d.value.text;
        setLineSel(null);
        setDiffWin((cur) => (cur ? (empty ? null : { ...cur, loading: false, text: d.value.text, truncated: d.value.truncated }) : cur));
      };

      // ---- 行级选择（契约 §8.3）：点选 / shift 点选 → lineApply ----
      const onLineClick = (h, k, shift) => {
        setLineSel((cur) => {
          if (!shift || !cur || cur.h !== h) return { h, a: k, b: k };
          return { h, a: cur.a, b: k };
        });
      };
      const applySelectedLines = async (mode) => {
        if (!lineSel || !diffWin) return;
        const r = await act("lineApply", () => remote.lineApply({
          path: repoPath,
          file: diffWin.file,
          scope: diffWin.scope === "staged" ? "staged" : "unstaged",
          hunkIndex: lineSel.h,
          rowStart: Math.min(lineSel.a, lineSel.b),
          rowEnd: Math.max(lineSel.a, lineSel.b),
          mode,
        }));
        if (r === undefined) return;
        await reloadDiff();
      };
      const lineBar = (diffWin && lineSel && (diffWin.scope === "worktree" || diffWin.scope === "staged"))
        ? React.createElement("div", { className: "gm-linebar" },
            React.createElement("span", { className: "gm-meta" }, "已选 " + (Math.abs(lineSel.b - lineSel.a) + 1) + " 行"),
            diffWin.scope === "worktree" ? React.createElement("button", {
              className: "gm-btn gm-btn-primary",
              disabled: !!props.busy,
              title: "只暂存选中的行（lineApply stage）",
              onClick: () => applySelectedLines("stage"),
            }, "暂存选中行") : null,
            diffWin.scope === "worktree" ? React.createElement("button", {
              className: "gm-btn gm-btn-danger",
              disabled: !!props.busy,
              title: "丢弃选中行在工作区的改动（危险）",
              onClick: () => setConfirming({ kind: "lineDiscard" }),
            }, "撤销选中行") : null,
            diffWin.scope === "staged" ? React.createElement("button", {
              className: "gm-btn",
              disabled: !!props.busy,
              title: "把选中行移出暂存区（改动保留在工作区）",
              onClick: () => applySelectedLines("unstage"),
            }, "取消暂存选中行") : null,
            React.createElement("button", { className: "gm-mini", onClick: () => setLineSel(null) }, "取消选择"),
          )
        : null;

      // ---- 文件级历史（契约 §8.4）：log({file}) + 逐版本 diffRange ----
      const openFileHist = async (file) => {
        setFileHist({ file, loading: true, entries: [] });
        const r = await unwrap(await remote.log({ path: repoPath, file, maxCount: 100 }));
        if (!r.ok) { setFileHist(null); setError(r.error.message || r.error.code); return; }
        setFileHist({ file, loading: false, entries: (r.value && r.value.commits) || [] });
      };
      const openHistDiff = async (file, c) => {
        // 根提交（无父）用空树 sha 当 from（纯 hex，checkRev 放行）
        const from = (c.parents && c.parents.length > 0) ? (c.sha + "^") : EMPTY_TREE_SHA;
        setHistDiff({ file, c, title: file, sub: (c.short || "") + " " + (c.subject || ""), loading: true, text: "", truncated: false });
        const r = await unwrap(await remote.diffRange({ path: repoPath, from, to: c.sha, file, kind: "patch" }));
        if (!r.ok) { setHistDiff(null); setError(r.error.message || r.error.code); return; }
        setHistDiff({ file, c, title: file, sub: (c.short || "") + " " + (c.subject || ""), loading: false, text: r.value.text, truncated: r.value.truncated });
      };

      // 只读 blame 窗口（契约 §3.4b）：变更 Tab 未暂存/已暂存文件行入口
      const openBlame = async (file, ref) => {
        setBlameWin({ file, ref, loading: true, lines: [], truncated: false });
        const req = { path: repoPath, file };
        if (ref) req.ref = ref;
        const r = await unwrap(await remote.blame(req));
        if (!r.ok) { setBlameWin(null); setError(r.error.message || r.error.code); return; }
        setBlameWin({ file, ref, loading: false, lines: (r.value && r.value.lines) || [], truncated: !!(r.value && r.value.truncated) });
      };

      // hunk 级操作：worktree=「暂存此块」（stageHunk，无确认）+「撤销此块」（危险，确认）；
      // staged=「取消暂存此块」（hunkApply，无确认，改动保留在工作区）。
      const stageHunk = async (hunkIndex) => {
        if (!diffWin) return;
        const r = await act("stageHunk", () => remote.stageHunk({ path: repoPath, file: diffWin.file, hunkIndex }));
        if (r === undefined) return;
        await reloadDiff();
      };
      const unstageHunk = async (hunkIndex) => {
        if (!diffWin) return;
        const r = await act("hunkApply", () => remote.hunkApply({ path: repoPath, scope: "staged", file: diffWin.file, hunkIndex }));
        if (r === undefined) return;
        await reloadDiff();
      };
      const onConfirmHunk = async () => {
        const c = hunkConfirm;
        setHunkConfirm(null);
        if (!c || !diffWin) return;
        const r = await act("hunkApply", () => remote.hunkApply({ path: repoPath, scope: diffWin.scope, file: diffWin.file, hunkIndex: c.hunkIndex }));
        if (r === undefined) return; // act 已把错误放进错误条
        await reloadDiff();
      };

      const hunkActions = [];
      if (diffWin && diffWin.scope === "worktree") {
        hunkActions.push({ label: "暂存此块", title: "把该代码块加入暂存区", danger: false, onClick: stageHunk });
        hunkActions.push({ label: "撤销此块", title: "丢弃该代码块在工作区的改动（恢复为暂存区版本）", danger: true, onClick: (j) => setHunkConfirm({ hunkIndex: j }) });
      } else if (diffWin && diffWin.scope === "staged") {
        hunkActions.push({ label: "取消暂存此块", title: "把该代码块移出暂存区（改动保留在工作区，内容不丢）", danger: false, onClick: unstageHunk });
      }

      // ---- stash ----
      const loadStashes = async () => {
        try {
          const u = await unwrap(await remote.stashList({ path: repoPath }));
          setStashes(u.ok ? ((u.value && u.value.stashes) || []) : []);
        } catch (_) {
          setStashes([]);
        }
      };
      const refreshStatus = async () => {
        const s = await unwrap(await remote.status({ path: repoPath }));
        if (s.ok && props.onStatus) props.onStatus(s.value);
      };
      React.useEffect(() => { loadStashes(); }, [repoPath]);

      const doStashPush = async () => {
        const req = { path: repoPath };
        if (stashMsg.trim()) req.message = stashMsg.trim();
        if (stashUntracked) req.includeUntracked = true;
        const r = await act("stashPush", () => remote.stashPush(req));
        if (r === undefined) return;
        setStashDlg(false); setStashMsg(""); setStashUntracked(false);
        setStashOpen(true);
        if (r && r.stashes) setStashes(r.stashes); else await loadStashes();
        await refreshStatus();
      };
      const doStashOp = async (label, fn, index) => {
        const r = await act(label, fn);
        if (r === undefined) return;
        if (r && r.stashes) setStashes(r.stashes); else await loadStashes();
        await refreshStatus();
        // stash pop/apply 冲突（无 MERGE_HEAD）→ 记录来源并跳冲突页（契约 §3.5 分流）
        if ((label === "stashPop" || label === "stashApply")
          && r && r.status && r.status.conflicted && r.status.conflicted.length > 0
          && !r.status.merging && !r.status.rebasing) {
          conflictSource = "stash";
          stashConflictIndex = typeof index === "number" ? index : 0;
          if (props.onSwitchTab) props.onSwitchTab("conflicts");
        }
      };

      // ---- 文件行 ----
      const renderGroup = (label, entries, kind, scope) => {
        if (!entries || entries.length === 0) return null;
        return React.createElement("div", { key: kind, className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" },
            React.createElement("span", null, label + " (" + entries.length + ")"),
            kind === "untracked" ? React.createElement("button", {
              className: "gm-mini gm-mini-danger",
              disabled: !!props.busy,
              onClick: () => setConfirming({ kind: "discard-all", files: entries.map((e) => (typeof e === "string" ? e : e.path)), scope: "untracked" }),
            }, "删除全部") : null,
          ),
          entries.map((e) => {
            const entry = typeof e === "string" ? { path: e } : e;
            const kindClass = (entry.kind && ("gm-file-kind-" + entry.kind)) || "";
            const isActive = !!(diffWin && diffWin.file === entry.path && diffWin.scope === scope);
            return React.createElement("div", {
              key: entry.path,
              className: "gm-file" + (isActive ? " gm-file-active" : ""),
              title: "点击查看差异",
              onClick: () => openDiff(entry.path, scope),
            },
              React.createElement("span", { className: "gm-file-kind " + kindClass }, entry.kind || "new"),
              React.createElement("span", { className: "gm-file-path" }, entry.path),
              entry.oldPath ? React.createElement("span", { className: "gm-file-old" }, "← " + entry.oldPath) : null,
              scope === "staged" ? React.createElement("button", { className: "gm-mini", disabled: !!props.busy, onClick: (ev) => { ev.stopPropagation(); act("unstage", () => remote.unstage({ path: repoPath, files: [entry.path] })); } }, "取消暂存") : null,
              scope === "unstaged" || scope === "untracked" ? React.createElement("button", { className: "gm-mini", disabled: !!props.busy, onClick: (ev) => { ev.stopPropagation(); act("stage", () => remote.stage({ path: repoPath, files: [entry.path] })); } }, "暂存") : null,
              scope === "staged" || scope === "unstaged" ? React.createElement("button", {
                className: "gm-mini",
                title: "逐行追溯（blame）该文件",
                onClick: (ev) => { ev.stopPropagation(); openBlame(entry.path); },
              }, "Blame") : null,
              scope === "staged" || scope === "unstaged" ? React.createElement("button", {
                className: "gm-mini",
                title: "该文件的提交历史",
                onClick: (ev) => { ev.stopPropagation(); openFileHist(entry.path); },
              }, "历史") : null,
              scope === "staged" || scope === "unstaged" || scope === "untracked" ? React.createElement("button", {
                className: "gm-mini gm-mini-danger",
                disabled: !!props.busy,
                onClick: (ev) => { ev.stopPropagation(); setConfirming({ kind: "discard", entry, scope }); },
              }, scope === "untracked" ? "删除" : "丢弃") : null,
            );
          }),
        );
      };

      const onConfirmDiscard = async () => {
        const c = confirming;
        setConfirming(null);
        if (!c) return;
        if (c.kind === "discard") {
          const file = c.entry.path || c.entry;
          if (c.scope === "staged") {
            // 已暂存的「丢弃」= 取消暂存 + 丢弃工作区改动（回到 HEAD 版本）
            await act("unstage", () => remote.unstage({ path: repoPath, files: [file] }));
          }
          await act("discard", () => remote.discard({ path: repoPath, files: [file], includeUntracked: c.scope === "untracked" }));
        } else if (c.kind === "discard-all") {
          await act("discard-all", () => remote.discard({ path: repoPath, files: c.files, includeUntracked: true }));
        } else if (c.kind === "stashDrop") {
          await doStashOp("stashDrop", () => remote.stashDrop({ path: repoPath, index: c.index }));
        } else if (c.kind === "stashClear") {
          await doStashOp("stashClear", () => remote.stashClear({ path: repoPath }));
        } else if (c.kind === "lineDiscard") {
          await applySelectedLines("discard");
        } else if (c.kind === "undoCommit") {
          // undo（契约 §8.5）：soft reset HEAD~1，改动回暂存区；toast 带重做提示
          const r = await act("undoCommit", () => remote.reset({ path: repoPath, mode: "soft", target: "HEAD~1" }));
          if (r !== undefined) {
            showToast("已撤销最后一次提交，改动保留在暂存区。\n重做：git reset --soft HEAD@{1}（或 git reflog 查看历史）。");
          }
        }
      };

      const submitCommit = async () => {
        if (!commitMsg.trim()) { setError("提交信息不能为空"); return; }
        const r = await act("commit", () => remote.commit({ path: repoPath, message: commitMsg, amend }));
        if (r) { setCommitMsg(""); setAmend(false); setDiffWin(null); }
      };

      // amend 勾选时拉 HEAD 提交信息预填（空框才填，避免覆盖用户已输入内容）
      React.useEffect(() => {
        if (!amend) return undefined;
        let alive = true;
        (async () => {
          try {
            const r = await unwrap(await remote.log({ path: repoPath, maxCount: 1 }));
            if (!alive || !r.ok || !r.value || !r.value.commits || r.value.commits.length === 0) return;
            setCommitMsg((m) => (m.trim() ? m : r.value.commits[0].subject || ""));
          } catch (_) { /* 预填失败不阻塞，用户手输即可 */ }
        })();
        return () => { alive = false; };
      }, [amend, repoPath]);

      const isClean = !status || (status.staged.length + status.unstaged.length + status.untracked.length === 0);
      return React.createElement(React.Fragment, null,
        // 提交框（置顶）
        React.createElement("div", { className: "gm-commit" },
          React.createElement("textarea", {
            className: "gm-textarea",
            placeholder: "提交信息（支持多行）",
            value: commitMsg,
            onChange: (e) => setCommitMsg(e.target.value),
          }),
          React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "center" } },
            React.createElement("label", { className: "gm-checkbox", title: "修改上一次提交（勾选后自动预填 HEAD 提交信息）" },
              React.createElement("input", { type: "checkbox", checked: amend, onChange: (e) => setAmend(e.target.checked) }),
              "Amend（修改上一次提交）",
            ),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-btn gm-btn-primary", disabled: !!props.busy || !commitMsg.trim(), onClick: submitCommit }, "提交"),
          ),
        ),
        // 工具行：暂存全部 / 取消暂存全部
        React.createElement("div", { className: "gm-filterbar", style: { marginTop: 12, marginBottom: 0 } },
          React.createElement("button", {
            className: "gm-btn",
            disabled: !!props.busy,
            title: "git add -A：暂存全部改动（含未跟踪文件）",
            onClick: () => act("stage-all", () => remote.stage({ path: repoPath, files: [], all: true })),
          }, "暂存全部"),
          React.createElement("button", {
            className: "gm-btn",
            disabled: !!props.busy || !status || status.staged.length === 0,
            onClick: () => act("unstage-all", () => remote.unstage({ path: repoPath, files: status.staged.map((e) => e.path) })),
          }, "取消暂存全部"),
          React.createElement("button", {
            className: "gm-btn",
            disabled: !!props.busy,
            title: "git reset --soft HEAD~1：撤销最后一次提交，改动保留在暂存区",
            onClick: () => setConfirming({ kind: "undoCommit" }),
          }, "撤销上次提交"),
          React.createElement("span", { style: { flex: 1 } }),
          isClean ? React.createElement("span", { className: "gm-meta" }, "工作区干净。") : null,
        ),
        renderGroup("Staged", status && status.staged, "staged", "staged"),
        renderGroup("Unstaged", status && status.unstaged, "unstaged", "worktree"),
        renderGroup("Untracked", status && status.untracked, "untracked", "untracked"),
        // Stash 折叠区
        React.createElement("div", { className: "gm-section" },
          React.createElement("div", { className: "gm-section-head" },
            React.createElement("span", {
              className: "gm-section-title",
              onClick: () => setStashOpen((v) => !v),
              title: stashOpen ? "收起" : "展开",
            }, stashOpen ? "▾" : "▸", " Stash (" + (stashes ? stashes.length : 0) + ")"),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-mini", disabled: !!props.busy, onClick: () => setStashDlg(true) }, "暂存更改到 stash…"),
            React.createElement("button", {
              className: "gm-mini gm-mini-danger",
              disabled: !!props.busy || !stashes || stashes.length === 0,
              onClick: () => setConfirming({ kind: "stashClear" }),
            }, "清空 stash"),
          ),
          stashOpen
            ? (stashes && stashes.length > 0
                ? stashes.map((s) => React.createElement("div", { key: s.index, className: "gm-file", style: { cursor: "default" } },
                    React.createElement("span", { className: "gm-file-kind" }, "W" + s.index),
                    React.createElement("span", { className: "gm-file-path", title: s.ref }, s.subject),
                    React.createElement("span", { className: "gm-meta" }, fmtTime(s.at)),
                    React.createElement("button", { className: "gm-mini", disabled: !!props.busy, title: "应用该 stash（保留 stash 条目）", onClick: () => doStashOp("stashApply", () => remote.stashApply({ path: repoPath, index: s.index }), s.index) }, "应用"),
                    React.createElement("button", { className: "gm-mini", disabled: !!props.busy, title: "应用并删除该 stash 条目", onClick: () => doStashOp("stashPop", () => remote.stashPop({ path: repoPath, index: s.index }), s.index) }, "弹出"),
                    React.createElement("button", { className: "gm-mini gm-mini-danger", disabled: !!props.busy, onClick: () => setConfirming({ kind: "stashDrop", index: s.index, subject: s.subject }) }, "删除"),
                  ))
                : React.createElement("div", { className: "gm-meta", style: { padding: "6px 2px" } }, stashes === null ? "加载 stash…" : "暂无 stash。点右上「暂存更改到 stash…」保存当前改动。"))
            : null,
        ),
        // diff 独立窗口（含行级选择；契约 §8.3）
        diffWin ? React.createElement(DiffWindow, {
          title: diffWin.file,
          sub: SCOPE_LABEL[diffWin.scope] || diffWin.scope,
          loading: diffWin.loading,
          text: diffWin.text,
          truncated: diffWin.truncated,
          onClose: () => { setDiffWin(null); setLineSel(null); },
          onRefresh: () => openDiff(diffWin.file, diffWin.scope),
          hunkActions: hunkActions,
          sel: lineSel,
          onLineClick: onLineClick,
          lineBar: lineBar,
        }) : null,
        // 文件级历史（契约 §8.4）
        fileHist ? React.createElement(FileHistoryWindow, {
          file: fileHist.file,
          loading: fileHist.loading,
          entries: fileHist.entries,
          onClose: () => setFileHist(null),
          onRefresh: () => openFileHist(fileHist.file),
          onOpenCommit: (c) => openHistDiff(fileHist.file, c),
        }) : null,
        histDiff ? React.createElement(DiffWindow, {
          title: histDiff.title,
          sub: histDiff.sub,
          loading: histDiff.loading,
          text: histDiff.text,
          truncated: histDiff.truncated,
          onClose: () => setHistDiff(null),
          onRefresh: () => openHistDiff(histDiff.file, histDiff.c),
        }) : null,
        // 只读 blame 窗口（契约 §3.4b）
        blameWin ? React.createElement(BlameWindow, {
          title: "Blame — " + blameWin.file,
          sub: blameWin.ref || "HEAD",
          loading: blameWin.loading,
          lines: blameWin.lines,
          truncated: blameWin.truncated,
          onClose: () => setBlameWin(null),
          onRefresh: () => openBlame(blameWin.file, blameWin.ref),
        }) : null,
        // 危险操作二次确认（Portal 落 body，浮于 diff 窗口 1050 之上，契约 §0）
        React.createElement(ConfirmDialog, {
          open: !!confirming && (confirming.kind === "discard" || confirming.kind === "discard-all"),
          title: "放弃变更？",
          message: "此操作会丢弃对以下文件的所有本地改动，无法撤销：\n\n" + (confirming && confirming.kind === "discard" ? (confirming.entry.path || confirming.entry) : (confirming && confirming.files ? confirming.files.join("\n") : "")),
          danger: true,
          confirmLabel: "确认丢弃",
          onCancel: () => setConfirming(null),
          onConfirm: onConfirmDiscard,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "lineDiscard",
          title: "撤销选中行？",
          message: "将丢弃选中的 " + (lineSel ? (Math.abs(lineSel.b - lineSel.a) + 1) : 0) + " 行在工作区中的改动（恢复为暂存区版本），此操作无法撤销。\n\n" + (diffWin ? diffWin.file : ""),
          danger: true,
          confirmLabel: "撤销选中行",
          onCancel: () => setConfirming(null),
          onConfirm: onConfirmDiscard,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "undoCommit",
          title: "撤销上次提交？",
          message: "将执行 git reset --soft HEAD~1：撤销最后一次提交，其改动保留在暂存区（不丢失内容）。\n\n重做提示：git reset --soft HEAD@{1}（或 git reflog 查看历史）。",
          danger: false,
          confirmLabel: "撤销上次提交",
          onCancel: () => setConfirming(null),
          onConfirm: onConfirmDiscard,
        }),
        React.createElement(ConfirmDialog, {
          open: !!hunkConfirm,
          title: "撤销此代码块？",
          message: "将丢弃该代码块在工作区中的改动（恢复为暂存区版本），此操作无法撤销。\n\n" + (diffWin ? diffWin.file : ""),
          danger: true,
          confirmLabel: "撤销此块",
          onCancel: () => setHunkConfirm(null),
          onConfirm: onConfirmHunk,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "stashDrop",
          title: "删除 stash 条目？",
          message: "该 stash 条目将被永久删除，无法撤销：\n\n" + (confirming && confirming.kind === "stashDrop" ? "#" + confirming.index + " " + confirming.subject : ""),
          danger: true,
          confirmLabel: "删除",
          onCancel: () => setConfirming(null),
          onConfirm: onConfirmDiscard,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "stashClear",
          title: "清空全部 stash？",
          message: "所有 stash 条目将被永久删除，无法撤销。",
          danger: true,
          confirmLabel: "清空",
          onCancel: () => setConfirming(null),
          onConfirm: onConfirmDiscard,
        }),
        // stash 新建弹窗
        stashDlg ? React.createElement(FormDialog, {
          open: true,
          title: "暂存更改到 stash",
          message: "把当前工作区与暂存区的改动收进 stash（可稍后应用/弹出）。",
          submitLabel: "创建 stash",
          onClose: () => setStashDlg(false),
          onSubmit: doStashPush,
          children: React.createElement(React.Fragment, null,
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "说明（可选，作为 stash message）"),
              React.createElement("textarea", { className: "gm-textarea", style: { minHeight: 48 }, placeholder: "stash 说明…", value: stashMsg, onChange: (e) => setStashMsg(e.target.value) }),
            ),
            React.createElement("label", { className: "gm-checkbox" },
              React.createElement("input", { type: "checkbox", checked: stashUntracked, onChange: (e) => setStashUntracked(e.target.checked) }),
              "包含未跟踪文件（git stash -u）",
            ),
          ),
        }) : null,
      );
    }

    // ============================================================================
    // BranchesTab（分支 + Tag 区）
    // ============================================================================
    function BranchesTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const status = props.status;
      const act = props.act;
      const [branches, setBranches] = React.useState(null);
      const [remotes, setRemotes] = React.useState([]);
      const [tags, setTags] = React.useState([]);
      const [creating, setCreating] = React.useState({ name: "", start: "" });
      const [confirming, setConfirming] = React.useState(null);
      const [tagDlg, setTagDlg] = React.useState(false);
      const [tagForm, setTagForm] = React.useState({ name: "", target: "HEAD", message: "", force: false });

      const loadTags = async () => {
        try {
          const u = await unwrap(await remote.tags({ path: repoPath }));
          setTags(u.ok ? ((u.value && u.value.tags) || []) : []);
        } catch (_) { setTags([]); }
      };
      const refresh = async () => {
        const [b, r] = await Promise.all([
          unwrap(await remote.branches({ path: repoPath })),
          unwrap(await remote.remotes({ path: repoPath })),
        ]);
        if (b.ok) setBranches(b.value);
        if (r.ok) setRemotes(r.value);
      };

      React.useEffect(() => { refresh(); loadTags(); }, [repoPath]);

      const createNew = async (form) => {
        const f = form && form.name !== undefined ? form : creating;
        if (!f.name.trim()) return;
        const payload = { path: repoPath, name: f.name.trim() };
        if (f.start) payload.startPoint = f.start;
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
          conflictSource = "merge";
          if (props.onSwitchTab) props.onSwitchTab("conflicts");
        }
      };
      const doDelete = async (name, force) => {
        setConfirming(null);
        await act("deleteBranch", () => remote.branchDelete({ path: repoPath, name, force: !!force }));
        refresh();
      };
      // rebaseBranch（契约 §8.1）：当前分支 rebase 到 branch 之上；冲突不抛错（done:false）
      const doRebase = async (name) => {
        setConfirming(null);
        const r = await act("rebaseBranch", () => remote.rebaseBranch({ path: repoPath, branch: name }));
        if (r === undefined) return;
        refresh();
        if (r.done === false) {
          conflictSource = "rebase";
          if (props.onSwitchTab) props.onSwitchTab("conflicts");
          setError("Rebase 遇到冲突：请在「冲突」页解决后点「继续 Rebase」（或「中止 Rebase」回退）。\n提示：git rebase --abort 可回到 rebase 前的状态（reflog 可查）。");
        } else {
          showToast("Rebase 完成：当前分支已重放到 \"" + name + "\" 之上（历史已改写）。\n回退提示：git reset --hard HEAD@{1}（或 git reflog 查看历史）。");
        }
      };

      // ---- tag 操作 ----
      const doTagCreate = async () => {
        const name = tagForm.name.trim();
        if (!name) return;
        const req = { path: repoPath, name };
        if (tagForm.target.trim()) req.sha = tagForm.target.trim(); // 契约：target 映射 wire 字段 sha
        if (tagForm.message.trim()) req.message = tagForm.message.trim(); // message 非空 → annotated
        if (tagForm.force) req.force = true;
        const r = await act("tagCreate", () => remote.tagCreate(req));
        if (r === undefined) return;
        if (r && r.tags) setTags(r.tags); else await loadTags();
        setTagDlg(false);
        setTagForm({ name: "", target: "HEAD", message: "", force: false });
      };
      const doTagDelete = async (name) => {
        setConfirming(null);
        const r = await act("tagDelete", () => remote.tagDelete({ path: repoPath, name }));
        if (r && r.tags) setTags(r.tags); else await loadTags();
      };
      const doTagPush = async (name) => {
        // push tag：走 push 的 refSpec（--force-with-lease 语义由 Host 保证）
        await act("pushTag", () => remote.push({ path: repoPath, remote: "origin", refSpec: "refs/tags/" + name }));
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
          ? React.createElement("button", { className: "gm-mini", onClick: () => createNew({ name: b.name.replace(/^[^/]+\//, ""), start: b.name }) }, "基于它建本地")
          : React.createElement(React.Fragment, null,
              b.current ? null : React.createElement("button", { className: "gm-mini", onClick: () => doCheckout(b.name) }, "切换"),
              b.current || b.name === "main" ? null : React.createElement("button", { className: "gm-mini", onClick: () => doMerge(b.name) }, "合并"),
              b.current ? null : React.createElement("button", {
                className: "gm-mini",
                title: "把当前分支 rebase 到该分支之上（改写当前分支历史）",
                onClick: () => setConfirming({ kind: "rebase", name: b.name }),
              }, "Rebase 当前到此分支"),
              b.current ? null : React.createElement("button", { className: "gm-mini gm-mini-danger", onClick: () => setConfirming({ kind: "delete", name: b.name }) }, "删除"),
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
            React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: () => createNew() }, "新建"),
          ),
        ),
        // Tag 区
        React.createElement("div", { className: "gm-section" },
          React.createElement("div", { className: "gm-section-head" },
            React.createElement("span", null, "Tag (" + tags.length + ")"),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-mini", onClick: () => setTagDlg(true) }, "新建 tag…"),
          ),
          tags.length === 0
            ? React.createElement("div", { className: "gm-meta", style: { padding: "6px 2px" } }, "暂无 tag。")
            : tags.map((t) => React.createElement("div", { key: t.name, className: "gm-file", style: { cursor: "default" } },
                React.createElement("span", { className: "gm-file-kind" }, "T"),
                React.createElement("span", { className: "gm-file-path" }, t.name),
                t.annotated ? React.createElement("span", { className: "gm-tag-badge", title: t.message || "annotated tag" }, "annotated") : null,
                React.createElement("span", { className: "gm-meta", style: { fontFamily: "ui-monospace,monospace" } }, t.short),
                React.createElement("span", { className: "gm-meta", title: t.subject }, (t.subject || "").slice(0, 40)),
                React.createElement("span", { className: "gm-meta" }, fmtTime(t.at)),
                React.createElement("button", { className: "gm-mini", title: "推送该 tag 到 origin", onClick: () => doTagPush(t.name) }, "push 到 origin"),
                React.createElement("button", { className: "gm-mini gm-mini-danger", onClick: () => setConfirming({ kind: "tagDelete", name: t.name }) }, "删除"),
              )),
        ),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "delete",
          title: "删除分支？",
          message: "确认删除分支 \"" + (confirming && confirming.name) + "\"？若未合并且无 -D，将失败。",
          danger: true,
          confirmLabel: "删除（未合并则失败）",
          onCancel: () => setConfirming(null),
          onConfirm: () => doDelete(confirming && confirming.name, false),
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "rebase",
          title: "Rebase 当前分支？",
          message: "将把当前分支 rebase 到 \"" + (confirming && confirming.name) + "\" 之上：当前分支的提交会被重放（sha 变化，历史改写）。\n若已推送远端，之后需要 force push（--force-with-lease）。\n冲突可在「冲突」页「中止 Rebase」回退。",
          danger: true,
          confirmLabel: "开始 Rebase",
          onCancel: () => setConfirming(null),
          onConfirm: () => doRebase(confirming && confirming.name),
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "tagDelete",
          title: "删除 tag？",
          message: "确认删除 tag \"" + (confirming && confirming.name) + "\"？本地 tag 将被删除，已推送的远端 tag 不受影响。",
          danger: true,
          confirmLabel: "删除",
          onCancel: () => setConfirming(null),
          onConfirm: () => doTagDelete(confirming && confirming.name),
        }),
        // 新建 tag 弹窗
        tagDlg ? React.createElement(FormDialog, {
          open: true,
          title: "新建 tag",
          submitLabel: "创建",
          onClose: () => setTagDlg(false),
          onSubmit: doTagCreate,
          submitDisabled: !tagForm.name.trim(),
          children: React.createElement(React.Fragment, null,
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "Tag 名称"),
              React.createElement("input", { className: "gm-input", placeholder: "如 v1.0.0", value: tagForm.name, onChange: (e) => setTagForm((s) => ({ ...s, name: e.target.value })) }),
            ),
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "目标提交（commit-ish，默认 HEAD）"),
              React.createElement("input", { className: "gm-input", placeholder: "HEAD / sha / 分支名", value: tagForm.target, onChange: (e) => setTagForm((s) => ({ ...s, target: e.target.value })) }),
            ),
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "说明（非空则创建 annotated tag）"),
              React.createElement("textarea", { className: "gm-textarea", style: { minHeight: 48 }, placeholder: "tag 说明…", value: tagForm.message, onChange: (e) => setTagForm((s) => ({ ...s, message: e.target.value })) }),
            ),
            React.createElement("label", { className: "gm-checkbox" },
              React.createElement("input", { type: "checkbox", checked: tagForm.force, onChange: (e) => setTagForm((s) => ({ ...s, force: e.target.checked })) }),
              "force（覆盖同名 tag）",
            ),
          ),
        }) : null,
      );
    }

    // ============================================================================
    // HistoryTab（分支线 SVG + 过滤条 + 提交详情侧栏 + 范围对比 + revert/reset）
    // ============================================================================
    function HistoryTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const act = props.act;
      const setError = props.setError;
      const [log, setLog] = React.useState(null); // { commits, graph, hasMore }
      const [refMode, setRefMode] = React.useState("all"); // all | current | ref:<name>
      const [viewMode, setViewMode] = React.useState("log"); // "log" | "reflog"（契约 §3.4b）
      const [reflog, setReflog] = React.useState(null); // reflogEntry[] | null
      const [reflogLimit, setReflogLimit] = React.useState(200);
      const [blameWin, setBlameWin] = React.useState(null); // { file, ref, loading, lines, truncated }
      const [rebaseDlg, setRebaseDlg] = React.useState(null); // { base, entries }（rebase todo 弹窗）
      const [fixupDlg, setFixupDlg] = React.useState(null); // { sha, subject }
      const [fixupForm, setFixupForm] = React.useState({ mode: "fixup", message: "" });
      const [fileHist, setFileHist] = React.useState(null); // { file, loading, entries }
      const [histDiff, setHistDiff] = React.useState(null); // { file, c, title, sub, loading, text, truncated }
      const [confirming, setConfirming] = React.useState(null); // { kind: undoMove|rebaseRun|fixupRun, ... }
      const [busyLocal, setBusyLocal] = React.useState(null); // rebase/fixup 进行中标记
      const [filters, setFilters] = React.useState({ file: "", author: "", grep: "", since: "", until: "" });
      const [refOptions, setRefOptions] = React.useState([]); // 分支/tag 名（ref 过滤下拉）
      const [maxCount, setMaxCount] = React.useState(200);
      const [diffWin, setDiffWin] = React.useState(null); // { sha, subject, loading, text, truncated }
      const [hoverRow, setHoverRow] = React.useState(null); // 悬停行 → 分支线聚焦高亮
      const [picking, setPicking] = React.useState(false); // cherry-pick 进行中（禁用按钮防重复点击）
      const [detail, setDetail] = React.useState(null); // 提交详情侧栏 { sha, subject, author, at, loading, message, files }
      const [resetDlg, setResetDlg] = React.useState(null); // { sha, subject }
      const [resetMode, setResetMode] = React.useState("mixed");
      const [resetText, setResetText] = React.useState("");
      const [comparing, setComparing] = React.useState(false); // 范围对比选择态
      const [cmpSel, setCmpSel] = React.useState([]); // [base, head]
      const [cmpDiff, setCmpDiff] = React.useState(null); // { kind, from, to, text, truncated, loading }

      const refresh = async () => {
        const req = { path: repoPath, maxCount, all: refMode === "all" };
        if (refMode.indexOf("ref:") === 0) req.ref = refMode.slice(4);
        if (filters.file.trim()) req.file = filters.file.trim();
        if (filters.author.trim()) req.author = filters.author.trim();
        if (filters.grep.trim()) req.grep = filters.grep.trim();
        if (filters.since) req.since = filters.since;
        if (filters.until) req.until = filters.until;
        const r = await unwrap(await remote.log(req));
        if (r.ok) setLog(r.value);
        else setError(r.error.message || r.error.code);
      };

      // 过滤条件变更 → 防抖重取
      React.useEffect(() => {
        const t = setTimeout(refresh, 250);
        return () => clearTimeout(t);
      }, [repoPath, maxCount, refMode, filters]);

      // ref 过滤下拉的候选（分支 + tag）
      React.useEffect(() => {
        let alive = true;
        (async () => {
          const names = [];
          try {
            const b = await unwrap(await remote.branches({ path: repoPath }));
            if (b.ok && b.value) {
              for (const x of (b.value.locals || [])) names.push(x.name);
            }
          } catch (_) { /* 忽略 */ }
          try {
            const t = await unwrap(await remote.tags({ path: repoPath }));
            if (t.ok && t.value) {
              for (const x of (t.value.tags || [])) names.push(x.name);
            }
          } catch (_) { /* 忽略 */ }
          if (alive) setRefOptions(names);
        })();
        return () => { alive = false; };
      }, [repoPath]);

      // Reflog 模式（契约 §3.4b）：reflog 取数
      React.useEffect(() => {
        if (viewMode !== "reflog") return undefined;
        let alive = true;
        (async () => {
          try {
            const r = await unwrap(await remote.reflog({ path: repoPath, limit: reflogLimit }));
            if (!alive) return;
            if (r.ok) setReflog((r.value && r.value.entries) || []);
            else setError(r.error.message || r.error.code);
          } catch (e) {
            if (alive) setError(String(e && e.message || e));
          }
        })();
        return () => { alive = false; };
      }, [viewMode, repoPath, reflogLimit]);

      // 只读 blame 窗口（契约 §3.4b）：提交详情侧栏文件行入口（ref=该提交）
      const openBlame = async (file, ref) => {
        setBlameWin({ file, ref, loading: true, lines: [], truncated: false });
        const req = { path: repoPath, file };
        if (ref) req.ref = ref;
        const r = await unwrap(await remote.blame(req));
        if (!r.ok) { setBlameWin(null); setError(r.error.message || r.error.code); return; }
        setBlameWin({ file, ref, loading: false, lines: (r.value && r.value.lines) || [], truncated: !!(r.value && r.value.truncated) });
      };

      // ---- rebase todo（契约 §8.6）：todo = 该提交（含）到 HEAD，base 传该提交的父 ----
      const openRebaseDlg = async () => {
        if (!detail) return;
        const base = detail.sha + "^"; // Host 口径 base..HEAD（不含 base），见契约 §8.1
        setBusyLocal(detail.sha);
        try {
          const r = await unwrap(await remote.rebasePlan({ path: repoPath, base }));
          if (!r.ok) { setError(r.error.message || r.error.code); return; }
          setRebaseDlg({ base, entries: (r.value && r.value.entries) || [] });
        } finally {
          setBusyLocal(null);
        }
      };
      const doRebaseRun = async () => {
        const c = confirming;
        setConfirming(null);
        if (!c) return;
        setBusyLocal("rebaseRun");
        try {
          const r = await unwrap(await remote.rebaseRun({ path: repoPath, base: c.base, entries: c.entries }));
          if (!r.ok) { setError(r.error.message || r.error.code); return; }
          if (props.onStatus && r.value && r.value.status) props.onStatus(r.value.status);
          refresh();
          if (r.value && r.value.done === false) {
            conflictSource = "rebase";
            if (props.onSwitchTab) props.onSwitchTab("conflicts");
            setError("Rebase 遇到冲突：请在「冲突」页解决后点「继续 Rebase」（或「中止 Rebase」回退）。\n提示：git rebase --abort 可回到 rebase 前的状态（reflog 可查）。");
          } else {
            setDetail(null);
            showToast("Rebase 完成，历史已改写。\n回退提示：git reset --hard HEAD@{1}（或 git reflog 查看历史）。");
          }
        } finally {
          setBusyLocal(null);
        }
      };

      // ---- fixup（契约 §8.6）：用暂存改动修正历史提交，改写历史 ----
      const openFixupDlg = () => {
        if (!detail) return;
        setFixupForm({ mode: "fixup", message: "" });
        setFixupDlg({ sha: detail.sha, subject: detail.subject });
      };
      const doFixupRun = async () => {
        const c = confirming;
        setConfirming(null);
        if (!c) return;
        setBusyLocal("fixup");
        try {
          const req = { path: repoPath, sha: c.sha, mode: c.mode };
          if (c.message && c.message.trim()) req.message = c.message.trim();
          const r = await unwrap(await remote.fixupCommit(req));
          if (!r.ok) { setError(r.error.message || r.error.code); return; }
          if (props.onStatus && r.value && r.value.status) props.onStatus(r.value.status);
          refresh();
          if (r.value && r.value.done === false) {
            conflictSource = "rebase";
            if (props.onSwitchTab) props.onSwitchTab("conflicts");
            setError("fixup/squash rebase 遇到冲突：请在「冲突」页解决后点「继续 Rebase」（或「中止 Rebase」回退）。");
          } else {
            setDetail(null);
            showToast("已用暂存改动修正 " + c.sha.slice(0, 8) + "（历史已改写）。\n回退提示：git reset --hard HEAD@{1}（或 git reflog 查看历史）。");
          }
        } finally {
          setBusyLocal(null);
        }
      };

      // ---- undo（契约 §8.5）：撤销上次分支移动（mixed reset @{1}） ----
      const doUndoMove = async () => {
        setConfirming(null);
        const r = await act("undoMove", () => remote.reset({ path: repoPath, mode: "mixed", target: "@{1}" }));
        if (r === undefined) return;
        refresh();
        showToast("已撤销上次分支移动，工作区改动保留。\n重做：git reset --mixed HEAD@{1}（或 git reflog 查看历史）。");
      };

      // ---- 文件级历史（契约 §8.4） ----
      const openFileHist = async (file) => {
        setFileHist({ file, loading: true, entries: [] });
        const r = await unwrap(await remote.log({ path: repoPath, file, maxCount: 100 }));
        if (!r.ok) { setFileHist(null); setError(r.error.message || r.error.code); return; }
        setFileHist({ file, loading: false, entries: (r.value && r.value.commits) || [] });
      };
      const openHistDiff = async (file, c) => {
        const from = (c.parents && c.parents.length > 0) ? (c.sha + "^") : EMPTY_TREE_SHA;
        setHistDiff({ file, c, title: file, sub: (c.short || "") + " " + (c.subject || ""), loading: true, text: "", truncated: false });
        const r = await unwrap(await remote.diffRange({ path: repoPath, from, to: c.sha, file, kind: "patch" }));
        if (!r.ok) { setHistDiff(null); setError(r.error.message || r.error.code); return; }
        setHistDiff({ file, c, title: file, sub: (c.short || "") + " " + (c.subject || ""), loading: false, text: r.value.text, truncated: r.value.truncated });
      };

      // 点击提交 → 打开提交详情侧栏（行内「diff」按钮直接开 diff 窗口）
      const openDetail = async (c) => {
        setDetail({ sha: c.sha, subject: c.subject, author: c.author, at: c.at, parents: c.parents || [], loading: true, message: c.subject || "", files: [] });
        const r = await unwrap(await remote.diff({ path: repoPath, scope: "commit", sha: c.sha }));
        if (!r.ok) {
          setDetail((d) => (d && d.sha === c.sha ? { ...d, loading: false } : d));
          setError(r.error.message || r.error.code);
          return;
        }
        const files = parseUnifiedDiff(r.value.text).map((f) => ({
          path: (f.newPath || f.oldPath || f.file || "").replace(/^[ab]\//, "").replace(/^"/, "").replace(/"$/, ""),
          status: f.status,
          add: f.addCount,
          del: f.delCount,
        }));
        const msg = parseShowMessage(r.value.text) || c.subject || "";
        setDetail((d) => (d && d.sha === c.sha ? { ...d, loading: false, message: msg, files } : d));
      };

      // 行内「diff」按钮 → 只读 diff 窗口（历史提交 diff 无 hunk 操作）
      const openCommitDiff = async (c) => {
        setDiffWin({ sha: c.sha, subject: c.subject, loading: true, text: "", truncated: false });
        const r = await unwrap(await remote.diff({ path: repoPath, scope: "commit", sha: c.sha }));
        if (!r.ok) { setDiffWin(null); setError(r.error.message || r.error.code); return; }
        setDiffWin({ sha: c.sha, subject: c.subject, loading: false, text: r.value.text, truncated: r.value.truncated });
      };

      // 详情侧栏点文件 → 该提交该文件的只读 diff 窗口
      const openFileDiff = async (c, file) => {
        setDiffWin({ sha: c.sha, subject: file, loading: true, text: "", truncated: false });
        const r = await unwrap(await remote.diff({ path: repoPath, scope: "commit", sha: c.sha, file }));
        if (!r.ok) { setDiffWin(null); setError(r.error.message || r.error.code); return; }
        setDiffWin({ sha: c.sha, subject: file, loading: false, text: r.value.text, truncated: r.value.truncated });
      };

      // cherry-pick：把提交拣选到当前分支。非破坏操作（新增提交），无需二次确认。
      // 冲突时后端返回 picked:false（不抛错）→ 关窗跳冲突页，「继续」即完成 pick。
      const doCherryPick = async (sha) => {
        setPicking(true);
        try {
          const r = await unwrap(await remote.cherryPick({ path: repoPath, sha }));
          if (!r.ok) { setError(r.error.message || r.error.code); return; }
          if (props.onStatus) props.onStatus(r.value.status);
          setDiffWin(null);
          refresh();
          if (r.value.picked === false) {
            conflictSource = "cherry";
            if (props.onSwitchTab) props.onSwitchTab("conflicts");
            setError("Cherry-pick 遇到冲突：请在「冲突」页解决后点「继续」完成（或「中止操作」回退）。");
          } else {
            conflictSource = null;
          }
        } finally {
          setPicking(false);
        }
      };

      // revert 提交（非破坏，同 cherry-pick 契约：冲突不抛错、跳冲突页）
      const doRevert = async (sha) => {
        setPicking(true);
        try {
          const r = await unwrap(await remote.revert({ path: repoPath, sha }));
          if (!r.ok) { setError(r.error.message || r.error.code); return; }
          if (props.onStatus) props.onStatus(r.value.status);
          setDetail(null);
          refresh();
          if (r.value.reverted === false) {
            conflictSource = "revert";
            if (props.onSwitchTab) props.onSwitchTab("conflicts");
            setError("Revert 遇到冲突：请在「冲突」页解决后点「继续」完成（或「中止操作」回退）。");
          } else {
            conflictSource = null;
          }
        } finally {
          setPicking(false);
        }
      };

      // reset 当前分支到指定提交（hard 需输入 RESET 打字确认）
      const doReset = async () => {
        const d = resetDlg;
        setResetDlg(null);
        setResetText("");
        if (!d) return;
        const r = await act("reset", () => remote.reset({ path: repoPath, mode: resetMode, target: d.sha }));
        if (r === undefined) return;
        setDetail(null);
        setDiffWin(null);
        refresh();
      };

      // ---- 范围对比 ----
      const openCompareDiff = async (from, to, kind) => {
        setCmpDiff({ kind, from, to, loading: true, text: "", truncated: false });
        const r = await unwrap(await remote.diffRange({ path: repoPath, from, to, kind }));
        if (!r.ok) { setCmpDiff(null); setError(r.error.message || r.error.code); return; }
        setCmpDiff({ kind, from, to, loading: false, text: r.value.text, truncated: r.value.truncated });
      };
      const pickCompare = async (c) => {
        if (cmpSel.length === 0) { setCmpSel([{ sha: c.sha, short: c.short, subject: c.subject }]); return; }
        const base = cmpSel[0];
        setCmpSel([base, { sha: c.sha, short: c.short, subject: c.subject }]);
        await openCompareDiff(base.sha, c.sha, "patch");
      };
      const exitCompare = () => {
        setComparing(false);
        setCmpSel([]);
        setCmpDiff(null);
      };

      if (!log && viewMode === "log") return React.createElement("div", { className: "gm-empty" }, "加载历史…");

      const { commits, graph, hasMore } = log || { commits: [], graph: { nodes: [], links: [], laneCount: 1 }, hasMore: false };
      const ROW_H = 32, PAD = 16;
      const PALETTE = ["#5b8cff","#2fb37d","#d99a1f","#9b7ff0","#e5484d","#18a0fb","#f76b15","#12a594","#e93d82","#8e4ec6","#6d7c8f","#a18072"];
      // 分支（车道）多时自动压缩列宽：图形区宽度封顶 ~170px，
      // 避免车道全部铺开把提交内容挤变形。
      const lanes = Math.max(1, graph.laneCount || 1);
      const COL_W = lanes <= 8 ? 14 : Math.max(5, Math.round(150 / lanes));
      const NODE_R = COL_W >= 10 ? 4 : 3;
      const width = Math.max(56, lanes * COL_W + PAD);
      const totalH = commits.length * ROW_H;

      const X = (col) => PAD / 2 + col * COL_W;
      const Y = (row) => row * ROW_H + ROW_H / 2;
      // 长边省略阈值（行）：跨度超过它的边改为"两端实线 stub + 中段细虚线"，
      // 压住长斜线/长竖线的视觉噪音，但保留走向线索。
      const SPAN_ELIDE = 24;

      // 悬停聚焦：边与悬停提交直接相连，或同车道竖线从上方跨到下方，算"相关"
      const hoverCol = hoverRow !== null && graph.nodes[hoverRow] ? graph.nodes[hoverRow].col : null;
      const isHot = (l) => {
        if (hoverRow === null) return false;
        if (l.fromRow === hoverRow || l.toRow === hoverRow) return true;
        return hoverCol !== null && l.fromCol === hoverCol && l.fromRow < hoverRow && (l.toRow === null || l.toRow > hoverRow);
      };
      // 悬停时相关边排到最后画（压在最上层）；sort 稳定，其余保持原始顺序
      const orderedLinks = hoverRow === null ? graph.links
        : graph.links.slice().sort((a, b) => (isHot(a) ? 1 : 0) - (isHot(b) ? 1 : 0));

      const renderLink = (l, i) => {
        const x1 = X(l.fromCol), x2 = X(l.toCol);
        const y1 = Y(l.fromRow);
        const y2 = (l.toRow === null ? totalH : Y(l.toRow));
        const color = PALETTE[l.color % PALETTE.length];
        const span = l.toRow === null ? Infinity : l.toRow - l.fromRow;
        const elided = span > SPAN_ELIDE;
        const hot = isHot(l);
        // 视觉分层：parent 竖线当背景骨架（淡），merge 斜线是信息（细但实）
        const baseOp = l.kind === "parent" ? 0.45 : l.kind === "collapse" ? 0.55 : 0.7;
        const opacity = hoverRow === null ? baseOp : (hot ? 0.95 : baseOp * 0.25);
        const sw = (l.kind === "merge" ? 1.25 : 1.5) + (hot ? 0.5 : 0);
        const key = "l" + i;

        if (elided) {
          const stub = ROW_H * 1.2;
          const midEnd = l.toRow === null ? totalH - 8 : y2 - stub;
          const parts = [
            React.createElement("path", { key: key + "-a", d: "M " + x1 + " " + y1 + " L " + x1 + " " + (y1 + stub), stroke: color, strokeWidth: sw, fill: "none", opacity }),
            React.createElement("path", { key: key + "-m", d: "M " + x1 + " " + (y1 + stub) + " L " + x2 + " " + midEnd, stroke: color, strokeWidth: 1, fill: "none", opacity: opacity * 0.35, strokeDasharray: "2 4" }),
          ];
          if (l.toRow === null) {
            // 父提交在窗口外：底边小倒三角，明示"延伸出去"
            parts.push(React.createElement("path", { key: key + "-z", d: "M " + (x2 - 3.5) + " " + (totalH - 8) + " L " + (x2 + 3.5) + " " + (totalH - 8) + " L " + x2 + " " + (totalH - 2.5) + " Z", fill: color, stroke: "none", opacity }));
          } else {
            parts.push(React.createElement("path", { key: key + "-b", d: "M " + x2 + " " + midEnd + " L " + x2 + " " + y2, stroke: color, strokeWidth: sw, fill: "none", opacity }));
          }
          return parts;
        }
        if (l.kind === "collapse" || l.fromCol === l.toCol) {
          // 同列竖线 / collapse 短横
          return React.createElement("path", { key, d: "M " + x1 + " " + y1 + " L " + x2 + " " + y2, stroke: color, strokeWidth: sw, fill: "none", opacity });
        }
        // 跨列用 cubic bezier
        return React.createElement("path", { key, d: "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + ROW_H) + ", " + x2 + " " + (y2 - ROW_H) + ", " + x2 + " " + y2, stroke: color, strokeWidth: sw, fill: "none", opacity });
      };

      const onRowClick = (c) => {
        if (comparing) { pickCompare(c); return; }
        openDetail(c);
      };

      // 过滤条：「提交 | Reflog」模式切换（契约 §3.4b）；log 过滤器只在提交模式显示
      const filterChildren = [
        React.createElement("button", {
          key: "mode-log",
          className: "gm-mini" + (viewMode === "log" ? " gm-mini-on" : ""),
          onClick: () => setViewMode("log"),
        }, "提交"),
        React.createElement("button", {
          key: "mode-reflog",
          className: "gm-mini" + (viewMode === "reflog" ? " gm-mini-on" : ""),
          onClick: () => setViewMode("reflog"),
        }, "Reflog"),
      ];
      if (viewMode === "log") {
        filterChildren.push(
          React.createElement("select", {
            key: "ref",
            className: "gm-input",
            style: { maxWidth: 150 },
            value: refMode,
            title: "ref 过滤：全部 / 当前分支 / 指定分支或 tag",
            onChange: (e) => setRefMode(e.target.value),
          },
            React.createElement("option", { value: "all" }, "全部（所有分支）"),
            React.createElement("option", { value: "current" }, "当前分支"),
            refOptions.map((n) => React.createElement("option", { key: "ref:" + n, value: "ref:" + n }, n)),
          ),
          React.createElement("input", { key: "file", className: "gm-input", style: { width: 110 }, placeholder: "路径过滤", value: filters.file, onChange: (e) => setFilters((s) => ({ ...s, file: e.target.value })) }),
          React.createElement("input", { key: "author", className: "gm-input", style: { width: 90 }, placeholder: "作者", value: filters.author, onChange: (e) => setFilters((s) => ({ ...s, author: e.target.value })) }),
          React.createElement("input", { key: "grep", className: "gm-input", style: { width: 100 }, placeholder: "grep 信息", value: filters.grep, onChange: (e) => setFilters((s) => ({ ...s, grep: e.target.value })) }),
          React.createElement("input", { key: "since", className: "gm-input", style: { width: 130 }, type: "date", title: "起始日期", value: filters.since, onChange: (e) => setFilters((s) => ({ ...s, since: e.target.value })) }),
          React.createElement("input", { key: "until", className: "gm-input", style: { width: 130 }, type: "date", title: "截止日期", value: filters.until, onChange: (e) => setFilters((s) => ({ ...s, until: e.target.value })) }),
          React.createElement("button", {
            key: "clear",
            className: "gm-mini",
            onClick: () => { setFilters({ file: "", author: "", grep: "", since: "", until: "" }); setRefMode("all"); },
          }, "清除过滤"),
          React.createElement("span", { key: "spacer", style: { flex: 1 } }),
          React.createElement("button", {
            key: "compare",
            className: "gm-mini",
            title: "依次点两个提交（base → head）对比差异",
            onClick: () => (comparing ? exitCompare() : (setComparing(true), setCmpSel([]))),
          }, comparing ? "退出对比" : "对比…"),
          React.createElement("button", {
            key: "undo-move",
            className: "gm-mini",
            title: "git reset --mixed @{1}：撤销上次分支移动（checkout/reset 等），工作区改动保留",
            onClick: () => setConfirming({ kind: "undoMove" }),
          }, "撤销上次分支移动"),
        );
      }
      const filterBar = React.createElement("div", { className: "gm-filterbar" }, filterChildren);

      const compareHint = comparing
        ? React.createElement("div", { className: "gm-notice" },
            cmpSel.length === 0
              ? "对比模式：点击选择 base 提交…"
              : "对比模式：已选 base " + cmpSel[0].short + "，点击选择 head 提交…",
          )
        : null;

      const list = React.createElement("div", { style: { position: "relative", border: "1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" } },
        React.createElement("svg", {
          width, height: totalH,
          style: { position: "absolute", left: 0, top: 0, pointerEvents: "none" },
          "aria-hidden": true,
        },
          orderedLinks.map(renderLink),
          graph.nodes.map((n, i) => React.createElement("circle", {
            key: "n" + i,
            cx: X(n.col),
            cy: Y(i),
            r: NODE_R + (hoverRow === i ? 0.75 : 0),
            fill: PALETTE[n.color % PALETTE.length],
            opacity: hoverRow === null || hoverRow === i ? 1 : 0.35,
          })),
        ),
        commits.map((c, i) => React.createElement("div", {
          key: c.sha,
          className: "gm-file" + ((diffWin && diffWin.sha === c.sha) || (detail && detail.sha === c.sha) || (comparing && cmpSel.some((s) => s.sha === c.sha)) ? " gm-file-active" : ""),
          style: { paddingLeft: width + 8, height: ROW_H, lineHeight: ROW_H + "px", boxSizing: "border-box" },
          title: comparing ? "点击选择对比提交（base → head）" : "点击查看提交详情",
          onClick: () => onRowClick(c),
          onMouseEnter: () => setHoverRow(i),
          onMouseLeave: () => setHoverRow(null),
        },
          React.createElement("span", { style: { flex: "none", fontFamily: "ui-monospace,monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginRight: 8 } }, c.short),
          c.refs ? React.createElement("span", { style: { flex: "none", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, lineHeight: "16px", boxSizing: "border-box", padding: "0 6px", borderRadius: 999, background: "color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-2))", border: "1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)", color: "var(--dsw-alias-brand-primary)", marginRight: 8 } }, c.refs) : null,
          React.createElement("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.subject),
          React.createElement("span", { style: { flex: "none", whiteSpace: "nowrap", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 } }, c.author),
          React.createElement("span", { style: { flex: "none", whiteSpace: "nowrap", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 } }, fmtTime(c.at)),
          React.createElement("button", {
            className: "gm-mini",
            title: "查看该提交的差异",
            onClick: (ev) => { ev.stopPropagation(); openCommitDiff(c); },
          }, "diff"),
        )),
      );

      // Reflog 模式列表（契约 §3.4b：复用提交行样式，无分支线，点行开提交详情）
      const reflogList = React.createElement("div", { style: { border: "1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" } },
        reflog === null
          ? React.createElement("div", { className: "gm-empty" }, "加载 reflog…")
          : reflog.length === 0
            ? React.createElement("div", { className: "gm-empty" }, "reflog 为空。")
            : reflog.map((e, i) => React.createElement("div", {
                key: e.sha + "@" + i,
                className: "gm-file" + (detail && detail.sha === e.sha ? " gm-file-active" : ""),
                title: "点击查看该提交详情",
                onClick: () => openDetail({ sha: e.sha, subject: e.message, author: "", at: e.at }),
              },
                React.createElement("span", { style: { flex: "none", fontFamily: "ui-monospace,monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginRight: 8 } }, e.short),
                React.createElement("span", { className: "gm-meta", style: { flex: "none", fontFamily: "ui-monospace,monospace" } }, e.selector || ""),
                React.createElement("span", { className: "gm-file-path" }, e.message),
                React.createElement("span", { className: "gm-meta" }, fmtTime(e.at)),
              )),
      );

      // 提交详情侧栏
      const detailPane = detail ? React.createElement("div", { className: "gm-hist-detail" },
        React.createElement("div", { className: "gm-section-head", style: { marginBottom: 6 } },
          React.createElement("span", null, "提交详情"),
          React.createElement("span", { style: { flex: 1 } }),
          React.createElement("button", { className: "gm-mini", onClick: () => setDetail(null), title: "关闭详情" }, "×"),
        ),
        React.createElement("div", { className: "gm-meta", style: { fontFamily: "ui-monospace,monospace" } }, detail.sha.slice(0, 12)),
        React.createElement("div", { className: "gm-meta" }, detail.author + " · " + fmtTime(detail.at)),
        React.createElement("div", { className: "gm-detail-msg" }, detail.loading ? "加载提交内容…" : detail.message),
        React.createElement("div", { style: { fontWeight: 500, fontSize: 12, marginBottom: 4 } }, "变更文件 (" + detail.files.length + ")"),
        detail.files.length === 0
          ? React.createElement("div", { className: "gm-meta" }, detail.loading ? "…" : "（无文件变更或为空提交）")
          : detail.files.map((f) => React.createElement("div", {
              key: f.path,
              className: "gm-detail-file",
              title: "点击查看该文件差异",
              onClick: () => openFileDiff(detail, f.path),
            },
              React.createElement("span", { className: "gm-file-kind " + (f.status === "added" ? "gm-file-kind-added" : f.status === "deleted" ? "gm-file-kind-deleted" : f.status === "renamed" || f.status === "copied" ? "gm-file-kind-renamed" : "gm-file-kind-modified") }, f.status),
              React.createElement("span", { className: "gm-file-path" }, f.path),
              React.createElement("button", {
                className: "gm-mini",
                title: "在该提交处逐行追溯（blame）此文件",
                onClick: (ev) => { ev.stopPropagation(); openBlame(f.path, detail.sha); },
              }, "Blame"),
              React.createElement("button", {
                className: "gm-mini",
                title: "该文件的提交历史",
                onClick: (ev) => { ev.stopPropagation(); openFileHist(f.path); },
              }, "历史"),
              React.createElement("span", { className: "gm-detail-count" }, "+" + f.add + " -" + f.del),
            )),
        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 12 } },
          React.createElement("button", { className: "gm-btn", disabled: picking || detail.loading, onClick: () => openCommitDiff({ sha: detail.sha, subject: detail.subject }) }, "查看 diff"),
          React.createElement("button", {
            className: "gm-btn",
            disabled: picking,
            title: "生成一个反向提交（非破坏操作）",
            onClick: () => doRevert(detail.sha),
          }, picking ? "Revert…" : "Revert 此提交"),
          React.createElement("button", {
            className: "gm-btn",
            disabled: picking || detail.loading || !!busyLocal || (detail.parents && detail.parents.length === 0),
            title: (detail.parents && detail.parents.length === 0)
              ? "根提交没有父提交，无法从这里整理历史"
              : "rebase todo：整理该提交（含）到 HEAD 的提交顺序与合并方式（改写历史）",
            onClick: openRebaseDlg,
          }, busyLocal === detail.sha ? "读取 todo…" : "从这里整理历史…"),
          React.createElement("button", {
            className: "gm-btn",
            disabled: picking || !!busyLocal || (detail.parents && detail.parents.length === 0),
            title: "用当前暂存的改动为该提交创建 fixup/squash 提交并 rebase 合入（改写历史）",
            onClick: openFixupDlg,
          }, "用暂存改动修正此提交…"),
          React.createElement("button", {
            className: "gm-btn gm-btn-danger",
            disabled: picking,
            onClick: () => { setResetDlg({ sha: detail.sha, subject: detail.subject }); setResetText(""); setResetMode("mixed"); },
          }, "Reset 当前分支到此提交…"),
        ),
      ) : null;

      return React.createElement(React.Fragment, null,
        filterBar,
        compareHint,
        React.createElement("div", { className: "gm-hist-wrap" },
          React.createElement("div", { className: "gm-hist-main" },
            viewMode === "reflog" ? reflogList : list,
            viewMode === "reflog"
              ? React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 10 } },
                  reflog && reflog.length >= reflogLimit
                    ? React.createElement("button", { className: "gm-btn", onClick: () => setReflogLimit((c) => c + 200) }, "加载更多（已加载 " + reflog.length + "）")
                    : React.createElement("span", { className: "gm-meta" }, "共 " + (reflog ? reflog.length : 0) + " 条 reflog"),
                )
              : React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 10 } },
                  hasMore
                    ? React.createElement("button", { className: "gm-btn", onClick: () => setMaxCount((c) => c + 200) }, "加载更多（已加载 " + commits.length + "）")
                    : React.createElement("span", { className: "gm-meta" }, "共 " + commits.length + " 个提交"),
                ),
          ),
          detailPane,
        ),
        // 只读 diff 窗口（含 Cherry-pick）
        diffWin ? React.createElement(DiffWindow, {
          title: "Commit " + diffWin.sha.slice(0, 12),
          sub: diffWin.subject || "",
          loading: diffWin.loading,
          text: diffWin.text,
          truncated: diffWin.truncated,
          onClose: () => setDiffWin(null),
          onRefresh: () => openCommitDiff({ sha: diffWin.sha, subject: diffWin.subject }),
          actions: React.createElement("button", {
            className: "gm-btn",
            disabled: picking || diffWin.loading,
            title: "把该提交拣选（cherry-pick）到当前分支",
            onClick: () => doCherryPick(diffWin.sha),
          }, picking ? "Cherry-pick…" : "Cherry-pick 到当前分支"),
        }) : null,
        // 范围对比 diff 窗口（stat / patch 切换）
        cmpDiff ? React.createElement(DiffWindow, {
          title: "对比 " + cmpDiff.from.slice(0, 8) + "…" + cmpDiff.to.slice(0, 8),
          sub: (cmpSel[0] ? cmpSel[0].subject : "") + " → " + (cmpSel[1] ? cmpSel[1].subject : ""),
          loading: cmpDiff.loading,
          text: cmpDiff.text,
          truncated: cmpDiff.truncated,
          plain: cmpDiff.kind === "stat",
          onClose: exitCompare,
          onRefresh: () => openCompareDiff(cmpDiff.from, cmpDiff.to, cmpDiff.kind),
          actions: React.createElement(React.Fragment, null,
            React.createElement("button", { className: "gm-btn", disabled: cmpDiff.kind === "stat" || cmpDiff.loading, onClick: () => openCompareDiff(cmpDiff.from, cmpDiff.to, "stat") }, "stat"),
            React.createElement("button", { className: "gm-btn", disabled: cmpDiff.kind === "patch" || cmpDiff.loading, onClick: () => openCompareDiff(cmpDiff.from, cmpDiff.to, "patch") }, "patch"),
            React.createElement("button", { className: "gm-btn", onClick: exitCompare }, "退出对比"),
          ),
        }) : null,
        // 只读 blame 窗口（契约 §3.4b）
        blameWin ? React.createElement(BlameWindow, {
          title: "Blame — " + blameWin.file,
          sub: blameWin.ref || "HEAD",
          loading: blameWin.loading,
          lines: blameWin.lines,
          truncated: blameWin.truncated,
          onClose: () => setBlameWin(null),
          onRefresh: () => openBlame(blameWin.file, blameWin.ref),
        }) : null,
        // 文件级历史（契约 §8.4）
        fileHist ? React.createElement(FileHistoryWindow, {
          file: fileHist.file,
          loading: fileHist.loading,
          entries: fileHist.entries,
          onClose: () => setFileHist(null),
          onRefresh: () => openFileHist(fileHist.file),
          onOpenCommit: (c) => openHistDiff(fileHist.file, c),
        }) : null,
        histDiff ? React.createElement(DiffWindow, {
          title: histDiff.title,
          sub: histDiff.sub,
          loading: histDiff.loading,
          text: histDiff.text,
          truncated: histDiff.truncated,
          onClose: () => setHistDiff(null),
          onRefresh: () => openHistDiff(histDiff.file, histDiff.c),
        }) : null,
        // rebase todo 弹窗（契约 §8.6）→ 提交后接危险级二次确认
        rebaseDlg ? React.createElement(RebaseTodoDialog, {
          entries: rebaseDlg.entries,
          onClose: () => setRebaseDlg(null),
          onSubmit: (items) => {
            const d = rebaseDlg;
            setRebaseDlg(null);
            setConfirming({ kind: "rebaseRun", base: d.base, entries: items });
          },
        }) : null,
        // fixup/squash 弹窗（契约 §8.6）→ 提交后接危险级二次确认
        fixupDlg ? React.createElement(FormDialog, {
          open: true,
          title: "用暂存改动修正 " + fixupDlg.sha.slice(0, 8),
          message: fixupDlg.subject || "",
          submitLabel: "下一步",
          onClose: () => setFixupDlg(null),
          onSubmit: () => {
            const d = fixupDlg;
            const f = fixupForm;
            setFixupDlg(null);
            setConfirming({ kind: "fixupRun", sha: d.sha, mode: f.mode, message: f.message });
          },
          children: React.createElement(React.Fragment, null,
            React.createElement("div", { style: { marginBottom: 10 } },
              React.createElement("label", { className: "gm-radio" },
                React.createElement("input", { type: "radio", name: "gm-fixup-mode", checked: fixupForm.mode === "fixup", onChange: () => setFixupForm((s) => ({ ...s, mode: "fixup" })) }),
                "fixup（并入该提交，沿用其提交信息）",
              ),
              React.createElement("label", { className: "gm-radio" },
                React.createElement("input", { type: "radio", name: "gm-fixup-mode", checked: fixupForm.mode === "squash", onChange: () => setFixupForm((s) => ({ ...s, mode: "squash" })) }),
                "squash（并入该提交，编辑合并信息）",
              ),
            ),
            fixupForm.mode === "squash"
              ? React.createElement("div", { className: "gm-form-row" },
                  React.createElement("span", { className: "gm-form-label" }, "合并信息（可选，留空沿用 git 默认）"),
                  React.createElement("input", { className: "gm-input", value: fixupForm.message, onChange: (e) => setFixupForm((s) => ({ ...s, message: e.target.value })) }),
                )
              : null,
          ),
        }) : null,
        // 危险级二次确认（undo / rebase / fixup）
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "undoMove",
          title: "撤销上次分支移动？",
          message: "将执行 git reset --mixed @{1}：分支指针回退到上一次移动前的位置，工作区改动保留（暂存区会被清空）。\n\n重做提示：git reset --mixed HEAD@{1}（或 git reflog 查看历史）。",
          danger: true,
          confirmLabel: "撤销分支移动",
          onCancel: () => setConfirming(null),
          onConfirm: doUndoMove,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "rebaseRun",
          title: "开始 Rebase？",
          message: "将按整理后的 todo 重放提交，改写当前分支历史（提交 sha 会变化）。\n若已推送远端，之后需要 force push（--force-with-lease）。\n冲突可随时「中止 Rebase」回退（git rebase --abort）。",
          danger: true,
          confirmLabel: "开始 Rebase",
          onCancel: () => setConfirming(null),
          onConfirm: doRebaseRun,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "fixupRun",
          title: "用暂存改动修正该提交？",
          message: "将创建 " + (confirming && confirming.kind === "fixupRun" ? confirming.mode : "fixup") + " 提交并 rebase 合入目标提交——当前分支历史会被改写（提交 sha 会变化）。\n若已推送远端，之后需要 force push（--force-with-lease）。",
          danger: true,
          confirmLabel: "修正并改写历史",
          onCancel: () => setConfirming(null),
          onConfirm: doFixupRun,
        }),
        // reset 弹窗（hard 需输入 RESET 打字确认）
        resetDlg ? React.createElement(FormDialog, {
          open: true,
          title: "Reset 当前分支到 " + resetDlg.sha.slice(0, 8) + "？",
          message: resetDlg.subject || "",
          submitLabel: "Reset",
          danger: resetMode === "hard",
          submitDisabled: resetMode === "hard" && resetText.trim() !== "RESET",
          onClose: () => { setResetDlg(null); setResetText(""); },
          onSubmit: doReset,
          children: React.createElement(React.Fragment, null,
            React.createElement("div", { style: { marginBottom: 10 } },
              React.createElement("label", { className: "gm-radio" },
                React.createElement("input", { type: "radio", name: "gm-reset-mode", checked: resetMode === "soft", onChange: () => setResetMode("soft") }),
                "soft（保留暂存区与工作区）",
              ),
              React.createElement("label", { className: "gm-radio" },
                React.createElement("input", { type: "radio", name: "gm-reset-mode", checked: resetMode === "mixed", onChange: () => setResetMode("mixed") }),
                "mixed（保留工作区，清空暂存区）",
              ),
              React.createElement("label", { className: "gm-radio" },
                React.createElement("input", { type: "radio", name: "gm-reset-mode", checked: resetMode === "hard", onChange: () => setResetMode("hard") }),
                "hard（⚠ 清空暂存区与工作区，不可恢复）",
              ),
            ),
            resetMode === "hard"
              ? React.createElement("div", { className: "gm-form-row" },
                  React.createElement("span", { className: "gm-form-label", style: { color: "var(--dsw-alias-state-error-primary)" } }, "hard 会丢弃所有未提交改动，无法撤销。请输入 RESET 确认："),
                  React.createElement("input", { className: "gm-input", placeholder: "RESET", value: resetText, onChange: (e) => setResetText(e.target.value) }),
                )
              : null,
          ),
        }) : null,
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
      const doAbort = async () => {
        setConfirming(null);
        conflictSource = null;
        await act("mergeAbort", () => remote.mergeAbort({ path: repoPath }));
      };
      // stash 冲突收尾：解决并暂存后删除对应 stash 条目（契约 §3.5）
      const doStashDrop = async () => {
        setConfirming(null);
        await act("stashDrop", () => remote.stashDrop({ path: repoPath, index: stashConflictIndex }));
        conflictSource = null;
        const s = await unwrap(await remote.status({ path: repoPath }));
        if (s.ok && props.onStatus) props.onStatus(s.value);
        if (props.onSwitchTab) props.onSwitchTab("changes");
      };

      if (!status) return React.createElement("div", { className: "gm-empty" }, "加载冲突…");
      if (status.conflicted.length === 0) {
        return React.createElement("div", { className: "gm-empty" }, "当前没有冲突。");
      }
      // 底部按钮分流（契约 §3.5 + §8.6）：来源判断顺序 rebase > merge/cherry/revert > stash。
      // rebase 态（rebase-merge/rebase-apply）→「继续 Rebase / 中止 Rebase」；
      // stash 冲突（仅 unmerged，无 MERGE_HEAD 等状态文件）→「删除 stash 条目 / 中止」；
      // merge / cherry-pick / revert 维持「继续 / 中止」。conflictSource==null 表示冲突
      // 产生于本会话之外（无法区分），两套按钮都给，避免用户卡死。
      const rebaseMode = !!status.rebasing;
      const stashMode = !rebaseMode && conflictSource === "stash";
      const unknownMode = !rebaseMode && conflictSource == null && !status.merging;
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
        rebaseMode
          ? React.createElement("div", {
              className: "gm-banner",
              style: { marginTop: 14, borderRadius: 8, borderBottom: "none" },
            }, "Rebase 进行中：解决冲突并暂存后点「继续 Rebase」；「中止 Rebase」回到 rebase 前的状态。")
          : null,
        (stashMode || unknownMode) && !rebaseMode
          ? React.createElement("div", {
              className: "gm-banner",
              style: { marginTop: 14, borderRadius: 8, borderBottom: "none" },
            }, "stash 应用冲突：解决并暂存后删除 stash 条目，或中止（丢弃未解决的冲突文件改动，stash 保留）")
          : null,
        React.createElement("div", { style: { marginTop: 14, display: "flex", gap: 8 } },
          rebaseMode
            ? React.createElement("button", { className: "gm-btn", onClick: async () => { await act("mergeContinue", () => remote.mergeContinue({ path: repoPath })); } }, "继续 Rebase")
            : (stashMode ? null : React.createElement("button", { className: "gm-btn", onClick: async () => { await act("mergeContinue", () => remote.mergeContinue({ path: repoPath })); } }, "继续（提交解决方案，完成 merge/cherry-pick）")),
          stashMode || unknownMode ? React.createElement("button", { className: "gm-btn gm-btn-danger", onClick: () => setConfirming({ kind: "stashDrop" }) }, "删除 stash 条目") : null,
          React.createElement("button", {
            className: "gm-btn gm-btn-danger",
            onClick: () => setConfirming({ kind: "abortMerge" }),
          }, rebaseMode ? "中止 Rebase" : (stashMode || unknownMode ? "中止" : "中止操作")),
        ),
        // 手动编辑器（Portal 落 body + modalStack，与其余弹层同规范）
        editing ? React.createElement(FormDialog, {
          open: true,
          width: "min(900px,94vw)",
          title: "手动解决 — " + editing.file,
          submitLabel: "保存并标记已解决",
          onClose: () => setEditing(null),
          onSubmit: async () => { await resolveCustom(editing.file, editing.content); setEditing(null); },
          children: React.createElement("textarea", {
            className: "gm-textarea",
            style: { minHeight: 320, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" },
            value: editing.content,
            onChange: (e) => setEditing({ ...editing, content: e.target.value }),
          }),
        }) : null,
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "abortMerge",
          title: "中止当前操作？",
          message: rebaseMode
            ? "进行中的 rebase 会被中止（git rebase --abort），回到 rebase 前的状态（reflog 可查）。"
            : (stashMode || unknownMode
              ? "将丢弃未解决的冲突文件改动，stash 条目保留（不会丢失）。"
              : "进行中的 merge / cherry-pick 会被中止，所有冲突解决作废。"),
          danger: true,
          confirmLabel: "中止",
          onCancel: () => setConfirming(null),
          onConfirm: doAbort,
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "stashDrop",
          title: "删除 stash 条目？",
          message: "确认已解决并暂存冲突后，删除对应 stash 条目（# " + stashConflictIndex + "）？该条目将被永久删除，无法撤销。",
          danger: true,
          confirmLabel: "删除 stash 条目",
          onCancel: () => setConfirming(null),
          onConfirm: doStashDrop,
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
      const [worktrees, setWorktrees] = React.useState(null);
      const [addDlg, setAddDlg] = React.useState(false);
      const [adding, setAdding] = React.useState({ path: "", newBranch: "", startPoint: "" });
      const [confirming, setConfirming] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      const refresh = async () => {
        const r = await unwrap(await remote.worktrees({ path: repoPath }));
        if (r.ok) setWorktrees(r.value.worktrees);
      };

      React.useEffect(() => { refresh(); }, [repoPath]);

      const doAdd = async () => {
        if (!adding.path) return;
        const wtPath = adding.path;
        setNotice(null);
        const payload = { path: repoPath, worktreePath: wtPath };
        if (adding.newBranch) payload.newBranch = adding.newBranch;
        if (adding.startPoint) payload.startPoint = adding.startPoint;
        const v = await act("worktreeAdd", () => remote.worktreeAdd(payload));
        if (v === undefined) return;
        setAddDlg(false);
        setAdding({ path: "", newBranch: "", startPoint: "" });
        refresh();
        // act 失败时返回 undefined；只在添加成功时注册工作区
        if (props.registerWorkspace) {
          const msg = await props.registerWorkspace(wtPath);
          if (msg) setNotice(msg);
        }
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
        notice ? React.createElement("div", { className: "gm-notice" }, notice) : null,
        React.createElement("div", { className: "gm-filegroup" },
          React.createElement("div", { className: "gm-filegroup-head" },
            React.createElement("span", null, "Worktree (" + worktrees.length + ")"),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-btn", onClick: doPrune }, "Prune"),
            React.createElement("button", { className: "gm-btn gm-btn-primary", onClick: () => setAddDlg(true) }, "添加"),
          ),
          worktrees.map((w) => React.createElement("div", { key: w.path, className: "gm-file" },
            React.createElement("span", { className: "gm-file-kind " + (w.current ? "gm-file-kind-added" : (w.bare ? "gm-file-kind-renamed" : "")) }, w.current ? "★" : (w.bare ? "B" : "L")),
            React.createElement("span", { className: "gm-file-path" }, w.path),
            React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, w.bare ? "(bare)" : (w.detached ? "(detached " + (w.headSha || "").slice(0, 7) + ")" : (w.branch || "(?)"))),
            React.createElement("span", { style: { flex: 1 } }),
            w.current ? null : React.createElement("button", { className: "gm-btn gm-btn-danger", onClick: () => setConfirming({ kind: "remove", path: w.path }) }, "删除"),
          )),
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
        // 添加 Worktree 弹窗（路径 + 新分支 + 起点）
        addDlg ? React.createElement(FormDialog, {
          open: true,
          title: "添加 Worktree",
          submitLabel: "添加",
          submitDisabled: !adding.path.trim(),
          onClose: () => setAddDlg(false),
          onSubmit: doAdd,
          children: React.createElement(React.Fragment, null,
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "Worktree 绝对路径"),
              React.createElement("input", { className: "gm-input", placeholder: "如 D:/worktrees/feat-x", value: adding.path, onChange: (e) => setAdding((s) => ({ ...s, path: e.target.value })) }),
            ),
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "新分支名（可选）"),
              React.createElement("input", { className: "gm-input", placeholder: "留空则使用起点的 detached/分支状态", value: adding.newBranch, onChange: (e) => setAdding((s) => ({ ...s, newBranch: e.target.value })) }),
            ),
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "起点（可选，commit-ish / 分支名）"),
              React.createElement("input", { className: "gm-input", placeholder: "默认 HEAD", value: adding.startPoint, onChange: (e) => setAdding((s) => ({ ...s, startPoint: e.target.value })) }),
            ),
          ),
        }) : null,
      );
    }

    // ============================================================================
    // SettingsTab（remote 增删改 + config 读写；Host P2 方法未就位时显示占位）
    // ============================================================================
    function SettingsTab(props) {
      const remote = props.remote;
      const repoPath = props.repoPath;
      const act = props.act;
      const [ready, setReady] = React.useState(null); // null=探测中 / true / false（即将推出）
      const [remotes, setRemotes] = React.useState([]);
      const [entries, setEntries] = React.useState([]);
      const [globalScope, setGlobalScope] = React.useState(false);
      const [confirming, setConfirming] = React.useState(null);
      const [remoteDlg, setRemoteDlg] = React.useState(null); // { mode: "add" | "rename", name, url, pushUrl, oldName }
      const [cfgNew, setCfgNew] = React.useState({ key: "", value: "" });
      const [cfgEdit, setCfgEdit] = React.useState({}); // key → { key, value }（行内编辑暂存）

      // P2 就位探测：Host 未实现 configList/remoteAdd 时 RPC 会报错 → 显示「即将推出」，
      // 绝不在未就位时反复调用未定义方法。
      React.useEffect(() => {
        let alive = true;
        (async () => {
          if (typeof remote.configList !== "function" || typeof remote.remoteAdd !== "function") {
            setReady(false);
            return;
          }
          try {
            const u = await unwrap(await remote.configList({ path: repoPath, global: globalScope }));
            if (!alive) return;
            if (u.ok) {
              setReady(true);
              setEntries((u.value && u.value.entries) || []);
              const r = await unwrap(await remote.remotes({ path: repoPath }));
              if (alive && r.ok) setRemotes(r.value || []);
            } else {
              setReady(false);
            }
          } catch (_) {
            if (alive) setReady(false);
          }
        })();
        return () => { alive = false; };
      }, [repoPath]);

      const loadConfig = async () => {
        const u = await unwrap(await remote.configList({ path: repoPath, global: globalScope }));
        if (u.ok) setEntries((u.value && u.value.entries) || []);
      };
      React.useEffect(() => { if (ready) loadConfig(); }, [globalScope, ready]);

      const doRemoteSubmit = async () => {
        const d = remoteDlg;
        if (!d) return;
        if (d.mode === "add") {
          if (!d.name.trim() || !d.url.trim()) return;
          const req = { path: repoPath, name: d.name.trim(), url: d.url.trim() };
          if (d.pushUrl.trim()) req.pushUrl = d.pushUrl.trim();
          const r = await act("remoteAdd", () => remote.remoteAdd(req));
          if (r && r.remotes) setRemotes(r.remotes);
        } else {
          if (!d.oldName || !d.name.trim() || d.name.trim() === d.oldName) return;
          const r = await act("remoteRename", () => remote.remoteRename({ path: repoPath, oldName: d.oldName, newName: d.name.trim() }));
          if (r && r.remotes) setRemotes(r.remotes);
        }
        setRemoteDlg(null);
      };

      const doCfgSave = async (key) => {
        const edit = cfgEdit[key];
        if (!edit || !edit.key.trim() || !edit.value.trim()) return;
        const req = { path: repoPath, key: edit.key.trim(), value: edit.value };
        if (globalScope) req.global = true;
        const r = await act("configSet", () => remote.configSet(req));
        if (r && r.entries) setEntries(r.entries); else await loadConfig();
        setCfgEdit((s) => { const n = { ...s }; delete n[key]; return n; });
      };
      const doCfgUnset = async (key) => {
        setConfirming(null);
        const req = { path: repoPath, key };
        if (globalScope) req.global = true;
        const r = await act("configUnset", () => remote.configUnset(req));
        if (r && r.entries) setEntries(r.entries); else await loadConfig();
      };
      const doCfgAdd = async () => {
        if (!cfgNew.key.trim() || !cfgNew.value.trim()) return;
        const req = { path: repoPath, key: cfgNew.key.trim(), value: cfgNew.value };
        if (globalScope) req.global = true;
        const r = await act("configSet", () => remote.configSet(req));
        if (r && r.entries) setEntries(r.entries); else await loadConfig();
        setCfgNew({ key: "", value: "" });
      };

      if (ready === null) return React.createElement("div", { className: "gm-empty" }, "加载设置…");

      if (ready === false) {
        return React.createElement("div", { className: "gm-empty" },
          React.createElement("div", { style: { fontWeight: 500, marginBottom: 8 } }, "设置（remote / config 管理）"),
          "即将推出：当前 Host 版本尚未提供 remoteAdd / remoteRemove / remoteRename / configList / configSet / configUnset 方法。",
        );
      }

      return React.createElement(React.Fragment, null,
        // Remote 区
        React.createElement("div", { className: "gm-section", style: { marginTop: 0 } },
          React.createElement("div", { className: "gm-section-head" },
            React.createElement("span", null, "Remote (" + remotes.length + ")"),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("button", { className: "gm-mini", onClick: () => setRemoteDlg({ mode: "add", name: "", url: "", pushUrl: "" }) }, "添加 remote…"),
          ),
          remotes.length === 0
            ? React.createElement("div", { className: "gm-meta", style: { padding: "6px 2px" } }, "暂无 remote。")
            : remotes.map((r) => React.createElement("div", { key: r.name, className: "gm-file", style: { cursor: "default" } },
                React.createElement("span", { className: "gm-file-kind" }, "R"),
                React.createElement("span", { className: "gm-file-path" }, r.name),
                React.createElement("span", { className: "gm-meta", style: { maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.fetchUrl || ""),
                React.createElement("span", { className: "gm-meta", style: { maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.pushUrl && r.pushUrl !== r.fetchUrl ? "push: " + r.pushUrl : ""),
                React.createElement("button", { className: "gm-mini", onClick: () => setRemoteDlg({ mode: "rename", oldName: r.name, name: r.name, url: "", pushUrl: "" }) }, "重命名"),
                React.createElement("button", { className: "gm-mini gm-mini-danger", onClick: () => setConfirming({ kind: "remoteRemove", name: r.name }) }, "删除"),
              )),
        ),
        // Config 区
        React.createElement("div", { className: "gm-section" },
          React.createElement("div", { className: "gm-section-head" },
            React.createElement("span", null, "Config (" + entries.length + ")"),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("label", { className: "gm-checkbox" },
              React.createElement("input", { type: "checkbox", checked: globalScope, onChange: (e) => setGlobalScope(e.target.checked) }),
              "global（取消勾选为 local）",
            ),
          ),
          entries.map((e) => {
            const edit = cfgEdit[e.key] || { key: e.key, value: e.value };
            return React.createElement("div", { key: e.key, className: "gm-cfg-row" },
              React.createElement("input", {
                className: "gm-input",
                style: { maxWidth: 220 },
                value: edit.key,
                onChange: (ev) => setCfgEdit((s) => ({ ...s, [e.key]: { ...edit, key: ev.target.value } })),
              }),
              React.createElement("input", {
                className: "gm-input",
                value: edit.value,
                onChange: (ev) => setCfgEdit((s) => ({ ...s, [e.key]: { ...edit, value: ev.target.value } })),
              }),
              React.createElement("button", { className: "gm-mini", onClick: () => doCfgSave(e.key) }, "保存"),
              React.createElement("button", { className: "gm-mini gm-mini-danger", onClick: () => setConfirming({ kind: "configUnset", key: e.key }) }, "删除"),
            );
          }),
          React.createElement("div", { className: "gm-cfg-row", style: { marginTop: 8 } },
            React.createElement("input", { className: "gm-input", style: { maxWidth: 220 }, placeholder: "key（如 user.name）", value: cfgNew.key, onChange: (e) => setCfgNew((s) => ({ ...s, key: e.target.value })) }),
            React.createElement("input", { className: "gm-input", placeholder: "value", value: cfgNew.value, onChange: (e) => setCfgNew((s) => ({ ...s, value: e.target.value })) }),
            React.createElement("button", { className: "gm-mini", disabled: !cfgNew.key.trim() || !cfgNew.value.trim(), onClick: doCfgAdd }, "添加"),
          ),
        ),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "remoteRemove",
          title: "删除 remote？",
          message: "确认删除 remote \"" + (confirming && confirming.name) + "\"？",
          danger: true,
          confirmLabel: "删除",
          onCancel: () => setConfirming(null),
          onConfirm: async () => {
            const name = confirming && confirming.name;
            setConfirming(null);
            const r = await act("remoteRemove", () => remote.remoteRemove({ path: repoPath, name }));
            if (r && r.remotes) setRemotes(r.remotes);
          },
        }),
        React.createElement(ConfirmDialog, {
          open: !!confirming && confirming.kind === "configUnset",
          title: "删除配置项？",
          message: "确认从 " + (globalScope ? "global" : "local") + " config 删除 \"" + (confirming && confirming.key) + "\"？",
          danger: true,
          confirmLabel: "删除",
          onCancel: () => setConfirming(null),
          onConfirm: () => doCfgUnset(confirming && confirming.key),
        }),
        remoteDlg ? React.createElement(FormDialog, {
          open: true,
          title: remoteDlg.mode === "add" ? "添加 remote" : "重命名 remote",
          submitLabel: remoteDlg.mode === "add" ? "添加" : "重命名",
          submitDisabled: remoteDlg.mode === "add"
            ? (!remoteDlg.name.trim() || !remoteDlg.url.trim())
            : (!remoteDlg.name.trim() || remoteDlg.name.trim() === remoteDlg.oldName),
          onClose: () => setRemoteDlg(null),
          onSubmit: doRemoteSubmit,
          children: React.createElement(React.Fragment, null,
            React.createElement("div", { className: "gm-form-row" },
              React.createElement("span", { className: "gm-form-label" }, "名称"),
              React.createElement("input", { className: "gm-input", placeholder: "如 origin", value: remoteDlg.name, onChange: (e) => setRemoteDlg((s) => ({ ...s, name: e.target.value })) }),
            ),
            remoteDlg.mode === "add" ? React.createElement(React.Fragment, null,
              React.createElement("div", { className: "gm-form-row" },
                React.createElement("span", { className: "gm-form-label" }, "fetch URL"),
                React.createElement("input", { className: "gm-input", placeholder: "https://… 或 git@…", value: remoteDlg.url, onChange: (e) => setRemoteDlg((s) => ({ ...s, url: e.target.value })) }),
              ),
              React.createElement("div", { className: "gm-form-row" },
                React.createElement("span", { className: "gm-form-label" }, "push URL（可选，缺省与 fetch 相同）"),
                React.createElement("input", { className: "gm-input", value: remoteDlg.pushUrl, onChange: (e) => setRemoteDlg((s) => ({ ...s, pushUrl: e.target.value })) }),
              ),
            ) : null,
          ),
        }) : null,
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
      // 客户端 workspaces 服务（核心服务，恒在；create({path}) host 侧按 canonical 路径去重）
      const workspaces = ctx.get("workspaces");

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
      //    Esc 层级（契约 §0）：modalStack 非空时 Esc 只关栈顶弹层（diff 窗口/
      //    确认框/表单弹窗），栈空才关面板。
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "git-manager", order: 150 },
        (props) => {
          const isOpen = useOpen();
          React.useEffect(() => {
            if (!isOpen) return;
            const onKey = (e) => {
              if (e.key === "Escape") {
                if (modalStack.length > 0) {
                  const top = modalStack[modalStack.length - 1];
                  if (top && typeof top.close === "function") top.close();
                  return;
                }
                setOpen(false);
              }
            };
            document.addEventListener("keydown", onKey);
            return () => document.removeEventListener("keydown", onKey);
          }, [isOpen]);
          if (!isOpen) return React.createElement(Toast, null);
          const close = () => setOpen(false);
          return React.createElement(React.Fragment, null,
            React.createElement(Toast, null),
            ReactDOM.createPortal(
              React.createElement("div", { className: "gm-overlay", role: "presentation" },
                React.createElement("div", { className: "gm-mask", "aria-hidden": true, onClick: close }),
                React.createElement(GitPanel, { slotProps: props, remote, workspaces, onClose: close }),
              ),
              document.body,
            ),
          );
        },
      ));
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
