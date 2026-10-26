# pr-lens-render-prototype

A prototype that draws animated architecture diagrams into a pull request comment **without any LLM**. A small script turns facts from git (which files changed, and the import statements in them) into a [PR Lens](https://github.com/coldteadotai/pr-lens) graph document. The PR Lens renderer draws it as light and dark SVGs, and a workflow posts them as one comment.

PR Lens normally starts with `analyze`, where a model reads the diff and writes the graph. This repo skips that step and builds the graph itself, so every box and arrow can be checked against a line of code.

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
  graph --> validate["pr-lens validate"]
  validate --> render["pr-lens render<br/>light + dark SVG"]
  render --> branch["orphan branch pr-diagrams<br/>pr/&lt;number&gt;/&lt;head-sha&gt;/"]
  facts --> branch
  branch --> compose["pr-lens comment<br/>--asset-base-url"]
  compose --> comment["one PR comment,<br/>updated in place"]
```

| Step | Where |
| --- | --- |
| Build the graph from git facts | [`scripts/build-graph.mjs`](scripts/build-graph.mjs) (Node ≥ 20, no dependencies) |
| Validate, render, compose the comment | `npx @coldtea/pr-lens-cli@0.13.2` (`validate`, `render`, `comment`) |
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

## What is deterministic, and what is not

Deterministic, given the same two commits:

- the graph document and `facts.json`, byte for byte (no timestamps and no model; every list is sorted by git output, line number or path)
- the SVGs. The renderer is deterministic, measures text from a table instead of fonts, and names each file after the hash of its contents.

Not deterministic, or not derived from the code:

- **The rules.** Lanes by directory, views by lane pair, and every node drawn as a `module` are choices made by this script. They are mechanical but opinionated.
- **Rename detection.** `git diff -M` uses a similarity threshold, so whether a move counts as a rename (`R`) or as a delete plus an add depends on how much the file changed.
- **The renderer version.** The CLI is pinned to `0.13.2`, but its own dependencies use caret ranges, so a new renderer patch release can change pixels.
- **Display.** GitHub serves comment images through its image proxy and decides how they are scaled.

## Limitations

- **A static import path is not a runtime flow.** The data-flow view shows which file imports which, starting from the entry file. It does not show calls, their order, branches or data. An import of a type and an import of a function look the same.
- **Width.** The renderer gives every lane a fixed 404 px column, so a view with *n* lanes is `12 + 424·n` px wide. The comment column is about 830 px wide, so anything over two lanes (860 px, shown at 97 %) gets scaled down until it is unreadable. This is why the builder splits the picture into views of at most two lanes and 8 nodes, and why there is no "everything at once" view. Data-flow rows are capped at 3 files, which keeps them at about 714 px.
- **The parser is a regex.** It reads static `import … from '…'` and `import '…'` statements, and blanks out comments first. It ignores `export … from`, dynamic `import()`, `require`, tsconfig path aliases and barrel re-exports. It only resolves relative specifiers under `src/`.
- **Public repository.** Image URLs point at `raw.githubusercontent.com`, which serves a private repository's files only with a token. The PR Lens Action uses `github.com/<repo>/raw/…` so that private repositories work too.
- **Fork pull requests** get a read-only token, so the publish and comment steps cannot write there.

## Run it locally

```bash
node scripts/build-graph.mjs main feature/discount-codes "Replace hard-coded coupons with discount codes" .pr-diagram
npx --yes @coldtea/pr-lens-cli@0.13.2 validate .pr-diagram/graph.json
npx --yes @coldtea/pr-lens-cli@0.13.2 render .pr-diagram/graph.json --out .pr-diagram/assets
```

The script prints the views it made and any edges it dropped. Open the SVGs in a browser to see the animation.

## The demo app

`src/` holds a tiny invented bookshop checkout. It has no dependencies and needs no build. `src/http/routes.ts` is the entry. It imports the checkout service, which imports the catalog repository and the price calculator. The catalog repository imports an in-memory stand-in for a database.

## Credit

The renderer, schema, `validate`, `render` and `comment` commands are [PR Lens](https://github.com/coldteadotai/pr-lens) by Coldtea AI, MIT licensed, used here unmodified through the published `@coldtea/pr-lens-cli` package. `scripts/publish.sh` and `scripts/comment.sh` are adapted from the PR Lens Action and keep its MIT notice.

## License

[MIT](LICENSE) © Dávid Radimák
