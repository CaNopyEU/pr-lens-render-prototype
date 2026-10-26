#!/usr/bin/env bash
#
# Posts the one diagram comment on the pull request, or updates the one that
# is already there.
#
# Adapted from PR Lens, packages/action/scripts/comment.sh
# https://github.com/coldteadotai/pr-lens
#
# MIT License
#
# Copyright (c) 2026 Coldtea AI
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
set -euo pipefail

WORK="${RUNNER_TEMP}/pr-diagram"
BODY="${WORK}/comment.md"
COMMENT_AUTHOR="${COMMENT_AUTHOR:-github-actions[bot]}"

cli() {
  npx --yes "${PR_LENS_CLI}" "$@"
}

# A run overtaken by a newer push must not replace a newer comment with an
# older picture. A failed lookup exits rather than returning, because inside an
# `if` a non-zero return would read as "not overtaken".
overtaken() {
  local current

  if ! current="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq .head.sha)"; then
    echo "::error::Could not ask GitHub what #${PR_NUMBER} points at."
    exit 1
  fi

  if [ -z "${current}" ]; then
    echo "::error::GitHub named no head commit for #${PR_NUMBER}."
    exit 1
  fi

  if [ "${current}" = "${HEAD_SHA}" ]; then
    return 1
  fi

  echo "::notice::#${PR_NUMBER} has moved on to ${current}; leaving the comment to the run that is drawing it."
  return 0
}

if overtaken; then
  exit 0
fi

cli comment \
  --graph "${WORK}/assets/drawn.graph.json" \
  --manifest "${WORK}/assets/manifest.json" \
  --asset-base-url "${ASSETS_URL}" \
  --out "${BODY}"

SEPARATOR_LINE="$(grep -n '^---$' "${BODY}" | tail -n 1 | cut -d: -f1 || true)"
SECTION="${WORK}/extra-sections.md"
OWN_WIDTH="$(sed -n 's/^<svg[^>]* width="\([0-9]*\)".*/\1/p' "${WORK}/assets/own-light.svg" | head -n 1)"
OWN_ALT="$(jq -rn --arg title "${PR_TITLE}" '"Import graph of the change: " + $title | @html')"

{
  printf '### Same facts, own SVG renderer (ELK layout, architecture-diagrams presets)\n\n'
  printf 'One picture for the whole change instead of one per pair of directories, at most 830 px wide so GitHub does not scale it down. Laid out by [ELK](https://eclipse.dev/elk/) (layered, orthogonal edges, one box per directory) and drawn by [`scripts/render-svg.mjs`](https://github.com/%s/blob/%s/scripts/render-svg.mjs) in the *blueprint* preset (light) and the *terminal* preset (dark). Status is a colour and a word on every box. A moving dot follows each import that touches a changed file, in walk order from `src/http/routes.ts`.\n\n' "${GITHUB_REPOSITORY}" "${HEAD_SHA}"
  printf '<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="%s/own-dark.svg">\n  <img alt="%s" src="%s/own-light.svg" width="%s">\n</picture>\n\n' \
    "${ASSETS_URL}" "${OWN_ALT}" "${ASSETS_URL}" "${OWN_WIDTH}"
  printf '<sub>Open as SVG: <a href="%s/own-light.svg">light</a> · <a href="%s/own-dark.svg">dark</a></sub>\n\n' "${ASSETS_URL}" "${ASSETS_URL}"
  printf '### Same facts, drawn by Mermaid\n\n'
  cat "${WORK}/mermaid.md"
  printf '\n'
} > "${SECTION}"

# The PR Lens footer starts at its last horizontal rule; the extra sections go above it.
if [ -n "${SEPARATOR_LINE}" ]; then
  {
    head -n "$(( SEPARATOR_LINE - 1 ))" "${BODY}"
    cat "${SECTION}"
    tail -n +"${SEPARATOR_LINE}" "${BODY}"
  } > "${BODY}.next"
  mv "${BODY}.next" "${BODY}"
else
  printf '\n' >> "${BODY}"
  cat "${SECTION}" >> "${BODY}"
fi

TIMING_LINE="$(jq -r '"Generated in CI: graph \(.graphMs) ms · PR Lens install \(.prLensInstallMs) ms · validate \(.validateMs) ms · render \(.renderMs) ms · elkjs install \(.elkInstallMs) ms · own SVG \(.ownSvgMs) ms · Mermaid \(.mermaidMs) ms · model tokens: \(.modelTokens)"' "${WORK}/timings.json")"

cat >> "${BODY}" <<EOF

<sub>No model was called. Every box is a file from <code>git diff --name-status</code> or a direct import neighbour of one, and every arrow is an import statement, as parsed by <a href="https://github.com/${GITHUB_REPOSITORY}/blob/${HEAD_SHA}/scripts/build-graph.mjs">scripts/build-graph.mjs</a>. The line each one comes from: <a href="${ASSETS_URL}/facts.json">facts.json</a>.</sub>

<sub>${TIMING_LINE}</sub>
EOF

MARKER="$(cli comment --print-marker)"

gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --paginate --jq '.[]' \
  > "${WORK}/comments.jsonl"

# Anyone can type the marker, so only a comment this workflow's identity
# posted is ever edited.
MINE="$(jq -c --arg author "${COMMENT_AUTHOR}" --arg marker "${MARKER}" \
  'select(.user.login == $author) | select(.body | startswith($marker))' \
  "${WORK}/comments.jsonl" | head -n 1)"

if overtaken; then
  exit 0
fi

if [ -n "${MINE}" ]; then
  URL="$(jq -Rs '{body: .}' < "${BODY}" \
    | gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/$(printf '%s' "${MINE}" | jq -r '.id')" \
      --input - --jq .html_url)"
  echo "Updated ${URL}"
else
  URL="$(jq -Rs '{body: .}' < "${BODY}" \
    | gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --input - --jq .html_url)"
  echo "Posted ${URL}"
fi

echo "Diagram comment: ${URL}" >> "${GITHUB_STEP_SUMMARY}"
