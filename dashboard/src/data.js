import { csvParse } from 'd3-dsv';

export const base = import.meta.env.BASE_URL;
export const pct = (v, digits = 1) => Number.isFinite(+v) && v !== '' && v != null ? `${(100 * +v).toFixed(digits)}%` : 'n/a';
export const count = v => Number.isFinite(+v) && v !== '' && v != null ? Math.round(+v).toLocaleString('en-US') : 'n/a';
export const signed = v => Number.isFinite(+v) && v !== '' && v != null ? `${+v >= 0 ? '+' : '−'}${Math.abs(100 * +v).toFixed(1)} pts` : 'n/a';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cache = new Map();

export function csv(name) {
  if (!cache.has(name)) cache.set(name, fetch(`${base}data/${name}`).then(r => {
    if (!r.ok) throw new Error(`Could not load ${name} (${r.status})`);
    return r.text();
  }).then(csvParse).catch(e => { cache.delete(name); throw e; }));
  return cache.get(name);
}

export function table(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th>${escapeHTML(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeHTML(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
