'use client';

/**
 * Preview — run a DRAFT flow once against a real report and watch it work.
 *
 * This is the step that makes the Studio usable by someone who does not read
 * logs: nodes light up as they execute, the answer streams in, and the footer
 * shows what the run actually cost. A flow that only reveals its behaviour
 * after being published is a flow nobody will dare publish.
 *
 * It spends real provider tokens, so it is one question at a time and every run
 * is recorded with mode='preview' — kept out of production metrics.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Loader2, Play, Square, X } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { type PreviewEvent, type Surfaces, getSurfaces, runPreview } from '@/lib/aiFlows';

interface Props {
  flowKey: string;
  version: number;
  onNodeState: (nodeKey: string, state: 'running' | 'ok' | 'error') => void;
  onReset: () => void;
  onClose: () => void;
}

interface Summary {
  runId?: string;
  usd?: number;
  modelCalls?: number;
  toolCalls?: number;
  coverage?: number | null;
  errors?: { node?: string; code?: string }[];
}

export function PreviewPanel({ flowKey, version, onNodeState, onReset, onClose }: Props) {
  const [surfaces, setSurfaces] = useState<Surfaces | null>(null);
  const [token, setToken] = useState('');
  const [question, setQuestion] = useState('Doanh thu tổng cộng là bao nhiêu?');
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState('');
  const [errorText, setErrorText] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const abort = useRef<AbortController | null>(null);

  React.useEffect(() => {
    getSurfaces()
      .then((s) => {
        setSurfaces(s);
        if (s.public_links.length && !token) setToken(s.public_links[0].token);
      })
      .catch(() => toast.error('Không tải được danh sách báo cáo'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    if (!token) { toast.error('Chọn một báo cáo để chạy thử'); return; }
    setRunning(true);
    setAnswer('');
    setErrorText('');
    setSummary(null);
    setStatus('Đang khởi động…');
    onReset();
    abort.current = new AbortController();

    const onEvent = (ev: PreviewEvent) => {
      switch (ev.type) {
        case 'node_started':
          if (ev.node) onNodeState(ev.node, 'running');
          setStatus(`Đang chạy bước ${ev.node}…`);
          break;
        case 'node_completed':
          if (ev.node) onNodeState(ev.node, ev.ok === false ? 'error' : 'ok');
          break;
        case 'status':
          if (ev.text) setStatus(ev.text);
          break;
        case 'text':
          if (ev.text) setAnswer((a) => a + ev.text);
          break;
        case 'error':
          setErrorText((t) => t + (t ? '\n' : '') + (ev.text ?? ''));
          break;
        case 'preview_done':
          setSummary({
            runId: ev.run_id,
            usd: ev.usd,
            modelCalls: ev.model_calls,
            toolCalls: ev.tool_calls,
            coverage: ev.verification?.coverage ?? null,
            errors: ev.errors,
          });
          setStatus('');
          break;
        default:
          break;
      }
    };

    try {
      await runPreview({ flow_key: flowKey, version, token, question }, onEvent, abort.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setErrorText((e as Error).message || 'Chạy thử thất bại');
      }
    } finally {
      setRunning(false);
      setStatus('');
    }
  }, [token, question, flowKey, version, onNodeState, onReset]);

  const stop = () => { abort.current?.abort(); setRunning(false); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-caption font-strong text-text-primary">Chạy thử</div>
        <Button variant="ghost" size="xs" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>
      </div>

      <div>
        <Label>Chạy trên báo cáo</Label>
        <Select value={token} onChange={(e) => setToken(e.target.value)} disabled={running}>
          <option value="">— chọn báo cáo —</option>
          {(surfaces?.public_links ?? []).map((l) => (
            <option key={l.token} value={l.token}>
              {l.dashboard_name} ({l.provider ?? 'chưa rõ'})
            </option>
          ))}
        </Select>
        {surfaces && surfaces.public_links.length === 0 && (
          <p className="mt-1 text-tiny text-warning">
            Chưa có link chia sẻ nào bật trợ lý AI. Bật ở màn hình chia sẻ báo cáo trước.
          </p>
        )}
      </div>

      <div>
        <Label>Câu hỏi thử</Label>
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={running} />
      </div>

      {running ? (
        <Button variant="secondary" size="sm" onClick={stop} className="w-full">
          <Square className="h-3.5 w-3.5" /> Dừng
        </Button>
      ) : (
        <Button variant="primary" size="sm" onClick={start} className="w-full" disabled={!token}>
          <Play className="h-3.5 w-3.5" /> Chạy thử
        </Button>
      )}

      {status && (
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-tiny text-text-secondary">
          <Loader2 className="h-3 w-3 animate-spin" /> {status}
        </div>
      )}

      {answer && (
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
          <div className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
            Câu trả lời
          </div>
          <div className="whitespace-pre-wrap text-tiny leading-relaxed text-text-primary">{answer}</div>
        </div>
      )}

      {errorText && (
        <div className="whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger/[0.05] p-2.5 text-tiny text-danger">
          {errorText}
        </div>
      )}

      {summary && (
        <div className="space-y-1.5 rounded-lg border border-[rgb(var(--border-line))] p-2.5">
          <div className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
            Kết quả lượt chạy
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="subtle" size="xs">{summary.modelCalls ?? 0} lượt AI</Badge>
            <Badge variant="subtle" size="xs">{summary.toolCalls ?? 0} công cụ</Badge>
            <Badge variant="subtle" size="xs">${(summary.usd ?? 0).toFixed(4)}</Badge>
            {summary.coverage != null && (
              <Badge variant={summary.coverage >= 0.999 ? 'success' : 'warning'} size="xs">
                kiểm chứng {Math.round(summary.coverage * 100)}%
              </Badge>
            )}
          </div>
          {!!summary.errors?.length && (
            <ul className="space-y-0.5 text-tiny text-danger">
              {summary.errors.map((e, i) => (
                <li key={i}>{e.node}: {e.code}</li>
              ))}
            </ul>
          )}
          {summary.runId && (
            <div className="text-tiny text-text-quaternary">
              mã lượt chạy: <code>{summary.runId.slice(0, 12)}…</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
