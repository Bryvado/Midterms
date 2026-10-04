# Handoff: TX 2026 Senate dashboard (Bryvado/Midterms)

This note brings a new assistant up to speed on the repo, the rules it works under, what has shipped, and how to test changes. The owner is Bryson. Live site: https://bryvado.github.io/Midterms/

## What this repo is

A public dashboard for Bryson's Texas 2026 U.S. Senate forecast: James Talarico (D) vs Ken Paxton (R), with Ted Brown (L) on the ballot. The model is not here. It lives in Bryson's local R project (`~/TX_Model_26`), is run in RStudio, and depends on large local checkpoints that are never committed. This repo only receives the small exports that the local script `08_publish.R` writes into `data/published/`.

Stack: static site in `dashboard/` built with Vite and vanilla JS, MapLibre GL with PMTiles for the map, d3 (scale, shape, dsv, interpolate) for charts, OpenFreeMap basemaps. A GitHub Actions workflow (`.github/workflows/dashboard.yml`) builds and deploys to GitHub Pages on pushes to `main` that touch `data/published/**`, `dashboard/**`, `scripts/**` or the workflow. Tiles are built in CI by tippecanoe from the published geojson (`scripts/build_tiles.R` joins the CSVs onto the geometry).

## Hard rules (from Bryson's CLAUDE.md and instructions)

1. Never recreate, port or copy the pipeline scripts (01 to 08). If a task seems to need model code, stop and say so.
2. Never compute or re-derive a model quantity in dashboard code. Display, format, round, sort and reshape only. Every number comes from `data/published/`.
3. Never edit anything in `data/published/`. If a published number looks wrong, report it and stop. Do not patch around it.
4. The repo is public: no licensed data (Silver Bulletin ratings), raw CCES, API keys, or anything from the local cache.
5. The headline is the combined estimate (poll-only Kalman at election day, precision-weighted against a fundamentals prior, with polling-bias variance inflating the poll term). Never present the poll-only Kalman win probability as the headline. Never display any `win_prob` column from a kalman_daily_wp file. The retired "54.3%" simulation spec (mc_final_2026-09-02) must never appear.
6. Gates marked UNGATED are real states, not errors. Show them next to the quantity they affect.
7. Sub-state results are regional profiles (ACS and spatial VTD clusters), plus the county, congressional district and county subdivision levels that are now published.
8. The election-night live results monitor is out of scope until Bryson starts it. Do not scaffold it.
9. No geometry fetches (tigris etc.) in the build. Use relative paths.
10. Prose: plain and dense, no em-dash asides, no "not X, it's Y" reframes, no news-hook framing. Chart copy uses full words, sentence case, no abbreviations or symbols standing in for words.
11. R code conventions if any R is written: no `cat()`, accumulate report lines and print once at the end with the report block last, check `.x/.y` collisions after joins, no `saveRDS`/`ggsave` unless asked, label code for RStudio as CONSOLE or SCRIPT.
12. Working style: preflight checks in a separate turn from the main change; when the cause of a bug is not evident, give only the minimal diagnostic and wait; treat hypotheses as unconfirmed until output confirms; gate failures are fixed, never loosened.
13. Never force-push any branch without asking Bryson first.

## Published data contract

Read the real headers before coding against any file. Files in `data/published/`:

- `headline.csv` (combined estimate: mean, sd, P(Talarico wins), run date), `kalman_track.csv` (daily track with `mean`, `se`, projection and trajectory columns, `fund_weight`, `fund_mean`, `fund_appr_*`, `tx_net_approval`, shifts vs past races), `poll_ledger.csv` (44 polls: pollster, field dates, n, population LV/RV, mode, lean, margin, `talarico_2p`, `influence`, `brown_named`), `gates.csv`, `uniform_shift.csv`, `scenarios.csv`, `sensitivities.csv` (adopted row and the Texas-approval scenario row, with `p_talarico_win`), `forecast_history.csv`.
- Per level pairs: `county_*`, `cd_*`, `cousub_*`, `precinct_details.csv` with `regional_projections.csv`. `*_details.csv` has demographics, past vote counts and simulated 2026 ballots and votes. `*_projections.csv` has `region_label`, `mean`, `q05`, `q95`, `p_talarico`, baselines and `shift_*` columns.
- Geometry: `counties.geojson`, `regions.geojson` (precincts), `congressional_districts.geojson`, `county_subdivisions.geojson`.
- `sim_cloud*.csv` are published but no dashboard code uses them. Leave them alone.

If a file or column the dashboard needs is missing, say which and what columns, so Bryson can add it to 08_publish.R.

Known published oddities (report, do not patch): many county names have no spaces ("Elpaso", "Fortbend", "Mclennan", "Sansaba", "Jimwells", "Vanzandt"), which carries into subdivision labels. Precinct labels are "County 201, VTD 0130 (suburbs)" with the FIPS code only.

## Dashboard layout

`dashboard/src/`:

- `main.js`: boot, headline bar, Methods dialog, loads CSVs, wires map, chart, list and the scenario label.
- `map.js`: MapLibre map, unit switching (county, precinct, cd, cousub), shading controls and scales, diverging ramps (CIELAB, charcoal midpoint in dark mode), themes, legend, `marginColor` and `partyColor` exports, `viewBounds`, and the zoom-to-place listener.
- `chart.js`: the polling chart (SVG built by hand), layer legend and toggles, "?" popover, poll marks, tooltips, expanded dialog.
- `details.js`: the Selected place panel: place detail tables, shade-by-number links, and the list/detail switch with a Back to list button.
- `list.js`: the sortable, searchable list shown when no place is selected.
- `labels.js`: display-only shortening of place labels.
- `layout.js`: floating draggable and resizable panels (Controls, Legend, Display, Polling, Selected place), layout saved in `localStorage` key `tx-layout-v1`.
- `data.js`: fetch and parse helpers, `pct`, `count`, `signed`, `escapeHTML`.
- `dashboard/scripts/stage-data.mjs` copies published CSVs into `public/data/` and writes `bounds_<level>.json` bounding boxes from the geojson. `public/data/` is gitignored.

URL state: `u` (unit), `m` (measure), `sc` and related scale keys, `ct` (chart layer flags, default `11100`), `cx=all` (full range), `pd=1` (plain poll dots).

## What shipped this session (all merged to main)

- #28 Poll marks: y = `talarico_2p`, x = field midpoint with a whisker, fill = `margin` on the blue-red ramp (clamped at 8 points), radius by sqrt(n), circle for LV and diamond for RV, opacity by `influence`, dashed ring for D or R sponsors. 44 marks in the All range.
- #29 and #30 Legend and declutter: the "?" popover explains each mark and has a "Show polls as plain dots" checkbox. One-row layer legend (Polls, Average, Forecast on; Fundamentals, Texas-approval scenario off), collapsing to a Layers dropdown under 600px. A one-sentence caption pulls the fundamentals weights from `kalman_track.csv`. The Texas-approval scenario labels its endpoint with `p_talarico_win` from `sensitivities.csv`.
- #31 and #32 Place list: with no place selected the panel lists places (population, shares, income, registered voters, projected ballots, projected Talarico share, shifts vs 2024). Sortable, searchable, level follows the map or can be set independently, "Only places in the map view" filter, short display names, and clicking a row zooms the map to it.

## Open items and things to know

- The scenario table and the "why the forecast sits below the polls" paragraph were removed from the polling panel with the old caret section. Not restored. Ask Bryson where they should go if wanted.
- Published county names without spaces (see above) need fixing in 08_publish.R if unintended.
- Precinct labels lack county names in the published file; the dashboard maps the FIPS code to a name using `county_projections.csv`.
- No CI checks run on pull requests in this repo, so verify locally.

## How to work and test

Git: branch off `origin/main` for each change, open a draft PR, and Bryson marks it ready and merges. Commits and PR bodies end with the attribution lines the harness specifies. Never force-push without asking.

Local build: `cd dashboard && npm install && npm run build`. The build runs `prepare:data` then `vite build` into `dashboard/dist`. Tiles are built only in CI, so for local browser tests copy previously built `.pmtiles` files into `dist/` after each build.

Browser testing used Playwright with the preinstalled Chromium at `/opt/pw-browsers`, served by a small Node static server with HTTP range support (PMTiles needs range requests) mounted at `/Midterms/`. The basemap tiles load over the network, so launch Chromium with the proxy flags and `--ignore-certificate-errors` in the sandbox. Without the basemap, `map.loaded()` stays false and `fitBounds` does nothing.

PR descriptions include screenshots at desktop (1440) and phone (390) widths in light and dark, committed under `docs/screenshots/<topic>/` and linked by raw URL.

Checks to run on any chart or list change: counts match the published rows (44 polls, 254 counties, 38 districts, 862 subdivisions, 9,712 precincts), no page errors, light and dark both readable, and no number computed in the browser.
