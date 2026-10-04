// Restyle existing basemap symbols; do not add a second set of labels.
export function applyMapLabels(map, theme) {
  const dark = theme === 'dark';
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
    const road = layer['source-layer'] === 'transportation_name';
    const place = layer['source-layer'] === 'place';
    map.setLayoutProperty(layer.id, 'text-font', ['Noto Sans Regular']);
    map.setLayoutProperty(layer.id, 'text-transform', 'none');
    map.setPaintProperty(layer.id, 'text-halo-blur', 0);
    map.setPaintProperty(layer.id, 'text-halo-width', road ? .55 : .7);
    map.setPaintProperty(layer.id, 'text-halo-color', dark ? 'rgba(12,18,23,0.85)' : 'rgba(255,255,255,0.9)');
    map.setPaintProperty(layer.id, 'text-color', dark ? '#f1f4f6' : '#293b43');
    if (road) map.setLayoutProperty(layer.id, 'text-size', ['interpolate',['linear'],['zoom'],10,11,14,12,18,13]);
    else if (place && typeof layer.layout['text-size'] === 'number') map.setLayoutProperty(layer.id, 'text-size', Math.max(12, layer.layout['text-size']));
  }
}
