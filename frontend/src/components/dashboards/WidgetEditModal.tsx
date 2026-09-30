'use client';

import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { dashboardApi } from '@/lib/api/dashboards';
import type { DashboardChart, DashboardWidgetType } from '@/types/api';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { WidgetConfigForm, widgetTypeLabel } from './widget-forms';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: number;
  widget: DashboardChart | null;
};

export function WidgetEditModal({ isOpen, onClose, dashboardId, widget }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<Record<string, any>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Reload draft each time a different widget is opened.
  useEffect(() => {
    if (!isOpen || !widget) return;
    setConfig({ ...(widget.widget_config ?? {}) });
  }, [isOpen, widget?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen || !widget) return null;

  const widgetType = (widget.widget_type ?? 'text') as DashboardWidgetType;

  const set = (key: string, value: any) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await dashboardApi.updateWidget(dashboardId, widget.id, config);
      await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
      toast.success(t('dashboards.widgetEdit.savedToast'));
      onClose();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : t('dashboards.widgetEdit.saveFailedToast'));
    } finally {
      setIsSaving(false);
    }
  };

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex h-8 items-center rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-surface-2"
      >
        {t('common.cancel')}
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={isSaving}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-[12px] font-[510] text-white shadow-sm transition-colors hover:bg-brand-hover disabled:opacity-60"
      >
        {isSaving && <Loader2 className="h-3 w-3 animate-spin" />}
        {isSaving ? t('dashboards.widgetEdit.saving') : t('dashboards.widgetEdit.save')}
      </button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('dashboards.widgetEdit.title', { type: widgetTypeLabel(t, widgetType) })}
      size="md"
      footer={footer}
    >
      <div className="p-5">
        <WidgetConfigForm type={widgetType} config={config} set={set} setConfig={setConfig} />
      </div>
    </Modal>
  );
}

