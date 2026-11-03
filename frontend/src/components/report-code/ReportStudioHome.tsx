'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClipboardPaste, Code2, Download, ImagePlus, LayoutDashboard, Sparkles, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { PasteCodeWizard } from '@/components/report-code/PasteCodeWizard';
import { downloadContextPack } from '@/components/report-code/contextPack';
import { readImage } from '@/components/report-code/StudioPanels';
import { useDatasets } from '@/hooks/use-datasets';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { reportCodeApi, type ReportSummary } from '@/lib/api/report-code';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

type Mode = 'code' | 'ai' | 'paste';

export function ReportStudioHome() {
  const { t } = useI18n();
  const router = useRouter();
  const { data: datasets = [] } = useDatasets();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'dashboards', 'edit');
  const [mode, setMode] = useState<Mode>('code');
  const [datasetId, setDatasetId] = useState<number | ''>('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [image, setImage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showPaste, setShowPaste] = useState(false);


  const create = async () => {
    if (datasetId === '' || busy) return;
    setBusy(true);
    try {
      const s = await reportCodeApi.create({ dataset_id: datasetId, prompt: prompt.trim(), name: name.trim() || undefined, reference_image: image });
      router.push(`/dashboards/code/${s.id}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
      setBusy(false);
    }
  };

  const createBlank = async () => {
    if (datasetId === '' || busy) return;
    setBusy(true);
    try {
      const s = await reportCodeApi.createBlank({ dataset_id: datasetId, name: name.trim() || t('reportCode.home.newCode') });
      router.push(`/dashboards/code/${s.id}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
      setBusy(false);
    }
  };


  const modes: { key: Mode; icon: typeof Wand2; title: string; desc: string }[] = [
    { key: 'code', icon: Code2, title: t('reportCode.home.newCode'), desc: t('reportCode.home.newCodeHint') },
    { key: 'ai', icon: Wand2, title: t('reportCode.home.modeAi'), desc: t('reportCode.home.modeAiDesc') },
    { key: 'paste', icon: ClipboardPaste, title: t('reportCode.home.modePaste'), desc: t('reportCode.home.modePasteDesc') },
  ];
  const ideas = [t('reportCode.home.idea1'), t('reportCode.home.idea2'), t('reportCode.home.idea3')];
  const datasetSelect = (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-secondary">{t('reportCode.home.dataset')} <span className="text-red-500">*</span></span>
      <select data-testid="rc-dataset" value={datasetId} onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : '')}
        className="w-full rounded-lg border border-stroke-control bg-surface-1 px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/30">
        <option value="">{t('reportCode.home.pickDataset')}</option>
        {datasets.map((d: { id: number; name: string }) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
  );

  return (
    <div className="min-h-full bg-surface-0" data-testid="report-studio-home">
      <div className="mx-auto max-w-6xl px-6 py-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-brand-container px-2.5 py-1 text-[11px] font-medium text-brand-on-container">
              <Sparkles className="h-3.5 w-3.5" />{t('reportCode.home.badge')}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{t('reportCode.home.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('reportCode.home.subtitle')}</p>
          </div>
          <Button variant="secondary" size="sm" leadingIcon={<LayoutDashboard className="h-3.5 w-3.5" />} onClick={() => router.push('/dashboards')}>
            {t('reportCode.home.manual')}
          </Button>
        </div>

        {canEdit && (
          <div className="mb-8 overflow-hidden rounded-xl border border-stroke-strong bg-surface-1 shadow-linear-sm">
            <div className="grid border-b border-stroke-line sm:grid-cols-3" role="tablist">
              {modes.map(({ key, icon: Icon, title, desc }) => (
                <button key={key} type="button" role="tab" aria-selected={mode === key} onClick={() => setMode(key)} data-testid={`rc-mode-${key}`}
                  className={`flex items-start gap-3 border-b-2 px-5 py-4 text-left transition md:border-b-2 ${mode === key ? 'border-brand bg-brand-container/40' : 'border-transparent hover:bg-surface-2'}`}>
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${mode === key ? 'bg-brand text-white' : 'bg-surface-2 text-text-secondary'}`}><Icon className="h-4 w-4" /></span>
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{title}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-text-tertiary">{desc}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="p-5">
              {mode === 'code' && (
                <div className="grid gap-5 lg:grid-cols-[1fr_300px]" data-testid="rc-code-panel">
                  <div className="space-y-2 text-sm text-text-secondary">
                    <p>{t('reportCode.home.newCodeHint')}</p>
                    <pre className="overflow-x-auto rounded-lg border border-stroke-line bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-secondary">{'<section data-rac-region="kpis">\n  <div data-rac-viz="kpi" data-rac-bind="b1"></div>\n</section>'}</pre>
                    <p className="text-[11px] text-text-quaternary">{t('reportCode.ai.governance')}</p>
                  </div>
                  <div className="space-y-3">
                    {datasetSelect}
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-text-secondary">{t('reportCode.home.name')}</span>
                      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('reportCode.home.nameHint')} data-testid="rc-blank-name"
                        className="w-full rounded-lg border border-stroke-control bg-surface-1 px-3 py-2 text-sm" />
                    </label>
                    <Button variant="primary" className="w-full" onClick={createBlank} disabled={datasetId === '' || busy} loading={busy}
                      leadingIcon={<Code2 className="h-4 w-4" />} data-testid="rc-create-blank">{t('reportCode.home.createBlank')}</Button>
                  </div>
                </div>
              )}
              {mode === 'ai' && (
                <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
                  <div className="space-y-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-text-secondary">{t('reportCode.home.prompt')}</span>
                      <Textarea data-testid="rc-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('reportCode.home.promptHint')} />
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {ideas.map((i) => (
                        <button key={i} type="button" onClick={() => setPrompt(i)}
                          className="rounded-full border border-stroke-strong bg-surface-1 px-2.5 py-1 text-[11px] text-text-secondary hover:border-brand/40 hover:text-brand">{i}</button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-3">
                    {datasetSelect}
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-text-secondary">{t('reportCode.home.name')}</span>
                      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('reportCode.home.nameHint')}
                        className="w-full rounded-lg border border-stroke-control bg-surface-1 px-3 py-2 text-sm" />
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-stroke-strong px-3 py-2 text-xs text-text-secondary hover:border-brand/40 hover:bg-surface-2">
                      <ImagePlus className="h-3.5 w-3.5 text-brand" />{image ? t('reportCode.ai.imageAttached') : t('reportCode.home.uploadImage')}
                      <input type="file" accept="image/*" className="hidden" data-testid="rc-image" onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        try { setImage(await readImage(f)); } catch { toast.error(t('reportCode.ai.imageTooLarge')); }
                      }} />
                    </label>
                    <Button variant="primary" className="w-full" onClick={create} disabled={datasetId === '' || busy} loading={busy}
                      leadingIcon={<Wand2 className="h-4 w-4" />} data-testid="rc-create">{t('reportCode.home.create')}</Button>
                    <p className="text-[11px] leading-relaxed text-text-quaternary">{t('reportCode.home.note')}</p>
                  </div>
                </div>
              )}
              {mode === 'paste' && (
                <div className="grid gap-5 lg:grid-cols-[1fr_300px]" data-testid="rc-paste-panel">
                  <div className="space-y-2 text-sm text-text-secondary">
                    <p>{t('reportCode.paste.intro')}</p>
                    <p className="text-xs text-text-tertiary">{t('reportCode.paste.preserve')}</p>
                    {/* The Context Pack is a TOOL of this path, not a way to create a report:
                        it briefs an external AI design tool on the governed data. */}
                    <div className="rounded-lg border border-stroke-line bg-surface-2 px-3 py-2 text-xs" data-testid="rc-pack-panel">
                      <div className="font-semibold text-text-primary">{t('reportCode.pack.title')}</div>
                      <p className="mt-0.5 text-text-tertiary">{t('reportCode.pack.hint')}</p>
                      <p className="mt-0.5 text-[11px] text-text-quaternary">{t('reportCode.pack.safe')}</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <Button variant="primary" className="w-full" leadingIcon={<ClipboardPaste className="h-4 w-4" />} onClick={() => setShowPaste(true)} data-testid="rc-paste-open">
                      {t('reportCode.paste.open')}
                    </Button>
                    {datasetSelect}
                    <Button variant="secondary" className="w-full" disabled={datasetId === ''} leadingIcon={<Download className="h-4 w-4" />}
                      onClick={() => datasetId !== '' && downloadContextPack(datasetId, t)} data-testid="rc-pack-download">{t('reportCode.pack.download')}</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Reports are managed in ONE place: /dashboards lists Build Manual and AI Vibe Reports together. */}
        <Link href="/dashboards?type=vibe" data-testid="rc-manage-all"
          className="inline-flex items-center gap-1.5 text-caption font-emphasis text-brand hover:text-brand-hover">
          <LayoutDashboard className="h-3.5 w-3.5" />{t('reportList.manageAll')} →
        </Link>
      </div>
      {showPaste && (
        <PasteCodeWizard datasets={datasets as { id: number; name: string }[]} datasetId={datasetId === '' ? null : datasetId}
          onClose={() => setShowPaste(false)} onDone={(id) => router.push(`/dashboards/code/${id}`)} />
      )}
    </div>
  );
}
