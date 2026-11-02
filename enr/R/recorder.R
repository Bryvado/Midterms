suppressPackageStartupMessages({ library(jsonlite); library(digest) })

arg <- function(name, default = NULL) {
  a <- commandArgs(trailingOnly = TRUE)
  hit <- grep(paste0("^--", name, "="), a, value = TRUE)
  if (length(hit)) sub(paste0("^--", name, "="), "", hit[1]) else default
}
cfg <- list(
  source      = arg("source", "live"),                       # live | replay
  election    = arg("election", "53815"),
  replay_dir  = arg("replay-dir", ""),
  store       = arg("store", "store"),                       # worktree of the results branch
  pack        = arg("pack", "enr/pack/enr_night_pack.rds"),
  estimator   = arg("estimator", "enr/R/enr_estimate.R"),
  step        = as.numeric(arg("step", "15")),               # seconds between header polls or replay snapshots
  county_max  = as.numeric(arg("county-max", "60")),         # countyInfo at least this often, seconds
  commit_max  = as.numeric(arg("commit-max", "300")),        # commit at least this often, seconds
  deploy_min  = as.numeric(arg("deploy-min", "60")),         # at most one deploy trigger per this many seconds
  handoff_at  = as.numeric(arg("handoff-at", "20700")),      # start the successor run after this many seconds (5h45m)
  stop_at     = as.numeric(arg("stop-at", "21000")),         # stop polling after this many seconds
  end_utc     = arg("end-utc", ""),                          # no successor is started after this time
  tail_wait   = as.numeric(arg("tail-wait", "300")),         # replay: seconds to keep watching the site after the last snapshot
  site        = arg("site", ""),                             # live.json URL on the published site, for latency
  push        = arg("push", "true") == "true",
  deploy      = arg("deploy", "true") == "true",
  run_id      = Sys.getenv("GITHUB_RUN_ID", "local"),
  run_attempt = Sys.getenv("GITHUB_RUN_ATTEMPT", "1"),
  branch      = arg("branch", "enr-2026"),
  workflow    = arg("workflow", "enr-recorder.yml"),
  ua          = "bryson-tx2026-research"
)
base_url <- "https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr"
t0 <- Sys.time()
now_utc <- function() format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC")
elapsed <- function() as.numeric(difftime(Sys.time(), t0, units = "secs"))
sp <- function(...) file.path(cfg$store, ...)
for (d in c("raw", "state", "log", "live")) dir.create(sp(d), showWarnings = FALSE, recursive = TRUE)
report <- character()

result_cols <- c("snapshot_utc", "county_num", "county_fips", "county_name", "office_id", "office_name", "office_type",
                 "cand_id", "cand_name", "cand_party", "votes", "votes_early", "race_votes_county", "reg_voters_county",
                 "precincts_reporting", "precincts_total")
append_csv <- function(df, path) {
  new <- !file.exists(path)
  write.table(df, path, sep = ",", row.names = FALSE, col.names = new, append = !new, qmethod = "double", na = "")
}
git <- function(...) suppressWarnings(system2("git", c("-C", cfg$store, ...), stdout = TRUE, stderr = TRUE))
git_ok <- function(...) { out <- git(...); s <- attr(out, "status"); is.null(s) || s == 0 }

# One HTTP GET through curl, returning status, seconds, bytes and the body path.
fetch <- function(url, out) {
  w <- suppressWarnings(system2("curl", c("-sS", "-m", "30", "-A", shQuote(cfg$ua), "-o", shQuote(out),
                                          "-w", shQuote("%{http_code} %{time_total} %{size_download}"), shQuote(url)), stdout = TRUE, stderr = FALSE))
  p <- strsplit(if (length(w)) w[length(w)] else "000 0 0", " ")[[1]]
  list(status = as.integer(p[1]), seconds = as.numeric(p[2]), bytes = as.numeric(p[3]), path = out)
}
# Header blocks are base64 JSON. Each is decoded to its JSON text, so the stored file and the hash see the content, not the encoding.
decode_header <- function(path) {
  h <- fromJSON(path, simplifyVector = FALSE)
  blocks <- lapply(h[setdiff(names(h), "Version")], function(x) tryCatch(rawToChar(base64_dec(x)), error = function(e) toJSON(x, auto_unbox = TRUE)))
  list(version = as.character(h$Version), blocks = blocks)
}
# Hash without the two fields that can move when no result has changed.
header_hash <- function(h) {
  home <- tryCatch({ x <- fromJSON(h$blocks$Home, simplifyVector = FALSE); x$LastUpdatedTime <- NULL; toJSON(x, auto_unbox = TRUE) }, error = function(e) h$blocks$Home)
  digest(paste(c(home, unlist(h$blocks[setdiff(names(h$blocks), "Home")])), collapse = "\n"), "xxhash64", serialize = FALSE)
}
header_text <- function(h) paste0("{\"Version\":", toJSON(h$version, auto_unbox = TRUE), paste0(",", vapply(names(h$blocks), function(k) toJSON(k, auto_unbox = TRUE), ""), ":", unlist(h$blocks), collapse = ""), "}")
text_hash <- function(txt) digest(txt, "xxhash64", serialize = FALSE)
# Stored pretty-printed by jq, uncompressed, so git keeps each version as a delta of the last.
write_json_text <- function(txt, path) {
  tmp <- tempfile(); writeLines(txt, tmp, useBytes = TRUE)
  ok <- suppressWarnings(system2("jq", c(".", tmp), stdout = path, stderr = FALSE))
  if (!identical(ok, 0L)) file.copy(tmp, path, overwrite = TRUE)
}

num <- function(x) if (is.null(x)) NA_real_ else suppressWarnings(as.numeric(x))
chr <- function(x) if (is.null(x)) NA_character_ else as.character(x)
# Statewide (SW) and federal (FD) races, one row per county x office x candidate, in a fixed order.
results_from_county <- function(ci, snap) {
  cols <- setNames(lapply(setdiff(result_cols, c("snapshot_utc", "county_fips")), function(x) vector("list", 0)), setdiff(result_cols, c("snapshot_utc", "county_fips")))
  for (cn in names(ci)) {
    cty <- ci[[cn]]
    for (r in cty$Races) {
      ot <- chr(r$OT)
      if (!ot %in% c("SW", "FD")) next
      n <- length(r$C)
      add <- list(county_num = rep(as.integer(cn), n), county_name = rep(chr(cty$N), n), office_id = rep(as.integer(r$OID), n),
                  office_name = rep(gsub("\\s+", " ", trimws(chr(r$N))), n), office_type = rep(ot, n),
                  cand_id = vapply(r$C, function(cd) as.integer(cd$id), 1L), cand_name = vapply(r$C, function(cd) chr(cd$N), ""),
                  cand_party = vapply(r$C, function(cd) chr(cd$P), ""), votes = vapply(r$C, function(cd) num(cd$V), 0),
                  votes_early = vapply(r$C, function(cd) num(cd$EV), 0), race_votes_county = rep(num(r$T), n), reg_voters_county = rep(num(r$OTRV), n),
                  precincts_reporting = rep(num(r$PR), n), precincts_total = rep(num(r$TP), n))
      for (k in names(add)) cols[[k]][[length(cols[[k]]) + 1L]] <- add[[k]]
    }
  }
  df <- as.data.frame(lapply(cols, unlist), stringsAsFactors = FALSE)
  df$county_fips <- sprintf("48%03d", 2L * df$county_num - 1L)
  df$snapshot_utc <- snap
  normalize(df[order(df$county_num, df$office_id, df$cand_id), result_cols])
}
num_cols <- c("county_num", "office_id", "cand_id", "votes", "votes_early", "race_votes_county", "reg_voters_county", "precincts_reporting", "precincts_total")
normalize <- function(df) {
  for (k in num_cols) df[[k]] <- suppressWarnings(as.numeric(df[[k]]))
  for (k in setdiff(result_cols, num_cols)) df[[k]] <- as.character(df[[k]])
  rownames(df) <- NULL
  df
}
# Replay snapshots carry a subset of the columns; the rest stay blank so the schema matches the live file.
pack_counties <- tryCatch(readRDS(cfg$pack)$county, error = function(e) NULL)
results_from_replay <- function(path) {
  df <- read.csv(path, colClasses = "character")
  for (k in setdiff(result_cols, names(df))) df[[k]] <- NA
  df$county_num <- (as.integer(substr(df$county_fips, 3, 5)) + 1L) / 2L
  if (!is.null(pack_counties)) df$county_name <- pack_counties$county[match(df$county_num, pack_counties$county_num)]
  normalize(df[order(df$county_num, df$office_type, df$office_name, df$cand_party), result_cols])
}
results_key <- function(df) paste(df$county_num, df$office_id, df$office_name, df$cand_id, df$cand_party, sep = "|")
results_hash <- function(df) digest(df[, setdiff(result_cols, "snapshot_utc")], "xxhash64")
# The estimator reads only the Senate rows, so it reruns only when they move.
senate_hash <- function(df) { k <- df$office_type == "FD" & gsub("\\s+", " ", trimws(df$office_name)) == "U. S. SENATOR"; results_hash(df[k, , drop = FALSE]) }

# One row per county x office x candidate whose count moved since the last snapshot. Election Day plus late = votes - early.
batches <- function(old, new) {
  if (is.null(old)) old <- new[0, ]
  m <- match(results_key(new), results_key(old))
  ov <- ifelse(is.na(m), 0, as.numeric(old$votes[m])); oe <- ifelse(is.na(m), 0, as.numeric(old$votes_early[m]))
  nv <- as.numeric(new$votes); ne <- as.numeric(new$votes_early)
  ov[is.na(ov)] <- 0; oe[is.na(oe)] <- 0; nv[is.na(nv)] <- 0; ne[is.na(ne)] <- 0
  d <- data.frame(snapshot_utc = new$snapshot_utc, prev_snapshot_utc = if (nrow(old)) old$snapshot_utc[1] else NA,
                  new[, c("county_num", "county_fips", "office_id", "office_name", "cand_id", "cand_party")],
                  d_votes = nv - ov, d_early = ne - oe, d_eday = (nv - ne) - (ov - oe), stringsAsFactors = FALSE)
  d$negative <- d$d_votes < 0 | d$d_early < 0 | d$d_eday < 0
  d[d$d_votes != 0 | d$d_early != 0, ]
}

log_call <- function(endpoint, f, hash, changed, version, note = "") {
  append_csv(data.frame(utc = now_utc(), run_id = cfg$run_id, endpoint = endpoint, status = f$status, seconds = f$seconds,
                        bytes = f$bytes, hash = hash, changed = changed, version = version, note = note), sp("log", "calls.csv"))
}
write_heartbeat <- function() {
  writeLines(toJSON(list(run_id = cfg$run_id, run_attempt = cfg$run_attempt, source = cfg$source, started_utc = format(t0, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                         last_utc = now_utc()), auto_unbox = TRUE, pretty = TRUE), sp("heartbeat"))
}
refspec <- function() sprintf("+refs/heads/%s:refs/remotes/origin/%s", cfg$branch, cfg$branch)
# A newer run has taken the branch when the heartbeat on the remote names another run.
superseded <- function() {
  if (!cfg$push) return(FALSE)
  if (!git_ok("fetch", "-q", "origin", refspec())) return(FALSE)
  hb <- tryCatch(fromJSON(paste(git("show", paste0("origin/", cfg$branch, ":heartbeat")), collapse = "\n")), error = function(e) NULL)
  !is.null(hb) && !identical(as.character(hb$run_id), cfg$run_id) && as.numeric(hb$run_id) > suppressWarnings(as.numeric(cfg$run_id))
}
commit <- function(msg) {
  write_heartbeat()
  git("add", "-A")
  if (git_ok("diff", "--cached", "--quiet")) return(NA)
  git("commit", "-q", "-m", shQuote(msg))
  if (!cfg$push) return(now_utc())
  if (superseded()) return("superseded")
  for (k in 1:4) {
    if (git_ok("push", "-q", "origin", paste0("HEAD:", cfg$branch))) return(now_utc())
    git("fetch", "-q", "origin", refspec())
    if (!git_ok("rebase", "-q", "-X", "theirs", paste0("origin/", cfg$branch))) git("rebase", "--abort")
    Sys.sleep(2^k)
  }
  NA
}
run_estimator <- function() {
  if (!file.exists(cfg$pack)) return(list(ok = FALSE, seconds = 0, msg = "no pack"))
  s <- Sys.time()
  out <- suppressWarnings(system2("Rscript", c(cfg$estimator, cfg$pack, sp("state", "results.csv"), sp("live")), stdout = TRUE, stderr = TRUE))
  st <- attr(out, "status")
  list(ok = is.null(st) || st == 0, seconds = as.numeric(difftime(Sys.time(), s, units = "secs")), msg = paste(tail(out, 3), collapse = " | "))
}
last_deploy <- -Inf; deploy_pending <- FALSE
trigger_deploy <- function() {
  if (!cfg$deploy) return(FALSE)
  if (elapsed() - last_deploy < cfg$deploy_min) { deploy_pending <<- TRUE; return(FALSE) }
  out <- suppressWarnings(system2("gh", c("workflow", "run", "enr-deploy.yml", "--ref", "main"), stdout = TRUE, stderr = TRUE))
  ok <- is.null(attr(out, "status"))
  if (ok) { last_deploy <<- elapsed(); deploy_pending <<- FALSE }
  append_csv(data.frame(utc = now_utc(), run_id = cfg$run_id, ok = ok, msg = paste(out, collapse = " ")), sp("log", "deploys.csv"))
  ok
}
# Snapshot time last seen on the published page, polled with a cache-busting query.
site_seen <- list()
poll_site <- function() {
  if (!nzchar(cfg$site)) return(invisible())
  f <- fetch(paste0(cfg$site, "?t=", as.integer(Sys.time())), tempfile())
  if (f$status != 200) return(invisible())
  snap <- tryCatch(fromJSON(f$path)$statewide$snapshot_utc, error = function(e) NULL)
  if (!is.null(snap) && is.null(site_seen[[snap]])) site_seen[[snap]] <<- now_utc()
}
wait_until <- function(t) repeat {
  left <- t - elapsed()
  if (left <= 0) break
  poll_site()
  Sys.sleep(min(3, max(0, t - elapsed())))
}

# Restore what the branch already holds, so a successor run continues the same series.
prev <- if (file.exists(sp("state", "results.csv"))) normalize(read.csv(sp("state", "results.csv"), colClasses = "character")) else NULL
prev_hash <- if (is.null(prev)) "" else results_hash(prev)
senate_prev <- if (is.null(prev) || !file.exists(sp("live", "live.json"))) "" else senate_hash(prev)
hdr_hash <- ""; ci_hash <- ""; version <- ""; version_at_ci <- ""; last_ci <- -Inf; last_commit <- elapsed()
timeline <- list(); n_changes <- 0L; n_ci_without_version <- 0L; n_negative <- 0L; handed_off <- FALSE
old_hb <- tryCatch(fromJSON(sp("heartbeat")), error = function(e) NULL)
if (identical(commit(sprintf("Run %s starts (%s)", cfg$run_id, cfg$source)), "superseded")) quit(status = 0)
# A predecessor that wrote within ten minutes is still polling: give it two steps to see this run's heartbeat and stop.
if (!is.null(old_hb) && !identical(as.character(old_hb$run_id), cfg$run_id) &&
    abs(as.numeric(difftime(Sys.time(), as.POSIXct(old_hb$last_utc, "UTC", format = "%Y-%m-%dT%H:%M:%OS"), units = "secs"))) < 600) Sys.sleep(2 * cfg$step)

snaps <- if (cfg$source == "replay") sort(list.files(cfg$replay_dir, pattern = "^snap_.*\\.csv$", full.names = TRUE)) else character()
i <- 0L
repeat {
  i <- i + 1L
  step_start <- elapsed()
  served <- now_utc()
  new <- NULL; changed_raw <- FALSE
  if (cfg$source == "replay") {
    if (i > length(snaps)) break
    new <- results_from_replay(snaps[i])
    log_call(paste0("replay:", basename(snaps[i])), list(status = 200L, seconds = 0, bytes = file.size(snaps[i])), "", TRUE, "")
  } else {
    f <- fetch(paste0(base_url, "/election/", cfg$election), tempfile(fileext = ".json"))
    h <- if (f$status == 200) tryCatch(decode_header(f$path), error = function(e) NULL) else NULL
    hh <- if (is.null(h)) "" else header_hash(h)
    v_new <- if (is.null(h)) version else h$version
    log_call("header", f, hh, nzchar(hh) && hh != hdr_hash, v_new)
    if (nzchar(hh) && hh != hdr_hash) { write_json_text(header_text(h), sp("raw", "header.json")); hdr_hash <- hh; changed_raw <- TRUE }
    version <- v_new
    if (version != version_at_ci || elapsed() - last_ci >= cfg$county_max) {
      g <- fetch(paste0(base_url, "/election/countyInfo/", cfg$election), tempfile(fileext = ".json"))
      txt <- if (g$status == 200) tryCatch(rawToChar(base64_dec(fromJSON(g$path)$upload)), error = function(e) NULL) else NULL
      ch <- if (is.null(txt)) "" else text_hash(txt)
      ci_changed <- nzchar(ch) && ch != ci_hash
      note <- if (ci_changed && nzchar(ci_hash) && version == version_at_ci) "countyInfo changed without a Version change" else ""
      if (nzchar(note)) n_ci_without_version <- n_ci_without_version + 1L
      log_call("countyInfo", g, ch, ci_changed, version, note)
      if (!is.null(txt)) { last_ci <- elapsed(); version_at_ci <- version }
      if (ci_changed) {
        ci <- tryCatch(fromJSON(txt, simplifyVector = FALSE), error = function(e) NULL)
        if (!is.null(ci)) {
          write_json_text(txt, sp("raw", "countyInfo.json")); ci_hash <- ch; changed_raw <- TRUE
          new <- results_from_county(ci, format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"))
        }
      }
    }
  }
  results_changed <- FALSE; senate_changed <- FALSE
  if (!is.null(new) && results_hash(new) != prev_hash) {
    b <- batches(prev, new)
    if (nrow(b)) { append_csv(b, sp("log", "batches.csv")); n_negative <- n_negative + sum(b$negative) }
    write.csv(new, sp("state", "results.csv"), row.names = FALSE, na = "")
    prev <- new; prev_hash <- results_hash(new); results_changed <- TRUE; n_changes <- n_changes + 1L
    sh <- senate_hash(new); senate_changed <- sh != senate_prev; senate_prev <- sh
  }
  est <- if (senate_changed) run_estimator() else NULL
  if (!is.null(est)) append_csv(data.frame(utc = now_utc(), snapshot_utc = prev$snapshot_utc[1], ok = est$ok, seconds = round(est$seconds, 2),
                                           msg = if (est$ok) "" else est$msg), sp("log", "estimator.csv"))
  committed <- NA
  if (results_changed || changed_raw || elapsed() - last_commit >= cfg$commit_max) {
    committed <- commit(if (results_changed) sprintf("Snapshot %s", prev$snapshot_utc[1]) else "Heartbeat")
    if (identical(committed, "superseded")) { report <- c(report, sprintf("Superseded by a newer run after %.0f s; stopping.", elapsed())); break }
    last_commit <- elapsed()
  }
  deployed <- FALSE
  if ((senate_changed && isTRUE(est$ok)) || (deploy_pending && elapsed() - last_deploy >= cfg$deploy_min)) deployed <- trigger_deploy()
  if (senate_changed) timeline[[prev$snapshot_utc[1]]] <- list(snapshot_utc = prev$snapshot_utc[1], served_utc = served,
    estimator_s = if (is.null(est)) NA else round(est$seconds, 2), committed_utc = if (is.character(committed)) committed else NA,
    deploy_triggered_utc = if (deployed) now_utc() else NA)
  if (cfg$source == "live" && !handed_off && elapsed() >= cfg$handoff_at && cfg$push &&
      (!nzchar(cfg$end_utc) || Sys.time() < as.POSIXct(cfg$end_utc, "UTC", format = "%Y-%m-%dT%H:%M:%S"))) {
    out <- suppressWarnings(system2("gh", c("workflow", "run", cfg$workflow, "--ref", "main", "-f", "source=live", "-f", paste0("election=", cfg$election),
                                            "-f", paste0("branch=", cfg$branch), "-f", paste0("end_utc=", cfg$end_utc), "-f", "reset_trajectory=false"), stdout = TRUE, stderr = TRUE))
    handed_off <- TRUE
    report <- c(report, sprintf("Successor requested at %.0f s: %s", elapsed(), paste(out, collapse = " ")))
  }
  if (cfg$source == "live" && elapsed() >= cfg$stop_at) break
  if (cfg$source == "live" && handed_off && i %% 4L == 0L && superseded()) { report <- c(report, "A newer run holds the heartbeat; stopping."); break }
  wait_until(step_start + cfg$step)
}
# Replay: keep the last deploy going and watch the site until the final snapshot shows or the wait runs out.
if (cfg$source == "replay") {
  last_snap <- if (is.null(prev)) "" else prev$snapshot_utc[1]
  end_wait <- elapsed() + cfg$tail_wait
  while (elapsed() < end_wait && (nzchar(cfg$site) && is.null(site_seen[[last_snap]]))) {
    if (deploy_pending && elapsed() - last_deploy >= cfg$deploy_min) trigger_deploy()
    wait_until(elapsed() + 3)
  }
}
lat <- do.call(rbind, lapply(timeline, function(r) { r$page_seen_utc <- if (is.null(site_seen[[r$snapshot_utc]])) NA else site_seen[[r$snapshot_utc]]; as.data.frame(r, stringsAsFactors = FALSE) }))
if (!is.null(lat) && nrow(lat)) {
  secs <- function(a, b) as.numeric(difftime(as.POSIXct(b, "UTC", format = "%Y-%m-%dT%H:%M:%OS"), as.POSIXct(a, "UTC", format = "%Y-%m-%dT%H:%M:%OS"), units = "secs"))
  lat$commit_s <- round(secs(lat$served_utc, lat$committed_utc), 1)
  lat$page_s <- round(secs(lat$served_utc, lat$page_seen_utc), 1)
  lat$run_id <- cfg$run_id
  append_csv(lat, sp("log", "latency.csv"))
  seen <- lat$page_s[!is.na(lat$page_s)]
  report <- c(report, sprintf("Snapshots with changed results: %d. Estimator median %.1f s, max %.1f s.", nrow(lat), median(lat$estimator_s, na.rm = TRUE), max(lat$estimator_s, na.rm = TRUE)),
              sprintf("Served to pushed: median %.1f s, max %.1f s.", median(lat$commit_s, na.rm = TRUE), max(lat$commit_s, na.rm = TRUE)),
              if (length(seen)) sprintf("Served to page: %d of %d snapshots seen on the site; median %.0f s, min %.0f s, max %.0f s.", length(seen), nrow(lat), median(seen), min(seen), max(seen))
              else "Served to page: no snapshot was seen on the site.")
}
invisible(commit(sprintf("Run %s ends (%s)", cfg$run_id, cfg$source)))
report <- c(sprintf("Run %s, source %s, %.0f s, %d polls or snapshots.", cfg$run_id, cfg$source, elapsed(), if (cfg$source == "replay") i - 1L else i),
            report, sprintf("countyInfo changed without a Version change: %d times. Negative deltas: %d rows.", n_ci_without_version, n_negative))
writeLines(report)
