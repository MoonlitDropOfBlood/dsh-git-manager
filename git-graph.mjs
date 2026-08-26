// git-graph.mjs — dsh-git-manager 分支线布局算法
//
// 纯函数 computeGraph(commits)：输入 git log --all --date-order 顺序的提交列表，
// 输出 { nodes, links, laneCount }，Client 据此渲染 SVG 分支线图形。
//
// 节点：nodes[i] = { col, color } —— commits[i] 在第 col 列、颜色索引。
// 连线：links[] = { fromRow, fromCol, toRow, toCol, color, kind }
//   kind ∈ "parent" | "merge" | "collapse"
//   toRow=null 表示父提交不在当前窗口（Client 画到 SVG 底部）
//
// 不变量：--date-order 保证父提交晚于子提交出现，toRow > fromRow 恒成立。

export function computeGraph(commits) {
  const lanes = []; // lanes[i] = { sha, color } | null
  const rowOf = new Map();
  commits.forEach((c, i) => rowOf.set(c.sha, i));
  const nodes = [];
  const links = [];
  let colorSeq = 0;
  let peak = 0;

  const alloc = (sha, color) => {
    let i = lanes.findIndex((l) => l === null);
    if (i < 0) { i = lanes.length; lanes.push(null); }
    lanes[i] = { sha, color: color ?? (colorSeq++ % 12) };
    if (lanes.length > peak) peak = lanes.length;
    return i;
  };

  commits.forEach((c, row) => {
    let col = lanes.findIndex((l) => l && l.sha === c.sha);
    if (col < 0) col = alloc(c.sha);
    const color = lanes[col].color;

    // 其他也在等这个 sha 的列并入本列（合并的另一侧）
    for (let i = 0; i < lanes.length; i++) {
      if (i !== col && lanes[i] && lanes[i].sha === c.sha) {
        links.push({
          fromRow: row, fromCol: col, toRow: row, toCol: i,
          color: lanes[i].color, kind: "collapse",
        });
        lanes[i] = null;
      }
    }

    nodes.push({ col, color });

    const ps = Array.isArray(c.parents) ? c.parents : [];
    if (ps.length === 0) {
      lanes[col] = null;
    } else {
      const first = ps[0];
      lanes[col] = { sha: first, color };
      links.push({
        fromRow: row, fromCol: col,
        toRow: rowOf.has(first) ? rowOf.get(first) : null,
        toCol: col, color, kind: "parent",
      });
      for (const p of ps.slice(1)) {
        let pc = lanes.findIndex((l) => l && l.sha === p);
        if (pc < 0) pc = alloc(p);
        links.push({
          fromRow: row, fromCol: col,
          toRow: rowOf.has(p) ? rowOf.get(p) : null,
          toCol: pc, color: lanes[pc].color, kind: "merge",
        });
      }
    }
    // 注意：不在循环里裁剪尾部空列——会破坏 alloc 的左偏重用 + 让 laneCount 错算。
    // SVG 渲染宽度需要的是 peak（峰值同时活动列数），下面统一报告。
  });

  // 收尾裁剪只在"全部 commit 处理完"之后进行，仅影响 laneCount 报告（不保留释放的列即可）。
  while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

  return { nodes, links, laneCount: peak };
}