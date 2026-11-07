suppressPackageStartupMessages({ library(jsonlite) })

# Usage: Rscript enr/R/observed_tallies.R <results.csv> <live dir>
# Writes observed.json: raw statewide Senate counts by vote type from one snapshot, no estimates.
a <- commandArgs(trailingOnly = TRUE)
d <- read.csv(a[1], colClasses = "character")
d <- d[gsub("\\s+", " ", trimws(d$office_name)) == "U. S. SENATOR", ]
for (k in c("votes", "votes_early")) d[[k]] <- as.numeric(d[[k]])
party <- function(p, col) sum(col[d$cand_party == p])
eday <- d$votes - d$votes_early
tally <- function(col) list(dem = party("DEM", col), rep = party("REP", col), all = sum(col),
                            dem_2p = party("DEM", col) / (party("DEM", col) + party("REP", col)))
gates <- c(no_na = !anyNA(d$votes) && !anyNA(d$votes_early), has_rows = nrow(d) > 0, early_le_total = all(d$votes_early <= d$votes))
out <- list(snapshot_utc = max(d$snapshot_utc), office = "U. S. SENATOR", early = tally(d$votes_early), eday_late = tally(eday), total = tally(d$votes))
if (all(gates)) write_json(out, file.path(a[2], "observed.json"), auto_unbox = TRUE, digits = 8)

report <- c(sprintf("observed.json for %s: early %.4f, Election Day + late %.4f, total %.4f (Talarico two-party share)",
                    out$snapshot_utc, out$early$dem_2p, out$eday_late$dem_2p, out$total$dem_2p),
            sprintf("  gate %-15s %s", names(gates), ifelse(gates, "pass", "FAIL")))
writeLines(report)
if (!all(gates)) quit(status = 1)
