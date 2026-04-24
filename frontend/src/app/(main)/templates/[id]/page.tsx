'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';

import { useReportTemplate, useUpdateReportTemplate } from '@/hooks/use-report-templates';
import type { TemplateDefinition, TemplateDocumentDefinition, TemplateFilter } from '@/types/template';
import { isTemplateDefinition, isTemplateDocumentDefinition, createDefaultDefinition } from '@/types/template';
import { TemplateBuilder } from '@/components/templates/builder';
import { DocumentTemplateWorkspace } from '@/components/templates/document/DocumentTemplateWorkspace';
import { getResourcePermissions } from '@/hooks/use-resource-permission';

export default function TemplateDetailPage() {
  const params = useParams();
  const templateId = Number(params.id);

  const { data: template, isLoading } = useReportTemplate(templateId);
  const updateMutation = useUpdateReportTemplate();

  const [definition, setDefinition] = useState<TemplateDefinition>(createDefaultDefinition());
  const [documentDefinition, setDocumentDefinition] = useState<TemplateDocumentDefinition | null>(null);
  const [templateFilters, setTemplateFilters] = useState<TemplateFilter[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const resPerms = getResourcePermissions(template?.user_permission);
  const canEdit = resPerms.canEdit;

  // Sync from server
  useEffect(() => {
    if (template) {
      const raw = template.blocks;
      if (isTemplateDefinition(raw)) {
        setDefinition(raw);
        setDocumentDefinition(null);
      } else if (isTemplateDocumentDefinition(raw)) {
        setDocumentDefinition(raw);
        setDefinition(createDefaultDefinition());
      } else {
        // Old/empty template → create fresh v3 definition
        setDefinition(createDefaultDefinition());
        setDocumentDefinition(null);
      }
      setTemplateFilters(Array.isArray(template.filters) ? template.filters : []);
      setHasChanges(false);
    }
  }, [template]);

  const handleDefinitionChange = useCallback((def: TemplateDefinition) => {
    setDefinition(def);
    setHasChanges(true);
  }, []);

  const handleTemplateFiltersChange = useCallback((filters: TemplateFilter[]) => {
    setTemplateFilters(filters);
    setHasChanges(true);
  }, []);

  const handleDocumentDefinitionChange = useCallback((next: TemplateDocumentDefinition) => {
    setDocumentDefinition(next);
    setHasChanges(true);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({
        id: templateId,
        data: { blocks: documentDefinition ?? definition, filters: templateFilters },
      });
      setHasChanges(false);
      toast.success('Template saved');
    } catch (error: any) {
      toast.error(`Failed to save: ${error.message}`);
    }
  }, [templateId, definition, documentDefinition, templateFilters, updateMutation]);

  if (isLoading || !template) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  if (documentDefinition) {
    return (
      <DocumentTemplateWorkspace
        template={template}
        definition={documentDefinition}
        canEdit={canEdit}
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        onDefinitionChange={handleDocumentDefinitionChange}
        onSave={handleSave}
      />
    );
  }

  return (
    <TemplateBuilder
      template={template}
      definition={definition}
      templateFilters={templateFilters}
      onDefinitionChange={handleDefinitionChange}
      onTemplateFiltersChange={handleTemplateFiltersChange}
      onSave={handleSave}
      isSaving={updateMutation.isPending}
      hasChanges={hasChanges}
      canEdit={canEdit}
    />
  );
}
