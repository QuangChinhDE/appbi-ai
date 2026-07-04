/**
 * Modal for adding an explore chart to a dashboard
 */
'use client';

import React, { useState } from 'react';
import { useDashboards } from '@/hooks/use-dashboards';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';

interface AddToDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  lookConfig: {
    source: {
      kind: string;
      datasetId: number | null;
      tableId: number | null;
    };
    dimensions: string[];
    measures: string[];
    filters: any[];
    chartType: string;
  };
  onAdd: (dashboardId: number, chartTitle: string) => void;
}

export function AddToDashboardModal({
  isOpen,
  onClose,
  lookConfig,
  onAdd,
}: AddToDashboardModalProps) {
  const { t } = useI18n();
  const [selectedDashboardId, setSelectedDashboardId] = useState<number | null>(null);
  const [chartTitle, setChartTitle] = useState('');
  const { data: dashboards, isLoading } = useDashboards();

  console.log('AddToDashboardModal render:', { isOpen, dashboards: dashboards?.length });

  const handleAdd = () => {
    if (selectedDashboardId && chartTitle.trim()) {
      onAdd(selectedDashboardId, chartTitle);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('explore.addToDashboard.title')}
      size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={handleAdd}
            disabled={!selectedDashboardId || !chartTitle.trim()}
          >
            {t('explore.addToDashboard.title')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <FieldGroup label={t('explore.addToDashboard.chartTitle')}>
          <Input
            type="text"
            value={chartTitle}
            onChange={(e) => setChartTitle(e.target.value)}
            placeholder={t('explore.addToDashboard.chartTitlePlaceholder')}
          />
        </FieldGroup>

        <FieldGroup label={t('explore.addToDashboard.selectDashboard')}>
          {isLoading ? (
            <div className="text-caption text-text-tertiary">{t('explore.addToDashboard.loadingDashboards')}</div>
          ) : dashboards && dashboards.length > 0 ? (
            <Select
              value={selectedDashboardId || ''}
              onChange={(e) => setSelectedDashboardId(Number(e.target.value))}
            >
              <option value="">{t('explore.addToDashboard.selectDashboardPlaceholder')}</option>
              {dashboards.map((dashboard) => (
                <option key={dashboard.id} value={dashboard.id}>
                  {dashboard.name}
                </option>
              ))}
            </Select>
          ) : (
            <div className="text-caption text-text-tertiary">
              {t('explore.addToDashboard.noDashboards')}
            </div>
          )}
        </FieldGroup>

        <div className="rounded-md bg-surface-2 p-3">
          <p className="text-caption font-emphasis text-text-secondary mb-1">{t('explore.addToDashboard.chartConfiguration')}</p>
          <div className="space-y-1 text-caption text-text-secondary">
            <p>{t('explore.addToDashboard.type')}: <span className="font-emphasis text-text-primary">{lookConfig.chartType}</span></p>
            <p>{t('explore.addToDashboard.dimensions')}: <span className="font-emphasis text-text-primary">{lookConfig.dimensions.join(', ') || t('explore.addToDashboard.none')}</span></p>
            <p>{t('explore.addToDashboard.measures')}: <span className="font-emphasis text-text-primary">{lookConfig.measures.join(', ') || t('explore.addToDashboard.none')}</span></p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
