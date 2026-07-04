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
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { FilterTag } from '@/components/ui/FilterTag';
import { toast } from '@/lib/toast';
import { useUrlNav } from '@/hooks/use-url-nav';
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

function ConfirmModal({ title, message, confirmLabel = 'Xoá', onConfirm, onClose, loading }: { title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; loading?: boolean }) {
  return (
    <Modal isOpen onClose={onClose} title={title} size="sm"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={loading}>Huỷ</Button>
        <Button variant="danger" onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </>)}>
      <p className="text-caption text-text-secondary">{message}</p>
    </Modal>
  );
}

function ExclusivityTag({ mx }: { mx: boolean }) {
  return mx
    ? <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-tiny text-info"><Layers className="h-3 w-3" />Chọn 1</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary"><Tags className="h-3 w-3" />Chọn nhiều</span>;
}

export default function GovernPage() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">Đang tải…</div>}>
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
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const reloadMetrics = useCallback(async () => { try { setMetrics((await getMetrics()).metrics); } catch { /* ignore */ } }, []);
  useEffect(() => { void reloadMetrics(); }, [reloadMetrics]);

  return (
    <AppModalShell
      onClose={onClose}
      title="Từ điển & Nhãn"
      icon={<Library className="h-4 w-4" />}
      maxWidthClass="max-w-3xl"
      description="Thuật ngữ nghiệp vụ & nhãn phân loại dùng chung — chuẩn hoá ngữ nghĩa dữ liệu cho cả tổ chức."
      footer={<Button variant="secondary" onClick={onClose}>Đóng</Button>}
    >
      <VocabManager metrics={metrics} onChanged={reloadMetrics} />
    </AppModalShell>
  );
}

function VocabManager({ metrics, onChanged }: {
  metrics: Metric[];
  onChanged: () => Promise<void>;
}) {
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
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <FilterTag tone="brand" active={seg === 'terms'} onClick={() => setSeg('terms')}><BookText className="mr-1 h-3 w-3" />Thuật ngữ ({terms.length})</FilterTag>
        <FilterTag tone="info" active={seg === 'tags'} onClick={() => setSeg('tags')}><Tags className="mr-1 h-3 w-3" />Phân loại ({classes.length})</FilterTag>
      </div>
      {loading ? (
        <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : seg === 'terms' ? (
        <TermsManager glossaries={glossaries} terms={terms} usage={termUsage} onChanged={refresh} />
      ) : (
        <TagsManager classes={classes} tags={tags} usage={tagUsage} onChanged={refresh} />
      )}
    </div>
  );
}

function GlossaryInlineManager({ glossaries, onChanged }: { glossaries: Glossary[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDel, setPendingDel] = useState<Glossary | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await upsertGlossary({ name }); setName(''); toast.success('Đã tạo bộ thuật ngữ', { description: name }); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không tạo được.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!pendingDel) return;
    setBusy(true);
    try { await deleteGlossary(pendingDel.fqn); toast.success('Đã xoá bộ thuật ngữ'); setPendingDel(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
      <div className="text-tiny uppercase tracking-[0.08em] text-text-tertiary">Bộ thuật ngữ</div>
      {glossaries.length > 0 && (
        <ul className="space-y-1">
          {glossaries.map((g) => (
            <li key={g.machine_name} className="flex items-center justify-between gap-2 text-caption text-text-secondary">
              <span className="flex items-center gap-1.5"><Library className="h-3.5 w-3.5 text-text-quaternary" />{g.name} <span className="text-tiny text-text-quaternary">({g.termCount})</span>{g.provider === 'system' && <Lock className="h-3 w-3 text-text-quaternary" />}</span>
              {g.provider !== 'system' && <button onClick={() => setPendingDel(g)} disabled={busy} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá"><Trash2 className="h-3.5 w-3.5" /></button>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên bộ thuật ngữ mới…" />
        <Button variant="secondary" size="sm" loading={busy} disabled={busy || !name.trim()} onClick={create}>Tạo</Button>
      </div>
      {pendingDel && <ConfirmModal title="Xoá bộ thuật ngữ?" message={<>Xoá <strong>{pendingDel.name}</strong>{pendingDel.termCount > 0 ? ` cùng ${pendingDel.termCount} thuật ngữ bên trong` : ''}?</>} onConfirm={del} onClose={() => setPendingDel(null)} loading={busy} />}
    </div>
  );
}

function TermsManager({ glossaries, terms, usage, onChanged }: {
  glossaries: Glossary[]; terms: GlossaryTerm[]; usage: Map<string, number>;
  onChanged: () => Promise<void>;
}) {
  const [glossOpen, setGlossOpen] = useState(false);
  const [form, setForm] = useState<{ open: boolean; machine?: string; glossary: string; name: string; def: string; syn: string }>(
    { open: false, glossary: '', name: '', def: '', syn: '' });
  const [busy, setBusy] = useState(false);
  const [delTerm, setDelTerm] = useState<GlossaryTerm | null>(null);
  const hasGloss = glossaries.length > 0;

  const openAdd = () => setForm({ open: true, glossary: glossaries[0]?.machine_name || '', name: '', def: '', syn: '' });
  const openEdit = (t: GlossaryTerm) => setForm({ open: true, machine: t.machine_name, glossary: t.glossaryFqn || '', name: t.name, def: t.definition || '', syn: (t.synonyms || []).join(', ') });

  const save = async () => {
    if (!form.name.trim() || !form.glossary) return;
    setBusy(true);
    try {
      await upsertTerm({ glossary: form.glossary, machine_name: form.machine, name: form.name, description: form.def, synonyms: form.syn.split(',').map((s) => s.trim()).filter(Boolean) });
      toast.success(form.machine ? 'Đã lưu thuật ngữ' : 'Đã thêm thuật ngữ', { description: form.name });
      setForm((f) => ({ ...f, open: false })); await onChanged();
    } catch (e) { toast.error(errDetail(e) || 'Không lưu được.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!delTerm) return;
    setBusy(true);
    try { await deleteTerm(delTerm.fqn); toast.success('Đã xoá', { description: delTerm.name }); setDelTerm(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-caption text-text-tertiary">{terms.length} thuật ngữ · {glossaries.length} bộ</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" leadingIcon={<Library className="h-3.5 w-3.5" />} onClick={() => setGlossOpen((v) => !v)}>Bộ thuật ngữ</Button>
          <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} disabled={!hasGloss} onClick={openAdd}>Thêm thuật ngữ</Button>
        </div>
      </div>

      {glossOpen && <GlossaryInlineManager glossaries={glossaries} onChanged={onChanged} />}

      {form.open && (
        <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
          {glossaries.length > 1 && (
            <Field label="Bộ thuật ngữ">
              <Select size="sm" value={form.glossary} onChange={(e) => setForm({ ...form, glossary: e.target.value })} disabled={!!form.machine}>
                {glossaries.map((g) => <option key={g.machine_name} value={g.machine_name}>{g.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Tên thuật ngữ"><Input size="sm" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="vd: Khách hàng hoạt động" /></Field>
          <Field label="Định nghĩa"><Textarea rows={2} value={form.def} onChange={(e) => setForm({ ...form, def: e.target.value })} placeholder="Định nghĩa nghiệp vụ rõ ràng…" /></Field>
          <Field label="Từ đồng nghĩa" hint="Phân tách bằng dấu phẩy"><Input size="sm" value={form.syn} onChange={(e) => setForm({ ...form, syn: e.target.value })} placeholder="active user, KH active" /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setForm((f) => ({ ...f, open: false }))} disabled={busy}>Huỷ</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={busy || !form.name.trim()} onClick={save}>Lưu</Button>
          </div>
        </div>
      )}

      {!hasGloss ? (
        <p className="py-6 text-center text-caption text-text-quaternary">Tạo một “Bộ thuật ngữ” trước (nút Bộ thuật ngữ), rồi thêm thuật ngữ.</p>
      ) : terms.length === 0 ? (
        <p className="py-6 text-center text-caption text-text-quaternary">Chưa có thuật ngữ nào.</p>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
          {terms.map((t) => {
            const sys = t.provider === 'system';
            const n = usage.get(t.fqn) || 0;
            return (
              <li key={t.fqn} className="flex items-start justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><BookText className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{t.name}{sys && <Lock className="h-3 w-3 text-text-quaternary" />}<span className="text-tiny text-text-quaternary">· {t.glossary}</span></span>
                  {t.definition && <span className="mt-0.5 line-clamp-1 block text-tiny text-text-tertiary">{t.definition}</span>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  {n > 0 && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-tiny text-brand" title="Số measure đang dùng thuật ngữ này">{n} chỉ số</span>}
                  {!sys && <>
                    <button onClick={() => openEdit(t)} className="p-1 text-text-quaternary hover:text-text-primary" aria-label="Sửa"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setDelTerm(t)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá"><Trash2 className="h-3.5 w-3.5" /></button>
                  </>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {delTerm && <ConfirmModal title="Xoá thuật ngữ?" message={<>Xoá <strong>{delTerm.name}</strong> khỏi từ điển dùng chung?</>} onConfirm={del} onClose={() => setDelTerm(null)} loading={busy} />}
    </div>
  );
}

function TagsManager({ classes, tags, usage, onChanged }: {
  classes: Classification[]; tags: Tag[]; usage: Map<string, number>;
  onChanged: () => Promise<void>;
}) {
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
    try { await upsertClassification({ name: cForm.name, description: cForm.desc, mutuallyExclusive: cForm.mx }); toast.success('Đã tạo phân loại', { description: cForm.name }); setAddClass(false); setCForm({ name: '', desc: '', mx: false }); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không tạo được.'); } finally { setBusy(false); }
  };
  const createTag = async (cmachine: string) => {
    if (!tagName.trim()) return;
    setBusy(true);
    try { await upsertTag({ classification: cmachine, name: tagName }); toast.success('Đã thêm tag', { description: tagName }); setAddTagFor(null); setTagName(''); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không thêm được.'); } finally { setBusy(false); }
  };
  const doDelTag = async () => {
    if (!delTag) return;
    setBusy(true);
    try { await deleteTag(delTag.fqn); toast.success('Đã xoá tag'); setDelTag(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };
  const doDelClass = async () => {
    if (!delClass) return;
    setBusy(true);
    try { await deleteClassification(delClass.fqn); toast.success('Đã xoá phân loại'); setDelClass(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-text-tertiary">{classes.length} phân loại · {tags.length} nhãn</span>
        <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAddClass((v) => !v)}>Thêm phân loại</Button>
      </div>

      {addClass && (
        <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
          <Field label="Tên phân loại"><Input size="sm" autoFocus value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} placeholder="vd: Độ nhạy cảm" /></Field>
          <Field label="Mô tả"><Input size="sm" value={cForm.desc} onChange={(e) => setCForm({ ...cForm, desc: e.target.value })} placeholder="Nhóm nhãn này dùng để…" /></Field>
          <label className="flex items-center gap-2 text-caption text-text-secondary"><input type="checkbox" checked={cForm.mx} onChange={(e) => setCForm({ ...cForm, mx: e.target.checked })} className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" />Chọn 1 (loại trừ) — mỗi đối tượng chỉ mang 1 nhãn</label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAddClass(false)} disabled={busy}>Huỷ</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={busy || !cForm.name.trim()} onClick={createClass}>Tạo</Button>
          </div>
        </div>
      )}

      {classes.length === 0 ? (
        <p className="py-6 text-center text-caption text-text-quaternary">Chưa có phân loại nào.</p>
      ) : (
        <ul className="space-y-2">
          {classes.map((c) => {
            const sys = c.provider === 'system';
            const ctags = tagsByClass.get(c.machine_name) || [];
            return (
              <li key={c.machine_name} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-caption font-emphasis text-text-primary"><Tags className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" /><span className="truncate">{c.name}</span>{sys && <Lock className="h-3 w-3 flex-shrink-0 text-text-quaternary" />}<ExclusivityTag mx={c.mutuallyExclusive} /></span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {!sys && <button onClick={() => { setAddTagFor(addTagFor === c.machine_name ? null : c.machine_name); setTagName(''); }} className="p-1 text-text-quaternary hover:text-text-primary" aria-label="Thêm tag" title="Thêm tag"><Plus className="h-3.5 w-3.5" /></button>}
                    {!sys && <button onClick={() => setDelClass(c)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá phân loại"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                </div>
                {addTagFor === c.machine_name && (
                  <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
                    <Input size="sm" autoFocus value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="Tên tag mới…" />
                    <Button variant="secondary" size="sm" loading={busy} disabled={busy || !tagName.trim()} onClick={() => createTag(c.machine_name)}>Thêm</Button>
                  </div>
                )}
                {ctags.length === 0 ? (
                  <p className="px-3 py-2 text-tiny text-text-quaternary">Chưa có tag.</p>
                ) : (
                  <ul className="divide-y divide-[rgb(var(--border-line))]">
                    {ctags.map((tg) => {
                      const n = usage.get(tg.fqn) || 0;
                      return (
                        <li key={tg.fqn} className="flex items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0 truncate text-caption text-text-secondary">{tg.name}{tg.description && <span className="ml-1.5 text-tiny text-text-quaternary">{cleanDesc(tg.description)}</span>}</span>
                          <div className="flex flex-shrink-0 items-center gap-1">
                            {n > 0 && <span className="rounded bg-info/10 px-1.5 py-0.5 text-tiny text-info" title="Số measure mang nhãn này">{n} chỉ số</span>}
                            {!sys && <button onClick={() => setDelTag(tg)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá tag"><Trash2 className="h-3.5 w-3.5" /></button>}
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
      )}
      {delTag && <ConfirmModal title="Xoá tag?" message={<>Xoá tag <strong>{delTag.name}</strong>?</>} onConfirm={doDelTag} onClose={() => setDelTag(null)} loading={busy} />}
      {delClass && <ConfirmModal title="Xoá phân loại?" message={<>Xoá <strong>{delClass.name}</strong> cùng toàn bộ tag bên trong?</>} onConfirm={doDelClass} onClose={() => setDelClass(null)} loading={busy} />}
    </div>
  );
}
