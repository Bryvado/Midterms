// Shared by the simulated-outcomes panel and the precinct shift explorer: highest-density contours from a grid of cell masses.
const defaultLevels = [.5, .8, .95];
// Highest-density regions: cells sorted by mass, cumulative sum, and the mass of the cell that reaches each level is the contour value.
export function thresholds(cells, levels = defaultLevels) {
  const total = cells.reduce((sum, cell) => sum + cell.m, 0);
  const sorted = [...cells].sort((a, b) => b.m - a.m);
  const found = [];
  let cumulative = 0;
  for (const cell of sorted) {
    cumulative += cell.m;
    while (found.length < levels.length && cumulative >= levels[found.length] * total) found.push(cell.m);
    if (found.length === levels.length) break;
  }
  return found;
}

// Marching squares on the grid of cell masses (padded with a ring of zeros so every contour closes).
export function contours(cells, levels = defaultLevels) {
  const xs = [...new Set(cells.map(c => c.x))].sort((a, b) => a - b), ys = [...new Set(cells.map(c => c.y))].sort((a, b) => a - b);
  const step = list => list.slice(1).reduce((min, v, i) => Math.min(min, v - list[i]), Infinity);
  const dx = step(xs), dy = step(ys);
  const nx = Math.round((xs.at(-1) - xs[0]) / dx) + 3, ny = Math.round((ys.at(-1) - ys[0]) / dy) + 3;
  const grid = Array.from({ length:ny }, () => new Float64Array(nx));
  for (const c of cells) grid[Math.round((c.y - ys[0]) / dy) + 1][Math.round((c.x - xs[0]) / dx) + 1] = c.m;
  const at = (i, j) => [xs[0] + (i - 1) * dx, ys[0] + (j - 1) * dy];
  return thresholds(cells, levels).map(level => {
    const segments = [];
    const edge = (side, i, j, v) => {
      const lerp = (a, b, va, vb) => a + (level - va) / (vb - va) * (b - a);
      if (side === 'top') return [lerp(at(i, j)[0], at(i + 1, j)[0], v[0], v[1]), at(i, j)[1]];
      if (side === 'bottom') return [lerp(at(i, j + 1)[0], at(i + 1, j + 1)[0], v[3], v[2]), at(i, j + 1)[1]];
      if (side === 'left') return [at(i, j)[0], lerp(at(i, j)[1], at(i, j + 1)[1], v[0], v[3])];
      return [at(i + 1, j)[0], lerp(at(i + 1, j)[1], at(i + 1, j + 1)[1], v[1], v[2])];
    };
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const v = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
      const code = (v[0] >= level ? 8 : 0) + (v[1] >= level ? 4 : 0) + (v[2] >= level ? 2 : 0) + (v[3] >= level ? 1 : 0);
      const centre = (v[0] + v[1] + v[2] + v[3]) / 4 >= level;
      const table = { 1:[['left','bottom']], 2:[['bottom','right']], 3:[['left','right']], 4:[['top','right']], 6:[['top','bottom']], 7:[['top','left']], 8:[['top','left']], 9:[['top','bottom']], 11:[['top','right']], 12:[['left','right']], 13:[['bottom','right']], 14:[['left','bottom']],
        5:centre ? [['top','left'], ['right','bottom']] : [['top','right'], ['left','bottom']], 10:centre ? [['top','right'], ['left','bottom']] : [['top','left'], ['right','bottom']] };
      for (const [a, b] of table[code] || []) segments.push([edge(a, i, j, v), edge(b, i, j, v)]);
    }
    return segments;
  });
}

