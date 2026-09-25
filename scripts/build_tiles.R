here::i_am("scripts/build_tiles.R")
library(dplyr)
library(readr)
library(sf)

args <- commandArgs(trailingOnly = TRUE)
out_geojson <- args[1]
report <- character()

regions <- st_read(here::here("data", "published", "regions.geojson"), quiet = TRUE) |>
  mutate(region_id = as.character(region_id)) |>
  select(region_id)
proj <- read_csv(here::here("data", "published", "regional_projections.csv"),
                 col_types = cols(region_id = col_character(), region_label = col_character(),
                                  profile = col_character(), .default = col_double()))

unmatched_proj <- anti_join(proj, st_drop_geometry(regions), by = "region_id")
unmatched_feat <- anti_join(st_drop_geometry(regions), proj, by = "region_id")
dup_ids <- sum(duplicated(proj$region_id)) + sum(duplicated(regions$region_id))

joined <- inner_join(regions, proj, by = "region_id") |>
  select(-any_of("profile")) |>
  mutate(across(where(is.numeric), ~ round(.x, 4)))
collisions <- grep("\\.(x|y)$", names(joined), value = TRUE)

gate_ok <- nrow(unmatched_proj) == 0 && dup_ids == 0 && length(collisions) == 0

report <- c(report,
  sprintf("features: %d, projection rows: %d, joined: %d", nrow(regions), nrow(proj), nrow(joined)),
  sprintf("projection rows without a feature: %d", nrow(unmatched_proj)),
  sprintf("features without a projection row: %d", nrow(unmatched_feat)),
  sprintf("duplicated region_id: %d", dup_ids),
  sprintf("join column collisions: %s", if (length(collisions)) paste(collisions, collapse = ", ") else "none"))

if (gate_ok) st_write(st_transform(joined, 4326), out_geojson, driver = "GeoJSON",
                      delete_dsn = TRUE, quiet = TRUE)

writeLines(report)
if (!gate_ok) stop("regions join gate failed; first unmatched projection ids: ",
                   paste(head(unmatched_proj$region_id, 10), collapse = ", "))
