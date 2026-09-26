import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'data/published');
const target = path.join(root, 'dashboard/public/data');
const files = [
  'headline.csv', 'kalman_track.csv', 'poll_ledger.csv', 'gates.csv',
  'uniform_shift.csv', 'scenarios.csv', 'county_details.csv', 'precinct_details.csv',
];
await mkdir(target, { recursive: true });
await Promise.all(files.map(file => copyFile(path.join(source, file), path.join(target, file))));
console.log(`Staged ${files.length} published data files.`);
