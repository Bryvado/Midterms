import { csv } from './data.js';

// Published labels are kept for search and hover; these are the shorter forms shown in the list and place heading.
let names;
export function countyNames() {
  names ||= csv('county_projections.csv').then(rows => new Map(rows.map(row => [row.region_id, row.region_label.replace(/ County$/, '')]))).catch(() => new Map());
  return names;
}

// county: "Harris County" -> "Harris". Districts and PUMAs keep their published labels.
export function shortLabel(level, label, counties, { keepCounty = false } = {}) {
  if (level === 'county') return keepCounty ? label : label.replace(/ County$/, '');
  return label;
}
