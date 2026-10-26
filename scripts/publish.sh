#!/usr/bin/env bash
#
# Commits a render to the data branch: an orphan branch that holds no code,
# one directory per pull request per head commit.
#
# Adapted from PR Lens, packages/action/scripts/publish.sh
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
DATA_BRANCH="${DATA_BRANCH:-pr-diagrams}"
DIRECTORY="pr/${PR_NUMBER}/${HEAD_SHA}"
WORKSPACE="${RUNNER_TEMP}/pr-diagram-publish"
PUSHED=""

for ATTEMPT in 1 2 3 4 5; do
  rm -rf "${WORKSPACE}"
  mkdir -p "${WORKSPACE}"
  cd "${WORKSPACE}"

  git init --quiet
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

  if git fetch --quiet --depth=1 origin "${DATA_BRANCH}" 2>/dev/null; then
    git checkout --quiet -b "${DATA_BRANCH}" FETCH_HEAD
  else
    git checkout --quiet --orphan "${DATA_BRANCH}"
  fi

  mkdir -p "${DIRECTORY}"
  cp "${WORK}"/assets/*.svg "${DIRECTORY}/"
  cp "${WORK}/graph.json" "${WORK}/facts.json" "${WORK}/timings.json" "${DIRECTORY}/"
  git add "${DIRECTORY}"

  if git diff --quiet --cached; then
    echo "This render is already published."
    PUSHED="already"
    break
  fi

  git commit --quiet -m "Diagrams for #${PR_NUMBER} at ${HEAD_SHA}"

  if git push --quiet origin "${DATA_BRANCH}"; then
    PUSHED="yes"
    break
  fi

  echo "${DATA_BRANCH} moved under this run; retrying (${ATTEMPT}/5)."
  sleep "$(( ATTEMPT * 3 ))"
done

if [ -z "${PUSHED}" ]; then
  echo "::error::Could not publish the diagrams: ${DATA_BRANCH} kept moving."
  exit 1
fi

# Public repository: raw.githubusercontent.com answers directly with the SVG.
echo "assets-url=https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${DATA_BRANCH}/${DIRECTORY}" >> "${GITHUB_OUTPUT}"
