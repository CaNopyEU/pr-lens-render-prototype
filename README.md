# pr-lens-render-prototype

A prototype that draws animated architecture diagrams into a pull request comment **without any LLM**. A small script turns facts from git (which files changed, and the import statements in them) into a [PR Lens](https://github.com/coldteadotai/pr-lens) graph document. The PR Lens renderer draws it as light and dark SVGs, and a workflow posts them as one comment.

PR Lens normally starts with `analyze`, where a model reads the diff and writes the graph. This repo skips that step and builds the graph itself, so every box and arrow can be checked against a line of code.

The same comment then draws the same facts two more ways, so the approaches can be compared side by side: as one SVG from an own renderer with an [ELK](https://eclipse.dev/elk/) layout, and as Mermaid that GitHub draws itself.

**Demo:** [pull request #1](https://github.com/CaNopyEU/pr-lens-render-prototype/pull/1). It adds `src/pricing/discountCodes.ts`, modifies `checkoutService.ts` and `priceCalculator.ts`, and deletes `couponRules.ts`, so all three change states show up in the diagrams.

## Pipeline

```mermaid
flowchart LR
  pr["pull_request event"] --> diff["git diff --name-status base...head"]
  pr --> imports["import statements<br/>at base and head"]
  diff --> build["scripts/build-graph.mjs"]
  imports --> build
  build --> graph["graph.json"]
  build --> facts["facts.json"]
  graph --> mermaid["scripts/build-mermaid.mjs"]
  facts --> mermaid
  graph --> own["scripts/render-svg.mjs<br/>ELK layout, light + dark SVG"]
  facts --> own
  own --> branch
  graph --> validate["pr-lens validate"]
  validate --> render["pr-lens render<br/>light + dark SVG"]
  render --> branch["orphan branch pr-diagrams<br/>pr/&lt;number&gt;/&lt;head-sha&gt;/"]
  facts --> branch
  branch --> compose["pr-lens comment<br/>--asset-base-url"]
  compose --> comment["one PR comment,<br/>updated in place"]
  mermaid --> comment
```

| Step | Where |
| --- | --- |
| Build the graph from git facts | [`scripts/build-graph.mjs`](scripts/build-graph.mjs) (Node ≥ 20, no dependencies) |
| Validate, render, compose the comment | `npx @coldtea/pr-lens-cli@0.13.2` (`validate`, `render`, `comment`) |
| Draw the same facts as one SVG | [`scripts/render-svg.mjs`](scripts/render-svg.mjs) (Node ≥ 20, `elkjs` pinned to 0.12.0 in [`package-lock.json`](package-lock.json)) |
| Draw the same facts as Mermaid | [`scripts/build-mermaid.mjs`](scripts/build-mermaid.mjs) (Node ≥ 20, no dependencies) |
| Time each step into `timings.json` | [`scripts/timed.mjs`](scripts/timed.mjs) |
| Publish SVGs to the `pr-diagrams` branch | [`scripts/publish.sh`](scripts/publish.sh), adapted from the PR Lens Action |
| Create or update the one comment | [`scripts/comment.sh`](scripts/comment.sh), adapted from the PR Lens Action |
| Wire it to `pull_request` | [`.github/workflows/pr-diagram.yml`](.github/workflows/pr-diagram.yml) |

No API key, no secret and no prlens.dev account are involved. The workflow uses only `GITHUB_TOKEN`. It never calls `analyze` or `canvas`.

## How the graph is built

- **Nodes.** Each changed `src/**/*.ts` file is a node, plus every file that imports one directly or is imported by one (its 1-hop neighbours). The node's state comes from the diff: `A` → added, `M` or `R` → modified, `D` → removed. Neighbours are unchanged context. The badge is the `git diff --numstat` line count.
- **Edges.** One edge per pair of importing and imported files where at least one of the two changed. The label lists the imported names. An import that exists only at head is added, one that exists only at the merge base is removed, and one whose names changed is modified. Imports are parsed at both revisions with `git show <rev>:<file>`, so a deleted file's imports are still known.
- **Dropped edges.** A relative import whose target file does not exist at that revision is dropped, logged, and listed under `droppedEdges` in `facts.json`. Package imports such as `node:fs` are listed under `externalImports` and not drawn.
- **Lanes.** One lane per first directory under `src/` (`src/http`, `src/pricing`, …). Lanes are ordered by when a depth-first walk from the entry first reaches them.
- **Views.** One architecture view per pair of lanes that an edge crosses. Edges inside a lane join a view that already shows that lane. Each view holds at most 8 nodes. A view whose edges are all unchanged is titled `Context · …` and starts collapsed.
- **Data flow.** A depth-first walk of the imports from `src/http/routes.ts`, in source order, over the imports at head plus the ones that exist only at the merge base. Each changed file the walk reaches gets one row: the chain of imports the walk took to get there, cut to the last 3 files. A changed file that already sits on another row's chain gets no row of its own.
- **Text.** The title is the PR title. Labels are file basenames and imported names. Summaries are fixed sentence templates filled with counts.
- **`facts.json`.** Lists, for every node, the diff line or the import that put it in the graph. For every edge, it gives the `file:line` of each import statement at head and at base. It is published next to the SVGs and linked from the comment.

## Own SVG renderer

Under the PR Lens pictures the comment has a section "Same facts, own SVG renderer". [`scripts/render-svg.mjs`](scripts/render-svg.mjs) reads `graph.json` and `facts.json`, takes every file and import of the architecture views, and draws them as **one** picture, `own-light.svg` and `own-dark.svg`. They are published next to the PR Lens SVGs and shown with a `<picture>` element, so GitHub picks the one that matches the reader's theme.

**Why.** PR Lens gives every lane a fixed 404 px column, so its pictures are 860 to 2100 px wide and get scaled down in a comment column of about 830 px (see [Limitations](#limitations)). A layout engine can size each box to its text instead, so the whole change fits in one picture that is shown at the size it was drawn. The demo comes out 701 px wide.

**How.**

- **Layout.** [elkjs](https://github.com/kieler/elkjs), algorithm `layered`, orthogonal edge routing, one compound node per `src/<dir>` (`hierarchyHandling: INCLUDE_CHILDREN`). Box sizes are computed before the layout from the label length times a per-character width, estimated high. The script tries left to right first and switches to top to bottom when the result would be wider than 830 px.
- **Directory labels.** Each label goes into a free spot along the top of its box, then along the bottom. A box whose top has no room for its label is widened and laid out again. Only when neither works is the label drawn over the lines on a background patch.
- **Look.** Light uses the *blueprint* preset (white boxes, thin grey borders, hatched directory boxes, monospace upper-case directory labels), dark uses the *terminal* preset (black canvas, hairline boxes, monospace, open arrowheads). Status is shown twice, as a colour and as a word on every box: `NEW`, `CHANGED`, `REMOVED` (dashed) or `UNCHANGED`. Arrows take the colour of the import's status, and their labels are the imported names, at most two plus a count.
- **Animation.** SMIL only, no script and no CSS: one `<animateMotion>` dot per import that touches a changed file, one after another in the depth-first order of the import walk from `src/http/routes.ts`, on a shared loop.

**Limits.**

- **Text is estimated, not measured.** The reader's browser picks the font, so a box can look a little loose. Labels are sized for the widest font in the stack.
- **Big changes still get wide.** Top to bottom only helps up to a point. A change with many files in one directory row will be wider than 830 px; the script warns and draws it anyway, and GitHub scales it down like the PR Lens pictures.
- **The dots need a browser.** Browsers run SMIL inside an `<img>`, and GitHub's image proxy passes it through. Email notifications and other static views show the picture without the dots.
- **Placement rules are heuristics.** Label spots and zone widening are simple rules tested on this demo, not a general label placer.

## Mermaid version

Below the own renderer's picture the comment has a third section, "Same facts, drawn by Mermaid". [`scripts/build-mermaid.mjs`](scripts/build-mermaid.mjs) reads `graph.json` and `facts.json` and writes `mermaid.md`, which `comment.sh` places in the same comment. Mermaid is a text format that GitHub draws itself, so unlike the SVGs these diagrams can be read and diffed as text. It has three diagrams:

- **Architecture.** One `flowchart LR` with a subgraph per `src/<dir>`, a box per file in the PR Lens views (green added, amber changed, red dashed removed, grey unchanged context) and an arrow per import statement those views draw, labelled with the same imported names.
- **Static import paths.** The chains of the PR Lens import-path view as one flowchart, one subgraph per chain. Still import statements, not a runtime trace.
- **Animated edges.** The architecture diagram again, in a collapsed block, with edge ids and `animate: true` on every edge that touches a changed file. This is Mermaid 11 syntax, and GitHub renders it: verified on pull request #1.

All three draw the same facts. Neither `build-mermaid.mjs` nor `render-svg.mjs` adds a box or arrow of its own, and both stop if one in `graph.json` is missing from `facts.json` or has a different state there.

Each CI step is also timed by `scripts/timed.mjs`. The numbers go to `timings.json`, which is published next to the SVGs, and into the last line of the comment.

## What is deterministic, and what is not

Deterministic, given the same two commits:

- the graph document and `facts.json`, byte for byte (no timestamps and no model; every list is sorted by git output, line number or path)
- the SVGs. The renderer is deterministic, measures text from a table instead of fonts, and names each file after the hash of its contents.
- the own SVGs, byte for byte. ELK is deterministic for the same input, and `elkjs` is pinned to an exact version with a lockfile.

Not deterministic, or not derived from the code:

- **The rules.** Lanes by directory, views by lane pair, and every node drawn as a `module` are choices made by this script. They are mechanical but opinionated.
- **Rename detection.** `git diff -M` uses a similarity threshold, so whether a move counts as a rename (`R`) or as a delete plus an add depends on how much the file changed.
- **The renderer version.** The CLI is pinned to `0.13.2`, but its own dependencies use caret ranges, so a new renderer patch release can change pixels.
- **Display.** GitHub serves comment images through its image proxy and decides how they are scaled.

## Limitations

- **A static import path is not a runtime flow.** The data-flow view shows which file imports which, starting from the entry file. It does not show calls, their order, branches or data. An import of a type and an import of a function look the same.
- **Width.** The renderer gives every lane a fixed 404 px column, so a view with *n* lanes is `12 + 424·n` px wide. The comment column is about 830 px wide, so anything over two lanes (860 px, shown at 97 %) gets scaled down until it is unreadable. This is why the builder splits the picture into views of at most two lanes and 8 nodes, and why there is no "everything at once" view. Data-flow rows are capped at 3 files, which keeps them at about 714 px. The [own SVG renderer](#own-svg-renderer) is the answer to this: one picture of the whole change, 701 px wide for the demo.
- **The parser is a regex.** It reads static `import … from '…'` and `import '…'` statements, and blanks out comments first. It ignores `export … from`, dynamic `import()`, `require`, tsconfig path aliases and barrel re-exports. It only resolves relative specifiers under `src/`.
- **Public repository.** Image URLs point at `raw.githubusercontent.com`, which serves a private repository's files only with a token. The PR Lens Action uses `github.com/<repo>/raw/…` so that private repositories work too.
- **Fork pull requests** get a read-only token, so the publish and comment steps cannot write there.

## Run it locally

```bash
node scripts/build-graph.mjs main feature/discount-codes "Replace hard-coded coupons with discount codes" .pr-diagram
npx --yes @coldtea/pr-lens-cli@0.13.2 validate .pr-diagram/graph.json
npx --yes @coldtea/pr-lens-cli@0.13.2 render .pr-diagram/graph.json --out .pr-diagram/assets
node scripts/build-mermaid.mjs .pr-diagram
npm ci
node scripts/render-svg.mjs .pr-diagram
```

The script prints the views it made and any edges it dropped. Open the SVGs in a browser to see the animation. `.pr-diagram/mermaid.md` holds the Mermaid section of the comment, and `.pr-diagram/assets/own-light.svg` and `own-dark.svg` are the own renderer's pictures.

## The demo app

`src/` holds a tiny invented bookshop checkout. It has no dependencies and needs no build. `src/http/routes.ts` is the entry. It imports the checkout service, which imports the catalog repository and the price calculator. The catalog repository imports an in-memory stand-in for a database.

## Credit

The own renderer lays out with [elkjs](https://github.com/kieler/elkjs) (EPL-2.0), installed by `npm ci` and not vendored.

The renderer, schema, `validate`, `render` and `comment` commands are [PR Lens](https://github.com/coldteadotai/pr-lens) by Coldtea AI, MIT licensed, used here unmodified through the published `@coldtea/pr-lens-cli` package. `scripts/publish.sh` and `scripts/comment.sh` are adapted from the PR Lens Action and keep its MIT notice.

## License

[MIT](LICENSE) © Dávid Radimák
