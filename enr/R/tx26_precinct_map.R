# tx26_precinct_map.R
# Interactive 2026 U.S. Senate precinct map on OpenFreeMap. Pick the shading variable,
# the low / middle / high colors and the values they sit at.
# Needs: theo.R (builds tx26), data/cache/tlc_precincts26p.rds, theo/theo/tx_counties_cb_2024.rds
# Counties published outside the state feed: drop <county>_2026_precinct_results.csv into
# data/raw/county_precincts/ (baselines come from VEST via data/cache/ev_crosswalk_tlc26_vest24.rds)

library(dplyr); library(tidyr); library(sf); library(readr); library(stringr); library(shiny); library(mapgl)
library(colourpicker); library(ggplot2)
options(shiny.autoload.r = FALSE)

ROOT <- path.expand("~/TX_Model_26")
CK <- file.path(ROOT, "data/cache/tx26_precinct_map_layer.rds")
if (!exists("tx26")) source(file.path(ROOT, "theo.R"), chdir = TRUE)

# ---- 1. results and shading variables (shares in %, shifts in points) ----

v <- function(x) suppressWarnings(as.numeric(x))
two <- function(d, r) ifelse(d + r > 0, 100 * d / (d + r), NA_real_)

res <- tx26 |>
  transmute(id = toupper(trimws(id)), level, cnty,
            sd = v(`2026sd`), sr = v(`2026sr`), so = v(`2026so`), s_in = v(`2026sin`),
            gd = v(`2026gd`), gr = v(`2026gr`),
            p24d = v(`2024pld`), p24r = v(`2024plr`), p24o = v(`2024plo`),
            s24d = v(`2024sld`), s24r = v(`2024slr`),
            p20d = v(`2020pld`), p20r = v(`2020plr`),
            g22d = v(`2022gld`), g22r = v(`2022glr`)) |>
  mutate(votes26 = sd + sr + so, votes24 = p24d + p24r + p24o,
         tal_2p = two(sd, sr),
         shift_p24 = tal_2p - two(p24d, p24r),
         shift_s24 = tal_2p - two(s24d, s24r),
         shift_p20 = tal_2p - two(p20d, p20r),
         shift_g22 = tal_2p - two(g22d, g22r),
         vs_gov26 = tal_2p - two(gd, gr),
         turnout = ifelse(votes24 > 0, 100 * votes26 / votes24, NA_real_))

cat("Senate votes in tx26:", format(sum(res$votes26, na.rm = TRUE), big.mark = ","), "\n")

keep <- c("id", "cnty", "votes26", "s_in", "tal_2p", "shift_p24", "shift_s24",
          "shift_p20", "shift_g22", "vs_gov26", "turnout")

# ---- 2. geometry: precincts, plus county polygons for counties with no matched precincts ----

if (file.exists(CK)) {
  layer <- readRDS(CK)
} else {
  pg <- readRDS(file.path(ROOT, "data/cache/tlc_precincts26p.rds"))
  key <- intersect(c("PCTKEY", "CNTYVTD", "pctkey"), names(pg))[1]
  stopifnot(inherits(pg, "sf"), !is.na(key))
  pg <- pg |> transmute(id = stringr::str_pad(toupper(trimws(as.character(.data[[key]]))), 7, pad = "0"))
  if (anyDuplicated(pg$id)) pg <- pg |> group_by(id) |> summarise(.groups = "drop")

  prec <- res |> filter(level == "precinct")
  cat("id widths, tx26:"); print(table(nchar(prec$id)))
  cat("id widths, TLC: "); print(table(nchar(pg$id)))

  m <- inner_join(pg, prec, by = "id")
  un <- anti_join(prec, st_drop_geometry(pg), by = "id")
  cat("precincts matched:", nrow(m), "of", nrow(prec),
      "| unmatched Senate votes:", format(sum(un$votes26, na.rm = TRUE), big.mark = ","), "\n")
  print(head(sort(table(substr(un$id, 1, 3)), decreasing = TRUE), 10)) # counties with unmatched precincts
  stopifnot(nrow(m) > 6000)

  cty <- readRDS(file.path(ROOT, "theo/theo/tx_counties_cb_2024.rds")) |>
    transmute(fips3 = substr(GEOID, 3, 5))
  crow <- res |> filter(level == "county") |> mutate(fips3 = substr(id, 1, 3)) |>
    filter(!fips3 %in% substr(m$id, 1, 3))
  cat("county-only rows to shade:", nrow(crow), "| ids:", head(crow$id), "\n")
  stopifnot(all(crow$fips3 %in% cty$fips3))
  cm <- inner_join(cty, crow, by = "fips3")

  geo <- function(x) st_sf(st_drop_geometry(x)[keep], geometry = st_geometry(x))
  layer <- rbind(geo(m), geo(cm)) |>
    st_transform(3083) |>
    mutate(log_dens = log10(pmax(votes26, 0) / (as.numeric(st_area(geometry)) / 2589988) + 1)) |>
    st_simplify(preserveTopology = TRUE, dTolerance = 25) |>
    st_transform(4326)
  saveRDS(layer, CK)
}

# ---- 2a. historical baselines on 2026 precincts (vtd_history.rds -> TLC26 via the VEST24 crosswalk) ----

HB <- file.path(ROOT, "data/cache/hist_baselines_by_tlc26.rds")
if (file.exists(HB)) {
  HBL <- readRDS(HB)
} else {
  h <- readRDS(file.path(ROOT, "data/cache/vtd_history.rds"))
  rk <- h$races |> filter(year >= 2018) |> transmute(race_key, rk = sub(" ", "", race_key), year, label)
  wd <- h$vtd |> inner_join(rk[c("race_key", "rk")], by = "race_key") |>
    pivot_wider(id_cols = CNTYVTD, names_from = rk, values_from = c(d, r), names_glue = "{.value}{rk}")

  xw <- readRDS(file.path(ROOT, "data/cache/ev_crosswalk_tlc26_vest24.rds"))$xw |>
    transmute(id = tlc26_key, vest_key, weight)
  cat("history ids found in crosswalk:", round(mean(wd$CNTYVTD %in% xw$vest_key), 4),
      "| weight sums per TLC id:", range(tapply(xw$weight, xw$id, sum)), "\n")

  hb26 <- xw |> inner_join(wd, by = c("vest_key" = "CNTYVTD")) |> group_by(id) |>
    summarise(across(c(starts_with("d_"), starts_with("r_")), ~ sum(.x * weight)), .groups = "drop")
  hbc <- wd |> mutate(id = substr(CNTYVTD, 1, 3)) |> select(-CNTYVTD) |> group_by(id) |>
    summarise(across(everything(), ~ sum(.x, na.rm = TRUE)), .groups = "drop")
  cat("statewide check, 2020 president D/R: history table", sum(hbc$d_2020_president), sum(hbc$r_2020_president),
      "| on 2026 precincts", round(sum(hb26$d_2020_president, na.rm = TRUE)), round(sum(hb26$r_2020_president, na.rm = TRUE)), "\n")

  d24 <- foreign::read.dbf(file.path(ROOT, "data/raw/vest/extract/2024/tx_2024_gen_all_tx_vtd/tx_2024_gen_all_tx_vtd.dbf"), as.is = TRUE)
  vt24 <- data.frame(vest_key = gsub("[^A-Z0-9]", "", toupper(d24$UNIQUE_ID)),
                      tot24 = rowSums(d24[grep("^G24PRE", names(d24))])) |>
    group_by(vest_key) |> summarise(tot24 = sum(tot24), .groups = "drop")
  vt24 <- xw |> inner_join(vt24, by = "vest_key") |> group_by(id) |>
    summarise(tot24 = sum(tot24 * weight), .groups = "drop")

  HBL <- list(hb = bind_rows(hb26, hbc), rk = rk, vt24 = vt24)
  saveRDS(HBL, HB)
}
hb <- HBL$hb
vt24 <- HBL$vt24

# ---- 2b. counties added from county-published precinct files ----

CP_DIR <- file.path(ROOT, "data/raw/county_precincts")
cp_files <- list.files(CP_DIR, "_2026_precinct_results\\.csv$", full.names = TRUE)

if (length(cp_files)) {
  cfx <- tigris::fips_codes |> filter(state == "TX") |>
    transmute(key = str_remove_all(toupper(county), "COUNTY|[^A-Z]"), fips3 = county_code)
  pg <- readRDS(file.path(ROOT, "data/cache/tlc_precincts26p.rds"))
  pk <- intersect(c("PCTKEY", "CNTYVTD", "pctkey"), names(pg))[1]
  pg <- pg |> transmute(id = str_pad(toupper(trimws(as.character(.data[[pk]]))), 7, pad = "0"))

  add_county <- function(f) {
    x <- read_csv(f, col_types = cols(.default = "c"), progress = FALSE) |>
      filter(row_type %in% c("candidate", "write_in_total")) |>
      mutate(total = as.numeric(total), party = coalesce(party, ""))
    f3 <- cfx$fips3[cfx$key == str_remove_all(toupper(x$county[1]), "[^A-Z]")]
    stopifnot(length(f3) == 1)
    crow <- res |> filter(level == "county", id == f3)

    w <- x |>
      mutate(id = paste0(f3, str_pad(precinct, 4, pad = "0"))) |>
      group_by(id) |>
      summarise(sd = sum(total[contest == "US Senator" & party == "DEM"]),
                sr = sum(total[contest == "US Senator" & party == "REP"]),
                so = sum(total[contest == "US Senator" & !party %in% c("DEM", "REP")]),
                gd = sum(total[contest == "Governor" & party == "DEM"]),
                gr = sum(total[contest == "Governor" & party == "REP"]), .groups = "drop") |>
      mutate(cnty = if (nrow(crow)) crow$cnty else x$county[1], s_in = 100)

    cat(x$county[1], "| precincts:", nrow(w), "| Senate votes in file:", sum(w$sd + w$sr + w$so),
        "| tx26 county row:", if (nrow(crow)) crow$votes26 else NA, "\n")

    g <- inner_join(pg |> filter(substr(id, 1, 3) == f3),
                     w |> left_join(hb, by = "id") |> left_join(vt24, by = "id"), by = "id")
    miss <- setdiff(w$id, g$id)
    if (length(miss)) stop("no TLC boundary for: ", paste(miss, collapse = ", "))
    cat("  TLC precincts with no results:", setdiff(pg$id[substr(pg$id, 1, 3) == f3], w$id),
        "| no 2024 baseline:", sum(is.na(g$d_2024_president)),
        "| no 2020 baseline:", sum(is.na(g$d_2020_president)), "\n")

    g <- g |>
      mutate(votes26 = sd + sr + so, votes24 = tot24,
             tal_2p    = two(sd, sr),
             shift_p24 = tal_2p - two(d_2024_president, r_2024_president),
             shift_s24 = tal_2p - two(d_2024_us_senate, r_2024_us_senate),
             shift_p20 = tal_2p - two(d_2020_president, r_2020_president),
             shift_g22 = tal_2p - two(d_2022_governor, r_2022_governor),
             vs_gov26  = tal_2p - two(gd, gr),
             turnout   = ifelse(votes24 > 0, 100 * votes26 / votes24, NA_real_)) |>
      st_transform(3083) |>
      mutate(log_dens = log10(votes26 / (as.numeric(st_area(geometry)) / 2589988) + 1)) |>
      st_simplify(preserveTopology = TRUE, dTolerance = 25) |>
      st_transform(4326)

    list(f3 = f3, sf = st_sf(st_drop_geometry(g)[c(keep, "log_dens")], geometry = st_geometry(g)))
  }

  added <- lapply(cp_files, add_county)
  drop <- vapply(added, `[[`, "", "f3")
  layer <- rbind(layer[!(nchar(layer$id) == 3 & layer$id %in% drop), ],
                 do.call(rbind, lapply(added, `[[`, "sf")))
}

# ---- 2c. shift columns for every other statewide race, 2018-2024 ----

RX <- HBL$rk |>
  filter(!rk %in% c("2024_president", "2024_us_senate", "2020_president", "2022_governor")) |>
  arrange(desc(year), rk) |>
  mutate(col = paste0("sh_", rk), lab = make.unique(paste0(label, " (pts)")))

L <- st_drop_geometry(layer)[c("id", "tal_2p")] |> left_join(hb, by = "id")
stopifnot(nrow(L) == nrow(layer))
for (i in seq_len(nrow(RX)))
  layer[[RX$col[i]]] <- L$tal_2p - two(L[[paste0("d_", RX$rk[i])]], L[[paste0("r_", RX$rk[i])]])

cat("extra shift races:", nrow(RX), "| share of precinct rows with a value (2022 supreme_court_3):",
    round(mean(is.finite(layer$sh_2022_supreme_court_3[nchar(layer$id) == 7])), 3), "\n")

# surname composition, if the corrected surname run has written it
sf_file <- file.path(ROOT, "civix_cache/ge2026_surname_precinct.rds")
if (file.exists(sf_file)) {
  cat("surname file written:", format(file.mtime(sf_file)), "\n")
  layer <- layer |> left_join(readRDS(sf_file) |>
    transmute(id = toupper(id), hisp = 100 * sh_p_hisp, black = 100 * sh_p_black),
    by = "id")
}

cat("mapped Senate votes:", format(sum(layer$votes26, na.rm = TRUE), big.mark = ","), "\n")

f1 <- function(x, fmt) ifelse(is.na(x), "-", sprintf(fmt, x))
layer$tip <- sprintf(
  "<b>%s</b> %s<br>Talarico 2P: %s<br>vs 2024 president: %s<br>vs 2024 Senate: %s<br>vs 2026 governor: %s<br>Senate votes: %s",
  layer$cnty, layer$id, f1(layer$tal_2p, "%.1f%%"), f1(layer$shift_p24, "%+.1f"),
  f1(layer$shift_s24, "%+.1f"), f1(layer$vs_gov26, "%+.1f"), format(layer$votes26, big.mark = ","))

# ---- 3. variables, palettes, default ranges ----

layer$is_cty <- nchar(layer$id) == 3
layer$tip <- ifelse(layer$is_cty, paste0("<i>County total (no precinct returns)</i><br>", layer$tip), layer$tip)

VARS <- data.frame(
  group = c("2026 result", rep("Shift in Talarico share", 4), "Ticket", "Turnout", "Turnout"),
  label = c("Talarico two-party share (%)", "vs 2024 president (pts)", "vs 2024 Senate (pts)",
            "vs 2020 president (pts)", "vs 2022 governor (pts)", "Talarico minus 2026 governor (pts)",
            "Turnout vs 2024 (%)", "Votes per sq mi (log10)"),
  col = c("tal_2p", "shift_p24", "shift_s24", "shift_p20", "shift_g22", "vs_gov26", "turnout", "log_dens"),
  center = c(50, 0, 0, 0, 0, 0, 100, NA))
VARS <- rbind(VARS, data.frame(group = paste("Shift vs", RX$year, "other races"),
                                label = RX$lab, col = RX$col, center = 0))
if ("hisp" %in% names(layer)) VARS <- rbind(VARS, data.frame(
  group = "Voter composition (surnames)", label = c("Hispanic share of voters (%)", "Black share of voters (%)"),
  col = c("hisp", "black"), center = NA))

cat("county-only polygons with no value, by variable:\n")
print(colSums(is.na(st_drop_geometry(layer)[layer$is_cty, VARS$col])))

PALS <- list(
  "Red–blue"     = c("#B2182B", "#EF8A62", "#F7F7F7", "#67A9CF", "#2166AC"),
  "Purple–green" = c("#762A83", "#AF8DC3", "#F7F7F7", "#7FBF7B", "#1B7837"),
  "Orange–purple"= c("#B35806", "#F1A340", "#F7F7F7", "#998EC3", "#542788"),
  "Blues"        = c("#F7FBFF", "#C6DBEF", "#6BAED6", "#2171B5", "#08306B"),
  "Viridis"      = c("#440154", "#3B528B", "#21918C", "#5EC962", "#FDE725"),
  "Magma"        = c("#000004", "#51127C", "#B63679", "#FB8861", "#FCFDBF"))

vals_of <- function(col) { x <- st_drop_geometry(layer)[[col]]; x[is.finite(x)] }
rng_for <- function(col, center) {
  x <- vals_of(col)
  if (is.na(center)) unname(round(quantile(x, c(.02, .98)), 1))
  else { s <- ceiling(quantile(abs(x - center), .98)); c(center - s, center + s) }
}
lim_for <- function(col) { x <- vals_of(col); c(floor(min(x)), ceiling(max(x))) }

swatch <- function(n) tags$span(tags$span(style = sprintf(
  "display:inline-block;width:110px;height:11px;border-radius:2px;vertical-align:middle;margin-right:8px;background:linear-gradient(90deg,%s)",
  paste(PALS[[n]], collapse = ","))), n)

# ---- 4. app ----

ui <- fillPage(
  tags$style(HTML(".ctl{background:rgba(255,255,255,.94);border:1px solid #d6d6d6;border-radius:10px;padding:14px 16px;font-size:13px}
    .ctl .form-group{margin-bottom:8px} .ctl label{font-weight:500} .ctl .radio{margin:2px 0}")),
  maplibreOutput("map", height = "100%"),
  absolutePanel(class = "ctl", top = 12, left = 12, width = 290, draggable = TRUE,
    selectInput("var", "Shade by", split(VARS$label, factor(VARS$group, unique(VARS$group)))),
    radioButtons("pal", "Colors", choiceNames = c(lapply(names(PALS), swatch), list("Custom")),
                 choiceValues = c(names(PALS), "Custom"), selected = "Red–blue"),
    conditionalPanel("input.pal == 'Custom'",
      colourInput("c1", NULL, "#B2182B"), colourInput("c2", NULL, "#F7F7F7"), colourInput("c3", NULL, "#2166AC")),
    checkboxInput("rev", "Reverse", FALSE),
    sliderInput("rng", "Range", min = lim_for("tal_2p")[1], max = lim_for("tal_2p")[2],
                value = rng_for("tal_2p", 50), step = 0.5),
    plotOutput("hist", height = 60),
    sliderInput("op", "Opacity", 0, 1, 0.8, 0.05)))

server <- function(input, output, session) {
  v <- reactive(VARS[VARS$label == input$var, ])

  observeEvent(input$var, {
    r <- v(); lim <- lim_for(r$col)
    updateSliderInput(session, "rng", min = lim[1], max = lim[2], value = rng_for(r$col, r$center),
                       step = if (r$col == "log_dens") 0.1 else 0.5)
    if (input$pal != "Custom") updateRadioButtons(session, "pal", selected = if (is.na(r$center)) "Viridis" else "Red–blue")
  }, ignoreInit = TRUE)

  sc <- reactive({
    r <- v(); lo <- input$rng[1]; hi <- input$rng[2]; req(hi > lo)
    cols <- if (input$pal == "Custom") c(input$c1, input$c2, input$c3) else PALS[[input$pal]]
    if (isTRUE(input$rev)) cols <- rev(cols)
    n <- length(cols); k <- (n + 1) / 2
    vals <- if (!is.na(r$center) && r$center > lo && r$center < hi)
      c(seq(lo, r$center, length.out = k), seq(r$center, hi, length.out = k)[-1]) else seq(lo, hi, length.out = n)
    list(col = r$col, vals = vals, cols = cols, label = r$label)
  })

  fill <- function(s) interpolate(column = s$col, values = s$vals, stops = s$cols, na_color = "#cfcfcf")

  output$map <- renderMaplibre({
    s <- isolate(sc())
    maplibre(style = "https://tiles.openfreemap.org/styles/positron", bounds = layer) |>
      add_fill_layer(id = "prec", source = layer, fill_color = fill(s), fill_opacity = isolate(input$op),
                      fill_outline_color = "rgba(255,255,255,0.35)", tooltip = "tip") |>
      add_line_layer(id = "cty", source = layer[layer$is_cty, ], line_color = "#4a4a4a",
                      line_width = 1.2, line_dasharray = c(2, 1)) |>
      add_legend(s$label, values = round(s$vals, 1), colors = s$cols, type = "continuous", position = "bottom-left")
  })

  observe({
    s <- sc()
    maplibre_proxy("map") |> set_paint_property("prec", "fill-color", fill(s)) |>
      clear_legend() |>
      add_legend(s$label, values = round(s$vals, 1), colors = s$cols, type = "continuous", position = "bottom-left")
  })

  observe(maplibre_proxy("map") |> set_paint_property("prec", "fill-opacity", input$op))

  output$hist <- renderPlot({
    s <- sc(); d <- st_drop_geometry(layer)
    ok <- is.finite(d[[s$col]])
    df <- data.frame(x = pmin(pmax(d[[s$col]][ok], min(s$vals)), max(s$vals)), w = d$votes26[ok])
    ggplot(df, aes(x, weight = w, fill = after_stat(x))) +
      geom_histogram(bins = 40) +
      scale_fill_gradientn(colours = s$cols, values = scales::rescale(s$vals), limits = range(s$vals), guide = "none") +
      theme_void()
  }, bg = "transparent")
}

shinyApp(ui, server)
