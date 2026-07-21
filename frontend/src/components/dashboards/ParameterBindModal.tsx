'use client';

import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ArrowRightLeft } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { dashboardApi } from '@/lib/api/dashboards';
import type { DashboardChart } from '@/types/api';
import type { ParamDef } from '@/lib/dashboard-params';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: number;
  chart: DashboardChart | null;
  paramDefs: ParamDef[];
};

type Role = 'none' | 'dimension' | 'metric';

interface Binding {
  param: string;
  role: 'dimension' | 'metric';
}

/**
 * Bind a chart's active dimension/measure to a dashboard what-if parameter.
 * The switcher's selected value (a field name) replaces the chart's dimension
 * or first measure at query time. Bindings persist under the reserved
 * `__whatifBindings` key of the chart instance's `parameters`.
 */
export function ParameterBindModal({ isOpen, onClose, dashboardId, chart, paramDefs }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen || !chart) return;
    const existing = (chart.parameters as any)?.__whatifBindings;
    const next: Record<string, Role> = {};
    if (Array.isArray(existing)) {
      for (const b of existing) {
        if (b?.param && (b.role === 'dimension' || b.role === 'metric')) next[b.param] = b.role;
      }
    }
    setRoles(next);
  }, [isOpen, chart?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen || !chart) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const bindings: Binding[] = Object.entries(roles)
        .filter(([, r]) => r === 'dimension' || r === 'metric')
        .map(([param, r]) => ({ param, role: r as 'dimension' | 'metric' }));
      // Preserve any non-whatif keys already on the instance.
      const base = { ...((chart.parameters as Record<string, any>) ?? {}) };
      if (bindings.length > 0) base.__whatifBindings = bindings;
      else delete base.__whatifBindings;
      await dashboardApi.updateChartParameters(dashboardId, chart.id, base);
      await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
      toast.success(t('dashboards.paramBind.savedToast'));
      onClose();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : t('dashboards.paramBind.saveFailedToast'));
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
        {t('common.save')}
      </button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('dashboards.paramBind.title')}
      size="md"
      footer={footer}
    >
      <div className="space-y-4 p-5">
        <p className="text-[12px] text-text-tertiary">{t('dashboards.paramBind.hint')}</p>
        {paramDefs.length === 0 ? (
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 text-[12px] text-text-tertiary">
            {t('dashboards.paramBind.noParams')}
          </p>
        ) : (
          <div className="space-y-2">
            {paramDefs.map((def) => (
              <div
                key={def.paramName}
                className="flex items-center gap-3 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2"
              >
                <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-[510] text-text-primary">
                    {def.label || def.paramName}
                  </div>
                  <div className="truncate text-[11px] text-text-tertiary">{def.paramName}</div>
                </div>
                <select
                  value={roles[def.paramName] ?? 'none'}
                  onChange={(e) =>
                    setRoles((prev) => ({ ...prev, [def.paramName]: e.target.value as Role }))
                  }
                  className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
                >
                  <option value="none">{t('dashboards.paramBind.roleNone')}</option>
                  <option value="dimension">{t('dashboards.paramBind.roleDimension')}</option>
                  <option value="metric">{t('dashboards.paramBind.roleMetric')}</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
