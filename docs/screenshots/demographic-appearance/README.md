# Demographic shading and appearance

Desktop captures use 1440 × 900; phone captures use a 390 × 844 viewport and include the stacked page.

The sun/moon menu independently sets the map background and the data-display theme. Dark data surfaces use blue-gray (#1b2937) against the dark basemap's black background. All four combinations were checked. Demographic maps use the existing sequential palettes and published fields; CVAP labels identify the denominator. Income retains the precinct median / aggregate average-of-precinct-medians distinction.

## Validation

- `npm --prefix dashboard run build` passed; the existing Vite bundle-size warning remains.
- Browser checks passed for all four map/panel combinations, independent preference persistence, demographic deep links, nine demographic/electorate measures across county, district, subdivision and precinct levels, and income-label switching.
- All 44 poll marks kept the same positions and data through theme changes. Chart colors follow the data-display theme; changing only the map theme leaves them unchanged. A lighter neutral midpoint makes nearly tied polls visible on dark panels without changing their margin, influence, shape or size encodings.
- Dark Methods, expanded-chart and filter dialogs, mobile popover bounds, Escape dismissal, and phone horizontal overflow checks passed; no JavaScript errors. Both OpenFreeMap styles returned HTTP 200.
- Decoded the existing zoom-5 tile at (7, 13) for each level: 140 county, 28 district, 490 subdivision and 5,570 precinct features. Character-format IDs and all nine numeric fields matched the published detail CSVs within the existing four-decimal tile precision.
- No model inputs, published data, allocation or simulation methods changed. Shared field metadata keeps dropdown selection and detail-number selection on the same scale. Existing percentage caps affect presentation only; income aggregation and ecological-inference caveats remain explicit.

Included previews: `desktop-light.png`, `desktop-dark.png`, `desktop-dark-map-light-panels.png`, `phone-dark.png`. Additional screenshots were captured and reviewed locally, but their GitHub uploads were blocked by automatic approval review.
