#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";

const ENTRY = "src/http/routes.ts";
const MAX_WIDTH = 830;
const MARGIN = 24;

const [dir = ".pr-diagram", outDir = join(dir, "assets")] = process.argv.slice(2);

const fail = (message) => {
  console.error(`render-svg: ${message}`);
  process.exit(1);
};

const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const graph = read("graph.json");
const facts = read("facts.json");

const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));

for (const node of graph.nodes) {
  const fact = facts.nodes[node.id];
  if (fact === undefined || fact.delta !== node.delta) fail(`node ${node.id} is not in facts.json with delta ${node.delta}`);
}
for (const edge of graph.edges) {
  const fact = facts.edges[edge.id];
  if (fact === undefined || fact.delta !== edge.delta) fail(`edge ${edge.id} is not in facts.json with delta ${edge.delta}`);
  if (facts.nodes[edge.from]?.path !== fact.from || facts.nodes[edge.to]?.path !== fact.to)
    fail(`edge ${edge.id} joins other files in facts.json than in graph.json`);
}

const views = graph.views.filter((view) => view.lens === "architecture");
const nodeIds = new Set(views.flatMap((view) => view.scope.nodes));
const edgeIds = new Set(views.flatMap((view) => view.scope.edges));
for (const id of nodeIds) if (!nodeById.has(id)) fail(`view node ${id} is not in graph.json`);
for (const id of edgeIds) if (!edgeById.has(id)) fail(`view edge ${id} is not in graph.json`);
const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
const edges = graph.edges.filter((edge) => edgeIds.has(edge.id));
const lanes = graph.lanes.filter((lane) => nodes.some((node) => node.lane === lane.id));

const SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

const EM = { sans: 0.58, mono: 0.62 };
const textWidth = (text, size, family, tracking = 0) => [...text].length * size * (EM[family] + tracking);
const ceilTo = (value, step) => Math.ceil(value / step) * step;

const TAG = { added: "NEW", modified: "CHANGED", removed: "REMOVED", unchanged: "UNCHANGED" };

const NODE = { label: 15, pill: 10.5, pillTracking: 0.06, stat: 12, padX: 14, height: 62 };
const EDGE_LABEL = { size: 12, lineHeight: 15 };
const LANE = { label: 12, tracking: 0.06, padTop: 40, padSide: 16, padBottom: 16 };

const laneLabelWidth = (lane) => ceilTo(textWidth(lane.label.toUpperCase(), LANE.label, "mono", LANE.tracking), 2);
const pillWidth = (tag) => ceilTo(textWidth(tag, NODE.pill, "mono", NODE.pillTracking) + 16, 2);
const statText = (node) => node.badges.find((badge) => /^\+\d+ −\d+$/.test(badge));

const nodeWidth = (node) => {
  const label = textWidth(node.label, NODE.label, "mono");
  const stat = statText(node);
  const second = pillWidth(TAG[node.delta]) + (stat ? 10 + textWidth(stat, NODE.stat, "mono") : 0);
  return ceilTo(Math.max(label, second) + 2 * NODE.padX, 10);
};

const lineOf = (site) => Number(/:(\d+)$/.exec(site)?.[1] ?? Infinity);
const importsOf = (edge) => {
  const fact = facts.edges[edge.id];
  return (fact.head ?? fact.base).imports;
};
const edgeLabel = (edge) => {
  const names = importsOf(edge);
  if (names.length === 0) return "side effect";
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
};
const edgeLabelWidth = (text) => ceilTo(textWidth(text, EDGE_LABEL.size, "mono"), 2) + 4;

// ELK applies a compound node's minimum size before it rotates a DOWN layout, so width and height swap.
const minimumSize = (direction, width, height) => (direction === "DOWN" ? `(${height}, ${width})` : `(${width}, ${height})`);

const elkGraph = (direction, widened) => ({
  id: "root",
  layoutOptions: {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.edgeLabels.placement": "CENTER",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.spacing.nodeNodeBetweenLayers": "36",
    "elk.layered.spacing.edgeNodeBetweenLayers": "18",
    "elk.spacing.nodeNode": "40",
    "elk.spacing.edgeNode": "20",
    "elk.spacing.edgeEdge": "14",
    "elk.spacing.edgeLabel": "6",
    "elk.spacing.labelNode": "8",
    "elk.json.edgeCoords": "ROOT",
    "elk.json.shapeCoords": "ROOT",
    "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  },
  children: lanes.map((lane) => ({
    id: `lane:${lane.id}`,
    layoutOptions: {
      "elk.padding": `[top=${LANE.padTop},left=${LANE.padSide},bottom=${LANE.padBottom},right=${LANE.padSide}]`,
      ...(widened.has(lane.id) && {
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": minimumSize(direction, ceilTo(2 * (laneLabelWidth(lane) + LANE.padSide + 12), 10), 60),
      }),
    },
    children: nodes
      .filter((node) => node.lane === lane.id)
      .map((node) => ({ id: node.id, width: nodeWidth(node), height: NODE.height })),
  })),
  edges: edges.map((edge) => {
    const text = edgeLabel(edge);
    return {
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
      labels: [{ id: `${edge.id}:label`, text, width: edgeLabelWidth(text), height: EDGE_LABEL.lineHeight }],
    };
  }),
});

const flatten = (node, into = new Map()) => {
  into.set(node.id, node);
  for (const child of node.children ?? []) flatten(child, into);
  return into;
};

const sectionPoints = (placedEdge) => {
  const section = placedEdge.sections[0];
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
};

const blockedBetween = ({ placed, placedEdges }, top, bottom) => {
  const blocks = [];
  const crosses = (y0, y1) => y1 > top && y0 < bottom;
  for (const edge of edges) {
    const points = sectionPoints(placedEdges.get(edge.id));
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      if (crosses(Math.min(a.y, b.y) - 1, Math.max(a.y, b.y) + 1)) blocks.push([Math.min(a.x, b.x) - 12, Math.max(a.x, b.x) + 12]);
    }
    const label = placedEdges.get(edge.id).labels?.[0];
    if (label && crosses(label.y, label.y + label.height)) blocks.push([label.x - 8, label.x + label.width + 8]);
  }
  for (const node of nodes) {
    const box = placed.get(node.id);
    if (crosses(box.y - 4, box.y + box.height + 4)) blocks.push([box.x - 8, box.x + box.width + 8]);
  }
  return blocks;
};

const freeSlot = (layout, top, bottom, min, max, width, preferred) => {
  const blocks = blockedBetween(layout, top, bottom);
  const free = (x) => x >= min - 0.01 && x + width <= max + 0.01 && blocks.every(([start, end]) => x + width <= start || x >= end);
  const candidates = [preferred, min, max - width, ...blocks.map(([, end]) => end), ...blocks.map(([start]) => start - width)];
  const fits = candidates.filter(free).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
  return fits[0] ?? null;
};

const zoneLabelSpot = (layout, lane, onBorder) => {
  const box = layout.placed.get(`lane:${lane.id}`);
  const width = laneLabelWidth(lane) + (onBorder ? 12 : 0);
  const bands = onBorder
    ? [box.y, box.y + box.height].map((y) => ({ top: y - 9, bottom: y + 9, baseline: y + 4 }))
    : [
        { top: box.y + 10, bottom: box.y + 30, baseline: box.y + 24 },
        { top: box.y + box.height - 28, bottom: box.y + box.height - 8, baseline: box.y + box.height - 14 },
      ];
  const preferred = onBorder ? box.x + (box.width - width) / 2 : box.x + LANE.padSide;
  for (const [index, band] of bands.entries()) {
    const x = freeSlot(layout, band.top, band.bottom, box.x + 12, box.x + box.width - 12, width, preferred);
    if (x !== null) return { x, width, ...band, band: index, masked: onBorder };
  }
  return { x: preferred, width, ...bands[0], band: -1, masked: true };
};

const elk = new ELK();
const arrange = async (direction) => {
  const run = async (widened) => {
    const result = await elk.layout(elkGraph(direction, widened));
    return { direction, result, placed: flatten(result), placedEdges: new Map(result.edges.map((edge) => [edge.id, edge])) };
  };
  const tight = await run(new Set());
  const crowded = lanes.filter((lane) => [false, true].some((onBorder) => zoneLabelSpot(tight, lane, onBorder).band !== 0));
  return crowded.length === 0 ? tight : run(new Set(crowded.map((lane) => lane.id)));
};

let chosen = await arrange("RIGHT");
if (chosen.result.width + 2 * MARGIN > MAX_WIDTH) {
  const down = await arrange("DOWN");
  console.log(`render-svg: RIGHT is ${Math.round(chosen.result.width + 2 * MARGIN)} px wide, using DOWN (${Math.round(down.result.width + 2 * MARGIN)} px)`);
  chosen = down;
}
const { result, direction, placed, placedEdges } = chosen;
if (result.width + 2 * MARGIN > MAX_WIDTH)
  console.warn(`render-svg: the ${direction} layout is ${Math.round(result.width + 2 * MARGIN)} px wide, over ${MAX_WIDTH} px; GitHub will scale it down`);

const touchesChange = (edge) => [edge.from, edge.to].some((id) => nodeById.get(id).delta !== "unchanged");

const walkOrder = (() => {
  const adjacency = new Map();
  for (const edge of edges) {
    const fact = facts.edges[edge.id];
    const list = adjacency.get(edge.from) ?? [];
    list.push({ edge, head: fact.head !== undefined, line: lineOf((fact.head ?? fact.base).sites[0]) });
    adjacency.set(edge.from, list);
  }
  for (const list of adjacency.values()) list.sort((a, b) => Number(b.head) - Number(a.head) || a.line - b.line);
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    seen.add(id);
    for (const { edge } of adjacency.get(id) ?? []) {
      order.push(edge);
      if (!seen.has(edge.to)) visit(edge.to);
    }
  };
  const entry = nodes.find((node) => facts.nodes[node.id].path === ENTRY);
  if (entry) visit(entry.id);
  return [...order, ...edges.filter((edge) => !order.includes(edge))];
})();

const THEMES = {
  light: {
    canvas: "#FFFFFF",
    title: { fill: "#171717", family: "sans", size: 17, weight: 600 },
    subtitle: "#737373",
    zone: { fill: "url(#hatch)", stroke: "#E5E5E5", dash: null, rx: 12, label: "#171717", labelOnBorder: false },
    hatch: ["#FFFFFF", "#F2F2F2"],
    node: { fill: "#FFFFFF", contextFill: "#FAFAFA", contextStroke: "#E5E5E5", rx: 10, label: "#171717", contextLabel: "#525252", family: "sans", weight: 500 },
    edge: { width: 1.75, context: "#A3A3A3", open: false, radius: 8 },
    edgeLabel: { fill: "#737373", family: "sans" },
    state: { added: "#0D9488", modified: "#B45309", removed: "#E11D48", unchanged: "#737373" },
    stateText: { added: "#0F766E", modified: "#B45309", removed: "#BE123C", unchanged: "#737373" },
    plus: "#0F766E",
    minus: "#BE123C",
    legend: "#737373",
  },
  dark: {
    canvas: "#000000",
    title: { fill: "#FFFFFF", family: "mono", size: 16, weight: 700 },
    subtitle: "#8A8A8A",
    zone: { fill: "none", stroke: "#4D4D4D", dash: "4 4", rx: 0, label: "#8A8A8A", labelOnBorder: true },
    hatch: null,
    node: { fill: "#000000", contextFill: "#0D0D0D", contextStroke: "#4D4D4D", rx: 0, label: "#FFFFFF", contextLabel: "#B3B3B3", family: "mono", weight: 400 },
    edge: { width: 1.5, context: "#5E5E5E", open: true, radius: 0 },
    edgeLabel: { fill: "#8A8A8A", family: "mono" },
    state: { added: "#2DD4BF", modified: "#F6821F", removed: "#FB7185", unchanged: "#8A8A8A" },
    stateText: { added: "#2DD4BF", modified: "#F6821F", removed: "#FB7185", unchanged: "#8A8A8A" },
    plus: "#2DD4BF",
    minus: "#FB7185",
    legend: "#8A8A8A",
  },
};

const esc = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (value) => String(Math.round(value * 100) / 100);

const pathData = (points, radius) => {
  let d = `M${num(points[0].x)} ${num(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    if (r < 0.5) {
      d += ` L${num(b.x)} ${num(b.y)}`;
      continue;
    }
    const toward = (from, to) => {
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      return { x: from.x + ((to.x - from.x) / length) * r, y: from.y + ((to.y - from.y) / length) * r };
    };
    const p1 = toward(b, a);
    const p2 = toward(b, c);
    d += ` L${num(p1.x)} ${num(p1.y)} Q${num(b.x)} ${num(b.y)} ${num(p2.x)} ${num(p2.y)}`;
  }
  const last = points.at(-1);
  return `${d} L${num(last.x)} ${num(last.y)}`;
};

const polylineLength = (points) =>
  points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);

const wrap = (text, maxWidth, size, family) => {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && textWidth(next, size, family) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
};

const counts = ["added", "modified", "removed", "unchanged"]
  .map((delta) => [delta, nodes.filter((node) => node.delta === delta).length])
  .filter(([, count]) => count > 0)
  .map(([delta, count]) => `${count} ${{ added: "new", modified: "changed", removed: "removed", unchanged: "unchanged" }[delta]}`)
  .join(" · ");
const subtitle = `Import graph of the change: ${counts} file${nodes.length === 1 ? "" : "s"}`;

const animated = walkOrder.filter(touchesChange);
const SPEED = 220;
const timing = (() => {
  let at = 0.3;
  const slots = new Map();
  for (const edge of animated) {
    const points = sectionPoints(placedEdges.get(edge.id));
    const travel = Math.min(1, Math.max(0.5, polylineLength(points) / SPEED));
    slots.set(edge.id, { start: at, travel });
    at += travel;
  }
  return { slots, cycle: at + 1 };
})();

const render = (themeName) => {
  const theme = THEMES[themeName];
  const fontOf = (family) => (family === "mono" ? MONO : SANS);
  const titleFont = theme.title;

  const graphWidth = result.width;
  const titleMax = Math.min(MAX_WIDTH, Math.max(graphWidth, 520) + 2 * MARGIN) - 2 * MARGIN;
  const titleLines = wrap(graph.title, titleMax, titleFont.size, titleFont.family);
  const titleWidth = Math.max(...titleLines.map((line) => textWidth(line, titleFont.size, titleFont.family)));
  const textBlock = Math.min(MAX_WIDTH, Math.max(titleWidth, textWidth(subtitle, 12, "mono")) + 2 * MARGIN);
  const width = Math.ceil(Math.max(graphWidth + 2 * MARGIN, textBlock));
  const offsetX = Math.round((width - graphWidth) / 2);
  const titleTop = MARGIN + titleFont.size;
  const subtitleY = titleTop + (titleLines.length - 1) * 22 + 22;
  const offsetY = subtitleY + 24;

  const legendItems = [
    { kind: "arrow", text: "A imports B, labelled with the imported names" },
    { kind: "dashed", text: "import removed" },
    { kind: "dot", text: `moving dot: imports that touch a changed file, in walk order from ${ENTRY.split("/").at(-1)}` },
  ];
  const legendRows = [];
  {
    let row = [];
    let x = 0;
    for (const item of legendItems) {
      const itemWidth = 30 + textWidth(item.text, 11, "mono");
      if (row.length > 0 && x + itemWidth > width - 2 * MARGIN) {
        legendRows.push(row);
        row = [];
        x = 0;
      }
      row.push({ ...item, x });
      x += itemWidth + 22;
    }
    legendRows.push(row);
  }
  const legendTop = offsetY + result.height + 36;
  const height = Math.ceil(legendTop + legendRows.length * 18 + MARGIN - 6);

  const out = [];
  const push = (line) => out.push(line);
  push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(SANS)}" role="img" aria-labelledby="title desc">`);
  push(`<title id="title">${esc(graph.title)}</title>`);
  push(`<desc id="desc">${esc(`${subtitle}. Each box is a file, each arrow an import statement labelled with the imported names.`)}</desc>`);
  push("<defs>");
  if (theme.hatch)
    push(`<pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="${theme.hatch[0]}"/><rect width="4" height="8" fill="${theme.hatch[1]}"/></pattern>`);
  const markerColors = new Map();
  const markerFor = (color) => {
    if (!markerColors.has(color)) markerColors.set(color, `arw${markerColors.size}`);
    return markerColors.get(color);
  };
  for (const edge of edges) markerFor(edge.delta === "unchanged" ? theme.edge.context : theme.state[edge.delta]);
  markerFor(theme.legend);
  for (const [color, id] of markerColors)
    push(
      theme.edge.open
        ? `<marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>`
        : `<marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="${color}"/></marker>`,
    );
  push("</defs>");
  push(`<rect width="${width}" height="${height}" fill="${theme.canvas}"/>`);

  titleLines.forEach((line, index) =>
    push(`<text x="${MARGIN}" y="${titleTop + index * 22}" font-family="${esc(fontOf(titleFont.family))}" font-size="${titleFont.size}" font-weight="${titleFont.weight}" fill="${titleFont.fill}" letter-spacing="0.02em">${esc(line)}</text>`),
  );
  push(`<text x="${MARGIN}" y="${subtitleY}" font-family="${esc(MONO)}" font-size="12" fill="${theme.subtitle}">${esc(subtitle)}</text>`);

  push(`<g transform="translate(${offsetX} ${offsetY})">`);

  for (const lane of lanes) {
    const box = placed.get(`lane:${lane.id}`);
    push(`<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${theme.zone.rx}" fill="${theme.zone.fill}" stroke="${theme.zone.stroke}" stroke-width="1.5"${theme.zone.dash ? ` stroke-dasharray="${theme.zone.dash}"` : ""}/>`);
  }

  const edgeColor = (edge) => (edge.delta === "unchanged" ? theme.edge.context : theme.state[edge.delta]);
  for (const edge of edges) {
    const points = sectionPoints(placedEdges.get(edge.id));
    const color = edgeColor(edge);
    push(`<path d="${pathData(points, theme.edge.radius)}" fill="none" stroke="${color}" stroke-width="${theme.edge.width}"${edge.delta === "removed" ? ' stroke-dasharray="6 5"' : ""} marker-end="url(#${markerFor(color)})"/>`);
  }

  for (const edge of edges) {
    const label = placedEdges.get(edge.id).labels?.[0];
    if (!label) continue;
    push(`<text x="${num(label.x + label.width / 2)}" y="${num(label.y + label.height - 3)}" text-anchor="middle" font-family="${esc(fontOf(theme.edgeLabel.family))}" font-size="${EDGE_LABEL.size}" fill="${edge.delta === "unchanged" ? theme.edgeLabel.fill : theme.stateText[edge.delta]}">${esc(label.text)}</text>`);
  }

  for (const lane of lanes) {
    const spot = zoneLabelSpot(chosen, lane, theme.zone.labelOnBorder);
    const inset = theme.zone.labelOnBorder ? 6 : 0;
    if (spot.masked)
      push(`<rect x="${num(spot.x - (inset ? 0 : 4))}" y="${num(spot.top)}" width="${num(spot.width + (inset ? 0 : 8))}" height="${num(spot.bottom - spot.top)}" rx="${inset ? 0 : 4}" fill="${theme.canvas}"/>`);
    push(`<text x="${num(spot.x + inset)}" y="${num(spot.baseline)}" font-family="${esc(MONO)}" font-size="${LANE.label}" font-weight="500" letter-spacing="${LANE.tracking}em" fill="${theme.zone.label}">${esc(lane.label.toUpperCase())}</text>`);
  }

  for (const node of nodes) {
    const box = placed.get(node.id);
    const color = theme.state[node.delta];
    const context = node.delta === "unchanged";
    const stroke = context ? theme.node.contextStroke : color;
    const fill = context ? theme.node.contextFill : theme.node.fill;
    push(`<g>`);
    push(`<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${theme.node.rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${node.delta === "removed" ? ' stroke-dasharray="5 4"' : ""}/>`);
    push(`<text x="${num(box.x + NODE.padX)}" y="${num(box.y + 25)}" font-family="${esc(fontOf(theme.node.family))}" font-size="${NODE.label}" font-weight="${theme.node.weight}" fill="${context ? theme.node.contextLabel : theme.node.label}"${node.delta === "removed" ? ' text-decoration="line-through"' : ""}>${esc(node.label)}</text>`);
    const tag = TAG[node.delta];
    const pw = pillWidth(tag);
    const py = box.y + 35;
    push(`<rect x="${num(box.x + NODE.padX)}" y="${num(py)}" width="${pw}" height="17" rx="8.5" fill="${theme.canvas}" stroke="${color}" stroke-width="1.25"/>`);
    push(`<text x="${num(box.x + NODE.padX + pw / 2)}" y="${num(py + 12)}" text-anchor="middle" font-family="${esc(MONO)}" font-size="${NODE.pill}" font-weight="500" letter-spacing="${NODE.pillTracking}em" fill="${theme.stateText[node.delta]}">${esc(tag)}</text>`);
    const stat = statText(node);
    if (stat) {
      const [plus, minus] = stat.split(" ");
      const tint = (count, color) => (/[1-9]/.test(count) ? color : theme.legend);
      push(`<text x="${num(box.x + NODE.padX + pw + 10)}" y="${num(py + 12.5)}" font-family="${esc(MONO)}" font-size="${NODE.stat}"><tspan fill="${tint(plus, theme.plus)}">${esc(plus)}</tspan><tspan dx="7" fill="${tint(minus, theme.minus)}">${esc(minus)}</tspan></text>`);
    }
    push(`</g>`);
  }

  for (const edge of animated) {
    const points = sectionPoints(placedEdges.get(edge.id));
    const { start, travel } = timing.slots.get(edge.id);
    const T = timing.cycle;
    const t0 = start / T;
    const t1 = (start + travel) / T;
    const fade = 0.12 / T;
    const d = pathData(points, theme.edge.radius);
    const keyTimes = [0, t0, t0 + fade, t1 - fade, t1, 1].map((value) => num(Math.round(value * 10000) / 10000)).join(";");
    push(`<circle r="4" fill="${edgeColor(edge)}" stroke="${theme.canvas}" stroke-width="1.5" opacity="0">`);
    push(`<animateMotion dur="${num(T)}s" repeatCount="indefinite" calcMode="linear" keyPoints="0;0;1;1" keyTimes="0;${num(Math.round(t0 * 10000) / 10000)};${num(Math.round(t1 * 10000) / 10000)};1" path="${d}"/>`);
    push(`<animate attributeName="opacity" dur="${num(T)}s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="${keyTimes}"/>`);
    push(`</circle>`);
  }

  push(`</g>`);

  legendRows.forEach((row, rowIndex) => {
    const y = legendTop + rowIndex * 18;
    for (const item of row) {
      const x = MARGIN + item.x;
      if (item.kind === "arrow")
        push(`<line x1="${x}" y1="${y - 4}" x2="${x + 22}" y2="${y - 4}" stroke="${theme.legend}" stroke-width="1.5" marker-end="url(#${markerFor(theme.legend)})"/>`);
      if (item.kind === "dashed")
        push(`<line x1="${x}" y1="${y - 4}" x2="${x + 22}" y2="${y - 4}" stroke="${theme.legend}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
      if (item.kind === "dot") push(`<circle cx="${x + 11}" cy="${y - 4}" r="4" fill="${theme.legend}"/>`);
      push(`<text x="${x + 30}" y="${y}" font-family="${esc(MONO)}" font-size="11" fill="${theme.legend}">${esc(item.text)}</text>`);
    }
  });

  push("</svg>");
  return { svg: `${out.join("\n")}\n`, width, height };
};

mkdirSync(outDir, { recursive: true });
for (const themeName of ["light", "dark"]) {
  const { svg, width, height } = render(themeName);
  writeFileSync(join(outDir, `own-${themeName}.svg`), svg);
  console.log(`wrote ${join(outDir, `own-${themeName}.svg`)} (${width}×${height}, ${direction}, ${animated.length} animated edges)`);
}
