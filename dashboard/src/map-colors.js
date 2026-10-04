import { lab } from 'd3-color';

// Raise lightness, never invert hue or the value axis. Charts use their own palettes.
export function darkMapColor(color, position, diverging) {
  const c = lab(color), t = Math.max(0, Math.min(1, position));
  const lift = diverging
    ? Math.max(0, 84 - c.l) * Math.sin(Math.PI * t) ** .7
    : .85 * Math.max(0, 42 + 44 * t - c.l);
  const chroma = 1 - .2 * lift / Math.max(1, 100 - c.l);
  c.l = Math.min(100, c.l + lift);
  c.a *= chroma;
  c.b *= chroma;
  return c.formatHex();
}
