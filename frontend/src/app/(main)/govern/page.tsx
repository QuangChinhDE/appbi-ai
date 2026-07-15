'use client';

/**
 * Govern — ONE surface: the business-document library (Cẩm nang tri thức).
 * No pill tabs. The KnowledgeTab (doc library + reader/editor + version history)
 * IS the whole page. Two things live off it:
 *   • Metrics (KPIs) are authored INSIDE documents — the editor's "Định nghĩa
 *     chỉ số" and the reader's per-card pencil open a MetricFormModal.
 *   • Master data (glossary terms + classification tags) is managed in the
 *     "Từ điển & Nhãn" modal (VocabManager wrapped in AppModalShell), launched
 *     from the document-library header.
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Tags, Library, Lock, Layers, Plus, Pencil, Trash2, BookText } from 'lucide-react';

import { KnowledgeTab } from '@/components/govern/KnowledgeTab';
import { AppModalShell } from '@/components/common/AppModalShell';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Label } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { toast } from '@/lib/toast';
import { useUrlNav } from '@/hooks/use-url-nav';
import { useI18n } from '@/providers/LanguageProvider';
import {
  getMetrics, getGlossaries, listGlossaryTerms, upsertGlossary, deleteGlossary, upsertTerm, deleteTerm,
  listClassifications, getTags, upsertClassification, deleteClassification, upsertTag, deleteTag,
  type GlossaryTerm, type Glossary, type Classification, type Tag, type Metric,
} from '@/lib/catalog';

function errDetail(err: unknown): string | undefined {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

/** Seed descriptions may carry markdown/HTML; render them as clean text. */
function cleanDesc(s?: string | null): string {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-tiny text-text-quaternary">{hint}</p>}
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel, onConfirm, onClose, loading }: { title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; loading?: boolean }) {
  const { t } = useI18n();
  return (
    <Modal isOpen onClose={onClose} title={title} size="sm"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={loading}>{t('govern.action.cancel')}</Button>
        <Button variant="danger" onClick={onConfirm} loading={loading}>{confirmLabel ?? t('govern.action.delete')}</Button>
      </>)}>
      <p className="text-caption text-text-secondary">{message}</p>
    </Modal>
  );
}

function ExclusivityTag({ mx }: { mx: boolean }) {
  const { t } = useI18n();
  return mx
    ? <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-tiny text-info"><Layers className="h-3 w-3" />{t('govern.vocab.chooseOne')}</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary"><Tags className="h-3 w-3" />{t('govern.vocab.chooseMany')}</span>;
}

export default function GovernPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">{t('govern.loading')}</div>}>
      <GovernModule />
    </Suspense>
  );
}

function GovernModule() {
  const nav = useUrlNav();
  const [vocabOpen, setVocabOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <KnowledgeTab nav={nav} onOpenVocab={() => setVocabOpen(true)} />
      </div>
      {vocabOpen && <VocabManagerModal onClose={() => setVocabOpen(false)} />}
    </div>
  );
}

// ══════════════════════ Từ điển & Nhãn — master-data modal ═══════════════════
function VocabManagerModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const reloadMetrics = useCallback(async () => { try { setMetrics((await getMetrics()).metrics); } catch { /* ignore */ } }, []);
  useEffect(() => { void reloadMetrics(); }, [reloadMetrics]);

  return (
    <AppModalShell
      onClose={onClose}
      title={t('govern.vocab.title')}
      icon={<Library className="h-4 w-4" />}
      maxWidthClass="max-w-3xl"
      /* FIXED panel size — opening inline forms/lists must never resize the
         modal; only the list area inside scrolls. */
      panelClassName="h-[min(680px,calc(100vh-4rem))]"
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-5"
      description={t('govern.vocab.description')}
      footer={<Button variant="secondary" onClick={onClose}>{t('govern.action.close')}</Button>}
    >
      <VocabManager metrics={metrics} onChanged={reloadMetrics} />
    </AppModalShell>
  );
}

function VocabManager({ metrics, onChanged }: {
  metrics: Metric[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [seg, setSeg] = useState<'terms' | 'tags'>('terms');
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [classes, setClasses] = useState<Classification[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [g, t, c, tg] = await Promise.all([getGlossaries(), listGlossaryTerms(), listClassifications(), getTags()]);
      setGlossaries(g); setTerms(t); setClasses(c); setTags(tg);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const termUsage = useMemo(() => {
    const map = new Map<string, number>();
    metrics.forEach((mt) => (mt.glossaryTerms || []).forEach((v) => map.set(v.fqn, (map.get(v.fqn) || 0) + 1)));
    return map;
  }, [metrics]);
  const tagUsage = useMemo(() => {
    const map = new Map<string, number>();
    metrics.forEach((mt) => (mt.tags || []).forEach((v) => map.set(v.fqn, (map.get(v.fqn) || 0) + 1)));
    return map;
  }, [metrics]);

  const refresh = async () => { await reload(); await onChanged(); };

  return (
    /* 3 tiers: (1) tab navigation — fixed; (2) per-tab toolbar — fixed;
       (3) the grouped list — the ONLY scrolling region. Modal never resizes. */
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Tabs<'terms' | 'tags'>
        value={seg}
        onChange={setSeg}
        items={[
          {
            key: 'terms',
            icon: <BookText className="h-3.5 w-3.5" />,
            label: t('govern.vocab.terms'),
            badge: <span className="rounded-full bg-surface-3 px-1.5 text-tiny text-text-tertiary">{terms.length}</span>,
          },
          {
            key: 'tags',
            icon: <Tags className="h-3.5 w-3.5" />,
            label: t('govern.vocab.classifications'),
            badge: <span className="rounded-full bg-surface-3 px-1.5 text-tiny text-text-tertiary">{classes.length}</span>,
          },
        ]}
      />
      {loading ? (
        <p className="py-8 text-center text-caption text-text-tertiary">{t('govern.loading')}</p>
      ) : seg === 'terms' ? (
        <TermsManager glossaries={glossaries} terms={terms} usage={termUsage} onChanged={refresh} />
      ) : (
        <TagsManager classes={classes} tags={tags} usage={tagUsage} onChanged={refresh} />
      )}
    </div>
  );
}

// Inline add/edit form for a term (rendered INSIDE a glossary-set card so the
// set is contextual — no separate set picker). Keyed by caller so it remounts.
function TermForm({ initial, busy, onSave, onCancel }: {
  initial: { name: string; def: string; syn: string };
  busy: boolean; onSave: (v: { name: string; def: string; syn: string }) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState(initial);
  return (
    <div className="space-y-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
      <Field label={t('govern.vocab.termName')}><Input size="sm" autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('govern.vocab.termNamePlaceholder')} /></Field>
      <Field label={t('govern.vocab.definition')}><Textarea rows={2} value={v.def} onChange={(e) => setV({ ...v, def: e.target.value })} placeholder={t('govern.vocab.definitionPlaceholder')} /></Field>
      <Field label={t('govern.vocab.synonyms')} hint={t('govern.vocab.synonymsHint')}><Input size="sm" value={v.syn} onChange={(e) => setV({ ...v, syn: e.target.value })} placeholder={t('govern.vocab.synonymsPlaceholder')} /></Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('govern.action.cancel')}</Button>
        <Button variant="primary" size="sm" loading={busy} disabled={busy || !v.name.trim()} onClick={() => onSave(v)}>{t('govern.action.save')}</Button>
      </div>
    </div>
  );
}

function TermsManager({ glossaries, terms, usage, onChanged }: {
  glossaries: Glossary[]; terms: GlossaryTerm[]; usage: Map<string, number>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [addSet, setAddSet] = useState(false);
  const [setName, setSetName] = useState('');
  const [form, setForm] = useState<{ setMachine: string; machine?: string } | null>(null);
  const [initial, setInitial] = useState({ name: '', def: '', syn: '' });
  const [busy, setBusy] = useState(false);
  const [delTerm, setDelTerm] = useState<GlossaryTerm | null>(null);
  const [delSet, setDelSet] = useState<Glossary | null>(null);

  const createSet = async () => {
    if (!setName.trim()) return;
    setBusy(true);
    try { await upsertGlossary({ name: setName }); toast.success(t('govern.vocab.createGlossarySuccess'), { description: setName }); setSetName(''); setAddSet(false); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.vocab.createGlossaryFailed')); } finally { setBusy(false); }
  };
  const openAdd = (g: Glossary) => { setInitial({ name: '', def: '', syn: '' }); setForm({ setMachine: g.machine_name }); };
  const openEdit = (g: Glossary, term: GlossaryTerm) => { setInitial({ name: term.name, def: term.definition || '', syn: (term.synonyms || []).join(', ') }); setForm({ setMachine: g.machine_name, machine: term.machine_name }); };
  const saveTerm = async (v: { name: string; def: string; syn: string }) => {
    if (!form || !v.name.trim()) return;
    setBusy(true);
    try {
      await upsertTerm({ glossary: form.setMachine, machine_name: form.machine, name: v.name, description: v.def, synonyms: v.syn.split(',').map((s) => s.trim()).filter(Boolean) });
      toast.success(form.machine ? t('govern.vocab.termSaved') : t('govern.vocab.termAdded'), { description: v.name });
      setForm(null); await onChanged();
    } catch (e) { toast.error(errDetail(e) || t('govern.vocab.saveFailed')); } finally { setBusy(false); }
  };
  const doDelTerm = async () => {
    if (!delTerm) return;
    setBusy(true);
    try { await deleteTerm(delTerm.fqn); toast.success(t('govern.vocab.deleted'), { description: delTerm.name }); setDelTerm(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.vocab.deleteGlossaryFailed')); } finally { setBusy(false); }
  };
  const doDelSet = async () => {
    if (!delSet) return;
    setBusy(true);
    try { await deleteGlossary(delSet.fqn); toast.success(t('govern.vocab.deleteGlossarySuccess')); setDelSet(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.action.deleteFailed')); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Tier 2 — contextual toolbar (FIXED): what this workspace is + its ONE
          setup action. Adding TERMS happens inside each set card below. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-caption text-text-secondary">{t('govern.vocab.termsSummary', { terms: terms.length, glossaries: glossaries.length })}</span>
          <span className="block text-tiny text-text-quaternary">{t('govern.vocab.termsIntro')}</span>
        </div>
        <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAddSet((v) => !v)}>{t('govern.vocab.createGlossarySet')}</Button>
      </div>

      {addSet && (
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
          <Input size="sm" autoFocus value={setName} onChange={(e) => setSetName(e.target.value)} placeholder={t('govern.vocab.newGlossaryPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') createSet(); }} />
          <Button variant="ghost" size="sm" onClick={() => { setAddSet(false); setSetName(''); }} disabled={busy}>{t('govern.action.cancel')}</Button>
          <Button variant="primary" size="sm" loading={busy} disabled={busy || !setName.trim()} onClick={createSet}>{t('govern.action.create')}</Button>
        </div>
      )}

      {/* Tier 3 — the grouped list: the ONLY scrolling region (modal size fixed). */}
      {glossaries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-8 text-center">
          <Library className="mx-auto mb-2 h-7 w-7 text-text-quaternary" />
          <p className="text-caption text-text-secondary">{t('govern.vocab.noGlossary')}</p>
          <p className="mx-auto mt-1 max-w-sm text-tiny text-text-quaternary">{t('govern.vocab.noGlossaryHint')}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          <ul className="space-y-2">
            {glossaries.map((g) => {
              const sys = g.provider === 'system';
              const gterms = terms.filter((tm) => tm.glossaryFqn === g.fqn || tm.glossary === g.name);
              const adding = !!form && form.setMachine === g.machine_name && !form.machine;
              return (
                <li key={g.machine_name} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                  <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-caption font-emphasis text-text-primary"><Library className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" /><span className="truncate">{g.name}</span><span className="text-tiny text-text-quaternary">({g.termCount})</span>{sys && <Lock className="h-3 w-3 flex-shrink-0 text-text-quaternary" />}</span>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      {!sys && <Button variant="ghost" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => openAdd(g)}>{t('govern.vocab.addTerm')}</Button>}
                      {!sys && <button onClick={() => setDelSet(g)} className="p-1 text-text-quaternary hover:text-danger" aria-label={t('govern.action.delete')}><Trash2 className="h-3.5 w-3.5" /></button>}
                    </div>
                  </div>
                  {adding && <TermForm key={`add:${g.machine_name}`} initial={initial} busy={busy} onSave={saveTerm} onCancel={() => setForm(null)} />}
                  {gterms.length === 0 && !adding ? (
                    <p className="px-3 py-2.5 text-tiny text-text-quaternary">{t('govern.vocab.noTermsInSet')}</p>
                  ) : (
                    <ul className="divide-y divide-[rgb(var(--border-line))]">
                      {gterms.map((term) => {
                        const tsys = term.provider === 'system';
                        const n = usage.get(term.fqn) || 0;
                        if (form && form.machine === term.machine_name) {
                          return <li key={term.fqn}><TermForm key={`edit:${term.machine_name}`} initial={initial} busy={busy} onSave={saveTerm} onCancel={() => setForm(null)} /></li>;
                        }
                        return (
                          <li key={term.fqn} className="flex items-start justify-between gap-2 px-3 py-2.5">
                            <div className="min-w-0">
                              <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><BookText className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{term.name}{tsys && <Lock className="h-3 w-3 text-text-quaternary" />}</span>
                              {term.definition && <span className="mt-0.5 line-clamp-2 block text-tiny text-text-tertiary">{term.definition}</span>}
                            </div>
                            <div className="flex flex-shrink-0 items-center gap-1">
                              {n > 0 && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-tiny text-brand" title={t('govern.vocab.termUsageTitle')}>{t('govern.vocab.metricCount', { count: n })}</span>}
                              {!tsys && <>
                                <button onClick={() => openEdit(g, term)} className="p-1 text-text-quaternary hover:text-text-primary" aria-label={t('govern.action.edit')}><Pencil className="h-3.5 w-3.5" /></button>
                                <button onClick={() => setDelTerm(term)} className="p-1 text-text-quaternary hover:text-danger" aria-label={t('govern.action.delete')}><Trash2 className="h-3.5 w-3.5" /></button>
                              </>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {delTerm && <ConfirmModal title={t('govern.vocab.deleteTermTitle')} message={t('govern.vocab.deleteTermMessage', { name: delTerm.name })} onConfirm={doDelTerm} onClose={() => setDelTerm(null)} loading={busy} />}
      {delSet && <ConfirmModal title={t('govern.vocab.deleteGlossaryTitle')} message={t('govern.vocab.deleteGlossaryMessage', { name: delSet.name, suffix: delSet.termCount > 0 ? t('govern.vocab.deleteGlossarySuffix', { count: delSet.termCount }) : '' })} onConfirm={doDelSet} onClose={() => setDelSet(null)} loading={busy} />}
    </div>
  );
}

function TagsManager({ classes, tags, usage, onChanged }: {
  classes: Classification[]; tags: Tag[]; usage: Map<string, number>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [addClass, setAddClass] = useState(false);
  const [cForm, setCForm] = useState({ name: '', desc: '', mx: false });
  const [busy, setBusy] = useState(false);
  const [addTagFor, setAddTagFor] = useState<string | null>(null);
  const [tagName, setTagName] = useState('');
  const [delTag, setDelTag] = useState<Tag | null>(null);
  const [delClass, setDelClass] = useState<Classification | null>(null);

  const tagsByClass = useMemo(() => {
    const m = new Map<string, Tag[]>();
    tags.forEach((t) => { const k = t.classification || ''; if (!m.has(k)) m.set(k, []); m.get(k)!.push(t); });
    return m;
  }, [tags]);

  const createClass = async () => {
    if (!cForm.name.trim()) return;
    setBusy(true);
    try { await upsertClassification({ name: cForm.name, description: cForm.desc, mutuallyExclusive: cForm.mx }); toast.success(t('govern.vocab.classificationCreated'), { description: cForm.name }); setAddClass(false); setCForm({ name: '', desc: '', mx: false }); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.vocab.createGlossaryFailed')); } finally { setBusy(false); }
  };
  const createTag = async (cmachine: string) => {
    if (!tagName.trim()) return;
    setBusy(true);
    try { await upsertTag({ classification: cmachine, name: tagName }); toast.success(t('govern.vocab.tagAdded'), { description: tagName }); setAddTagFor(null); setTagName(''); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.vocab.addFailed')); } finally { setBusy(false); }
  };
  const doDelTag = async () => {
    if (!delTag) return;
    setBusy(true);
    try { await deleteTag(delTag.fqn); toast.success(t('govern.vocab.tagDeleted')); setDelTag(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.action.deleteFailed')); } finally { setBusy(false); }
  };
  const doDelClass = async () => {
    if (!delClass) return;
    setBusy(true);
    try { await deleteClassification(delClass.fqn); toast.success(t('govern.vocab.classificationDeleted')); setDelClass(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || t('govern.action.deleteFailed')); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Tier 2 — contextual toolbar (FIXED). Adding TAGS happens inside each
          classification card below. */}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-caption text-text-secondary">{t('govern.vocab.classificationsSummary', { classes: classes.length, tags: tags.length })}</span>
        <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAddClass((v) => !v)}>{t('govern.vocab.addClassification')}</Button>
      </div>

      {addClass && (
        <div className="shrink-0 space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
          <Field label={t('govern.vocab.classificationName')}><Input size="sm" autoFocus value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} placeholder={t('govern.vocab.classificationNamePlaceholder')} /></Field>
          <Field label={t('govern.vocab.classificationDescription')}><Input size="sm" value={cForm.desc} onChange={(e) => setCForm({ ...cForm, desc: e.target.value })} placeholder={t('govern.vocab.classificationDescriptionPlaceholder')} /></Field>
          <label className="flex items-center gap-2 text-caption text-text-secondary"><input type="checkbox" checked={cForm.mx} onChange={(e) => setCForm({ ...cForm, mx: e.target.checked })} className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" />{t('govern.vocab.mutuallyExclusive')}</label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAddClass(false)} disabled={busy}>{t('govern.action.cancel')}</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={busy || !cForm.name.trim()} onClick={createClass}>{t('govern.action.create')}</Button>
          </div>
        </div>
      )}

      {/* Tier 3 — grouped list: the ONLY scrolling region. */}
      {classes.length === 0 ? (
        <p className="py-6 text-center text-caption text-text-quaternary">{t('govern.vocab.noClassifications')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          <ul className="space-y-2">
          {classes.map((c) => {
            const sys = c.provider === 'system';
            const ctags = tagsByClass.get(c.machine_name) || [];
            return (
              <li key={c.machine_name} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-caption font-emphasis text-text-primary"><Tags className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" /><span className="truncate">{c.name}</span>{sys && <Lock className="h-3 w-3 flex-shrink-0 text-text-quaternary" />}<ExclusivityTag mx={c.mutuallyExclusive} /></span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {!sys && <button onClick={() => { setAddTagFor(addTagFor === c.machine_name ? null : c.machine_name); setTagName(''); }} className="p-1 text-text-quaternary hover:text-text-primary" aria-label={t('govern.vocab.addTag')} title={t('govern.vocab.addTag')}><Plus className="h-3.5 w-3.5" /></button>}
                    {!sys && <button onClick={() => setDelClass(c)} className="p-1 text-text-quaternary hover:text-danger" aria-label={t('govern.vocab.deleteClassificationTitle')}><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                </div>
                {addTagFor === c.machine_name && (
                  <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
                    <Input size="sm" autoFocus value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder={t('govern.vocab.tagNamePlaceholder')} />
                    <Button variant="secondary" size="sm" loading={busy} disabled={busy || !tagName.trim()} onClick={() => createTag(c.machine_name)}>{t('govern.vocab.addTag')}</Button>
                  </div>
                )}
                {ctags.length === 0 ? (
                  <p className="px-3 py-2 text-tiny text-text-quaternary">{t('govern.vocab.noTags')}</p>
                ) : (
                  <ul className="divide-y divide-[rgb(var(--border-line))]">
                    {ctags.map((tg) => {
                      const n = usage.get(tg.fqn) || 0;
                      return (
                        <li key={tg.fqn} className="flex items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0 truncate text-caption text-text-secondary">{tg.name}{tg.description && <span className="ml-1.5 text-tiny text-text-quaternary">{cleanDesc(tg.description)}</span>}</span>
                          <div className="flex flex-shrink-0 items-center gap-1">
                            {n > 0 && <span className="rounded bg-info/10 px-1.5 py-0.5 text-tiny text-info" title={t('govern.vocab.tagUsageTitle')}>{t('govern.vocab.metricCount', { count: n })}</span>}
                            {!sys && <button onClick={() => setDelTag(tg)} className="p-1 text-text-quaternary hover:text-danger" aria-label={t('govern.vocab.deleteTagTitle')}><Trash2 className="h-3.5 w-3.5" /></button>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
          </ul>
        </div>
      )}
      {delTag && <ConfirmModal title={t('govern.vocab.deleteTagTitle')} message={t('govern.vocab.deleteTagMessage', { name: delTag.name })} onConfirm={doDelTag} onClose={() => setDelTag(null)} loading={busy} />}
      {delClass && <ConfirmModal title={t('govern.vocab.deleteClassificationTitle')} message={t('govern.vocab.deleteClassificationMessage', { name: delClass.name })} onConfirm={doDelClass} onClose={() => setDelClass(null)} loading={busy} />}
    </div>
  );
}
