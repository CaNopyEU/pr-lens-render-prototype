#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";

const ENTRY = "src/http/routes.ts";
const MAX_VIEW_NODES = 8;
const MAX_FLOW_PARTICIPANTS = 3;
const MAX_ARCHITECTURE_VIEWS = 24;
const SCHEMA_VERSION = "0.2.0";
const GENERATOR = { name: "build-graph", version: "0.1.0" };

const [baseArg, headArg, titleArg, outDir = ".pr-diagram"] = process.argv.slice(2);
if (!baseArg || !headArg || !titleArg) {
  console.error("usage: node scripts/build-graph.mjs <base-sha> <head-sha> <pr-title> [out-dir]");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const commit = (ref) => git("rev-parse", "--verify", `${ref}^{commit}`).trim();

const baseTip = commit(baseArg);
const head = commit(headArg);
const base = git("merge-base", baseTip, head).trim();

const isSource = (path) => /^src\/.+\.tsx?$/.test(path) && !path.endsWith(".d.ts");

const nulFields = (output) => output.split("\0").filter((field) => field !== "");

const parseNameStatus = (output) => {
  const fields = nulFields(output);
  const entries = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const from = fields[i++];
      const to = fields[i++];
      entries.push({ letter, status, from, path: to, raw: `${status}\t${from}\t${to}` });
    } else {
      const path = fields[i++];
      entries.push({ letter, status, path, raw: `${status}\t${path}` });
    }
  }
  return entries;
};

const parseNumstat = (output) => {
  const fields = output.split("\0");
  const stats = new Map();
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]);
    if (match === null) continue;
    let path = match[3];
    if (path === "") {
      i += 2;
      path = fields[i];
    }
    stats.set(path, {
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return stats;
};

const diffRange = `${baseTip}...${head}`;
const diff = parseNameStatus(git("diff", "--name-status", "-M", "-z", diffRange));
const numstat = parseNumstat(git("diff", "--numstat", "-M", "-z", diffRange));

const treeFiles = (revision) =>
  new Set(nulFields(git("ls-tree", "-r", "--name-only", "-z", revision, "--", "src")).filter(isSource));

const filesAt = { head: treeFiles(head), base: treeFiles(base) };
const shaOf = { head, base };

const blankComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));

const IMPORT_FROM = /^[ \t]*import\s+(type\s+)?([^;"'`]*?)\s*from\s*["']([^"']+)["']/gm;
const IMPORT_BARE = /^[ \t]*import\s*["']([^"']+)["']/gm;

const symbolsOf = (clause) => {
  const symbols = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = clause.replace(/\{[^}]*\}/, "").split(",").map((part) => part.trim()).filter(Boolean);
  for (const part of outside) {
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(part);
    symbols.push(namespace ? `* as ${namespace[1]}` : part);
  }
  if (braces) {
    for (const raw of braces[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name !== "") symbols.push(name);
    }
  }
  return symbols;
};

const lineAt = (source, index) => source.slice(0, index).split("\n").length;

const resolveSpecifier = (from, specifier, files) => {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = joined.replace(/\.(m?js|jsx)$/, "");
  const candidates = [joined, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`];
  return candidates.find((candidate) => files.has(candidate));
};

const dropped = [];
const external = [];

const importsAt = (side) => {
  const graph = new Map();
  for (const path of [...filesAt[side]].sort()) {
    const source = blankComments(git("show", `${shaOf[side]}:${path}`));
    const found = [];
    for (const match of source.matchAll(IMPORT_FROM))
      found.push({ index: match.index + match[0].indexOf("import"), specifier: match[3], symbols: symbolsOf(match[2]) });
    for (const match of source.matchAll(IMPORT_BARE))
      found.push({ index: match.index + match[0].indexOf("import"), specifier: match[1], symbols: [] });
    found.sort((a, b) => a.index - b.index);

    const edges = [];
    for (const { index, specifier, symbols } of found) {
      const line = lineAt(source, index);
      if (!specifier.startsWith(".")) {
        external.push({ revision: side, site: `${path}:${line}`, specifier });
        continue;
      }
      const target = resolveSpecifier(path, specifier, filesAt[side]);
      if (target === undefined) {
        dropped.push({ revision: side, site: `${path}:${line}`, specifier, reason: "target file does not exist at this revision" });
        continue;
      }
      edges.push({ to: target, symbols, line });
    }
    graph.set(path, edges);
  }
  return graph;
};

const importsHead = importsAt("head");
const importsBase = importsAt("base");

const renamedTo = new Map(diff.filter((entry) => entry.letter === "R").map((entry) => [entry.from, entry.path]));
const asHeadPath = (path) => renamedTo.get(path) ?? path;

const union = new Map();
const edgeKey = (from, to) => `${from}\0${to}`;
const record = (side, from, { to, symbols, line }, sitePath = from) => {
  const key = edgeKey(from, to);
  const edge = union.get(key) ?? { from, to };
  const site = `${sitePath}:${line}`;
  const seen = edge[side];
  edge[side] = seen
    ? { ...seen, symbols: [...new Set([...seen.symbols, ...symbols])], sites: [...seen.sites, site] }
    : { symbols, line, site, sites: [site] };
  union.set(key, edge);
};
for (const [from, edges] of importsHead) for (const edge of edges) record("head", from, edge);
for (const [from, edges] of importsBase)
  for (const edge of edges) record("base", asHeadPath(from), { ...edge, to: asHeadPath(edge.to) }, from);

const sameSymbols = (a, b) => [...a].sort().join(",") === [...b].sort().join(",");
const edgeDelta = (edge) =>
  edge.head && edge.base
    ? sameSymbols(edge.head.symbols, edge.base.symbols) ? "unchanged" : "modified"
    : edge.head ? "added" : "removed";

const NODE_DELTA = { A: "added", C: "added", M: "modified", T: "modified", R: "modified", D: "removed" };
const changed = new Map();
const skipped = [];
for (const entry of diff) {
  if (!isSource(entry.path)) {
    skipped.push(entry.raw);
    continue;
  }
  changed.set(entry.path, { delta: NODE_DELTA[entry.letter] ?? "modified", entry });
}

const incident = [...union.values()].filter((edge) => changed.has(edge.from) || changed.has(edge.to));

const nodePaths = new Set(changed.keys());
const nodeWhy = new Map([...changed].map(([path, { entry }]) => [path, `diff: ${entry.raw}`]));
for (const edge of incident) {
  for (const [path, other, verb] of [[edge.from, edge.to, "imports"], [edge.to, edge.from, "is imported by"]]) {
    if (nodePaths.has(path)) continue;
    nodePaths.add(path);
    const fact = edge.head ?? edge.base;
    nodeWhy.set(path, `1-hop neighbour: ${path} ${verb} ${other} (${fact.site})`);
  }
}

const adjacency = new Map();
for (const edge of [...union.values()]) {
  const list = adjacency.get(edge.from) ?? [];
  list.push(edge);
  adjacency.set(edge.from, list);
}
for (const list of adjacency.values())
  list.sort((a, b) => (a.head ? 0 : 1) - (b.head ? 0 : 1) || (a.head ?? a.base).line - (b.head ?? b.base).line);

const entryExists = filesAt.head.has(ENTRY) || filesAt.base.has(ENTRY);
const parent = new Map();
const discovery = [];
if (entryExists) {
  const visit = (path) => {
    discovery.push(path);
    for (const edge of adjacency.get(path) ?? []) {
      if (edge.to === ENTRY || parent.has(edge.to)) continue;
      parent.set(edge.to, edge);
      visit(edge.to);
    }
  };
  visit(ENTRY);
}

const laneOf = (path) => {
  const parts = path.split("/");
  return parts.length > 2 ? `src/${parts[1]}` : "src";
};

const pathTo = (target) => {
  const hops = [];
  for (let at = target; parent.has(at); at = parent.get(at).from) hops.unshift(parent.get(at));
  return hops;
};

const flowTargets = [...changed.keys()]
  .filter((path) => path !== ENTRY && parent.has(path))
  .sort((a, b) => discovery.indexOf(a) - discovery.indexOf(b));
const unreachable = [...changed.keys()].filter((path) => path !== ENTRY && !parent.has(path));
const onOtherPath = (target) =>
  flowTargets.some((other) => other !== target && pathTo(other).some((hop) => hop.from === target));
const onPathTargets = flowTargets.filter(onOtherPath);
const flowPaths = flowTargets
  .filter((target) => !onOtherPath(target))
  .map((target) => ({ target, hops: pathTo(target).slice(-(MAX_FLOW_PARTICIPANTS - 1)) }));

for (const { hops } of flowPaths)
  for (const hop of hops)
    for (const path of [hop.from, hop.to])
      if (!nodePaths.has(path)) {
        nodePaths.add(path);
        nodeWhy.set(path, `on the import path from ${ENTRY}`);
      }

const firstSeen = (lane) => {
  const index = discovery.findIndex((path) => laneOf(path) === lane);
  return index === -1 ? Infinity : index;
};
const laneOrder = [...new Set([...nodePaths].map(laneOf))].sort(
  (a, b) => firstSeen(a) - firstSeen(b) || (a < b ? -1 : a > b ? 1 : 0),
);
const laneRank = (lane) => laneOrder.indexOf(lane);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const safeId = (raw) => {
  let id = raw.replace(/[^A-Za-z0-9._:/-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  if (id === "" || id.length > 128 || !ID_PATTERN.test(id))
    id = `${id.slice(0, 100) || "id"}-${createHash("sha1").update(raw).digest("hex").slice(0, 12)}`;
  return id;
};
const nodeId = (path) => safeId(path);
const edgeId = (edge) => safeId(`import:${edge.from}:${edge.to}`);

const stem = (path) => basename(path).replace(/\.tsx?$/, "");
const stemCount = new Map();
for (const path of nodePaths) stemCount.set(stem(path), (stemCount.get(stem(path)) ?? 0) + 1);
const labelOf = (path) => (stemCount.get(stem(path)) > 1 ? path.split("/").slice(-2).join("/").replace(/\.tsx?$/, "") : stem(path));

const symbolLabel = (symbols, maxShown, maxLength) => {
  if (symbols.length === 0) return "side effect";
  const shown = symbols.slice(0, maxShown).join(", ");
  const label = symbols.length > maxShown ? `${shown} +${symbols.length - maxShown}` : shown;
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
};
const edgeLabel = (edge, maxShown = 3, maxLength = 40) => symbolLabel((edge.head ?? edge.base).symbols, maxShown, maxLength);
const edgeSiteFile = (edge) => {
  const side = edge.head ? "head" : "base";
  const fact = edge[side];
  const [path] = fact.site.split(/:(?=\d+$)/);
  return side === "head" ? { path, startLine: fact.line } : { path, startLine: fact.line, revision: "base" };
};

const sortedPaths = [...nodePaths].sort(
  (a, b) => laneRank(laneOf(a)) - laneRank(laneOf(b)) || discoveryRank(a) - discoveryRank(b) || (a < b ? -1 : 1),
);
function discoveryRank(path) {
  const index = discovery.indexOf(path);
  return index === -1 ? Infinity : index;
}

const nodes = sortedPaths.map((path) => {
  const delta = changed.get(path)?.delta ?? "unchanged";
  const stat = numstat.get(path);
  const badges = [];
  if (changed.get(path)?.entry.letter === "R") badges.push("RENAMED");
  if (stat !== undefined && delta !== "unchanged") badges.push(`+${stat.additions} −${stat.deletions}`);
  return {
    id: nodeId(path),
    label: labelOf(path),
    kind: "module",
    delta,
    lane: safeId(laneOf(path)),
    files: [delta === "removed" ? { path, revision: "base" } : { path }],
    badges,
  };
});

const edges = incident
  .sort((a, b) => discoveryRank(a.from) - discoveryRank(b.from) || (a.head ?? a.base).line - (b.head ?? b.base).line || (a.to < b.to ? -1 : 1))
  .map((edge) => {
    const delta = edgeDelta(edge);
    return {
      id: edgeId(edge),
      from: nodeId(edge.from),
      to: nodeId(edge.to),
      kind: "dependency",
      delta,
      label: edgeLabel(edge),
      emphasis: "normal",
      animated: delta === "added" || delta === "modified",
      files: [edgeSiteFile(edge)],
    };
  });

const edgeDocFor = (edge) => edges.find((candidate) => candidate.id === edgeId(edge));

const DELTA_ORDER = ["added", "modified", "removed", "unchanged"];
const countDeltas = (items) =>
  DELTA_ORDER.map((delta) => [delta, items.filter((item) => item.delta === delta).length])
    .filter(([, count]) => count > 0)
    .map(([delta, count]) => `${count} ${delta}`)
    .join(", ");

const groups = new Map();
const lanesOfEdge = (edge) => [laneOf(edge.from), laneOf(edge.to)].sort((a, b) => laneRank(a) - laneRank(b));
for (const edge of incident) {
  const [a, b] = lanesOfEdge(edge);
  const key = a === b ? a : `${a}|${b}`;
  const group = groups.get(key) ?? { lanes: a === b ? [a] : [a, b], edges: [] };
  group.edges.push(edge);
  groups.set(key, group);
}
for (const [key, group] of [...groups]) {
  if (group.lanes.length !== 1) continue;
  const host = [...groups.values()].find((other) => other.lanes.length === 2 && other.lanes.includes(group.lanes[0]));
  if (host === undefined) continue;
  host.edges.push(...group.edges);
  groups.delete(key);
}
const connected = new Set(incident.flatMap((edge) => [edge.from, edge.to]));
for (const path of changed.keys()) {
  if (connected.has(path)) continue;
  const lane = laneOf(path);
  const group = groups.get(`isolated:${lane}`) ?? { lanes: [lane], edges: [], isolated: [] };
  group.isolated.push(path);
  groups.set(`isolated:${lane}`, group);
}

const changeWeight = (group) =>
  group.edges.filter((edge) => edgeDelta(edge) !== "unchanged").length +
  new Set(group.edges.flatMap((edge) => [edge.from, edge.to]).filter((path) => changed.has(path))).size;

const chunk = (group) => {
  if (group.isolated) return [{ ...group, nodes: group.isolated }];
  const chunks = [];
  let current = { edges: [], nodes: new Set() };
  for (const edge of group.edges) {
    const grown = new Set([...current.nodes, edge.from, edge.to]);
    if (grown.size > MAX_VIEW_NODES && current.edges.length > 0) {
      chunks.push(current);
      current = { edges: [], nodes: new Set() };
    }
    current.edges.push(edge);
    current.nodes = new Set([...current.nodes, edge.from, edge.to]);
  }
  chunks.push(current);
  return chunks.map((part) => ({ lanes: group.lanes, edges: part.edges, nodes: [...part.nodes] }));
};

const arrowBetween = ([a, b], groupEdges) => {
  if (b === undefined) return a;
  const forward = groupEdges.some((edge) => laneOf(edge.from) === a && laneOf(edge.to) === b);
  const backward = groupEdges.some((edge) => laneOf(edge.from) === b && laneOf(edge.to) === a);
  if (forward && backward) return `${a} ↔ ${b}`;
  return backward ? `${b} → ${a}` : `${a} → ${b}`;
};

const architectureParts = [...groups.values()]
  .sort((a, b) => changeWeight(b) - changeWeight(a) || laneRank(a.lanes[0]) - laneRank(b.lanes[0]) || laneRank(a.lanes.at(-1)) - laneRank(b.lanes.at(-1)))
  .flatMap((group) => {
    const parts = chunk(group);
    return parts.map((part, index) => ({ ...part, part: parts.length > 1 ? ` (${index + 1}/${parts.length})` : "" }));
  });
const omittedViews = Math.max(0, architectureParts.length - MAX_ARCHITECTURE_VIEWS);
const architectureViews = architectureParts
  .slice(0, MAX_ARCHITECTURE_VIEWS)
  .map((part, index) => {
    const drawnEdges = part.edges.map(edgeDocFor);
    const contextOnly = !part.isolated && drawnEdges.every((edge) => edge.delta === "unchanged");
    const summary = part.isolated
      ? `Changed files in ${part.lanes[0]} with no import to or from another file.`
      : `Import statements ${part.lanes.length === 1 ? `inside ${part.lanes[0]}` : "between these directories"} that touch a changed file: ${countDeltas(drawnEdges)}. An arrow points from the importing file to the imported one and carries the imported names.`;
    return {
      id: `architecture-${index + 1}`,
      title: `${part.isolated ? `Isolated: ${part.lanes[0]}` : `${contextOnly ? "Context · " : ""}${arrowBetween(part.lanes, part.edges)}`}${part.part}`,
      lens: "architecture",
      summary,
      scope: {
        kind: "selection",
        lanes: [],
        nodes: part.nodes.map(nodeId),
        edges: drawnEdges.map((edge) => edge.id),
        flows: [],
      },
      defaultOpen: index === 0,
      children: [],
    };
  });

const flows = flowPaths.map(({ target, hops }, index) => {
  const participants = [hops[0].from, ...hops.map((hop) => hop.to)];
  const omitted = pathTo(target).length - hops.length;
  return {
    id: `import-path-${index + 1}`,
    title: `${omitted > 0 ? "… → " : ""}${participants.map(labelOf).join(" → ")}`,
    summary: `First chain of import statements a depth-first walk from ${ENTRY} takes to reach ${target}${omitted > 0 ? `, its first ${omitted} hop(s) cut for width` : ""}.`,
    delta: changed.get(target).delta,
    participants: participants.map((path) => ({ node: nodeId(path) })),
    messages: hops.map((hop, step) => {
      const delta = edgeDelta(hop);
      return {
        id: `hop-${step + 1}`,
        from: nodeId(hop.from),
        to: nodeId(hop.to),
        label: `imports ${edgeLabel(hop, 2, 26)}`,
        kind: "sync",
        delta,
        animated: delta !== "removed",
        files: [edgeSiteFile(hop)],
      };
    }),
  };
});

const dataFlowViews =
  flows.length === 0
    ? []
    : [
        {
          id: "import-paths",
          title: `Static import paths from ${ENTRY} (not a runtime trace)`,
          lens: "data-flow",
          summary: `One row per changed file at the end of an import chain (${flowPaths.map(({ target }) => labelOf(target)).join(", ")}): the first chain of import statements that a depth-first walk from ${ENTRY}, in source order, takes to reach it.${onPathTargets.length > 0 ? ` ${onPathTargets.map(labelOf).join(", ")} changed too and sits on those chains.` : ""} It shows which file imports which; it does not show what runs, when, or with what data.`,
          scope: { kind: "selection", lanes: [], nodes: [], edges: [], flows: flows.map((flow) => flow.id) },
          defaultOpen: true,
          children: [],
        },
      ];

const lanes = laneOrder.map((lane, order) => ({ id: safeId(lane), label: lane, order }));

const repo = (() => {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  const remote = fromEnv ?? (() => {
    try {
      const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url.trim())?.[1];
    } catch {
      return undefined;
    }
  })();
  const [owner, name] = (remote ?? `local/${basename(process.cwd())}`).split("/");
  return { owner, name, host: "github.com" };
})();

const prNumber = Number(process.env.PR_NUMBER);
const title = titleArg.length > 120 ? `${titleArg.slice(0, 119)}…` : titleArg;
const total = (key) => [...numstat.values()].reduce((sum, stat) => sum + stat[key], 0);
const countOf = (delta) => [...changed.values()].filter((change) => change.delta === delta).length;
const deltaChips = [
  ["Added", "added"],
  ["Changed", "modified"],
  ["Removed", "removed"],
]
  .filter(([, delta]) => countOf(delta) > 0)
  .map(([label, delta]) => ({ label, value: String(countOf(delta)), tone: delta }));

const graph = {
  schemaVersion: SCHEMA_VERSION,
  kind: "graph",
  title,
  summary: `Drawn from git facts only, no model: ${changed.size} changed source ${changed.size === 1 ? "file" : "files"} (${countDeltas([...changed.values()])}) and the files that import them or that they import. A box is a file, an arrow is one import statement, and facts.json gives the line each comes from.`,
  lenses: flows.length > 0 ? ["architecture", "data-flow"] : ["architecture"],
  provenance: {
    repo,
    base: { sha: base, ...(process.env.GITHUB_BASE_REF ? { ref: process.env.GITHUB_BASE_REF } : {}) },
    head: { sha: head, ...(process.env.GITHUB_HEAD_REF ? { ref: process.env.GITHUB_HEAD_REF } : {}) },
    ...(Number.isInteger(prNumber) && prNumber > 0
      ? { pullRequest: { number: prNumber, title: titleArg.slice(0, 512), url: `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}` } }
      : {}),
    generator: GENERATOR,
  },
  lanes,
  nodes,
  edges,
  flows,
  stats: { filesChanged: diff.length, additions: total("additions"), deletions: total("deletions"), chips: deltaChips },
  views: [...architectureViews, ...dataFlowViews],
  layout: { laneOrder: lanes.map((lane) => lane.id) },
};

const facts = {
  generator: `scripts/build-graph.mjs ${GENERATOR.version}`,
  commits: { baseTip, mergeBase: base, head },
  commands: [
    `git diff --name-status -M ${diffRange}`,
    `git diff --numstat -M ${diffRange}`,
    `git ls-tree -r --name-only <rev> -- src   (rev = ${base.slice(0, 12)} and ${head.slice(0, 12)})`,
    "git show <rev>:<file>   (import statements parsed from every src/**/*.ts at both revisions)",
  ],
  diff: diff.map((entry) => entry.raw),
  nodes: Object.fromEntries(
    nodes.map((node) => {
      const [{ path }] = node.files;
      return [node.id, { path, delta: node.delta, lane: laneOf(path), fact: nodeWhy.get(path) }];
    }),
  ),
  edges: Object.fromEntries(
    incident.map((edge) => [
      edgeId(edge),
      {
        from: edge.from,
        to: edge.to,
        delta: edgeDelta(edge),
        ...(edge.head ? { head: { sites: edge.head.sites, imports: edge.head.symbols } } : {}),
        ...(edge.base ? { base: { sites: edge.base.sites, imports: edge.base.symbols } } : {}),
      },
    ]),
  ),
  importPaths: Object.fromEntries(
    flowPaths.map(({ target, hops }, index) => [
      flows[index].id,
      { target, hops: hops.map((hop) => `${(hop.head ?? hop.base).site} ${hop.from} -> ${hop.to} [${edgeDelta(hop)}]`) },
    ]),
  ),
  notReachableFromEntry: unreachable,
  droppedEdges: dropped,
  externalImports: external,
  skippedDiffEntries: skipped,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
writeFileSync(join(outDir, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`);

console.log(`base ${base.slice(0, 12)} (merge base of ${baseTip.slice(0, 12)}) -> head ${head.slice(0, 12)}`);
console.log(`diff: ${diff.length} entries, ${changed.size} source files, ${skipped.length} skipped`);
console.log(`graph: ${nodes.length} nodes, ${edges.length} edges, ${lanes.length} lanes, ${architectureViews.length} architecture views, ${flows.length} import paths`);
for (const view of graph.views) console.log(`  view ${view.id}: ${view.title} [${view.scope.nodes.length || "-"} nodes]`);
if (omittedViews > 0) console.log(`omitted ${omittedViews} architecture views over the cap of ${MAX_ARCHITECTURE_VIEWS}`);
if (dropped.length === 0) console.log("dropped edges: none");
for (const edge of dropped) console.log(`dropped edge (${edge.revision}) ${edge.site} '${edge.specifier}': ${edge.reason}`);
for (const path of unreachable) console.log(`not reachable from ${ENTRY}: ${path}`);
console.log(`wrote ${join(outDir, "graph.json")} and ${join(outDir, "facts.json")}`);
