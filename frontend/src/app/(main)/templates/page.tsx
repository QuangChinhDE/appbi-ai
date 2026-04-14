'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, FileText, Clock, Hash, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useReportTemplates, useCreateReportTemplate, useDeleteReportTemplate } from '@/hooks/use-report-templates';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { TemplateList } from '@/components/templates/TemplateList';
import { TemplateCardGrid } from '@/components/templates/TemplateCardGrid';
import { useI18n } from '@/providers/LanguageProvider';

export default function TemplatesPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [deletingId, setDeletingId] = useState<number | undefined>();

  const { data: templates, isLoading } = useReportTemplates();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'report_templates', 'edit');
  const createMutation = useCreateReportTemplate();
  const deleteMutation = useDeleteReportTemplate();

  const templateItems = templates ?? [];
  const updatedThisWeek = useMemo(
    () =>
      templateItems.filter((tpl) => {
        const ts = new Date(tpl.updated_at).getTime();
        return Number.isFinite(ts) && Date.now() - ts <= 7 * 24 * 60 * 60 * 1000;
      }).length,
    [templateItems],
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const tpl = await createMutation.mutateAsync({ name: newName.trim() });
      setNewName('');
      setIsCreating(false);
      router.push(`/templates/${tpl.id}`);
    } catch (error: any) {
      toast.error(`Could not create template: ${error.message}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this report template?')) return;
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync(id);
    } catch (error: any) {
      toast.error(`Could not delete template: ${error.message}`);
    } finally {
      setDeletingId(undefined);
    }
  };

  return (
    <PageListLayout
      title={t('module.templates.title')}
      description={`${templateItems.length} template${templateItems.length !== 1 ? 's' : ''}`}
      isLoading={isLoading}
      loadingText={t('templates.loading')}
      searchPlaceholder={t('templates.searchPlaceholder')}
      overview={
        <ModuleOverview
          icon={FileText}
          title={t('overview.templates.title')}
          description={t('overview.templates.description')}
          badges={[
            t('overview.templates.badge1'),
            t('overview.templates.badge2'),
            t('overview.templates.badge3'),
          ]}
          stats={[
            {
              label: t('overview.templates.total'),
              value: templateItems.length,
              helper: t('overview.templates.totalHelper'),
            },
            {
              label: t('overview.templates.blocks'),
              value: templateItems.reduce((s, t) => s + (Array.isArray(t.blocks) ? t.blocks.length : 1), 0),
              helper: t('overview.templates.blocksHelper'),
            },
            {
              label: t('overview.templates.updated'),
              value: updatedThisWeek,
              helper: t('overview.templates.updatedHelper'),
            },
          ]}
        />
      }
      action={
        canEdit ? (
          isCreating ? (
            <form onSubmit={handleCreate} className="flex items-center gap-2">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Template name…"
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={createMutation.isPending || !newName.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </button>
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >
                {t('common.cancel')}
              </button>
            </form>
          ) : (
            <button
              onClick={() => setIsCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              {t('action.newTemplate')}
            </button>
          )
        ) : null
      }
    >
      {({ viewMode, filterText }) => {
        const filtered = templateItems.filter(
          (tpl) =>
            tpl.name.toLowerCase().includes(filterText.toLowerCase()) ||
            (tpl.description ?? '').toLowerCase().includes(filterText.toLowerCase()),
        );

        return viewMode === 'grid' ? (
          <TemplateCardGrid templates={filtered} onDelete={canEdit ? handleDelete : undefined} deletingId={deletingId} />
        ) : (
          <TemplateList templates={filtered} onDelete={canEdit ? handleDelete : undefined} deletingId={deletingId} />
        );
      }}
    </PageListLayout>
  );
}
