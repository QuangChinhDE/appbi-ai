'use client';

/**
 * DatasetQualityScheduleModal
 * ---------------------------
 * Configure automation for a dataset's Quality checks:
 *   • Toggle scheduled runs on/off
 *   • Pick a recurrence preset (Daily/Weekly/Monthly) or enter a cron expression
 *   • Pick a timezone
 *   • Configure primary email recipient + CC list that receive the PDF report
 *
 * Bound to the `/quality/schedule` endpoint via useQualitySchedule /
 * useUpsertQualitySchedule hooks.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Info, Loader2, Mail, Plus, X } from 'lucide-react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import {
  type QualitySchedule,
  type QualityScheduleType,
  type QualityScheduleUpsert,
  useQualitySchedule,
  useUpsertQualitySchedule,
} from '@/hooks/use-datasets';
import { useCurrentUser } from '@/hooks/use-current-user';

interface Props {
  datasetId: number;
  open: boolean;
  canEdit: boolean;
  onClose: () => void;
}

type FrequencyMode = 'daily' | 'weekly' | 'monthly' | 'custom';

const WEEKDAYS = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
  { value: '0', label: 'Sun' },
];

const TIMEZONES = [
  'UTC',
  'Asia/Ho_Chi_Minh',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Cron helpers ────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function parsePresetFromCron(cron?: string | null): {
  mode: FrequencyMode;
  hour: number;
  minute: number;
  weekday: string;
  monthDay: number;
} {
  const defaults = { mode: 'daily' as FrequencyMode, hour: 8, minute: 0, weekday: '1', monthDay: 1 };
  if (!cron) return defaults;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...defaults, mode: 'custom' };

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const minuteNum = Number(minute);
  const hourNum = Number(hour);
  const monthDayNum = Number(dayOfMonth);
  const isSimpleTime = Number.isFinite(minuteNum) && Number.isFinite(hourNum);

  // Daily: "m h * * *"
  if (isSimpleTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { mode: 'daily', hour: hourNum, minute: minuteNum, weekday: '1', monthDay: 1 };
  }
  // Weekly: "m h * * d"
  if (isSimpleTime && dayOfMonth === '*' && month === '*' && /^[0-6]$/.test(dayOfWeek)) {
    return { mode: 'weekly', hour: hourNum, minute: minuteNum, weekday: dayOfWeek, monthDay: 1 };
  }
  // Monthly: "m h D * *"
  if (isSimpleTime && /^([1-9]|[12]\d|3[01])$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
    return {
      mode: 'monthly',
      hour: hourNum,
      minute: minuteNum,
      weekday: '1',
      monthDay: monthDayNum,
    };
  }
  return { ...defaults, mode: 'custom' };
}

function buildCron(mode: FrequencyMode, hour: number, minute: number, weekday: string, monthDay: number): string {
  switch (mode) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

function describeSchedule(mode: FrequencyMode, hour: number, minute: number, weekday: string, monthDay: number, timezone: string): string {
  const timeLabel = `${pad2(hour)}:${pad2(minute)}`;
  if (mode === 'daily') return `Daily at ${timeLabel} (${timezone})`;
  if (mode === 'weekly') {
    const weekdayLabel = WEEKDAYS.find((item) => item.value === weekday)?.label ?? weekday;
    return `Every ${weekdayLabel} at ${timeLabel} (${timezone})`;
  }
  if (mode === 'monthly') return `Day ${monthDay} of each month at ${timeLabel} (${timezone})`;
  return `Custom cron (${timezone})`;
}

function formatStoredScheduleTime(value?: string | null): string {
  if (!value) return '—';
  const text = String(value).trim();
  if (!text) return '—';
  const normalized = text.replace('T', ' ');
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return normalized;
}

// ── Component ────────────────────────────────────────────────────────────

export function DatasetQualityScheduleModal({ datasetId, open, canEdit, onClose }: Props) {
  const { data: schedule, isLoading } = useQualitySchedule(open ? datasetId : null);
  const { data: currentUser } = useCurrentUser();
  const upsert = useUpsertQualitySchedule(datasetId);

  const [enabled, setEnabled] = useState(false);
  const [type, setType] = useState<QualityScheduleType>('manual');
  const [mode, setMode] = useState<FrequencyMode>('daily');
  const [hour, setHour] = useState(8);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState('1');
  const [monthDay, setMonthDay] = useState(1);
  const [customCron, setCustomCron] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccDraft, setCcDraft] = useState('');
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset form from server data when opened or after refetch
  useEffect(() => {
    if (!open) return;
    const parsed = parsePresetFromCron(schedule?.cron);
    setEnabled(!!schedule?.enabled);
    setType(schedule?.type ?? 'manual');
    setMode(parsed.mode);
    setHour(parsed.hour);
    setMinute(parsed.minute);
    setWeekday(parsed.weekday);
    setMonthDay(parsed.monthDay);
    setCustomCron(schedule?.cron ?? '');
    setTimezone(schedule?.timezone || 'UTC');
    const defaultEmail = schedule?.recipient_email || currentUser?.email || '';
    setRecipientEmail(defaultEmail);
    setCcEmails(schedule?.cc_emails ?? []);
    setCcDraft('');
    setNotifyOnSuccess(schedule?.notify_on_success ?? true);
    setNotifyOnFailure(schedule?.notify_on_failure ?? true);
    setLocalError(null);
  }, [open, schedule, currentUser?.email]);

  const effectiveCron = useMemo(() => {
    if (mode === 'custom') return customCron.trim();
    return buildCron(mode, hour, minute, weekday, monthDay);
  }, [mode, hour, minute, weekday, monthDay, customCron]);

  const scheduleSummary = useMemo(
    () => describeSchedule(mode, hour, minute, weekday, monthDay, timezone),
    [mode, hour, minute, weekday, monthDay, timezone],
  );

  const savedNextRunTimezone = schedule?.timezone || timezone;

  const nextCcIsValid = !ccDraft.trim() || EMAIL_REGEX.test(ccDraft.trim().toLowerCase());
  const recipientIsValid = !recipientEmail.trim() || EMAIL_REGEX.test(recipientEmail.trim().toLowerCase());

  function addCc() {
    const candidate = ccDraft.trim().toLowerCase();
    if (!candidate) return;
    if (!EMAIL_REGEX.test(candidate)) {
      setLocalError(`Invalid CC email: ${candidate}`);
      return;
    }
    if (candidate === recipientEmail.trim().toLowerCase()) {
      setLocalError('CC already matches the primary recipient.');
      return;
    }
    if (ccEmails.includes(candidate)) {
      setLocalError('That email is already in the CC list.');
      return;
    }
    setCcEmails((prev) => [...prev, candidate]);
    setCcDraft('');
    setLocalError(null);
  }

  function removeCc(email: string) {
    setCcEmails((prev) => prev.filter((e) => e !== email));
  }

  async function handleSave() {
    setLocalError(null);

    const body: QualityScheduleUpsert = {
      enabled,
      type,
      cron: enabled && type === 'schedule' ? effectiveCron : null,
      timezone,
      recipient_email: recipientEmail.trim().toLowerCase() || null,
      cc_emails: ccEmails,
      notify_on_success: notifyOnSuccess,
      notify_on_failure: notifyOnFailure,
    };

    if (enabled && type === 'schedule') {
      if (!body.cron) {
        setLocalError('Please configure a schedule or provide a cron expression.');
        return;
      }
      if (!body.recipient_email) {
        setLocalError('A primary email recipient is required for scheduled runs.');
        return;
      }
      if (!recipientIsValid) {
        setLocalError('Primary email address is invalid.');
        return;
      }
    }

    try {
      await upsert.mutateAsync(body);
      toast.success('Quality automation saved', {
        description: enabled && type === 'schedule'
          ? 'Scheduled runs will email the configured recipients after each execution.'
          : 'Automatic runs are turned off.',
      });
      onClose();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      const msg = typeof detail === 'string'
        ? detail
        : Array.isArray(detail) && detail[0]?.msg
          ? detail[0].msg
          : err?.message || 'Failed to save automation settings.';
      setLocalError(msg);
    }
  }

  if (!open) return null;

  const readOnly = !canEdit;
  const hoursOptions = Array.from({ length: 24 }, (_, i) => i);
  const minutesOptions = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const monthDayOptions = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <AppModalShell
      title="Quality Automation"
      description="Run the enabled rules automatically and email a PDF report to the recipients below."
      icon={<CalendarClock className="h-4 w-4" />}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      closeDisabled={upsert.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={upsert.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={readOnly || upsert.isPending}
            leadingIcon={upsert.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            Save automation
          </Button>
        </>
      }
    >
      {isLoading && !schedule ? (
        <div className="flex items-center gap-2 text-caption text-text-tertiary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading automation settings…
        </div>
      ) : (
        <div className="space-y-5">
          {/* Automation toggle */}
          <section className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  const v = e.target.checked;
                  setEnabled(v);
                  setType(v ? 'schedule' : 'manual');
                }}
                disabled={readOnly}
                className="mt-0.5 h-4 w-4"
              />
              <div className="min-w-0">
                <div className="text-small font-emphasis text-text-primary">Run quality checks automatically</div>
                <div className="mt-0.5 text-caption text-text-tertiary">
                  When enabled, AppBI runs every enabled rule on this dataset on the schedule below
                  and emails a PDF report to the recipients.
                </div>
              </div>
            </label>
          </section>

          {/* Schedule config */}
          <section className={`space-y-3 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="text-caption font-emphasis text-text-secondary uppercase tracking-wide">
              Recurrence
            </div>

            <div className="flex flex-wrap gap-2">
              {(['daily', 'weekly', 'monthly', 'custom'] as FrequencyMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  disabled={readOnly}
                  className={`rounded-md border px-3 py-1.5 text-caption transition-colors ${
                    mode === m
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
                  }`}
                >
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>

            {mode !== 'custom' && (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-caption text-text-tertiary">At</span>
                  <select
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                    disabled={readOnly}
                    className="h-8 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-caption"
                  >
                    {hoursOptions.map((h) => (
                      <option key={h} value={h}>{pad2(h)}</option>
                    ))}
                  </select>
                  <span className="text-text-tertiary">:</span>
                  <select
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                    disabled={readOnly}
                    className="h-8 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-caption"
                  >
                    {minutesOptions.map((m) => (
                      <option key={m} value={m}>{pad2(m)}</option>
                    ))}
                  </select>
                </div>

                {mode === 'weekly' && (
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-text-tertiary">on</span>
                    <select
                      value={weekday}
                      onChange={(e) => setWeekday(e.target.value)}
                      disabled={readOnly}
                      className="h-8 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-caption"
                    >
                      {WEEKDAYS.map((w) => (
                        <option key={w.value} value={w.value}>{w.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {mode === 'monthly' && (
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-text-tertiary">on day</span>
                    <select
                      value={monthDay}
                      onChange={(e) => setMonthDay(Number(e.target.value))}
                      disabled={readOnly}
                      className="h-8 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-caption"
                    >
                      {monthDayOptions.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {mode === 'custom' && (
              <div className="space-y-1.5">
                <label className="block text-caption text-text-secondary">
                  Custom cron expression (5 fields: <code>minute hour day month weekday</code>)
                </label>
                <input
                  type="text"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 2 * * *"
                  disabled={readOnly}
                  className="h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption font-mono"
                />
                <div className="flex items-start gap-1.5 text-caption text-text-tertiary">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Examples: <code>0 2 * * *</code> (every day at 02:00) · <code>30 6 * * 1</code> (every Monday at 06:30).
                  </span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-caption text-text-tertiary">Timezone</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={readOnly}
                className="h-8 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-caption"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
                {!TIMEZONES.includes(timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
              </select>
            </div>

            {effectiveCron && (
              <div className="space-y-1.5 rounded-md bg-surface-2 px-3 py-2 text-caption text-text-tertiary">
                <div>
                  Schedule: <span className="text-text-secondary">{scheduleSummary}</span>
                </div>
                <div>
                  Cron <span className="text-[11px]">(minute hour day month weekday)</span>: <code className="font-mono text-text-secondary">{effectiveCron}</code>
                </div>
                {schedule?.next_run_at && enabled && (
                  <div>
                    Next run: <span className="text-text-secondary">{formatStoredScheduleTime(schedule.next_run_at)}</span> {savedNextRunTimezone}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Email config */}
          <section className={`space-y-3 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="text-caption font-emphasis text-text-secondary uppercase tracking-wide">
              Email notifications
            </div>

            <div className="space-y-1.5">
              <label className="block text-caption text-text-secondary">Primary recipient</label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-text-quaternary" />
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="owner@company.com"
                  disabled={readOnly}
                  className="h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 pl-8 pr-3 text-caption"
                />
              </div>
              {!recipientIsValid && (
                <div className="text-caption text-danger">Invalid email address.</div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-caption text-text-secondary">CC (optional)</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={ccDraft}
                  onChange={(e) => setCcDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCc();
                    }
                  }}
                  placeholder="teammate@company.com"
                  disabled={readOnly}
                  className="h-9 flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={addCc}
                  disabled={readOnly || !ccDraft.trim() || !nextCcIsValid}
                  leadingIcon={<Plus className="h-3.5 w-3.5" />}
                >
                  Add
                </Button>
              </div>
              {ccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ccEmails.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1 text-caption text-text-secondary"
                    >
                      {email}
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => removeCc(email)}
                          className="text-text-quaternary hover:text-danger"
                          aria-label={`Remove ${email}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-4 pt-1">
              <label className="flex items-center gap-2 text-caption text-text-secondary">
                <input
                  type="checkbox"
                  checked={notifyOnSuccess}
                  onChange={(e) => setNotifyOnSuccess(e.target.checked)}
                  disabled={readOnly}
                />
                Send on success
              </label>
              <label className="flex items-center gap-2 text-caption text-text-secondary">
                <input
                  type="checkbox"
                  checked={notifyOnFailure}
                  onChange={(e) => setNotifyOnFailure(e.target.checked)}
                  disabled={readOnly}
                />
                Send on failure
              </label>
            </div>
          </section>

          {/* Status / last run */}
          {schedule && (schedule.last_run_at || schedule.last_error) && (
            <section className="rounded-md bg-surface-2 px-3 py-2 text-caption text-text-tertiary space-y-0.5">
              {schedule.last_run_at && (
                <div>
                  Last run: <span className="text-text-secondary">{schedule.last_run_at}</span>{' '}
                  {schedule.last_run_status && `· status ${schedule.last_run_status}`}
                </div>
              )}
              {schedule.last_error && (
                <div className="text-warning">Last error: {schedule.last_error}</div>
              )}
            </section>
          )}

          {localError && (
            <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{localError}</span>
            </div>
          )}
        </div>
      )}
    </AppModalShell>
  );
}
