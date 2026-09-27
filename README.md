# Texas 2026 Senate forecast explorer

Static GitHub Pages dashboard at [bryvado.github.io/Midterms](https://bryvado.github.io/Midterms/). The R model publishes CSV and GeoJSON files into `data/published/`. The browser UI in `dashboard/` reads those published files; it does not run the model.

## Local UI development

```sh
cd dashboard
npm ci
npm run dev
```

`npm run dev` stages the published CSVs into an ignored `dashboard/public/data/` directory. To preview the map locally, put `regions.pmtiles` and `counties.pmtiles` in `dashboard/public/`; GitHub Actions produces them during deployment. The summary, polling chart, and methods can be developed without local tiles.

Run `npm run build` in `dashboard/` to create the static site in `dashboard/dist/`. The Vite build uses `/Midterms/` for GitHub Pages asset paths. The deployed map uses MapLibre GL JS with PMTiles; the polling chart is a responsive SVG component.

## Publishing

Push dashboard changes or published data to `main`. [The Pages workflow](.github/workflows/dashboard.yml) builds the UI, joins projections and place details to the precinct and county geometry with `scripts/build_tiles.R`, creates detailed PMTiles and net-vote-density breaks, and deploys the resulting static files. It caches map tiles by their source data and tile-building script so a UI-only change does not repeat the tile build. The county layer sits beneath precincts to cover small polygons that cannot render at statewide zoom.

The published files are the data contract. `headline.csv`, `kalman_track.csv`, `poll_ledger.csv`, `gates.csv`, `uniform_shift.csv`, `scenarios.csv`, and the two detail CSVs are staged for the browser. The projection CSVs and GeoJSON feed the tile build. Keep the model's gate statuses and two-party definition visible when editing the UI.
