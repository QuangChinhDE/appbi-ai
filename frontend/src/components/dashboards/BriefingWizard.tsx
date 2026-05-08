'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Check, ChevronRight, RefreshCw, AlertTriangle, Loader2,
  Target, User, Calendar, Lightbulb, X,
} from 'lucide-react';
import {
  fetchAiBriefingGuess,
  streamAiBriefingBrief,
  type AiBriefing,
  type AiBriefingGuess,
  type AiBriefingGuessOption,
  type AiProvider,
} from '@/lib/api/public';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BriefingWizardResult {
  /** Confirmed briefing — stored in component state and sent on every chat turn. */
  briefing: AiBriefing;
  /** Streamed Executive Brief paragraph — also rendered as the welcome message. */
  executiveBrief: string;
}

interface Props {
  token: string;
  sessionToken?: string | null;
  apiKey: string;
  provider: AiProvider;
  model: string;
  onSkip: () => void;
  onComplete: (result: BriefingWizardResult) => void;
}

type Step = 'loading' | 'domain' | 'profile' | 'brief' | 'error';

// ── Component ────────────────────────────────────────────────────────────────

export function BriefingWizard({
  token, sessionToken, apiKey, provider, model, onSkip, onComplete,
}: Props) {
  const [step, setStep] = useState<Step>('loading');
  const [error, setError] = useState('');
  const [guess, setGuess] = useState<AiBriefingGuess | null>(null);

  // Step 1 — domain confirmation
  const [domain, setDomain] = useState('');
  const [domainLabel, setDomainLabel] = useState('');

  // Step 2 — role / focus / timeframe + free-text note
  const [role, setRole] = useState<string>('manager');
  const [focus, setFocus] = useState<string>('overview');
  const [timeframe, setTimeframe] = useState<string>('current_period');
  const [note, setNote] = useState('');

  // Step 3 — executive brief
  const [briefText, setBriefText] = useState('');
  const [briefStreaming, setBriefStreaming] = useState(false);
  const [briefError, setBriefError] = useState('');

  // ── Load guess on mount ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await fetchAiBriefingGuess(token, sessionToken ?? undefined);
        if (cancelled) return;
        setGuess(g);
        setDomain(g.domain || 'generic');
        setDomainLabel(g.domain_label || g.domain || 'Tổng hợp');
        setStep('domain');
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Không tải được dự đoán.');
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token, sessionToken]);

  // ── Step 1 handlers ────────────────────────────────────────────────────────

  const handleDomainPick = useCallback((value: string, label: string) => {
    setDomain(value);
    setDomainLabel(label);
  }, []);

  const handleDomainConfirm = useCallback(() => {
    setStep('profile');
  }, []);

  // ── Step 2 → trigger brief ─────────────────────────────────────────────────

  const triggerBrief = useCallback(async (briefingArg: AiBriefing) => {
    setStep('brief');
    setBriefText('');
    setBriefError('');
    setBriefStreaming(true);
    try {
      const gen = streamAiBriefingBrief(
        token,
        briefingArg,
        apiKey,
        provider,
        model,
        sessionToken ?? undefined,
      );
      let acc = '';
      for await (const ev of gen) {
        if (ev.type === 'text') {
          acc += ev.text;
          setBriefText(acc);
        } else if (ev.type === 'error') {
          setBriefError(ev.text);
        }
      }
      // If LLM returned nothing (BYOK quota / connectivity), provide a
      // fallback so the user can still proceed.
      if (!acc.trim()) {
        const fallback = buildFallbackBrief(guess, briefingArg);
        acc = fallback;
        setBriefText(fallback);
      }
      // After streaming, finalise and call onComplete
      onComplete({ briefing: briefingArg, executiveBrief: acc });
    } catch (err: unknown) {
      const fallback = buildFallbackBrief(guess, briefingArg);
      setBriefText(fallback);
      setBriefError(err instanceof Error ? err.message : 'Không sinh được brief.');
      onComplete({ briefing: briefingArg, executiveBrief: fallback });
    } finally {
      setBriefStreaming(false);
    }
  }, [apiKey, guess, model, onComplete, provider, sessionToken, token]);

  const handleProfileConfirm = useCallback(() => {
    if (!guess) return;
    const briefing: AiBriefing = {
      domain,
      domain_label: domainLabel,
      role,
      focus,
      timeframe,
      custom_note: note.trim().slice(0, 600),
      key_chart_ids: guess.key_chart_ids,
      confirmed: true,
    };
    triggerBrief(briefing);
  }, [domain, domainLabel, focus, guess, note, role, timeframe, triggerBrief]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-4 text-caption text-text-tertiary">
        <Loader2 className="h-4 w-4 animate-spin text-brand" />
        Đang đọc nhanh dashboard để chuẩn bị câu hỏi mở đầu…
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-caption text-danger">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-strong">Không tải được khảo sát mở đầu</div>
            <div className="text-tiny opacity-80">{error}</div>
          </div>
        </div>
        <button
          onClick={onSkip}
          className="rounded-lg bg-brand px-3 py-1.5 text-caption font-strong text-white transition-colors hover:bg-brand/90"
        >
          Bỏ qua, vào chat thẳng
        </button>
      </div>
    );
  }

  if (step === 'domain' && guess) {
    return (
      <DomainStep
        guess={guess}
        domain={domain}
        domainLabel={domainLabel}
        onPick={handleDomainPick}
        onConfirm={handleDomainConfirm}
        onSkip={onSkip}
      />
    );
  }

  if (step === 'profile' && guess) {
    return (
      <ProfileStep
        guess={guess}
        domain={domain}
        domainLabel={domainLabel}
        role={role}
        focus={focus}
        timeframe={timeframe}
        note={note}
        onRole={setRole}
        onFocus={setFocus}
        onTimeframe={setTimeframe}
        onNote={setNote}
        onBack={() => setStep('domain')}
        onConfirm={handleProfileConfirm}
        onSkip={onSkip}
      />
    );
  }

  if (step === 'brief') {
    return (
      <BriefStep
        text={briefText}
        streaming={briefStreaming}
        warning={briefError}
      />
    );
  }

  return null;
}

// ── Step 1 — Domain ──────────────────────────────────────────────────────────

function DomainStep({
  guess, domain, domainLabel, onPick, onConfirm, onSkip,
}: {
  guess: AiBriefingGuess;
  domain: string;
  domainLabel: string;
  onPick: (value: string, label: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const altDomains = useMemo(
    () => guess.alt_domains.filter((a) => a.domain !== domain).slice(0, 3),
    [domain, guess.alt_domains],
  );
  const confidencePct = Math.round((guess.confidence ?? 0) * 100);
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      <Header step={1} total={3} title="Lĩnh vực dashboard" onSkip={onSkip} />

      <div className="rounded-lg border border-brand/20 bg-brand/5 p-3 text-caption">
        <div className="mb-1 flex items-center gap-1.5 text-tiny font-strong text-brand">
          <Sparkles className="h-3.5 w-3.5" /> AI đoán:
        </div>
        <div className="text-text-primary">
          Đây có vẻ là dashboard về <span className="font-strong">{domainLabel}</span>
          {confidencePct > 0 && (
            <span className="ml-1 text-text-tertiary text-tiny">
              (độ tự tin {confidencePct}%)
            </span>
          )}
          .
        </div>
        {guess.headline_facts.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-tiny text-text-secondary">
            {guess.headline_facts.slice(0, 3).map((f, i) => (
              <li key={i}>• {f.text}</li>
            ))}
          </ul>
        )}
        {guess.timeframe_hint && (
          <div className="mt-2 text-tiny text-text-tertiary">
            <Calendar className="mr-1 inline h-3 w-3" />
            {guess.timeframe_hint}
          </div>
        )}
      </div>

      <div className="text-caption text-text-secondary">
        Đúng không? Nếu chưa khớp, sửa lại lĩnh vực dưới đây.
      </div>

      {altDomains.length > 0 && !showPicker && (
        <div className="flex flex-wrap gap-1.5">
          {altDomains.map((a) => (
            <button
              key={a.domain}
              onClick={() => onPick(a.domain, a.label)}
              className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-tiny text-text-secondary transition-colors hover:bg-surface-3"
            >
              {a.label}
            </button>
          ))}
          <button
            onClick={() => setShowPicker(true)}
            className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-tiny text-text-secondary transition-colors hover:bg-surface-3"
          >
            Khác…
          </button>
        </div>
      )}

      {showPicker && (
        <select
          value={domain}
          onChange={(e) => {
            const v = e.target.value;
            const label = guess.domain_catalog.find((d) => d.value === v)?.label || v;
            onPick(v, label);
          }}
          className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption text-text-primary"
        >
          {guess.domain_catalog.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onSkip}
          className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption text-text-secondary transition-colors hover:bg-surface-3"
        >
          Bỏ qua
        </button>
        <button
          onClick={onConfirm}
          className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-caption font-strong text-white transition-colors hover:bg-brand/90"
        >
          Đúng rồi <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Step 2 — Profile (role / focus / timeframe + note) ─────────────────────

function ProfileStep({
  guess, domain, domainLabel, role, focus, timeframe, note,
  onRole, onFocus, onTimeframe, onNote, onBack, onConfirm, onSkip,
}: {
  guess: AiBriefingGuess;
  domain: string;
  domainLabel: string;
  role: string;
  focus: string;
  timeframe: string;
  note: string;
  onRole: (v: string) => void;
  onFocus: (v: string) => void;
  onTimeframe: (v: string) => void;
  onNote: (v: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      <Header step={2} total={3} title="Bạn là ai, đang tìm gì?" onSkip={onSkip} />

      <div className="rounded-lg bg-surface-2 px-3 py-2 text-tiny text-text-secondary">
        Lĩnh vực: <span className="font-strong text-text-primary">{domainLabel}</span>
        <button
          onClick={onBack}
          className="ml-2 text-brand hover:underline"
        >
          Đổi
        </button>
      </div>

      <div>
        <Label icon={<User className="h-3 w-3" />} text="Vai trò của bạn" />
        <OptionPills
          options={guess.role_options}
          value={role}
          onChange={onRole}
        />
      </div>

      <div>
        <Label icon={<Target className="h-3 w-3" />} text="Bạn quan tâm điều gì hôm nay" />
        <OptionPills
          options={guess.focus_options}
          value={focus}
          onChange={onFocus}
        />
      </div>

      <div>
        <Label icon={<Calendar className="h-3 w-3" />} text="Khung thời gian" />
        <OptionPills
          options={guess.timeframe_options}
          value={timeframe}
          onChange={onTimeframe}
        />
      </div>

      <div>
        <Label icon={<Lightbulb className="h-3 w-3" />} text="Ghi chú thêm (tuỳ chọn)" />
        <textarea
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="Vd: Quan tâm tới phòng IT, đặc biệt là task quá hạn"
          rows={2}
          maxLength={600}
          className="w-full resize-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand/60 focus:outline-none"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onBack}
          className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption text-text-secondary transition-colors hover:bg-surface-3"
        >
          Quay lại
        </button>
        <button
          onClick={onConfirm}
          className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-caption font-strong text-white transition-colors hover:bg-brand/90"
        >
          Tóm tắt cho tôi <Sparkles className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Step 3 — Brief streaming ────────────────────────────────────────────────

function BriefStep({
  text, streaming, warning,
}: {
  text: string;
  streaming: boolean;
  warning: string;
}) {
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      <Header step={3} total={3} title="Tóm tắt khởi đầu" hideSkip />

      <div className="rounded-lg border border-brand/30 bg-brand/5 p-3 text-caption text-text-primary">
        {streaming && !text && (
          <div className="flex items-center gap-2 text-text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
            <span className="italic">AI đang viết Executive Brief…</span>
          </div>
        )}
        {text && (
          <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
        )}
      </div>

      {warning && !streaming && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2 text-tiny text-warning">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>Có lỗi khi gọi LLM ({warning}). Hiển thị bản tóm tắt heuristic.</span>
        </div>
      )}

      {!streaming && text && (
        <div className="text-tiny text-text-tertiary">
          Bot đã sẵn sàng nhận câu hỏi. Brief này được giữ làm bối cảnh cho mọi câu hỏi tiếp theo.
        </div>
      )}
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function Header({
  step, total, title, onSkip, hideSkip = false,
}: {
  step: number;
  total: number;
  title: string;
  onSkip?: () => void;
  hideSkip?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-tiny text-text-tertiary">Bước {step}/{total}</div>
        <div className="text-caption font-strong text-text-primary">{title}</div>
      </div>
      {!hideSkip && onSkip && (
        <button
          onClick={onSkip}
          className="text-tiny text-text-tertiary hover:text-text-secondary"
        >
          Bỏ qua khảo sát
        </button>
      )}
    </div>
  );
}

function Label({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="mb-1 flex items-center gap-1 text-tiny text-text-secondary">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function OptionPills({
  options, value, onChange,
}: {
  options: AiBriefingGuessOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.hint_vi || opt.label_vi || opt.label || opt.value}
            className={`rounded-full px-2.5 py-1 text-tiny font-strong transition-colors ${
              active
                ? 'bg-brand text-white'
                : 'border border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:bg-surface-3'
            }`}
          >
            {active && <Check className="mr-1 inline h-3 w-3" />}
            {opt.label_vi || opt.label || opt.value}
          </button>
        );
      })}
    </div>
  );
}

// ── Fallback brief (when LLM call failed) ────────────────────────────────────

function buildFallbackBrief(guess: AiBriefingGuess | null, briefing: AiBriefing): string {
  const lines: string[] = [];
  lines.push(
    `Tóm tắt nhanh dashboard ${briefing.domain_label || 'tổng hợp'} ` +
    `(vai trò: ${briefing.role}, trọng tâm: ${briefing.focus}).`,
  );
  if (guess && guess.headline_facts.length > 0) {
    lines.push('');
    lines.push('Điểm cần chú ý:');
    for (const f of guess.headline_facts.slice(0, 3)) {
      lines.push(`- ${f.text}`);
    }
  }
  lines.push('');
  lines.push('[FOLLOWUP] Phòng/đối tượng nào đáng chú ý nhất?');
  lines.push('[FOLLOWUP] Có chỉ số nào đang xấu đi không?');
  lines.push('[FOLLOWUP] So sánh với kỳ trước thế nào?');
  return lines.join('\n');
}
