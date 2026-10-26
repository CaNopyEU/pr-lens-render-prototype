#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir = ".pr-diagram"] = process.argv.slice(2);

const fail = (message) => {
  console.error(`build-mermaid: ${message}`);
  process.exit(1);
};

const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const graph = read("graph.json");
const facts = read("facts.json");

const STATUS = { added: "added", modified: "changed", removed: "removed", unchanged: "context" };
const LEGEND = "green = added, amber = changed, red dashed = removed, grey = unchanged context";
const LINK_STROKE = { added: "#1a7f37", modified: "#bf8700", removed: "#cf222e" };

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

const text = (value) =>
  value.replace(/#/g, "#35;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/&/g, "#amp;");

const nodeText = (node) => [node.label, ...node.badges].map(text).join("<br/>");

const classDefs = [
  "classDef added fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#0b3d1a",
  "classDef changed fill:#fff1c2,stroke:#bf8700,stroke-width:2px,color:#4d3800",
  "classDef removed fill:#ffebe9,stroke:#cf222e,stroke-width:2px,stroke-dasharray:5 3,color:#5c1015",
  "classDef context fill:#eaeef2,stroke:#8c959f,color:#24292f",
];

const classLines = (members) =>
  Object.values(STATUS)
    .map((status) => [status, members.filter((member) => STATUS[member.delta] === status).map((member) => member.mermaidId)])
    .filter(([, ids]) => ids.length > 0)
    .map(([status, ids]) => `  class ${ids.join(",")} ${status}`);

const linkStyleLines = (edges) =>
  edges.flatMap((edge, index) =>
    LINK_STROKE[edge.delta] ? [`  linkStyle ${index} stroke:${LINK_STROKE[edge.delta]},stroke-width:2px`] : [],
  );

const arrow = (delta) => (delta === "removed" ? "-.->" : "-->");

const architecture = (() => {
  const views = graph.views.filter((view) => view.lens === "architecture");
  const nodeIds = new Set(views.flatMap((view) => view.scope.nodes));
  const edgeIds = new Set(views.flatMap((view) => view.scope.edges));
  for (const id of nodeIds) if (!nodeById.has(id)) fail(`view node ${id} is not in graph.json`);
  for (const id of edgeIds) if (!edgeById.has(id)) fail(`view edge ${id} is not in graph.json`);

  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id)).map((node, index) => ({ ...node, mermaidId: `n${index + 1}` }));
  const edges = graph.edges.filter((edge) => edgeIds.has(edge.id));
  const mermaidIdOf = new Map(nodes.map((node) => [node.id, node.mermaidId]));
  return { nodes, edges, mermaidIdOf };
})();

const drawArchitecture = ({ animated }) => {
  const { nodes, edges, mermaidIdOf } = architecture;
  const lines = ["flowchart LR"];

  graph.lanes.forEach((lane, index) => {
    const members = nodes.filter((node) => node.lane === lane.id);
    if (members.length === 0) return;
    lines.push(`  subgraph L${index + 1}["${text(lane.label)}"]`);
    for (const node of members) lines.push(`    ${node.mermaidId}["${nodeText(node)}"]`);
    lines.push("  end");
  });

  const touchesChange = (edge) => [edge.from, edge.to].some((id) => nodeById.get(id).delta !== "unchanged");
  edges.forEach((edge, index) => {
    const id = animated ? ` e${index + 1}@` : " ";
    lines.push(`  ${mermaidIdOf.get(edge.from)}${id}${arrow(edge.delta)}|"${text(edge.label)}"| ${mermaidIdOf.get(edge.to)}`);
  });
  if (animated)
    edges.forEach((edge, index) => {
      if (touchesChange(edge)) lines.push(`  e${index + 1}@{ animate: true }`);
    });

  lines.push(...classDefs.map((line) => `  ${line}`), ...classLines(nodes), ...linkStyleLines(edges));
  return lines.join("\n");
};

const drawImportPaths = () => {
  const lines = ["flowchart LR"];
  const members = [];
  const allEdges = [];

  graph.flows.forEach((flow, flowIndex) => {
    const hops = facts.importPaths[flow.id]?.hops;
    if (hops === undefined || hops.length !== flow.messages.length) fail(`flow ${flow.id} is not in facts.json with the same hops`);
    const idOf = new Map();
    lines.push(`  subgraph P${flowIndex + 1}["${text(flow.title)}"]`, "    direction LR");
    flow.participants.forEach((participant, index) => {
      const node = nodeById.get(participant.node);
      if (node === undefined) fail(`flow ${flow.id} names node ${participant.node}, which is not in graph.json`);
      const mermaidId = `p${flowIndex + 1}n${index + 1}`;
      idOf.set(node.id, mermaidId);
      members.push({ mermaidId, delta: node.delta });
      lines.push(`    ${mermaidId}["${nodeText(node)}"]`);
    });
    flow.messages.forEach((message, index) => {
      if (!hops[index].includes(`${message.from} -> ${message.to} [${message.delta}]`))
        fail(`hop ${message.id} of ${flow.id} does not match facts.json`);
      allEdges.push(message);
      lines.push(`    ${idOf.get(message.from)} ${arrow(message.delta)}|"${text(message.label)}"| ${idOf.get(message.to)}`);
    });
    lines.push("  end");
  });

  lines.push(...classDefs.map((line) => `  ${line}`), ...classLines(members), ...linkStyleLines(allEdges));
  return lines.join("\n");
};

const fence = (diagram) => `\`\`\`mermaid\n${diagram}\n\`\`\``;

const importPathsView = graph.views.find((view) => view.lens === "data-flow");

const sections = [
  [
    "#### Architecture (Mermaid)",
    `One box per file in the views above, one arrow per import statement that touches a changed file, labelled with the imported names. Boxes: ${LEGEND}.`,
    fence(drawArchitecture({ animated: false })),
  ],
  ...(importPathsView && graph.flows.length > 0
    ? [
        [
          "#### Static import paths (Mermaid)",
          `The chains of the "${importPathsView.title}" view, one row per chain. Import statements only, not a runtime trace.`,
          fence(drawImportPaths()),
        ],
      ]
    : []),
  [
    "<details>\n<summary>Animated edges (Mermaid 11 edge animation, which GitHub renders: verified on this PR)</summary>",
    "The architecture diagram again, with an id on every edge and `animate: true` on the edges that touch a changed file.",
    fence(drawArchitecture({ animated: true })),
    "</details>",
  ],
];

const markdown = `${sections.map((section) => section.join("\n\n")).join("\n\n")}\n`;
writeFileSync(join(dir, "mermaid.md"), markdown);

console.log(`mermaid: ${architecture.nodes.length} nodes, ${architecture.edges.length} edges, ${graph.flows.length} import paths`);
console.log(`wrote ${join(dir, "mermaid.md")}`);
