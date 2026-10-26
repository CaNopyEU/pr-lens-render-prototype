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
SECTION="${WORK}/mermaid-section.md"

{
  printf '### Same facts, drawn by Mermaid\n\n'
  cat "${WORK}/mermaid.md"
  printf '\n'
} > "${SECTION}"

# The PR Lens footer starts at its last horizontal rule; the Mermaid section goes above it.
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

TIMING_LINE="$(jq -r '"Generated in CI: graph \(.graphMs) ms · PR Lens install \(.prLensInstallMs) ms · validate \(.validateMs) ms · render \(.renderMs) ms · Mermaid \(.mermaidMs) ms · model tokens: \(.modelTokens)"' "${WORK}/timings.json")"

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
