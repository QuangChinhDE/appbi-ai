// Region centroid lookup (approx [lng, lat]) for geocoding a location DIMENSION
// (2-letter state codes) to a map position — the way Power BI / Tableau place a
// marker per region by name. Used by the MAP_POINT donut-marker mode when the
// chart has no explicit lat/lng. Covers Brazil (UF) + US states; extend as
// needed. Keys are upper-cased on lookup so "sp" / "SP" both match.
export const REGION_CENTROIDS: Record<string, readonly [number, number]> = {
  // ── Brazil (UF) ──
  AC: [-70.5, -9.0], AL: [-36.6, -9.6], AP: [-52.0, 1.4], AM: [-64.6, -4.1],
  BA: [-41.7, -12.5], CE: [-39.6, -5.5], DF: [-47.8, -15.8], ES: [-40.7, -19.6],
  GO: [-49.6, -16.0], MA: [-45.4, -5.4], MT: [-55.9, -12.6], MS: [-54.8, -20.5],
  MG: [-44.6, -18.5], PA: [-52.3, -4.0], PB: [-36.8, -7.1], PR: [-51.6, -24.8],
  PE: [-37.9, -8.4], PI: [-42.8, -7.7], RJ: [-42.6, -22.2], RN: [-36.6, -5.8],
  RS: [-53.5, -30.0], RO: [-62.8, -10.9], RR: [-61.4, 2.1], SC: [-50.5, -27.2],
  SP: [-48.6, -22.2], SE: [-37.4, -10.6], TO: [-48.3, -10.2],
  // ── US states ──
  AZ: [-111.7, 34.2], CA: [-119.7, 37.0], CO: [-105.5, 39.0], CT: [-72.7, 41.6],
  FL: [-81.7, 28.6], GA: [-83.4, 32.6], IA: [-93.5, 42.0], ID: [-114.6, 44.4],
  IL: [-89.2, 40.0], IN: [-86.3, 39.9], KS: [-98.4, 38.5], KY: [-84.9, 37.5],
  LA: [-92.0, 31.1], MD: [-76.8, 39.0], ME: [-69.2, 45.4],
  MI: [-85.0, 44.3], MN: [-94.3, 46.3], MO: [-92.5, 38.4],
  NC: [-79.4, 35.6], ND: [-100.5, 47.5], NE: [-99.8, 41.5], NH: [-71.6, 43.7],
  NJ: [-74.7, 40.2], NM: [-106.1, 34.4], NV: [-116.6, 39.3], NY: [-75.5, 42.9],
  OH: [-82.8, 40.2], OK: [-97.5, 35.6], OR: [-120.6, 44.0],
  RI: [-71.5, 41.7], SD: [-100.2, 44.4], TN: [-86.4, 35.9],
  TX: [-99.3, 31.5], UT: [-111.7, 39.3], VA: [-78.8, 37.5], VT: [-72.7, 44.1],
  WA: [-120.4, 47.4], WI: [-89.9, 44.6], WV: [-80.6, 38.6], WY: [-107.6, 43.0],
};

export function lookupCentroid(name: unknown): readonly [number, number] | null {
  if (name == null) return null;
  const key = String(name).trim().toUpperCase();
  return REGION_CENTROIDS[key] ?? null;
}
