/** Time-axis bucket values from the chart engine. */

/** A bucket value as a Date. The engine returns naive timestamps
 *  ("2018-01-01T00:00:00") that name a CALENDAR period, not an instant; parsed
 *  as local time they land in the previous month for any viewer east of UTC.
 *  So a string without an offset is read as UTC, and every calendar operation
 *  below uses UTC. */
export function parseBucket(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
