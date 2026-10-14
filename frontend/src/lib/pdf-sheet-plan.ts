/**
 * Where to cut a tall snapshot into sheets, and at which scale.
 *
 * Each sheet ends at the lowest row edge that fits (never mid-chart, never
 * under a lone heading). At ONE fixed scale a tall next row left a sheet up to
 * ~65% empty. So a few scales are tried, from the width-fit down to 80% of it
 * (never below the readable floor): fewest sheets wins, then the least empty
 * space on any sheet but the last, then the larger scale. Exported for tests.
 */
export function planSnapshotSheets(
  ch: number,
  cuts: number[],
  pxPerSheetAt: (scale: number) => number,
  widthFit: number,
  floor: number,
): { scale: number; sheets: Array<[number, number]> } {
  const partition = (pxPerSheet: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let from = 0;
    while (from < ch && out.length < 200) {
      const limit = from + pxPerSheet;
      const edge = cuts.filter((y) => y > from + pxPerSheet * 0.35 && y <= limit).pop();
      const to = limit >= ch ? ch : (edge ?? limit);
      out.push([from, to]);
      from = to;
    }
    return out;
  };
  let best: { scale: number; sheets: Array<[number, number]>; waste: number } | null = null;
  for (let k = 0; k <= 5; k++) {
    const scale = widthFit * (1 - k * 0.04);
    if (k > 0 && scale < floor) break;
    const pxPerSheet = pxPerSheetAt(scale);
    const sheets = partition(pxPerSheet);
    const waste = sheets.slice(0, -1).reduce((mx, [a, b]) => Math.max(mx, 1 - (b - a) / pxPerSheet), 0);
    if (!best || sheets.length < best.sheets.length
        || (sheets.length === best.sheets.length && waste < best.waste - 0.05)) {
      best = { scale, sheets, waste };
    }
  }
  return { scale: best!.scale, sheets: best!.sheets };
}
