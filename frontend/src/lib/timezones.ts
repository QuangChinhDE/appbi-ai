/**
 * IANA timezone helpers for the refresh-schedule picker.
 *
 * The backend scheduler already honours ``schedule.timezone`` (APScheduler
 * CronTrigger(timezone=...)); this just lets the DA pick one instead of the
 * silent UTC default. New schedules default to the browser's own zone so "run
 * at 02:00" means 02:00 where the user is, not 02:00 UTC.
 */

/** The viewer's own IANA zone (e.g. "Asia/Ho_Chi_Minh"), or "UTC" as fallback. */
export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const FALLBACK_TIMEZONES = [
  'UTC',
  'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Jakarta',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Australia/Sydney', 'Pacific/Auckland',
];

/** Full IANA list where supported (~400 zones), else a curated fallback. UTC and
 *  the browser zone are pinned first for quick access. */
export function listTimezones(): string[] {
  let zones: string[] = FALLBACK_TIMEZONES;
  try {
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof anyIntl.supportedValuesOf === 'function') {
      const all = anyIntl.supportedValuesOf('timeZone');
      if (Array.isArray(all) && all.length) zones = all;
    }
  } catch {
    /* keep fallback */
  }
  const pinned = Array.from(new Set(['UTC', getBrowserTimezone()]));
  const rest = zones.filter((z) => !pinned.includes(z)).sort();
  return [...pinned, ...rest];
}

/** Current UTC offset label for a zone, e.g. "UTC+07:00" — for the option text. */
export function timezoneOffsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date());
    const off = parts.find((p) => p.type === 'timeZoneName')?.value;
    return off ? off.replace('GMT', 'UTC') : '';
  } catch {
    return '';
  }
}
