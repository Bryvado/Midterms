import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'data/published');
const target = path.join(root, 'dashboard/public/data');
const files = [
  'headline.csv', 'kalman_track.csv', 'poll_ledger.csv', 'uniform_shift.csv', 'scenarios.csv', 'drivers.csv',
  'county_details.csv', 'precinct_details.csv', 'cd_details.csv', 'cousub_details.csv', 'puma_details.csv',
  'county_projections.csv', 'regional_projections.csv', 'cd_projections.csv', 'cousub_projections.csv', 'puma_projections.csv',
  'sim_scatter_points.csv', 'sim_scatter_density.csv', 'sim_scatter_axes.csv',
  'history_races.csv', 'history_precinct.csv', 'history_county.csv', 'history_congressional_district.csv', 'history_county_subdivision.csv', 'history_puma.csv',
];
// Optional files: copied when published, skipped (and their controls hidden) when not.
const optional = ['sensitivities.csv', 'demographics_measures.csv', 'early_vote_county.csv', 'early_vote_daily.csv', 'early_vote_map_precinct.csv', 'early_vote_map_puma.csv', 'early_vote_map_county.csv'];
// Start from an empty folder so files dropped from data/published are not served from an earlier run.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(files.map(file => copyFile(path.join(source, file), path.join(target, file))));
// optional.json lists which optional files were published, so the page can skip absent ones without a failed request.
const present = (await Promise.all(optional.map(file => copyFile(path.join(source, file), path.join(target, file)).then(() => file, () => null)))).filter(Boolean);
await writeFile(path.join(target, 'optional.json'), JSON.stringify(present));
// Bounding boxes per place, read from the published geometry, so the dashboard can zoom to a place without loading the polygons.
const geometry = { county:'counties.geojson', precinct:'regions.geojson', cd:'congressional_districts.geojson', cousub:'county_subdivisions.geojson', puma:'pumas.geojson' };
const walk = (coords, box) => {
  if (typeof coords[0] === 'number') { box[0] = Math.min(box[0], coords[0]); box[1] = Math.min(box[1], coords[1]); box[2] = Math.max(box[2], coords[0]); box[3] = Math.max(box[3], coords[1]); return; }
  for (const part of coords) walk(part, box);
};
for (const [level, file] of Object.entries(geometry)) {
  try {
    const collection = JSON.parse(await readFile(path.join(source, file), 'utf8'));
    const boxes = {};
    for (const feature of collection.features) {
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      walk(feature.geometry.coordinates, box);
      boxes[feature.properties.region_id] = box.map(v => +v.toFixed(4));
    }
    await writeFile(path.join(target, `bounds_${level}.json`), JSON.stringify(boxes));
  } catch { /* geometry not published for this level: zooming to its places is skipped */ }
}
console.log(`Staged ${files.length} published data files.`);
