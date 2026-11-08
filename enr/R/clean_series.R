suppressPackageStartupMessages({ library(dplyr) })
options(scipen = 100)

# Usage: Rscript enr/R/clean_series.R <recovered results dir> <out dir> [county_fips.csv]
a <- commandArgs(trailingOnly = TRUE)
in_dir <- a[1]; out_dir <- a[2]; lookup_path <- if (length(a) >= 3) a[3] else "enr/county_fips.csv"
files <- sort(list.files(in_dir, pattern = "\\.csv$", full.names = TRUE))
num_cols <- c("county_num", "office_id", "cand_id", "votes", "votes_early", "race_votes_county", "reg_voters_county", "precincts_reporting", "precincts_total")
masked_cols <- c("votes", "votes_early", "race_votes_county", "precincts_reporting")
read_snap <- function(f) { d <- read.csv(f, colClasses = "character"); for (k in num_cols) d[[k]] <- as.numeric(d[[k]]); d }
snaps <- lapply(files, read_snap)
result_cols <- names(snaps[[1]])

# County FIPS from the name (letters only, uppercase), not from the SOS county number.
county_key <- function(x) gsub("[^A-Z]", "", toupper(x))
lookup <- read.csv(lookup_path, colClasses = "character")
fips_of <- function(name) lookup$county_fips[match(county_key(name), county_key(lookup$county_name))]
unmatched <- unique(unlist(lapply(snaps, function(d) d$county_name[is.na(fips_of(d$county_name))])))
fips_changed <- unique(subset(snaps[[length(snaps)]], county_fips != fips_of(county_name), c(county_name, county_fips)))
snaps <- lapply(snaps, function(d) { d$county_fips <- fips_of(d$county_name); d })

# Every snapshot must list the same county x office x candidate rows in the same order, so rows line up by position.
row_key <- function(d) paste(d$county_num, d$office_id, d$cand_id, sep = "|")
keys_aligned <- all(vapply(snaps, function(d) identical(row_key(d), row_key(snaps[[1]])), TRUE))
fin <- snaps[[length(snaps)]]
group <- paste(fin$county_num, fin$office_id, sep = "|")
# 2,500 votes separates the night's double counts (smallest: Upshur, 8,087) from ordinary revisions (largest: Nueces, 1,351).
THRESHOLD <- 2500
limit <- function(final) final + THRESHOLD

# A county x office is bad in a snapshot when any candidate's votes or early votes exceed the final value by more than THRESHOLD.
# Its rows then take the masked columns from that county x office's last good snapshot.
last_good <- fin[, masked_cols]; last_good[] <- NA
clean <- vector("list", length(snaps)); flag_rows <- list()
for (i in seq_along(snaps)) {
  d <- snaps[[i]]
  over <- (!is.na(d$votes) & d$votes > limit(fin$votes)) | (!is.na(d$votes_early) & d$votes_early > limit(fin$votes_early))
  bad_groups <- unique(group[over])
  bad <- group %in% bad_groups
  if (length(bad_groups)) {
    excess <- pmax(d$votes - fin$votes, d$votes_early - fin$votes_early, na.rm = TRUE)
    flag_rows[[length(flag_rows) + 1]] <- data.frame(snapshot_utc = d$snapshot_utc[1], source_file = basename(files[i]), county_fips = d$county_fips,
                                                     county_name = d$county_name, office_name = d$office_name, group = group, over = over, excess = excess) |>
      filter(group %in% bad_groups) |>
      group_by(snapshot_utc, source_file, county_fips, county_name, office_name) |>
      summarise(candidates_over = sum(over), max_excess = max(excess), .groups = "drop")
  }
  for (k in masked_cols) d[[k]][bad] <- last_good[[k]][bad]
  for (k in masked_cols) last_good[[k]][!bad] <- snaps[[i]][[k]][!bad]
  clean[[i]] <- d
}
flags <- bind_rows(flag_rows)
flags <- if (nrow(flags)) arrange(flags, office_name, county_name, snapshot_utc) else flags

# One window per run of consecutive flagged snapshots for a county x office; cleared_utc is the first good snapshot after it.
snap_index <- setNames(seq_along(snaps), vapply(snaps, function(d) d$snapshot_utc[1], ""))
windows <- flags |>
  mutate(i = snap_index[snapshot_utc]) |>
  group_by(office_name, county_name) |>
  mutate(run = cumsum(c(1, diff(i) != 1))) |>
  group_by(office_name, county_name, county_fips, run) |>
  summarise(start_utc = first(snapshot_utc), end_utc = last(snapshot_utc), cleared_utc = names(snap_index)[max(i) + 1], snapshots = n(),
            max_excess = max(max_excess), .groups = "drop") |>
  select(-run) |>
  arrange(office_name, start_utc)

senate <- "U. S. SENATOR"
required <- c("STARR", "UPSHUR", "DALLAS", "GUADALUPE", "FORT BEND")
senate_flagged <- unique(windows$county_name[windows$office_name == senate])
gates <- c(
  all_names_match = length(unmatched) == 0,
  rows_aligned = keys_aligned,
  final_votes_unchanged = identical(clean[[length(clean)]]$votes, snaps[[length(snaps)]]$votes) &&
    identical(clean[[length(clean)]]$votes_early, snaps[[length(snaps)]]$votes_early),
  no_na_votes = all(vapply(clean, function(d) !anyNA(d$votes), TRUE)),
  same_snapshot_count = length(clean) == length(files),
  senate_flagged_exactly = setequal(senate_flagged, required)
)

if (all(gates)) {
  dir.create(file.path(out_dir, "results"), recursive = TRUE, showWarnings = FALSE)
  for (i in seq_along(clean)) write.csv(clean[[i]][, result_cols], file.path(out_dir, "results", basename(files[i])), row.names = FALSE, na = "")
  write.csv(flags, file.path(out_dir, "flags.csv"), row.names = FALSE, na = "")
  write.csv(windows, file.path(out_dir, "windows.csv"), row.names = FALSE, na = "")
}

report <- c(
  sprintf("Snapshots in %d, out %d (%s to %s)", length(files), length(clean), snaps[[1]]$snapshot_utc[1], fin$snapshot_utc[1]),
  sprintf("County FIPS corrected for %d counties: %s", nrow(fips_changed), paste(sprintf("%s %s->%s", fips_changed$county_name, fips_changed$county_fips, fips_of(fips_changed$county_name)), collapse = ", ")),
  sprintf("Flagged county x office x snapshot cells: %d, in %d windows across %d offices", nrow(flags), nrow(windows), length(unique(windows$office_name))),
  if (!setequal(senate_flagged, required)) paste("Senate counties flagged:", paste(sort(senate_flagged), collapse = ", ")),
  "All flagged windows (UTC):",
  capture.output(print(as.data.frame(windows[, c("office_name", "county_name", "start_utc", "end_utc", "cleared_utc", "snapshots", "max_excess")]), row.names = FALSE)),
  "Senate windows (UTC):",
  capture.output(print(as.data.frame(windows[windows$office_name == senate, c("county_name", "start_utc", "end_utc", "cleared_utc", "snapshots", "max_excess")]), row.names = FALSE)),
  "Gates:", sprintf("  %-26s %s", names(gates), ifelse(gates, "pass", "FAIL")),
  if (length(unmatched)) paste("Unmatched county names:", paste(unmatched, collapse = ", ")),
  if (all(gates)) paste("Wrote", length(clean), "snapshots to", file.path(out_dir, "results")) else "Nothing written."
)
writeLines(report)
if (!all(gates)) quit(status = 1)
