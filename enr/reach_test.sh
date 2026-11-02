#!/usr/bin/env bash
# Polls the SOS ENR endpoints from a runner and logs status, size, latency, cache headers and body hash per request.
set -uo pipefail
BASE="https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr"
UA="bryson-tx2026-research"
ROUNDS="${ROUNDS:-20}"; GAP="${GAP:-15}"
OUT="${OUT:-reach}"; mkdir -p "$OUT/bodies"
JAR="$OUT/cookies.txt"
CSV="$OUT/calls.csv"
echo "utc,round,endpoint,status,bytes,seconds,sha256,version,cache_control,etag,last_modified,age,cf_cache_status,cf_ray,conditional,cond_status" > "$CSV"
hdr() { grep -i "^$1:" "$2" | tail -1 | cut -d' ' -f2- | tr -d '\r",' ; }
call() {
  local round="$1" ep="$2" tag="$3" body="$OUT/bodies/$3.json" h="$OUT/bodies/$3.hdr"
  local w; w=$(curl -sS -A "$UA" -b "$JAR" -c "$JAR" -D "$h" -o "$body" -w '%{http_code} %{size_download} %{time_total}' "$BASE/$ep" 2>"$OUT/bodies/$tag.err") || w="000 0 0"
  read -r status bytes secs <<<"$w"
  local sha; sha=$(sha256sum "$body" 2>/dev/null | cut -c1-16)
  local ver=""; [[ "$tag" == header* && "$status" == 200 ]] && ver=$(jq -r '.Version // ""' "$body" 2>/dev/null)
  # Conditional request: replay any validator the server sent and record whether it answers 304.
  local et lm cond="" cst=""
  et=$(hdr etag "$h"); lm=$(hdr last-modified "$h")
  if [[ -n "$et" ]]; then cond="if-none-match"; cst=$(curl -sS -A "$UA" -b "$JAR" -o /dev/null -w '%{http_code}' -H "If-None-Match: \"$et\"" "$BASE/$ep"); 
  elif [[ -n "$lm" ]]; then cond="if-modified-since"; cst=$(curl -sS -A "$UA" -b "$JAR" -o /dev/null -w '%{http_code}' -H "If-Modified-Since: $lm" "$BASE/$ep"); fi
  printf '%s,%s,%s,%s,%s,%s,%s,%s,"%s",%s,"%s",%s,%s,%s,%s,%s\n' "$(date -u +%FT%TZ)" "$round" "$ep" "$status" "$bytes" "$secs" "$sha" "$ver" \
    "$(hdr cache-control "$h")" "$et" "$lm" "$(hdr age "$h")" "$(hdr cf-cache-status "$h")" "$(hdr cf-ray "$h")" "$cond" "$cst" >> "$CSV"
}
for r in $(seq 1 "$ROUNDS"); do
  start=$(date +%s)
  call "$r" electionConstants constants
  call "$r" election/53815 header53815
  call "$r" election/countyInfo/53813 county53813
  call "$r" election/countyInfo/53815 county53815
  if [[ "$r" == 1 ]]; then mkdir -p "$OUT/first"; cp "$OUT"/bodies/*.json "$OUT"/bodies/*.hdr "$OUT/first/"; fi
  left=$(( GAP - ($(date +%s) - start) )); (( r < ROUNDS && left > 0 )) && sleep "$left"
done
# Summary of what the first round returned.
{
  echo "## ENR reach test"
  echo; echo "Runner egress: $(curl -sS https://api.ipify.org 2>/dev/null || echo unknown)"
  echo; echo "### 2026 elections in electionConstants"
  jq -r '.upload' "$OUT/first/constants.json" | base64 -d | jq -r '.electionInfo["2026"] | to_entries[] | .key as $t | .value[] | "- \($t) \(.ID) \(.N) official=\(.O)"' 2>/dev/null || echo "could not decode"
  echo; echo "### election/53815 header"
  jq -r '"Version: \(.Version)\nFields: \(keys | join(", "))"' "$OUT/first/header53815.json" 2>/dev/null || head -c 300 "$OUT/first/header53815.json"
  jq -r '.Home' "$OUT/first/header53815.json" 2>/dev/null | base64 -d 2>/dev/null; echo
  echo; echo "### countyInfo/53815"
  echo "base64 bytes: $(stat -c %s "$OUT/first/county53815.json")"; echo "decoded bytes: $(jq -r .upload "$OUT/first/county53815.json" | base64 -d | wc -c)"
  echo; echo "### Per endpoint"
  echo '| endpoint | n | statuses | distinct bodies | distinct versions | median s | max s | bytes |'; echo '|---|---|---|---|---|---|---|---|'
  for ep in electionConstants election/53815 election/countyInfo/53813 election/countyInfo/53815; do
    awk -F, -v ep="$ep" '$3==ep' "$CSV" > "$OUT/ep.tmp"
    n=$(wc -l < "$OUT/ep.tmp"); st=$(cut -d, -f4 "$OUT/ep.tmp" | sort | uniq -c | awk '{printf "%s×%s ", $2, $1}')
    nb=$(cut -d, -f7 "$OUT/ep.tmp" | sort -u | wc -l); nv=$(cut -d, -f8 "$OUT/ep.tmp" | sort -u | tr '\n' ' ')
    med=$(cut -d, -f6 "$OUT/ep.tmp" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'); mx=$(cut -d, -f6 "$OUT/ep.tmp" | sort -n | tail -1)
    by=$(cut -d, -f5 "$OUT/ep.tmp" | sort -u | tr '\n' ' ')
    echo "| $ep | $n | $st | $nb | $nv | $med | $mx | $by |"
  done
  echo; echo "### Response headers, first round"
  for f in "$OUT"/first/*.hdr; do echo "**$(basename "$f" .hdr)**"; echo '```'; tr -d '\r' < "$f" | grep -viE '^set-cookie|^$'; echo '```'; done
} > "$OUT/summary.md"
cat "$OUT/summary.md"
echo; echo "calls.csv:"; cat "$CSV"
