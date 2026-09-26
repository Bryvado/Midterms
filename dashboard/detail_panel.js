function(el, x, data) {
  var S = window.txDetail = window.txDetail || { cache: {}, pending: {} };
  function parseCSV(text) {
    var rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    var h = rows.shift(), out = {};
    rows.forEach(function(r) {
      if (r.length < h.length) return;
      var o = {}; h.forEach(function(k, j) { o[k] = r[j]; }); out[o.region_id] = o;
    });
    return out;
  }
  function load(unit) {
    if (S.cache[unit]) return Promise.resolve(S.cache[unit]);
    if (!S.pending[unit]) S.pending[unit] = fetch(data.url).then(function(r) {
      if (!r.ok) throw new Error(r.status); return r.text();
    }).then(function(t) { S.cache[unit] = parseCSV(t); return S.cache[unit]; })
      .catch(function(e) { delete S.pending[unit]; throw e; });
    return S.pending[unit];
  }
  function num(v) { return v === undefined || v === '' || v === 'NA' || isNaN(+v) ? null : +v; }
  function cnt(v) { v = num(v); return v === null ? 'n/a' : Math.round(v).toLocaleString('en-US'); }
  function pct(v) { v = num(v); return v === null ? 'n/a' : (100 * v).toFixed(1) + '%'; }
  function money(v) { v = num(v); return v === null ? 'n/a' : '$' + Math.round(v).toLocaleString('en-US'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function panel() {
    if (S.panel) return S.panel;
    var css = document.createElement('style');
    css.textContent =
      '#tx-detail{position:fixed;z-index:2000;background:#fff;box-shadow:0 0 12px rgba(0,0,0,.25);' +
      'overflow-y:auto;font-size:13px;line-height:1.35;padding:12px 14px;display:none;box-sizing:border-box}' +
      '#tx-detail.open{display:block}' +
      '@media (min-width:701px){#tx-detail{top:0;right:0;bottom:0;width:380px;max-width:90vw}}' +
      '@media (max-width:700px){#tx-detail{left:0;right:0;bottom:0;max-height:60vh;border-radius:10px 10px 0 0}}' +
      '#tx-detail h3{font-size:16px;margin:0 28px 2px 0}#tx-detail h4{font-size:13px;margin:12px 0 4px;' +
      'text-transform:uppercase;letter-spacing:.03em;color:#555}#tx-detail table{width:100%;border-collapse:collapse}' +
      '#tx-detail td,#tx-detail th{padding:2px 4px;border-bottom:1px solid #eee;text-align:right}' +
      '#tx-detail td:first-child,#tx-detail th:first-child{text-align:left}' +
      '#tx-detail .note{color:#666;font-size:12px;margin:4px 0}' +
      '#tx-detail .x{position:absolute;top:6px;right:8px;border:0;background:none;font-size:22px;cursor:pointer;color:#555}';
    document.head.appendChild(css);
    var p = document.createElement('aside');
    p.id = 'tx-detail'; p.setAttribute('aria-live', 'polite');
    p.innerHTML = '<button class="x" aria-label="Close">&times;</button><div class="body"></div>';
    p.querySelector('.x').addEventListener('click', function() { p.classList.remove('open'); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') p.classList.remove('open'); });
    document.body.appendChild(p);
    return S.panel = p;
  }
  function show(html) {
    var p = panel(); p.querySelector('.body').innerHTML = html; p.classList.add('open'); p.scrollTop = 0;
  }
  function render(label, d) {
    var h = '<h3>' + esc(label) + '</h3>';
    if (data.unit === 'precinct' && d.profile) h += '<div class="note">Regional profile: ' + esc(d.profile) + '</div>';
    h += '<h4>Projected 2026 votes</h4><table><tr><th></th><th>Mean</th><th>90% range</th></tr>';
    [['Ballots cast', 'ballots'], ['Talarico (D)', 'talarico'], ['Paxton (R)', 'paxton']].forEach(function(r) {
      h += '<tr><td>' + r[0] + '</td><td>' + cnt(d[r[1] + '_mean']) + '</td><td>' +
        cnt(d[r[1] + '_q05']) + ' to ' + cnt(d[r[1] + '_q95']) + '</td></tr>';
    });
    h += '<tr><td>Brown (L)</td><td>' + cnt(d.brown_mean) + '</td><td></td></tr></table>' +
      '<div class="note">Counts come from the vote-count simulation. The share they imply can differ from the ' +
      'map\'s projected two-party share by up to about half a point.</div>';
    h += '<h4>Past results</h4><table><tr><th>Race</th><th>D votes</th><th>R votes</th><th>D two-party</th></tr>';
    data.bases.forEach(function(b, i) {
      var dv = num(d['dem_' + b]), rv = num(d['rep_' + b]);
      var sh = dv === null || rv === null || dv + rv === 0 ? 'n/a' : pct(dv / (dv + rv));
      h += '<tr><td>' + esc(data.base_labels[i]) + '</td><td>' + cnt(d['dem_' + b]) + '</td><td>' +
        cnt(d['rep_' + b]) + '</td><td>' + sh + '</td></tr>';
    });
    h += '</table><h4>Demographics</h4>';
    if (String(d.demographics_imputed).toUpperCase() === 'TRUE')
      h += '<div class="note"><strong>Estimated from neighboring precincts</strong></div>';
    var inc = data.unit === 'county' ? 'Population-weighted average of precinct median incomes' : 'Median income';
    h += '<table>' + [
      ['Population', cnt(d.population)],
      ['Citizen voting-age population (CVAP)', cnt(d.cvap_total)],
      ['Hispanic share of CVAP', pct(d.hisp_cvap_share)],
      ['White share of CVAP', pct(d.white_cvap_share)],
      ['Black share of CVAP', pct(d.black_cvap_share)],
      ["Bachelor's degree or higher", pct(d.ba_plus_share)],
      [inc, money(d.med_income)],
      ['Registered voters, 2024', cnt(d.registered_2024)],
      ['Voted in 2022', cnt(d.voted_2022)]
    ].map(function(r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</table>';
    return h;
  }
  if (data.eager) load(data.unit).catch(function() {});
  var tries = 0;
  (function wait() {
    var w = window.HTMLWidgets && HTMLWidgets.find('#' + el.id);
    var map = el.map || (w && w.getMap && w.getMap());
    if (!(map && map.getLayer && map.getLayer(data.ids[0]))) {
      if (tries++ < 200) setTimeout(wait, 100);
      return;
    }
    data.ids.forEach(function(id) {
      map.on('click', id, function(e) {
        var f = e.features && e.features[0];
        if (!f) return;
        var rid = String(f.properties.region_id !== undefined ? f.properties.region_id : f.id);
        var label = f.properties.region_label || rid;
        if (!S.cache[data.unit]) show('<h3>' + esc(label) + '</h3><div class="note">Loading details…</div>');
        load(data.unit).then(function(tab) {
          var d = tab[rid];
          show(d ? render(label, d) : '<h3>' + esc(label) + '</h3><div class="note">No detail row for this ' + data.unit + '.</div>');
        }).catch(function() {
          show('<h3>' + esc(label) + '</h3><div class="note">Details could not be loaded.</div>');
        });
      });
    });
  })();
}
