'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useReportTemplate, useUpdateReportTemplate } from '@/hooks/use-report-templates';
import type { TemplateDefinition } from '@/types/template';
import { isTemplateDefinition, createDefaultDefinition } from '@/types/template';
import { TemplateBuilder } from '@/components/templates/builder';
import { getResourcePermissions } from '@/hooks/use-resource-permission';

export default function TemplateDetailPage() {
  const params = useParams();
  const templateId = Number(params.id);

  const { data: template, isLoading } = useReportTemplate(templateId);
  const updateMutation = useUpdateReportTemplate();

  const [definition, setDefinition] = useState<TemplateDefinition>(createDefaultDefinition());
  const [hasChanges, setHasChanges] = useState(false);

  const resPerms = getResourcePermissions(template?.user_permission);
  const canEdit = resPerms.canEdit;

  // Sync from server
  useEffect(() => {
    if (template) {
      const raw = template.blocks;
      if (isTemplateDefinition(raw)) {
        setDefinition(raw);
      } else {
        // Old/empty template → create fresh v3 definition
        setDefinition(createDefaultDefinition());
      }
      setHasChanges(false);
    }
  }, [template]);

  const handleDefinitionChange = useCallback((def: TemplateDefinition) => {
    setDefinition(def);
    setHasChanges(true);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({
        id: templateId,
        data: { blocks: definition },
      });
      setHasChanges(false);
      toast.success('Template saved');
    } catch (error: any) {
      toast.error(`Failed to save: ${error.message}`);
    }
  }, [templateId, definition, updateMutation]);

  if (isLoading || !template) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <TemplateBuilder
      template={template}
      definition={definition}
      onDefinitionChange={handleDefinitionChange}
      onSave={handleSave}
      isSaving={updateMutation.isPending}
      hasChanges={hasChanges}
      canEdit={canEdit}
    />
  );
}
