import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'data/published');
const target = path.join(root, 'dashboard/public/data');
const files = [
  'headline.csv', 'kalman_track.csv', 'poll_ledger.csv', 'gates.csv',
  'uniform_shift.csv', 'scenarios.csv', 'county_details.csv', 'precinct_details.csv',
  'cd_details.csv', 'cousub_details.csv',
  'county_projections.csv', 'regional_projections.csv', 'cd_projections.csv', 'cousub_projections.csv',
];
// Optional files: copied when published, skipped (and their controls hidden) when not.
const optional = ['sensitivities.csv'];
await mkdir(target, { recursive: true });
await Promise.all(files.map(file => copyFile(path.join(source, file), path.join(target, file))));
await Promise.all(optional.map(file => copyFile(path.join(source, file), path.join(target, file)).catch(() => {})));
console.log(`Staged ${files.length} published data files.`);
