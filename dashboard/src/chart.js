import Plotly from 'plotly.js-basic-dist-min';
import { pct } from './data.js';

let track = [], polls = [], fundamentals = null, baselines = new Map();
const root = document.querySelector('#trend-chart');

export function initChart(trackRows, pollRows, headline, shifts) {
  track = trackRows;
  polls = pollRows;
  fundamentals = headline.find(row => row.component === 'fundamentals');
  baselines = new Map(shifts.filter(row => row.component === 'combined').map(row => [row.baseline, row.label]));
  document.querySelector('#poll-summary').textContent = `Poll ledger · ${polls.length} polls`;
  renderChart('mean');
  new ResizeObserver(() => Plotly.Plots.resize(root)).observe(root);
}

export function renderChart(measure) {
  if (!track.length) return;
  const key = measure.startsWith('shift_') ? measure : 'mean';
  const shift = key !== 'mean';
  const label = shift ? `Shift vs ${baselines.get(key.slice(6)) || key.slice(6)}` : 'Polling average';
  document.querySelector('#trend-title').textContent = label;
  const observed = track.filter(row => row.projected !== 'TRUE');
  const last = observed.at(-1);
  const projected = [last, ...track.filter(row => row.projected === 'TRUE')].filter(Boolean);
  const color = '#286b87';
  const traces = [];
  function segment(rows, forecast) {
    if (!rows.length) return;
    const x = rows.map(r => r.date);
    const lo = rows.map(r => +r[key] - 1.96 * +r.se);
    const hi = rows.map(r => +r[key] + 1.96 * +r.se);
    traces.push({ type:'scatter', mode:'lines', x, y:lo, line:{ width:0 }, hoverinfo:'skip', showlegend:false });
    traces.push({ type:'scatter', mode:'lines', x, y:hi, fill:'tonexty', fillcolor:forecast ? 'rgba(40,107,135,.10)' : 'rgba(40,107,135,.20)', line:{ width:0 }, hoverinfo:'skip', showlegend:false });
    traces.push({ type:'scatter', mode:'lines', x, y:rows.map(r => +r[key]), name:forecast ? 'Projection' : 'Average', line:{ color, width:forecast ? 2 : 2.5, dash:forecast ? 'dash' : 'solid' }, hovertemplate:'%{x}<br>%{y:.1%}<extra></extra>', showlegend:false });
  }
  if (!shift && fundamentals) {
    const x = [track[0].date, track.at(-1).date];
    const mean = +fundamentals.mean, sd = +fundamentals.sd;
    traces.push({ type:'scatter', mode:'lines', x, y:[mean-1.96*sd,mean-1.96*sd], line:{width:0}, hoverinfo:'skip', showlegend:false });
    traces.push({ type:'scatter', mode:'lines', x, y:[mean+1.96*sd,mean+1.96*sd], fill:'tonexty', fillcolor:'rgba(115,125,128,.09)', line:{width:0}, hoverinfo:'skip', showlegend:false });
  }
  segment(observed, false);
  segment(projected, true);
  if (!shift) traces.push({ type:'scatter', mode:'markers', name:'Polls', x:polls.map(r => r.end_date), y:polls.map(r => +r.talarico_2p), marker:{ color:'#25363b', opacity:.65, size:polls.map(r => Math.max(5, 27 * Math.sqrt(+r.weight))) }, text:polls.map(r => `${r.pollster}<br>n = ${r.n}<br>Talarico ${r.talarico}, Paxton ${r.paxton}<br>Relative weight ${pct(r.weight)}`), hovertemplate:'%{text}<br>%{x}: %{y:.1%}<extra></extra>', showlegend:false });
  const layout = {
    margin:{ l:45, r:10, t:12, b:36 }, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
    font:{ family:'DM Sans, sans-serif', size:10, color:'#586c72' }, hovermode:'closest',
    xaxis:{ type:'date', showgrid:false, linecolor:'#cbd5d5', tickformat:'%b %Y', nticks:5, tickfont:{size:10} },
    yaxis:{ tickformat:shift ? '+.0%' : '.0%', showgrid:true, gridcolor:'#e8eeed', zeroline:false, fixedrange:true },
    shapes:[{ type:'line', xref:'paper', x0:0, x1:1, y0:shift ? 0 : .5, y1:shift ? 0 : .5, line:{ color:'#97a5a7', dash:'dot', width:1 } }],
    showlegend:false,
  };
  Plotly.react(root, traces, layout, { displayModeBar:false, responsive:true, scrollZoom:false });
}
