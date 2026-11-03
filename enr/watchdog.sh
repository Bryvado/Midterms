#!/usr/bin/env bash
# Starts the ENR recorder, or restarts it when it is missing, hung or stale. Runs from .github/workflows/enr_watchdog.yml.
set -uo pipefail
# The window and the recorder's end time, in one place.
WINDOW_START="${WINDOW_START:-2026-11-03T23:30:00Z}"
WINDOW_END="${WINDOW_END:-2026-11-05T06:00:00Z}"
STALE_MIN=12
WORKFLOW=enr-recorder.yml
TEST_REPLAY="${TEST_REPLAY:-false}"; DRY_RUN="${DRY_RUN:-false}"; NOW_OVERRIDE="${NOW_OVERRIDE:-}"
REPO="${GITHUB_REPOSITORY:-Bryvado/Midterms}"
now=$(date -u +%s); [ -n "$NOW_OVERRIDE" ] && now=$(date -u -d "$NOW_OVERRIDE" +%s)
say() { echo "$*"; echo "- $*" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

if [ "$TEST_REPLAY" = true ]; then
  BRANCH=enr-replay; INPUTS=(-f source=replay -f replay_dir=enr/replay/sim_night_01 -f branch=enr-replay -f step=15)
else
  BRANCH=enr-2026; INPUTS=(-f source=live -f election=53815 -f branch=enr-2026 -f step=15 -f reset_trajectory=auto)
  if [ "$now" -lt "$(date -u -d "$WINDOW_START" +%s)" ] || [ "$now" -ge "$(date -u -d "$WINDOW_END" +%s)" ]; then
    say "Outside the window $WINDOW_START to $WINDOW_END (now $(date -u -d "@$now" +%FT%TZ)); nothing to do."; exit 0
  fi
fi

# Recorder runs for this branch (the run name ends "on <branch>)") that are queued or in progress, newest first, and the age of the newest one.
runs=$( { gh run list -R "$REPO" -w "$WORKFLOW" -s in_progress -L 20 --json databaseId,createdAt,url,displayTitle; gh run list -R "$REPO" -w "$WORKFLOW" -s queued -L 20 --json databaseId,createdAt,url,displayTitle; } | jq -s --arg b "on $BRANCH)" 'add | map(select(.displayTitle | endswith($b))) | sort_by(.createdAt) | reverse')
n_runs=$(jq length <<<"$runs")
run_age_min=$(jq -r --argjson now "$now" 'if length > 0 then (($now - (.[0].createdAt | fromdateiso8601)) / 60 | floor) else 99999 end' <<<"$runs")
# The newest commit on the results branch; a missing branch is "no commit yet".
commit_utc=$(gh api "repos/$REPO/commits/$BRANCH" --jq .commit.committer.date 2>/dev/null || true)
[[ "$commit_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || commit_utc=""
if [ -n "$commit_utc" ]; then commit_age_min=$(( (now - $(date -u -d "$commit_utc" +%s)) / 60 )); else commit_age_min=99999; fi
say "Recorder runs queued or in progress: $n_runs (newest started ${run_age_min} min ago). Newest $BRANCH commit: ${commit_utc:-none} (${commit_age_min} min old)."

# Healthy: a run exists and either the branch moved within the threshold or the newest run is still starting up.
reason=""
if [ "$n_runs" -eq 0 ]; then reason="no run"
elif [ "$commit_age_min" -ge "$STALE_MIN" ] && [ "$run_age_min" -ge "$STALE_MIN" ]; then reason="hung run"
fi
if [ -z "$reason" ]; then say "Healthy; nothing to do."; exit 0; fi
[ "$reason" = "no run" ] && [ -n "$commit_utc" ] && [ "$commit_age_min" -ge "$STALE_MIN" ] && reason="stale branch, no run"

if [ "$DRY_RUN" = true ]; then
  say "Dry run: reason '$reason'. Would cancel: $(jq -r 'map(.databaseId) | join(", ") | if . == "" then "none" else . end' <<<"$runs"). Would dispatch $WORKFLOW on main with ${INPUTS[*]}."; exit 0
fi
# A run that is in progress but has not moved the branch is hung: cancel it before starting a new one.
for id in $(jq -r '.[].databaseId' <<<"$runs"); do gh run cancel -R "$REPO" "$id" && say "Cancelled hung run $id."; done
dispatch() { gh workflow run -R "$REPO" "$WORKFLOW" --ref main "${INPUTS[@]}"; }
started=$(date -u +%FT%TZ)
dispatch && say "Dispatched $WORKFLOW (${INPUTS[*]}) for: $reason."
new_url=""
for attempt in 1 2; do
  sleep 120
  new_url=$(gh run list -R "$REPO" -w "$WORKFLOW" -e workflow_dispatch -L 10 --json createdAt,url | jq -r --arg t "$started" 'map(select(.createdAt >= $t)) | .[0].url // ""')
  [ -n "$new_url" ] && break
  [ "$attempt" = 1 ] && { say "No new run after 2 minutes; dispatching once more."; dispatch; }
done
say "New run: ${new_url:-not seen}"

# One issue collects every start and restart, so each one sends an email.
title="ENR recorder restarted"
body="$(date -u +%FT%TZ): started the recorder ($([ "$TEST_REPLAY" = true ] && echo "test replay on enr-replay" || echo "live on enr-2026")). Reason: $reason. Run: ${new_url:-not seen yet}. Watchdog run: ${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-local}"
issue=$(gh issue list -R "$REPO" --state open --search "in:title \"$title\"" --json number,title --jq "map(select(.title == \"$title\")) | .[0].number // empty")
if [ -n "$issue" ]; then gh issue comment -R "$REPO" "$issue" --body "$body"; else gh issue create -R "$REPO" --title "$title" --body "$body"; fi
[ -n "$new_url" ] || exit 1
