#!/usr/bin/env bash
# Re-run the 3-way merge for currently conflicted files with line endings normalized to LF.
# The repo mixes CRLF and LF, so git often reports whole-file conflicts where only a few lines differ.
# Usage (during a conflicted `git merge <branch>`):  scripts/dev/eol-merge.sh <branch>
# Files that still conflict keep standard <<<<<<< markers for manual resolution.
set -euo pipefail
branch="$1"
base=$(git merge-base HEAD "$branch")
tmp=$(mktemp -d)
for f in $(git diff --name-only --diff-filter=U); do
  n=$(echo "$f" | tr '/' '_')
  git show "$base:$f" 2>/dev/null | tr -d '\r' > "$tmp/$n.base" || : > "$tmp/$n.base"
  git show "HEAD:$f" | tr -d '\r' > "$tmp/$n.ours"
  git show "$branch:$f" | tr -d '\r' > "$tmp/$n.theirs"
  cp "$tmp/$n.ours" "$tmp/$n.out"
  if git merge-file -L ours -L base -L theirs "$tmp/$n.out" "$tmp/$n.base" "$tmp/$n.theirs"; then
    echo "clean     $f"
  else
    echo "CONFLICT  $f"
  fi
  cp "$tmp/$n.out" "$f"
done
rm -rf "$tmp"
