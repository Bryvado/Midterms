import { csv } from './data.js';

// Descriptive arithmetic on published columns only: shares, shifts, ratios and weighted summaries of past results and of the published 2026 projection.
// Races from 2016 on come from the details files; earlier races (hist) come from the published history files, so any two can be compared.
const race = (key, year, office, label, short, extra = {}) => ({ key, label, short, office, year, ...extra });
export const races = [
  race('pres04', 2004, 'pres', '2004 President', '2004 Pres.', { hist:true, col:'president_2004' }),
  race('sen02', 2002, 'sen', '2002 Senate', '2002 Sen.', { hist:true, col:'us_senate_2002' }),
  race('gov02', 2002, 'gov', '2002 Governor', '2002 Gov.', { hist:true, col:'governor_2002' }),
  race('sen06', 2006, 'sen', '2006 Senate', '2006 Sen.', { hist:true, col:'us_senate_2006' }),
  race('gov06', 2006, 'gov', '2006 Governor', '2006 Gov.', { hist:true, col:'governor_2006' }),
  race('pres08', 2008, 'pres', '2008 President', '2008 Pres.', { hist:true, col:'president_2008' }),
  race('sen08', 2008, 'sen', '2008 Senate', '2008 Sen.', { hist:true, col:'us_senate_2008' }),
  race('gov10', 2010, 'gov', '2010 Governor', '2010 Gov.', { hist:true, col:'governor_2010' }),
  race('pres12', 2012, 'pres', '2012 President', '2012 Pres.', { hist:true, col:'president_2012' }),
  race('sen12', 2012, 'sen', '2012 Senate', '2012 Sen.', { hist:true, col:'us_senate_2012' }),
  race('gov14', 2014, 'gov', '2014 Governor', '2014 Gov.', { hist:true, col:'governor_2014' }),
  race('sen14', 2014, 'sen', '2014 Senate', '2014 Sen.', { hist:true, col:'us_senate_2014' }),
  race('pres16', 2016, 'pres', '2016 President', '2016 Pres.'),
  race('sen18', 2018, 'sen', '2018 Senate', '2018 Sen.'),
  race('gov18', 2018, 'gov', '2018 Governor', '2018 Gov.'),
  race('pres20', 2020, 'pres', '2020 President', '2020 Pres.'),
  race('sen20', 2020, 'sen', '2020 Senate', '2020 Sen.'),
  race('gov22', 2022, 'gov', '2022 Governor', '2022 Gov.'),
  race('pres24', 2024, 'pres', '2024 President', '2024 Pres.'),
  race('sen24', 2024, 'sen', '2024 Senate', '2024 Sen.'),
  race('f26', 2026, 'sen', '2026 forecast', '2026 forecast', { forecast:true }),
].sort((a, b) => a.year - b.year);
// Races read from the details files (reconciled against uniform_shift.csv) and from the history files.
export const pastKeys = races.filter(item => !item.forecast && !item.hist).map(item => item.key);
export const histRaces = races.filter(item => item.hist);
export const raceOf = key => races.find(race => race.key === key);
export const metrics = [
  { key:'shift', label:'Shift in Democratic share' },
  { key:'rshift', label:'Shift relative to statewide' },
  { key:'ratio', label:'Turnout ratio' },
  { key:'rratio', label:'Turnout ratio relative to statewide' },
  { key:'net', label:'Net Democratic vote change' },
];
export const profileNames = ['rural', 'suburbs', 'urban', 'hispanic'];
export const profileLabels = { rural:'Rural', suburbs:'Suburbs', urban:'Diverse urban', hispanic:'Hispanic working-class' };
export const minOptions = [0, 50, 100, 250, 500, 1000];
export const levelInfo = {
  precinct:{ label:'Precincts', noun:'precincts', details:'precinct_details.csv', projections:'regional_projections.csv', history:'history_precinct.csv' },
  county:{ label:'Counties', noun:'counties', details:'county_details.csv', projections:'county_projections.csv', history:'history_county.csv' },
  cd:{ label:'Congressional districts', noun:'districts', details:'cd_details.csv', projections:'cd_projections.csv', history:'history_congressional_district.csv' },
  cousub:{ label:'County subdivisions', noun:'subdivisions', details:'cousub_details.csv', projections:'cousub_projections.csv', history:'history_county_subdivision.csv' },
  puma:{ label:'PUMAs', noun:'PUMAs', details:'puma_details.csv', projections:'puma_projections.csv', history:'history_puma.csv' },
};

const params = new URLSearchParams(location.search);
export const state = {
  from:'pres20', to:'pres24', metric:'shift', min:100, weighted:true, county:'', profile:'',
  y2from:'pres24', y2to:'f26', xrel:false, yrel:false, view:'xy', demog:'hisp_cvap_share', color:'profile', contours:false, level:'precinct',
};
const defaults = { ...state };
const urlKeys = { from:'cf', to:'cto', min:'cmin', county:'cc', profile:'cp', y2from:'y2f', y2to:'y2t', view:'cv', demog:'cdx', color:'ccol', level:'clv' };
{
  const raceKeys = races.map(race => race.key);
  const text = (key, ok) => { const v = params.get(urlKeys[key]); if (v != null && ok(v)) state[key] = v; };
  text('from', v => raceKeys.includes(v)); text('to', v => raceKeys.includes(v));
  text('y2from', v => raceKeys.includes(v)); text('y2to', v => raceKeys.includes(v));
  if (params.has('cmin') && minOptions.includes(+params.get('cmin'))) state.min = +params.get('cmin');
  text('county', v => /^\d{3}$/.test(v)); text('profile', v => profileNames.includes(v));
  text('view', v => ['xy', 'demog', 'table'].includes(v));
  // Any measure key is accepted here; the picker falls back to the default when the key is not offered at the level.
  text('demog', v => /^[a-z0-9_]{1,48}$/.test(v));
  text('color', v => ['profile', 'share'].includes(v)); text('level', v => v in levelInfo);
  if (params.get('cw') === '0') state.weighted = false;
  if (params.get('cxr') === '1') state.xrel = true;
  if (params.get('cyr') === '1') state.yrel = true;
  if (params.get('ccon') === '1') state.contours = true;
  const m = params.get('m');
  if (m?.startsWith('cmp_') && metrics.some(metric => `cmp_${metric.key}` === m)) state.metric = m.slice(4);
}
export const isCompareMeasure = key => typeof key === 'string' && key.startsWith('cmp_');

function syncURL() {
  const url = new URL(location.href);
  for (const [key, name] of Object.entries(urlKeys)) {
    if (state[key] === defaults[key]) url.searchParams.delete(name); else url.searchParams.set(name, String(state[key]));
  }
  for (const [key, name] of [['xrel', 'cxr'], ['yrel', 'cyr'], ['contours', 'ccon']]) { if (state[key]) url.searchParams.set(name, '1'); else url.searchParams.delete(name); }
  if (state.weighted) url.searchParams.delete('cw'); else url.searchParams.set('cw', '0');
  history.replaceState(null, '', url);
}
let version = 0;
export const stateVersion = () => version;
// `what` tells listeners how much to redo: 'pair' and 'filters' change values, 'view' only the panel.
export function setState(patch, what = 'pair') {
  Object.assign(state, patch);
  if (what !== 'view') version++;
  syncURL();
  window.dispatchEvent(new CustomEvent('compare-change', { detail:{ what } }));
}
export function setMetric(metric) { if (state.metric !== metric) { state.metric = metric; version++; } }
syncURL();

// ---- Stores: typed arrays per level, built once from the cached CSVs ----
const stores = new Map();
const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
const votes = v => { const x = num(v); return Number.isFinite(x) ? x : 0; };
export function loadStore(level) {
  if (!stores.has(level)) {
    const info = levelInfo[level];
    stores.set(level, Promise.all([csv(info.details), csv(info.projections), csv(info.history).catch(() => [])]).then(([details, projections, history]) => {
      const byId = new Map(projections.map(row => [row.region_id, row])), byHistory = new Map(history.map(row => [row.region_id, row]));
      const n = details.length;
      const store = { level, n, ids:new Array(n), labels:new Array(n), county:new Array(n), profile:new Uint8Array(n).fill(255), imputed:new Uint8Array(n),
        dem:{}, rep:{}, tal:new Float64Array(n), pax:new Float64Array(n), mean:new Float64Array(n), q05:new Float64Array(n), q95:new Float64Array(n), pTal:new Float64Array(n),
        demog:{ hisp_cvap_share:new Float64Array(n), white_cvap_share:new Float64Array(n), black_cvap_share:new Float64Array(n), ba_plus_share:new Float64Array(n), med_income:new Float64Array(n), population:new Float64Array(n), area_sqmi:new Float64Array(n) },
        cache:new Map(), tp:new Map(), share:new Map(), index:null };
      for (const item of races) if (!item.forecast) { store.dem[item.key] = new Float64Array(n); store.rep[item.key] = new Float64Array(n); }
      for (let i = 0; i < n; i++) {
        const row = details[i], p = byId.get(row.region_id) || {};
        store.ids[i] = row.region_id;
        store.labels[i] = p.region_label || row.region_id;
        store.county[i] = level === 'precinct' || level === 'cousub' ? row.region_id.slice(0, 3) : level === 'county' ? row.region_id : '';
        const prof = profileNames.indexOf(row.profile);
        if (prof >= 0) store.profile[i] = prof;
        store.imputed[i] = String(row.demographics_imputed).toUpperCase() === 'TRUE' ? 1 : 0;
        for (const key of pastKeys) { store.dem[key][i] = votes(row[`dem_${key}`]); store.rep[key][i] = votes(row[`rep_${key}`]); }
        const old = byHistory.get(row.region_id);
        if (old) for (const item of histRaces) { store.dem[item.key][i] = votes(old[`dem_${item.col}`]); store.rep[item.key][i] = votes(old[`rep_${item.col}`]); }
        store.tal[i] = votes(row.talarico_mean); store.pax[i] = votes(row.paxton_mean);
        store.mean[i] = num(p.mean); store.q05[i] = num(p.q05); store.q95[i] = num(p.q95); store.pTal[i] = num(p.p_talarico);
        for (const key of Object.keys(store.demog)) store.demog[key][i] = num(row[key]);
      }
      return store;
    }).catch(error => { stores.delete(level); throw error; }));
  }
  return stores.get(level);
}
const loadedStores = new Map();
export async function ensureStore(level) { const store = await loadStore(level); loadedStores.set(level, store); return store; }
export const storeIfLoaded = level => loadedStores.get(level) || null;

// Two-party votes and share for one race. For 2026 the share is the projection's mean field and the votes are the expected Talarico plus Paxton votes.
export function tpOf(store, key) {
  if (!store.tp.has(key)) {
    const out = new Float64Array(store.n);
    if (key === 'f26') for (let i = 0; i < store.n; i++) out[i] = store.tal[i] + store.pax[i];
    else for (let i = 0; i < store.n; i++) out[i] = store.dem[key][i] + store.rep[key][i];
    store.tp.set(key, out);
  }
  return store.tp.get(key);
}
export function shareOf(store, key) {
  if (!store.share.has(key)) {
    const tp = tpOf(store, key), out = new Float64Array(store.n);
    for (let i = 0; i < store.n; i++) out[i] = tp[i] > 0 ? (key === 'f26' ? store.mean[i] : store.dem[key][i] / tp[i]) : NaN;
    store.share.set(key, out);
  }
  return store.share.get(key);
}
// Statewide share from vote totals summed over every row.
export function statewide(store, key) {
  const tp = tpOf(store, key);
  let total = 0, dem = 0;
  for (let i = 0; i < store.n; i++) { total += tp[i]; dem += key === 'f26' ? store.tal[i] : store.dem[key][i]; }
  return { share:total > 0 ? dem / total : NaN, total, dem };
}

export function indexOf(store, id) {
  if (!store.index) store.index = new Map(store.ids.map((value, i) => [value, i]));
  return store.index.get(id);
}
export const countyFilterApplies = level => level === 'precinct' || level === 'county' || level === 'cousub';
export const STATUS = { ok:0, missing:1, below:2, filtered:3 };
const filterKey = f => `${f.min}|${f.county}|${f.profile}`;
// Everything derived for one pair at one level under the current filters. Recomputed only when the pair, minimum or filters change.
export function evaluate(store, from, to, f = state) {
  const key = `${from}|${to}|${filterKey(f)}`;
  if (store.cache.has(key)) return store.cache.get(key);
  const n = store.n, tA = tpOf(store, from), tB = tpOf(store, to), sA = shareOf(store, from), sB = shareOf(store, to);
  const shift = new Float64Array(n).fill(NaN), ratio = new Float64Array(n).fill(NaN), net = new Float64Array(n).fill(NaN), status = new Uint8Array(n);
  const counts = { shown:0, below:0, missing:0, filtered:0, total:n };
  const stateA = statewide(store, from), stateB = statewide(store, to);
  let bothA = 0, bothB = 0;
  for (let i = 0; i < n; i++) {
    // The county filter needs a county for every place (not districts or PUMAs); the profile filter exists only for precincts.
    if ((f.county && countyFilterApplies(store.level) && store.county[i] !== f.county) || (f.profile && store.level === 'precinct' && store.profile[i] !== profileNames.indexOf(f.profile))) { status[i] = STATUS.filtered; counts.filtered++; continue; }
    if (!(tA[i] > 0) || !(tB[i] > 0) || !Number.isFinite(sA[i]) || !Number.isFinite(sB[i])) { status[i] = STATUS.missing; counts.missing++; continue; }
    bothA += tA[i]; bothB += tB[i];
    if (tA[i] < f.min || tB[i] < f.min) { status[i] = STATUS.below; counts.below++; continue; }
    status[i] = STATUS.ok; counts.shown++;
    shift[i] = sB[i] - sA[i];
    ratio[i] = tB[i] / tA[i];
    net[i] = (to === 'f26' ? store.tal[i] - store.pax[i] : store.dem[to][i] - store.rep[to][i]) - (from === 'f26' ? store.tal[i] - store.pax[i] : store.dem[from][i] - store.rep[from][i]);
  }
  // The statewide ratio compares only rows that have votes in both races, so the totals line up.
  let aligned = 0, alignedB = 0;
  for (let i = 0; i < n; i++) if (tA[i] > 0 && tB[i] > 0 && Number.isFinite(sA[i]) && Number.isFinite(sB[i])) { aligned += tA[i]; alignedB += tB[i]; }
  const result = { from, to, filters:{ ...f }, shift, ratio, net, status, counts, shareA:sA, shareB:sB, tpA:tA, tpB:tB,
    stateShareA:stateA.share, stateShareB:stateB.share, stateShift:stateB.share - stateA.share, stateRatio:aligned > 0 ? alignedB / aligned : NaN };
  if (store.cache.size > 24) store.cache.delete(store.cache.keys().next().value);
  store.cache.set(key, result);
  return result;
}
// Metric values for one metric from an evaluation: relative variants subtract the statewide figure (a ratio is relative in log terms).
export function metricArray(ev, metric) {
  const n = ev.shift.length, out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (ev.status[i] !== STATUS.ok) continue;
    out[i] = metric === 'shift' ? ev.shift[i] : metric === 'rshift' ? ev.shift[i] - ev.stateShift : metric === 'ratio' ? Math.log(ev.ratio[i]) : metric === 'rratio' ? Math.log(ev.ratio[i]) - Math.log(ev.stateRatio) : ev.net[i];
  }
  return out;
}
export const pairLabel = (from = state.from, to = state.to) => `${raceOf(from).label} to ${raceOf(to).label}`;
export const crossOffice = (from = state.from, to = state.to) => raceOf(from).office !== raceOf(to).office;
// Vote sources: 2002-2014 moved onto today's precincts from older returns, 2016-2022 and 2024 each come from one exact source.
const sourceGroup = key => { const year = raceOf(key).year; return year <= 2014 ? 'moved' : year <= 2022 ? 'older' : 'recent'; };
export const crossesSources = (from = state.from, to = state.to) => sourceGroup(from) !== sourceGroup(to);
export const sourceCaveat = 'Part of the precinct-level change can come from how each source assigns votes to precincts, not from voters.';

// ---- Weighted summaries ----
export function weightedMean(values, weights, idx) {
  let sw = 0, s = 0;
  for (const i of idx) { const w = weights ? weights[i] : 1; if (Number.isFinite(values[i]) && w > 0) { sw += w; s += w * values[i]; } }
  return sw > 0 ? s / sw : NaN;
}
export function weightedFit(x, y, weights, idx) {
  let sw = 0, mx = 0, my = 0;
  for (const i of idx) { const w = weights ? weights[i] : 1; sw += w; mx += w * x[i]; my += w * y[i]; }
  if (!(sw > 0)) return null;
  mx /= sw; my /= sw;
  let sxx = 0, syy = 0, sxy = 0;
  for (const i of idx) { const w = weights ? weights[i] : 1, dx = x[i] - mx, dy = y[i] - my; sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy; }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return { r:sxy / Math.sqrt(sxx * syy), slope:sxy / sxx, intercept:my - sxy / sxx * mx, n:idx.length };
}
// Deciles of x that each hold a tenth of the total weight; returns the weighted mean x and y of each.
export function weightedDeciles(x, y, weights, idx, bins = 10) {
  const order = [...idx].sort((a, b) => x[a] - x[b]);
  const total = order.reduce((s, i) => s + (weights ? weights[i] : 1), 0);
  const out = Array.from({ length:bins }, () => ({ w:0, x:0, y:0, n:0 }));
  let cumulative = 0;
  for (const i of order) {
    const w = weights ? weights[i] : 1;
    const bin = Math.min(bins - 1, Math.floor(bins * (cumulative + w / 2) / total));
    out[bin].w += w; out[bin].x += w * x[i]; out[bin].y += w * y[i]; out[bin].n++;
    cumulative += w;
  }
  return out.filter(bin => bin.w > 0).map(bin => ({ x:bin.x / bin.w, y:bin.y / bin.w, n:bin.n, w:bin.w }));
}

// ---- Map support ----
// The fill looks each place up by region_id in values computed from the stores, so any pair of races can be shaded, whether or not the tiles carry its columns.
const lookups = new WeakMap();
const roundTo = v => Math.round(v * 1e6) / 1e6;
export function mapExpressions(level, metric = state.metric) {
  const store = storeIfLoaded(level);
  if (!store) return null;
  const { from, to, min } = state;
  const ev = evaluate(store, from, to);
  const key = `${from}|${to}|${filterKey(state)}|${metric}`;
  let cache = lookups.get(store);
  if (!cache) lookups.set(store, cache = new Map());
  if (!cache.has(key)) {
    const values = {}, codes = {}, array = metricArray(ev, metric);
    for (let i = 0; i < store.n; i++) {
      if (ev.status[i] === STATUS.ok && Number.isFinite(array[i])) values[store.ids[i]] = roundTo(array[i]); else codes[store.ids[i]] = ev.status[i] === STATUS.ok ? STATUS.missing : ev.status[i];
    }
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    cache.set(key, { values, codes });
  }
  const { values, codes } = cache.get(key);
  const id = ['to-string', ['get', 'region_id']], code = ['coalesce', ['get', id, ['literal', codes]], 0];
  return {
    nodata:['all', ['==', code, 0], ['!', ['has', id, ['literal', values]]]],
    filtered:ev.counts.filtered ? ['==', code, STATUS.filtered] : null,
    missing:['==', code, STATUS.missing],
    below:min > 0 ? ['==', code, STATUS.below] : null,
    value:['get', id, ['literal', values]], ev,
  };
}
// The same values for a hovered feature, read from the store by its region_id; status is never ok for places that are not shaded.
export function describeProps(props, level = state.level) {
  const { from, to } = state;
  const store = storeIfLoaded(level);
  const at = store ? indexOf(store, String(props.region_id)) : undefined;
  if (at === undefined) return { status:STATUS.missing, value:NaN, shareA:NaN, shareB:NaN, shift:NaN, tpA:0, tpB:0, ratio:NaN, net:NaN };
  const ev = evaluate(store, from, to);
  const tpA = ev.tpA[at], tpB = ev.tpB[at], shareA = ev.shareA[at], shareB = ev.shareB[at];
  const net = (to === 'f26' ? store.tal[at] - store.pax[at] : store.dem[to][at] - store.rep[to][at]) - (from === 'f26' ? store.tal[at] - store.pax[at] : store.dem[from][at] - store.rep[from][at]);
  const status = ev.status[at];
  const arrays = ev.arrays ||= {};
  const value = status === STATUS.ok ? (arrays[state.metric] ||= metricArray(ev, state.metric))[at] : NaN;
  return { status, value, shareA, shareB, shift:shareB - shareA, tpA, tpB, ratio:tpB / tpA, net };
}
// Sorted metric values of the shaded places at one level, for the map's range fit and class breaks.
export function metricValues(store, metric = state.metric) {
  const values = [];
  for (const v of metricArray(evaluate(store, state.from, state.to), metric)) if (Number.isFinite(v)) values.push(v);
  return values.sort((a, b) => a - b);
}
