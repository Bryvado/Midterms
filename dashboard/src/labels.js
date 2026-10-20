import { csv } from './data.js';

// Published labels are kept for search and hover; these are the shorter forms shown in the list and place heading.
let names;
export function countyNames() {
  names ||= csv('county_projections.csv').then(rows => new Map(rows.map(row => [row.region_id, row.region_label.replace(/ County$/, '')]))).catch(() => new Map());
  return names;
}

const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

// county: "Harris County" -> "Harris"; subdivision: "Newcastle CCD, Young County" -> "Newcastle (Young)";
// precinct: "County 201, VTD 0130 (suburbs)" -> "Harris 0130 (Suburbs)", using the published county name for the code.
export function shortLabel(level, label, counties, { keepCounty = false } = {}) {
  if (level === 'county') return keepCounty ? label : label.replace(/ County$/, '');
  if (level === 'cousub') {
    const m = /^(.*?) CCD, (.*?)(?: County)?$/.exec(label);
    return m ? `${m[1]} (${m[2]})` : label;
  }
  if (level === 'precinct') {
    const m = /^County (\d{3}), VTD (\S+) \((\w+)\)$/.exec(label);
    return m ? `${counties.get(m[1]) || `County ${m[1]}`} ${m[2]} (${capital(m[3])})` : label;
  }
  return label;
}
