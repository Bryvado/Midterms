#!/usr/bin/env bash
# Rebuilds every stored version of the results, raw payloads and live estimate from a results branch's history.
# Usage: enr/recover.sh [branch] [out_dir]    (defaults: enr-2026, recovered/<branch>)
set -euo pipefail
BRANCH="${1:-enr-2026}"; OUT="${2:-recovered/$BRANCH}"
git fetch -q origin "$BRANCH"
mkdir -p "$OUT/results" "$OUT/countyInfo" "$OUT/header" "$OUT/live"
n=0
while read -r sha when; do
  stamp=$(date -u -d "@$when" +%Y%m%dT%H%M%SZ)
  for pair in state/results.csv:results raw/countyInfo.json:countyInfo raw/header.json:header live/live.json:live; do
    path="${pair%%:*}"; dir="${pair##*:}"
    if git diff-tree --no-commit-id --name-only -r "$sha" | grep -qx "$path"; then
      git show "$sha:$path" > "$OUT/$dir/${stamp}_${sha:0:8}.${path##*.}"
    fi
  done
  n=$((n + 1))
done < <(git log --reverse --format='%H %ct' "origin/$BRANCH" -- state/results.csv raw/countyInfo.json raw/header.json live/live.json)
printf 'Recovered %d commits from %s into %s\n' "$n" "$BRANCH" "$OUT"
for d in results countyInfo header live; do printf '  %-10s %s files\n' "$d" "$(ls "$OUT/$d" | wc -l)"; done
