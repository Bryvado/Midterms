import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { base, pct, count, signed, escapeHTML } from './data.js';

const bounds = [[-106.65, 25.84], [-93.51, 36.5]];
const shareColors = ['#a64238','#ce6e5d','#ecd0c8','#d7e5e8','#75aab9','#286b87'];
const shiftColors = ['#a64238','#d7846f','#f2f0ea','#88b3be','#286b87'];
const countColors = ['#edf3f5','#c7dfe6','#9dc7d4','#68a3b9','#367b9a','#124d70'];
const shareStops = [0.2, 0.35, 0.4999, 0.5, 0.65, 0.8];
const shiftStops = [-.15, -.075, 0, .075, .15];
const probStops = [0, .2, .4, .6, .8, 1];
const message = document.querySelector('#map-message');
const tooltip = document.querySelector('#map-tooltip');
const legend = document.querySelector('#legend');
let map, unit = 'county', measure = 'mean', onSelect = () => {};

const style = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const tileURL = name => `pmtiles://${new URL(`${base}${name}.pmtiles`, location.href).href}`;
const layerName = level => `${level}-fill`;
const isShift = key => key.startsWith('shift_');
const isCount = key => key === 'dem_pres24';

function scale(key, level = unit) {
  if (isCount(key)) return level === 'county'
    ? { stops:[0,350,1300,5500,28000,150000], colors:countColors, labels:['0','350','1.3k','5.5k','28k','150k+'] }
    : { stops:[0,100,350,750,1200,2000], colors:countColors, labels:['0','100','350','750','1.2k','2k+'] };
  if (isShift(key)) return { stops: shiftStops, colors: shiftColors, labels: ['−15','−7.5','0','+7.5','+15'], suffix: 'two-party points' };
  if (key === 'p_talarico') return { stops: probStops, colors: shareColors, labels: ['0%','20%','40%','60%','80%','100%'], suffix: 'probability' };
  return { stops: shareStops, colors: shareColors, labels: ['20%','35%','50%','65%','80%'], suffix: 'two-party share' };
}

function colorExpression(key, level) {
  const { stops, colors } = scale(key, level);
  const interpolation = ['interpolate', ['linear'], ['to-number', ['get', key]], ...stops.flatMap((stop, i) => [stop, colors[i]])];
  return ['case', ['has', key], interpolation, '#afb8b8'];
}

function drawLegend() {
  const s = scale(measure, unit);
  const select = document.querySelector('#measure');
  const title = select.selectedOptions[0]?.textContent || 'Projected share';
  legend.innerHTML = `<div class="legend-title">${escapeHTML(title)}${measure.startsWith('base_') || isCount(measure) ? ' · 2024 actual' : ''}</div><div class="legend-ramp">${s.colors.map(color => `<span style="background:${color}"></span>`).join('')}</div><div class="legend-labels">${s.labels.map(label => `<span>${label}</span>`).join('')}</div>${isShift(measure) ? '<div class="legend-note">Grey: no baseline for this place</div>' : isCount(measure) ? '<div class="legend-note">Vote counts reflect population as well as preference.</div>' : ''}`;
}

function valueText(props) {
  const v = props[measure];
  return isCount(measure) ? count(v) : isShift(measure) ? signed(v) : pct(v);
}

function showTooltip(event, props) {
  const label = props.region_label || props.region_id || 'Selected place';
  tooltip.innerHTML = `<strong>${escapeHTML(label)}</strong>${escapeHTML(document.querySelector('#measure').selectedOptions[0].textContent)}: ${escapeHTML(valueText(props))}<br>Projected share: ${escapeHTML(pct(props.mean))}<br>90% interval: ${escapeHTML(pct(props.q05))}–${escapeHTML(pct(props.q95))}<br><span class="note">Click for details</span>`;
  const rect = document.querySelector('.map-pane').getBoundingClientRect();
  let x = event.originalEvent.clientX - rect.left + 13;
  let y = event.originalEvent.clientY - rect.top + 13;
  x = Math.min(x, rect.width - 265);
  y = Math.min(y, rect.height - 125);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
  tooltip.hidden = false;
}

export function setUnit(next) {
  unit = next;
  document.querySelectorAll('[data-unit]').forEach(button => {
    const active = button.dataset.unit === unit;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (map?.getLayer('county-fill')) {
    for (const level of ['county','precinct']) map.setLayoutProperty(layerName(level), 'visibility', level === unit ? 'visible' : 'none');
  }
  drawLegend();
  tooltip.hidden = true;
}

export function setMeasure(next) {
  measure = next;
  drawLegend();
  if (!map?.getLayer('county-fill')) return;
  for (const level of ['county','precinct']) map.setPaintProperty(layerName(level), 'fill-color', colorExpression(measure, level));
  tooltip.hidden = true;
}

export function initMap(select) {
  onSelect = select;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  map = new maplibregl.Map({ container:'map', style, bounds, fitBoundsOptions: { padding: 28 }, attributionControl: false, cooperativeGestures: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('load', () => {
    for (const level of ['county','precinct']) {
      map.addSource(level, { type:'vector', url:tileURL(level === 'county' ? 'counties' : 'regions'), promoteId:'region_id' });
      map.addLayer({ id:layerName(level), type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:level === unit ? 'visible' : 'none' }, paint:{ 'fill-color':colorExpression(measure, level), 'fill-opacity':.83, 'fill-outline-color':'rgba(40,60,65,.28)' } });
    }
    message.hidden = true;
  });
  map.on('mousemove', e => {
    if (!map.getLayer(layerName(unit))) return;
    const features = map.queryRenderedFeatures(e.point, { layers:[layerName(unit)] });
    const feature = features[0];
    map.getCanvas().style.cursor = feature ? 'pointer' : '';
    if (feature) showTooltip(e, feature.properties);
    else tooltip.hidden = true;
  });
  map.on('mouseleave', () => { tooltip.hidden = true; });
  map.on('click', e => {
    if (!map.getLayer(layerName(unit))) return;
    const feature = map.queryRenderedFeatures(e.point, { layers:[layerName(unit)] })[0];
    if (feature) { tooltip.hidden = true; onSelect(unit, feature.properties); }
  });
  map.on('error', e => {
    const error = String(e.error?.message || e.error || '');
    if (/pmtiles|regions|counties|404|fetch/i.test(error)) {
      message.textContent = 'Map tiles could not be loaded. The other data remains available.';
      message.hidden = false;
    }
    console.error('Map error:', e.error);
  });
  document.querySelector('#reset-map').addEventListener('click', () => map.fitBounds(bounds, { padding: 28, duration: 450 }));
  drawLegend();
  return map;
}
