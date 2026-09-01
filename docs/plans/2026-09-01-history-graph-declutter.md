# 历史分支线"乱"的治理方案（design）

日期：2026-09-01
状态：设计待评审
范围：`git-graph.mjs`（布局算法）、`client.js` HistoryTab（SVG 渲染）；一期纯客户端，不动 Host wire。

## 1. 问题拆解：为什么会乱

现状管线：Host `computeGraph(commits)`（左偏空闲列复用，输出 nodes/links/laneCount）
→ Client 固定 ROW_H=32、COL_W 自适应、同列竖线 / 跨列 cubic bezier、`toRow=null`
画到 SVG 底部。

分支多 + 合并多 + 跨度大时，乱来自四个结构性因素：

1. **长跨度边（span 几十上百行）**：`--date-order` 下，一个分支从创建到合并中间隔着
   大量无关提交，它的 parent/merge 边就是一根纵贯全屏的长线/长斜线——这是最刺眼的乱源。
2. **跨列 merge 斜线穿插**：bezier 从子节点斜插到右侧目标列，途中穿过若干车道竖线，
   形成"毛线团"观感。
3. **无视觉层级**：所有边同粗（1.5px）同透明度（0.7），主干和短命分支一视同仁，
   眼睛没有锚点。
4. **颜色复用**：12 色调色板循环，>12 车道时相邻车道可能撞色，加重混淆。

注意：车道列复用（alloc 左偏）本身不是乱源——它保证列数紧凑；乱的是"边"的渲染方式。

## 2. 候选方案对比

| 方案 | 针对 | 成本 | 收益 | 风险 |
|---|---|---|---|---|
| A. 长边省略/淡化 | 乱源 ①④ | 低（纯客户端） | 高 | 连通性变弱（靠 stub+虚线保留线索） |
| B. 悬停聚焦高亮 | 全部 | 低（纯客户端） | 高 | 无（不删信息，只加对比） |
| C. merge 边绕道路由 | 乱源 ② | 高（改布局算法） | 中 | 布局回归风险大 |
| D. 「只看主线」first-parent 模式 | 乱源 ①②③ | 中（Host log 加参 + wire schema + UI 开关） | 高（merge 重仓库立竿见影） | 低，但是"另一种视图"而非修复 |
| E. 车道数硬上限+折叠 | 乱源 ① | 中 | 中 | 丢连通性信息 |
| F. 视觉分层降噪（粗细/透明度/虚线） | 乱源 ③ | 极低 | 中 | 无 |
| G. 主干固定第 0 列 | 乱源 ③ | 中（改 computeGraph） | 中 | 需识别主干（当前分支 tip），启发式 |

**推荐组合**：

- **一期（纯 client.js，零 Host 变更）**：A + B + F。三者叠加正好互补——
  F 让默认视图安静下来，A 把最长的刺头边压下去，B 给"我想看清这一条线"提供按需放大。
- **二期（可选）**：D「只看主线」开关。merge 密集的仓库一键回到干净主干。
- 明确不做：C（路由绕行）——收益不确定、回归风险高，A 已覆盖其最严重情形；
  E（硬折叠）——丢信息，不如 A 的软省略。

## 3. 一期详细设计

### 3.1 A：长边省略渲染

阈值 `SPAN_ELIDE = 24`（行）。对每条 link 算 `span = toRow - fromRow`：

- `span ≤ 24`：保持现状渲染（同列竖线 / 跨列 bezier）。
- `span > 24` 或 `toRow === null`（父在窗口外）：改为三段式——
  - 上 stub：从子节点垂直向下 1.2×ROW_H，实线、正常透明度；
  - 中段：从上 stub 末端到下 stub 起点的直虚线（`stroke-dasharray:2 4`，
    透明度降到 0.22），跨列时直接连斜虚线，保留方向感；
  - 下 stub：接入父节点（或 SVG 底边）的 1.2×ROW_H 实线。
  - `toRow === null` 没有下端点：下 stub 换成底边小倒三角 `▾`（path 画 4px 三角），
    明示"延伸到窗口外"。

纯客户端即可实现：`links[]` 里本来就有 `fromRow/toRow`，span 在渲染时现算，
**不需要动 computeGraph，零 Host/wire 变更**。

### 3.2 B：悬停聚焦

- HistoryTab 加 `hoverRow` state；提交行 `onMouseEnter/Leave` 设置
  （SVG 保持 `pointerEvents:none`，命中检测走行 div，零成本）。
- 边与悬停行的相关性判定：
  - 直接相连：`fromRow === hoverRow || toRow === hoverRow`；
  - 同车道经过：`fromCol === hoverCol && fromRow < hoverRow && (toRow === null || toRow > hoverRow)`。
- 渲染：不相关边 `opacity × 0.2`；相关边 `opacity = 0.95` 且 `strokeWidth +0.5`。
  节点圆同步：非相关行节点 `opacity 0.35`。
- 鼠标移出列表恢复默认。

### 3.3 F：视觉分层

- parent 竖线：opacity 0.7 → 0.45（它是背景骨架）；
- merge bezier：保持 0.7 但 `strokeWidth 1.5 → 1.25`（斜线是信息，竖线是基底）；
- collapse 短横：opacity 0.5；
- 节点圆不变（视觉锚点要最实）。
- 调色板不动（写死 12 色是既有约定；>12 车道时相邻撞色由 B 的聚焦兜底）。

### 3.4 渲染顺序

现在一遍按 links 数组顺序画。改为三趟：先画省略淡化边（最底层）→ 普通边 →
悬停相关边（最上层），最后画节点。避免淡化边盖住高亮边。

## 4. 二期（可选）：「只看主线」

- Host：`getLog(cwd, opts)` 支持 `firstParent: true` → `git log` 加 `--first-parent`；
  typert 的 log request schema 是 passthrough（`z.object({}).passthrough()`），
  **wire 无需改**；computeGraph 输入自然只剩主线链 + 合并点，输出近直线。
- Client：工具行加 checkbox「只看主线」，state 进 `refresh()` 依赖数组。
- 与「所有分支」复选框互斥提示即可。

## 5. 验证

- `npm run check` + `npm test`：computeGraph 未动，现有 graph 单测/静态守卫不受影响。
- 视觉验证：`scripts/cdp-e2e.mjs`（已有）连 headless Edge 截图历史 Tab，
  对比 24+ 车道、长跨度 merge 的仓库前后效果。
- 手测清单：悬停某提交 → 其祖先/后代边高亮；长跨度边三段式渲染；
  `toRow=null` 边底部有 ▾；Esc/关窗行为不回归。

## 6. 实施步骤（一期）

1. `client.js` HistoryTab：hoverRow state + 相关性判定 + 三趟渲染 + 分层样式。
2. 三段式长边渲染（含 ▾ 标记）。
3. 检查 + 自测 + CDP 截图复核。
4. AGENTS.md 同步渲染分层约定。
