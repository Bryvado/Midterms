here::i_am("scripts/build_tiles.R")
library(dplyr)
library(readr)
library(sf)

args <- commandArgs(trailingOnly = TRUE)
out_geojson <- args[1]
geo_file <- if (length(args) >= 2) args[2] else "regions.geojson"
csv_file <- if (length(args) >= 3) args[3] else "regional_projections.csv"
unit <- if (length(args) >= 4) args[4] else "precinct"
report <- character()

regions <- st_read(here::here("data", "published", geo_file), quiet = TRUE) |>
  mutate(region_id = as.character(region_id)) |>
  select(region_id)
proj <- read_csv(here::here("data", "published", csv_file),
                 col_types = cols(region_id = col_character(), region_label = col_character(),
                                  profile = col_character(), .default = col_double()))
details_file <- paste0(unit, "_details.csv")
actual <- read_csv(here::here("data", "published", details_file),
                   col_types = cols(region_id = col_character(), .default = col_guess()),
                   show_col_types = FALSE) |>
  select(-any_of(c("profile", "demographics_imputed")))

unmatched_proj <- anti_join(proj, st_drop_geometry(regions), by = "region_id")
unmatched_feat <- anti_join(st_drop_geometry(regions), proj, by = "region_id")
dup_ids <- sum(duplicated(proj$region_id)) + sum(duplicated(regions$region_id))
actual_unmatched <- anti_join(proj, actual, by = "region_id")
actual_dup_ids <- sum(duplicated(actual$region_id))

joined <- inner_join(regions, proj, by = "region_id") |>
  left_join(actual, by = "region_id") |>
  select(-any_of("profile")) |>
  mutate(across(where(is.numeric), ~ round(.x, 4)))
collisions <- grep("\\.(x|y)$", names(joined), value = TRUE)

gate_ok <- nrow(unmatched_proj) == 0 && dup_ids == 0 && length(collisions) == 0 &&
  nrow(actual_unmatched) == 0 && actual_dup_ids == 0 && all(!is.na(joined$dem_pres24))

report <- c(report,
  sprintf("%s + %s", geo_file, csv_file),
  sprintf("features: %d, projection rows: %d, joined: %d", nrow(regions), nrow(proj), nrow(joined)),
  sprintf("projection rows without a feature: %d", nrow(unmatched_proj)),
  sprintf("features without a projection row: %d", nrow(unmatched_feat)),
  sprintf("projection rows without 2024 Harris votes: %d", nrow(actual_unmatched)),
  sprintf("duplicate detail ids: %d", actual_dup_ids),
  sprintf("duplicated region_id: %d", dup_ids),
  sprintf("join column collisions: %s", if (length(collisions)) paste(collisions, collapse = ", ") else "none"))

if (gate_ok) {
  st_write(st_transform(joined, 4326), out_geojson, driver = "GeoJSON",
           delete_dsn = TRUE, quiet = TRUE)
}

writeLines(report)
if (!gate_ok) stop("regions join gate failed; first unmatched projection ids: ",
                   paste(head(c(unmatched_proj$region_id, actual_unmatched$region_id), 10), collapse = ", "))
