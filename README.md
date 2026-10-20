# Texas 2026 Senate forecast explorer

Static GitHub Pages dashboard at [bryvado.github.io/Midterms](https://bryvado.github.io/Midterms/). The R model publishes CSV and GeoJSON files into `data/published/`. The browser UI in `dashboard/` reads those published files; it does not run the model.

## Local UI development

```sh
cd dashboard
npm ci
npm run dev
```

`npm run dev` stages the published CSVs into an ignored `dashboard/public/data/` directory. To preview the map locally, put `regions.pmtiles`, `counties.pmtiles`, `districts.pmtiles`, `cousubs.pmtiles` and `pumas.pmtiles` in `dashboard/public/`; GitHub Actions produces them during deployment. The summary, polling chart, and the methodology page can be developed without local tiles.

Run `npm run build` in `dashboard/` to create the static site in `dashboard/dist/`. The Vite build uses `/Midterms/` for GitHub Pages asset paths. The deployed map uses MapLibre GL JS with PMTiles; the polling chart is a responsive SVG component.

## Publishing

Push dashboard changes or published data to `main`. [The Pages workflow](.github/workflows/dashboard.yml) builds the UI, joins projections and place details to the precinct, county, congressional district, county subdivision and PUMA geometry with `scripts/build_tiles.R`, creates PMTiles, and deploys the resulting static files. It caches map tiles by their source data and tile-building script so a UI-only change does not repeat the tile build.

The published files are the data contract. Early-vote rosters, primary voting history and surname-based estimates are used only in aggregate inside the model and are never published. `headline.csv`, `kalman_track.csv`, `poll_ledger.csv`, `uniform_shift.csv`, `scenarios.csv`, `drivers.csv`, the history files and the detail and projection CSVs for the five levels are staged for the browser. The projection CSVs and GeoJSON feed the tile build. Keep the two-party definition visible when editing the UI.
