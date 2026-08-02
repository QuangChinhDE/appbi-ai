'use client';

/**
 * Import a flow bundle.
 *
 * Importing is the one action here that can fail for reasons the author cannot
 * see from the file: this deployment may simply not have a tool the bundle
 * needs. So the file is checked against the server BEFORE anything is written,
 * and the dialog says plainly what is fatal, what is merely worth knowing, and
 * what key the flow will land under.
 */
import React, { useRef, useState } from 'react';
import { AlertTriangle, FileJson, Info, Upload } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { type BundleCheck, checkBundle, importBundle } from '@/lib/aiFlows';
import { errText } from '../shared';

interface Props {
  onClose: () => void;
  onImported: (flowKey: string, version: number) => void;
}

export function ImportDialog({ onClose, onImported }: Props) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [check, setCheck] = useState<BundleCheck | null>(null);
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      const result = await checkBundle(parsed);
      setBundle(parsed);
      setCheck(result);
      setNewKey(String(result.flow_key ?? ''));
    } catch (e) {
      setBundle(null);
      setCheck(null);
      toast.error(e instanceof SyntaxError ? t('aiFlows.port.badFile') : errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      const flow = await importBundle(bundle, newKey.trim() || undefined);
      toast.success(t('aiFlows.port.done', { key: flow.flow_key }));
      onImported(flow.flow_key, flow.version);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-body font-strong text-text-primary">
          {t('aiFlows.port.importTitle')}
        </h2>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f);
          }}
        />

        <Button
          variant="secondary"
          className="w-full"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <FileJson className="h-4 w-4" /> {t('aiFlows.port.pick')}
        </Button>

        {check && (
          <div className="mt-4 space-y-3">
            <p className="text-caption text-text-secondary">
              {t('aiFlows.port.summary', {
                name: check.display_name ?? check.flow_key ?? '—',
                count: check.node_count ?? 0,
              })}
            </p>

            {check.fatal.length > 0 && (
              <div className="rounded-lg border border-danger/30 bg-danger/[0.05] p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-caption font-emphasis text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" /> {t('aiFlows.port.fatal')}
                </div>
                <ul className="space-y-0.5">
                  {check.fatal.map((f, i) => (
                    <li key={i} className="text-tiny text-text-secondary">{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {check.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/[0.06] p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-caption font-emphasis text-warning">
                  <Info className="h-3.5 w-3.5" /> {t('aiFlows.port.warnings')}
                </div>
                <ul className="space-y-0.5">
                  {check.warnings.map((w, i) => (
                    <li key={i} className="text-tiny text-text-secondary">{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {check.ok && (
              <>
                <div>
                  <Label>{t('aiFlows.port.newKey')}</Label>
                  <Input
                    value={newKey}
                    onChange={(e) => setNewKey(
                      e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    )}
                  />
                </div>
                <p className="text-tiny leading-relaxed text-text-quaternary">
                  {t('aiFlows.port.draftNotice')}
                </p>
              </>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('aiFlows.common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || !check?.ok}
            onClick={doImport}
          >
            <Upload className="h-4 w-4" /> {t('aiFlows.port.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Download a bundle as a file. Kept here so the export button is one call. */
export function downloadBundle(bundle: Record<string, unknown>, filename: string) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
