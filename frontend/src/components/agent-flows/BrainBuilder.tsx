'use client';

/**
 * The bench for building one brain.
 *
 * WHY THE LAYOUT CHANGED
 * The previous version put the CHAIN in the wide centre column (capped at
 * `max-w-2xl`, so most of it was empty) and the STEP EDITOR in a right-hand half
 * panel. That is backwards from every other detail screen in the product: Datasets
 * puts the table tree in a `w-72` rail on the left and the work surface on the
 * right, and Explore does the same with its field list. A chain of five items needs
 * a rail; a prompt, twenty-four tool grants and a set of knowledge descriptions need
 * the room. So the rail is on the left now and the editor gets the rest.
 *
 * ONE HEADER, NOT TWO
 * There was a header row and then a second bordered row holding a stats strip —
 * about ninety pixels of chrome before anything a user came for. Datasets does it in
 * a single `h-11` bar: breadcrumb, name, status, actions. So does this.
 *
 * WHAT THE HEADER OWES THE AUTHOR
 * Publishing changes what live viewers are told, so the bar has to say three things
 * it never said: whether there are unsaved edits, which version would go live, and
 * what is already running. `impact` is read before Publish rather than after,
 * because that is the question the endpoint exists to answer.
 */
import {
  AlertTriangle, ArrowLeft, ChevronLeft, History, Loader2, Save, Send,
} from 'lucide-react';
import React from 'react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  blankStep, brainImpact, getBrain, listAttachable, listProviders, listToolPacks,
  listVersions, publishBrain, rollbackBrain, saveBrain, validateSteps,
  type AgentStep, type Attachable, type BrainDetail, type BrainLinkUsage,
  type BrainVersionRow, type ProviderGroup, type StepProblem, type ToolPack,
} from '@/lib/agentFlows';

import { BrainOverviewPanel } from './BrainOverviewPanel';
import { StepChainRail } from './StepChainRail';
import { StepEditor, type StepTab } from './StepEditor';
import { StatusBadge } from './shared';

/** What the work surface is showing. The overview is a first-class destination, not
 *  a modal: description, warnings, reach and version history are properties of the
 *  BRAIN, and the previous build had nowhere to put them — so warnings were
 *  rendered inside whichever step happened to be selected, and description could
 *  not be edited at all. */
type Selection = { kind: 'overview' } | { kind: 'step'; index: number };

export function BrainBuilder({
  brainKey, onBack, canEdit, canPublish,
}: {
  brainKey: string;
  onBack: () => void;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const [detail, setDetail] = React.useState<BrainDetail | null>(null);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [steps, setSteps] = React.useState<AgentStep[]>([]);
  const [baseline, setBaseline] = React.useState('');

  const [sel, setSel] = React.useState<Selection>({ kind: 'overview' });
  const [tab, setTab] = React.useState<StepTab>('basic');
  const [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [packs, setPacks] = React.useState<ToolPack[]>([]);
  const [providers, setProviders] = React.useState<ProviderGroup[]>([]);
  const [sources, setSources] = React.useState<Attachable>({ documents: [], datasets: [], metrics: [] });
  const [versions, setVersions] = React.useState<BrainVersionRow[]>([]);
  const [links, setLinks] = React.useState<BrainLinkUsage[] | null>(null);

  const [confirmLeave, setConfirmLeave] = React.useState(false);
  const [publishing, setPublishing] = React.useState<{ links: BrainLinkUsage[] } | null>(null);

  /** One snapshot string is the whole dirty check. Comparing field-by-field is how a
   *  builder ends up "dirty" because a `model` went from `undefined` to `''`. */
  const snapshot = React.useMemo(
    () => JSON.stringify({ name, description, steps }),
    [name, description, steps],
  );
  const dirty = baseline !== '' && snapshot !== baseline;

  const adopt = React.useCallback((d: BrainDetail) => {
    const loaded = d.body?.steps?.length ? d.body.steps : [blankStep([])];
    setDetail(d);
    setName(d.name);
    setDescription(d.description || '');
    setSteps(loaded);
    setBaseline(JSON.stringify({ name: d.name, description: d.description || '', steps: loaded }));
  }, []);

  React.useEffect(() => {
    getBrain(brainKey).then(adopt).catch((e) => {
      setLoadError(detailMsg(e) || 'Không mở được bộ não này.');
    });
    listToolPacks().then(setPacks).catch(() => undefined);
    listProviders().then(setProviders).catch(() => undefined);
    listAttachable().then(setSources).catch(() => undefined);
    listVersions(brainKey).then(setVersions).catch(() => undefined);
    // Loaded up front, not on the way to Publish: "five links are running this" has
    // to be visible while editing, which is when it changes the author's mind.
    brainImpact(brainKey).then((r) => setLinks(r.links)).catch(() => setLinks([]));
  }, [brainKey, adopt]);

  /** Problems the server would reject, resolved to the step they belong to. */
  const problems: StepProblem[] = React.useMemo(() => validateSteps(steps), [steps]);
  const problemsByStep = React.useMemo(() => {
    const map = new Map<number, StepProblem[]>();
    problems.forEach((p) => {
      const list = map.get(p.index);
      if (list) list.push(p); else map.set(p.index, [p]);
    });
    return map;
  }, [problems]);

  const save = React.useCallback(async (): Promise<BrainDetail | null> => {
    if (!canEdit) return null;
    if (problems.length > 0) {
      const first = problems[0];
      setSel({ kind: 'step', index: first.index });
      setTab(first.tab);
      toast.error(`Bước ${first.index + 1}: ${first.message}`);
      return null;
    }
    setBusy(true);
    try {
      const saved = await saveBrain({
        brain_key: brainKey,
        name: name.trim() || brainKey,
        description,
        // `model` only travels when a provider was actually chosen: the server
        // refuses a step that inherits its provider yet names a model.
        body: {
          steps: steps.map((s) => (
            !s.provider || s.provider === 'inherit' ? { ...s, provider: 'inherit' as const, model: '' } : s
          )),
        },
      });
      adopt(saved);
      listVersions(brainKey).then(setVersions).catch(() => undefined);
      toast.success(`Đã lưu bản nháp v${saved.version}`);
      return saved;
    } catch (e) {
      toast.error(detailMsg(e) || 'Không lưu được.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [adopt, brainKey, canEdit, description, name, problems, steps]);

  // Ctrl/Cmd+S. Every other editing surface in the product takes it, and a builder
  // that only saves from a button is a builder people lose work in.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !busy) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, busy, save]);

  // Closing the tab with unsaved steps. The in-app guard below covers Back; this
  // covers the browser.
  React.useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);

  const leave = () => { if (dirty) setConfirmLeave(true); else onBack(); };

  const startPublish = async () => {
    let target = detail;
    if (dirty) {
      target = await save();
      if (!target) return;
    }
    if (!target) return;
    setBusy(true);
    try {
      const impact = await brainImpact(brainKey);
      setLinks(impact.links);
      setPublishing({ links: impact.links });
    } catch {
      // An impact read that fails must not block publishing — it is a disclosure,
      // not a permission. The dialog then says it could not be read.
      setPublishing({ links: [] });
    } finally {
      setBusy(false);
    }
  };

  const doPublish = async () => {
    if (!detail) return;
    setPublishing(null);
    setBusy(true);
    try {
      const out = await publishBrain(brainKey, detail.version);
      adopt(out);
      listVersions(brainKey).then(setVersions).catch(() => undefined);
      toast.success(`Đã phát hành v${out.version} — các link đang dùng bộ não này sẽ trả lời theo bản mới.`);
    } catch (e) {
      toast.error(detailMsg(e) || 'Không phát hành được.');
    } finally {
      setBusy(false);
    }
  };

  const doRollback = async () => {
    setBusy(true);
    try {
      const out = await rollbackBrain(brainKey);
      adopt(out);
      listVersions(brainKey).then(setVersions).catch(() => undefined);
      toast.success(`Đã quay lại v${out.version}.`);
    } catch (e) {
      toast.error(detailMsg(e) || 'Không quay lại được.');
    } finally {
      setBusy(false);
    }
  };

  /** Pull an older version's content into the editor as the working draft. Saving
   *  then writes a NEW version — restoring never rewrites history. */
  const restoreVersion = async (version: number) => {
    setBusy(true);
    try {
      const old = await getBrain(brainKey, version);
      const loaded = old.body?.steps?.length ? old.body.steps : [blankStep([])];
      setName(old.name);
      setDescription(old.description || '');
      setSteps(loaded);
      setSel({ kind: 'overview' });
      toast.success(`Đã nạp nội dung v${version} vào bàn làm việc. Lưu để tạo bản nháp mới.`);
    } catch (e) {
      toast.error(detailMsg(e) || 'Không mở được phiên bản này.');
    } finally {
      setBusy(false);
    }
  };

  /* ── step operations ────────────────────────────────────────────────────── */

  const patchStep = (index: number, p: Partial<AgentStep>) =>
    setSteps((cur) => cur.map((s, i) => (i === index ? { ...s, ...p } : s)));

  const addStep = (at: number) => {
    setSteps((cur) => {
      const next = [...cur];
      next.splice(at, 0, blankStep(cur));
      return next;
    });
    setSel({ kind: 'step', index: at });
    setTab('basic');
  };

  const duplicateStep = (index: number) => {
    setSteps((cur) => {
      const copy = { ...cur[index], key: blankStep(cur).key, name: `${cur[index].name || cur[index].key} (bản sao)` };
      const next = [...cur];
      next.splice(index + 1, 0, copy);
      return next;
    });
    setSel({ kind: 'step', index: index + 1 });
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= steps.length) return;
    setSteps((cur) => {
      const next = [...cur];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setSel({ kind: 'step', index: to });
  };

  const removeStep = (index: number) => {
    setSteps((cur) => cur.filter((_, i) => i !== index));
    setSel((cur) => {
      if (cur.kind !== 'step') return cur;
      return { kind: 'step', index: Math.max(0, Math.min(cur.index, steps.length - 2)) };
    });
  };

  /* ── render ─────────────────────────────────────────────────────────────── */

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <AlertTriangle className="h-7 w-7 text-warning" />
        <p className="text-caption text-text-secondary">{loadError}</p>
        <Button size="sm" variant="secondary" leadingIcon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={onBack}>
          Về danh sách
        </Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-brand" />
          <p className="text-caption text-text-tertiary">Đang mở bộ não…</p>
        </div>
      </div>
    );
  }

  const activeStep = sel.kind === 'step' ? steps[sel.index] : undefined;
  const liveCount = links?.length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── single top bar, same height and rhythm as the Dataset detail page ── */}
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button
          type="button"
          onClick={leave}
          className="flex flex-shrink-0 items-center gap-1 text-caption text-text-tertiary transition-colors hover:text-text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
          Agent Flows
        </button>
        <span className="text-text-quaternary">/</span>

        {/* The name is a heading that happens to be editable, so it is styled as a
            heading until focused. A bare 224px input read as a form field on a page
            with no form. */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          aria-label="Tên bộ não"
          className={cn(
            'min-w-0 max-w-[280px] flex-shrink rounded border border-transparent bg-transparent px-1.5 py-0.5',
            'text-caption font-emphasis text-text-primary outline-none',
            canEdit && 'hover:border-[rgb(var(--border-line))] focus:border-brand focus:bg-surface-1',
          )}
        />

        <StatusBadge status={detail.status} version={detail.version} />
        {liveCount > 0 && (
          <span
            title="Số link công khai đang trỏ vào bộ não này"
            className="hidden flex-shrink-0 items-center gap-1 text-tiny text-text-tertiary sm:inline-flex"
          >
            · {liveCount} link đang dùng
          </span>
        )}

        <div className="min-w-2 flex-1" />

        {dirty && (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-tiny text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Chưa lưu
          </span>
        )}
        {problems.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const first = problems[0];
              setSel({ kind: 'step', index: first.index });
              setTab(first.tab);
            }}
            title="Bấm để đến chỗ cần sửa"
            className="flex flex-shrink-0 items-center gap-1 rounded border border-danger/25 bg-danger/10 px-1.5 py-0.5 text-tiny text-danger"
          >
            <AlertTriangle className="h-3 w-3" />
            {problems.length} chỗ cần sửa
          </button>
        )}

        <VersionMenu
          versions={versions}
          currentVersion={detail.version}
          canPublish={canPublish}
          busy={busy}
          onRestore={(v) => void restoreVersion(v)}
          onRollback={() => void doRollback()}
        />

        {canEdit && (
          <Button
            variant="secondary" size="xs" disabled={busy || !dirty}
            leadingIcon={<Save className="h-3.5 w-3.5" />}
            title="Ctrl+S"
            onClick={() => void save()}
          >
            Lưu nháp
          </Button>
        )}
        {canPublish && (
          <Button
            size="xs" disabled={busy || (detail.status === 'published' && !dirty)}
            leadingIcon={<Send className="h-3.5 w-3.5" />}
            onClick={() => void startPublish()}
            title={
              detail.status === 'published' && !dirty
                ? 'Bản này đang chạy rồi'
                : 'Đưa bản này ra cho người xem'
            }
          >
            {dirty ? 'Lưu & phát hành' : `Phát hành v${detail.version}`}
          </Button>
        )}
      </div>

      {/* ── rail + work surface ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <StepChainRail
          steps={steps}
          selection={sel}
          problemsByStep={problemsByStep}
          warningCount={detail.warnings.length}
          readCount={detail.reads.length}
          linkCount={liveCount}
          canEdit={canEdit}
          onSelectOverview={() => setSel({ kind: 'overview' })}
          onSelectStep={(index) => { setSel({ kind: 'step', index }); setTab('basic'); }}
          onAdd={addStep}
          onDuplicate={duplicateStep}
          onMove={moveStep}
          onRemove={removeStep}
        />

        <main className="min-w-0 flex-1 overflow-y-auto bg-surface-0">
          {sel.kind === 'overview' || !activeStep ? (
            <BrainOverviewPanel
              detail={detail}
              name={name}
              description={description}
              steps={steps}
              sources={sources}
              links={links}
              canEdit={canEdit}
              onDescriptionChange={setDescription}
              onGoToStep={(index, target) => { setSel({ kind: 'step', index }); setTab(target); }}
            />
          ) : (
            <StepEditor
              key={activeStep.key}
              step={activeStep}
              index={sel.index}
              isLast={sel.index === steps.length - 1}
              tab={tab}
              onTabChange={setTab}
              problems={problemsByStep.get(sel.index) || []}
              packs={packs}
              providers={providers}
              sources={sources}
              canEdit={canEdit}
              onPatch={(p) => patchStep(sel.index, p)}
            />
          )}
        </main>
      </div>

      <ConfirmDialog
        isOpen={confirmLeave}
        title="Rời bàn làm việc khi chưa lưu?"
        description="Các thay đổi chưa lưu sẽ mất. Bản đang phát hành không bị ảnh hưởng."
        confirmLabel="Rời và bỏ thay đổi"
        cancelLabel="Ở lại"
        variant="warning"
        onConfirm={onBack}
        onClose={() => setConfirmLeave(false)}
      />

      {publishing && (
        <ConfirmDialog
          isOpen
          title={`Phát hành v${detail.version}?`}
          description={publishDescription(publishing.links, detail.version)}
          confirmLabel="Phát hành"
          cancelLabel="Chưa"
          variant="warning"
          onConfirm={() => void doPublish()}
          onClose={() => setPublishing(null)}
        />
      )}
    </div>
  );
}

/** What Publish is about to change, said in terms of who sees it.
 *
 *  A brain is reusable, so "publish" is not a local act: the count of links is the
 *  blast radius, and it is the reason `/impact` exists. */
function publishDescription(links: BrainLinkUsage[], version: number): string {
  if (links.length === 0) {
    return `v${version} sẽ trở thành bản đang chạy. Hiện chưa có link công khai nào trỏ vào bộ não này, nên chưa ai bị ảnh hưởng ngay.`;
  }
  const live = links.filter((l) => l.bot_enabled);
  const names = links.slice(0, 4).map((l) => l.link_name || `link #${l.link_id}`).join(', ');
  const more = links.length > 4 ? ` và ${links.length - 4} link nữa` : '';
  return `v${version} sẽ trả lời ngay trên ${links.length} link đang dùng bộ não này (${names}${more}).`
    + ` ${live.length}/${links.length} link đang bật ChatBot.`;
}

function detailMsg(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

/* ── version history ──────────────────────────────────────────────────────── */

/**
 * Version history, which had no UI at all despite two endpoints serving it.
 *
 * Without it, "I published something worse ten minutes ago" had no answer in the
 * product — `/versions` and `/rollback` existed and nothing called them.
 */
function VersionMenu({
  versions, currentVersion, canPublish, busy, onRestore, onRollback,
}: {
  versions: BrainVersionRow[];
  currentVersion: number;
  canPublish: boolean;
  busy: boolean;
  onRestore: (version: number) => void;
  onRollback: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const hasPrevious = versions.some((v) => v.status === 'archived' && v.published_at);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <Button
        variant="ghost" size="xs"
        leadingIcon={<History className="h-3.5 w-3.5" />}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hidden sm:inline">Phiên bản</span>
        <span className="tabular-nums text-text-tertiary">{versions.length || 1}</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-80 overflow-hidden rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear">
          <p className="border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-tiny leading-snug text-text-tertiary">
            Lưu là tạo bản mới, không sửa bản đang chạy. Nạp lại một bản cũ cũng tạo bản mới —
            lịch sử không bị ghi đè.
          </p>
          <div className="max-h-72 overflow-y-auto">
            {versions.length === 0 && (
              <p className="px-3 py-3 text-tiny text-text-tertiary">Chưa có lịch sử.</p>
            )}
            {versions.map((v) => (
              <div
                key={v.version}
                className={cn(
                  'flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2 last:border-b-0',
                  v.version === currentVersion && 'bg-brand/5',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-caption font-emphasis tabular-nums text-text-primary">v{v.version}</span>
                    <StatusBadge status={v.status} size="xs" />
                    {v.version === currentVersion && (
                      <span className="text-tiny text-text-quaternary">đang mở</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-tiny text-text-quaternary">
                    {v.created_by || '—'}
                  </span>
                </span>
                {v.version !== currentVersion && (
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => { onRestore(v.version); setOpen(false); }}>
                    Nạp lại
                  </Button>
                )}
              </div>
            ))}
          </div>
          {canPublish && hasPrevious && (
            <div className="border-t border-[rgb(var(--border-line))] p-2">
              <Button
                variant="secondary" size="xs" fullWidth disabled={busy}
                onClick={() => { onRollback(); setOpen(false); }}
              >
                Quay lại bản đã chạy trước đó
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
