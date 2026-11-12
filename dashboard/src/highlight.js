// Hover and selection outlines use feature state, never a layer filter: a filter change re-parses every loaded tile in the worker.
// The outline layer's paint reads ['feature-state', key]; a style reload drops all state, so callers reset() first.
export function featureStates(key) {
  const lit = new Map();
  return {
    set(map, source, ids) {
      if (!map?.getSource(source)) return;
      const prev = lit.get(source) || new Set(), next = new Set(ids.filter(Boolean).map(String));
      for (const id of prev) if (!next.has(id)) map.setFeatureState({ source, sourceLayer:'regions', id }, { [key]:false });
      for (const id of next) if (!prev.has(id)) map.setFeatureState({ source, sourceLayer:'regions', id }, { [key]:true });
      lit.set(source, next);
    },
    reset() { lit.clear(); },
  };
}
export const stateWidth = (key, width) => ['case', ['boolean', ['feature-state', key], false], width, 0];
// Two feature-state keys on one outline layer: a hover/selection outline wins over a picked-set outline, which wins over nothing.
export const stateWidth2 = (key1, w1, key2, w2) => ['case', ['boolean', ['feature-state', key1], false], w1, ['boolean', ['feature-state', key2], false], w2, 0];
// Marks only the rows whose state changed, from a cache of id to row built when the table is drawn.
export function rowMarker() {
  let rows = new Map(), marked = new Set();
  return {
    index(host) { rows = new Map([...host.querySelectorAll('tbody tr')].map(tr => [tr.dataset.id, tr])); marked = new Set(); },
    mark(ids) {
      const next = new Set(ids.filter(Boolean).map(String));
      for (const id of marked) if (!next.has(id)) rows.get(id)?.classList.remove('active');
      for (const id of next) if (!marked.has(id)) rows.get(id)?.classList.add('active');
      marked = next;
    },
  };
}
