'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, FileText, Loader2, FileSpreadsheet } from 'lucide-react';
import { toast } from '@/lib/toast';

import { useReportTemplates, useCreateReportTemplate, useDeleteReportTemplate } from '@/hooks/use-report-templates';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { TemplateList } from '@/components/templates/TemplateList';
import { TemplateCardGrid } from '@/components/templates/TemplateCardGrid';
import { ImportWizard } from '@/components/templates/ImportWizard';
import { useI18n } from '@/providers/LanguageProvider';
import { Button } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { Input } from '@/components/ui/Input';
import { isTemplateDefinition } from '@/types/template';

export default function TemplatesPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [deletingId, setDeletingId] = useState<number | undefined>();
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [listFilters, setListFilters] = useState<{ layout?: string; binding?: string; owner?: string }>({});

  const { data: templates, isLoading } = useReportTemplates();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'report_templates', 'edit');
  const createMutation = useCreateReportTemplate();
  const deleteMutation = useDeleteReportTemplate();

  const templateItems = templates ?? [];
  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;
  const updatedThisWeek = useMemo(
    () =>
      templateItems.filter((tpl) => {
        const ts = new Date(tpl.updated_at).getTime();
        return Number.isFinite(ts) && Date.now() - ts <= 7 * 24 * 60 * 60 * 1000;
      }).length,
    [templateItems],
  );

  const toggleListFilter = (key: 'layout' | 'binding' | 'owner', value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  const clearListFilters = () => setListFilters({});

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
    <>
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
              <Input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Template name…"
                size="sm"
                className="w-56"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={createMutation.isPending || !newName.trim()}
                leadingIcon={
                  createMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )
                }
              >
                Create
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsCreating(false)}
              >
                {t('common.cancel')}
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowImportWizard(true)}
                leadingIcon={<FileSpreadsheet className="h-3.5 w-3.5" />}
              >
                Import from Excel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setIsCreating(true)}
                leadingIcon={<Plus className="h-3.5 w-3.5" />}
              >
                {t('action.newTemplate')}
              </Button>
            </div>
          )
        ) : null
      }
      defaultView="list"
      activeFilters={activeListFilterCount > 0 ? (
        <>
          {listFilters.layout && (
            <FilterTag active onClick={() => toggleListFilter('layout', listFilters.layout!)}>
              Layout: {listFilters.layout}
            </FilterTag>
          )}
          {listFilters.binding && (
            <FilterTag
              tone={listFilters.binding === 'bound' ? 'success' : 'warning'}
              active
              onClick={() => toggleListFilter('binding', listFilters.binding!)}
            >
              {listFilters.binding === 'bound' ? 'Bound' : 'Unbound'}
            </FilterTag>
          )}
          {listFilters.owner && (
            <FilterTag active onClick={() => toggleListFilter('owner', listFilters.owner!)}>
              Owner: {listFilters.owner.split('@')[0]}
            </FilterTag>
          )}
          <Button variant="ghost" size="xs" onClick={clearListFilters}>
            Clear filters
          </Button>
        </>
      ) : null}
    >
      {({ viewMode, filterText }) => {
        const needle = filterText.trim().toLowerCase();
        const filtered = templateItems.filter((tpl) => {
          const definition = isTemplateDefinition(tpl.blocks) ? tpl.blocks : null;
          const layout = definition?.layout ?? 'custom';
          const binding = definition?.dataSource?.datasetName ? 'bound' : 'unbound';
          const matchesSearch =
            needle.length === 0 ||
            tpl.name.toLowerCase().includes(needle) ||
            (tpl.description ?? '').toLowerCase().includes(needle) ||
            definition?.dataSource?.datasetName?.toLowerCase().includes(needle) ||
            definition?.dataSource?.tableName?.toLowerCase().includes(needle) ||
            (tpl.owner_email ?? '').toLowerCase().includes(needle);

          return (
            matchesSearch &&
            (!listFilters.layout || layout === listFilters.layout) &&
            (!listFilters.binding || binding === listFilters.binding) &&
            (!listFilters.owner || tpl.owner_email === listFilters.owner)
          );
        });

        return viewMode === 'grid' ? (
          <TemplateCardGrid templates={filtered} onDelete={canEdit ? handleDelete : undefined} deletingId={deletingId} />
        ) : (
          <TemplateList
            templates={filtered}
            onDelete={canEdit ? handleDelete : undefined}
            deletingId={deletingId}
            activeFilters={listFilters}
            onFilterClick={(key, value) => toggleListFilter(key as 'layout' | 'binding' | 'owner', value)}
          />
        );
      }}
    </PageListLayout>

    <ImportWizard open={showImportWizard} onClose={() => setShowImportWizard(false)} />
    </>
  );
}
