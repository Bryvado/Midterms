#!/usr/bin/env bash
# Rebuilds live.json and trajectory.json from a cleaned snapshot series, starting from an empty live dir.
# Usage: enr/rebuild_live.sh <cleaned results dir> <live dir> [pack] [estimator]
# A snapshot whose Senate rows match the previous one is skipped, as the recorder does, so a re-recorded
# snapshot at a run start adds no trajectory point. observed.json holds the final snapshot's raw Senate tallies.
set -euo pipefail
IN="$1"; LIVE="$2"; PACK="${3:-enr/pack/enr_night_pack.rds}"; EST="${4:-enr/R/enr_estimate.R}"
rm -rf "$LIVE"; mkdir -p "$LIVE"
prev=""; ran=0; skipped=()
for f in $(ls "$IN"/*.csv | sort); do
  h=$(grep '"U. S. SENATOR"' "$f" | cut -d, -f2- | md5sum | cut -c1-32)
  if [ "$h" = "$prev" ]; then skipped+=("$(basename "$f")"); continue; fi
  Rscript "$EST" "$PACK" "$f" "$LIVE" > /dev/null
  prev="$h"; ran=$((ran + 1)); last="$f"
done
Rscript enr/R/observed_tallies.R "$last" "$LIVE"
printf 'Estimator runs: %d. Skipped (Senate rows unchanged): %d %s\n' "$ran" "${#skipped[@]}" "${skipped[*]:-}"
jq -c '.statewide | {snapshot_utc, tal_2p_mean, votes_counted, counties_complete}' "$LIVE/live.json"
printf 'Trajectory points: %s\n' "$(jq length "$LIVE/trajectory.json")"
