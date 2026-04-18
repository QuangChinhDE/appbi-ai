/**
 * Modal for adding an explore chart to a dashboard
 */
'use client';

import React, { useState } from 'react';
import { useDashboards } from '@/hooks/use-dashboards';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select } from '@/components/ui/Input';

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
      title="Add to Dashboard"
      size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleAdd}
            disabled={!selectedDashboardId || !chartTitle.trim()}
          >
            Add to Dashboard
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <FieldGroup label="Chart Title">
          <Input
            type="text"
            value={chartTitle}
            onChange={(e) => setChartTitle(e.target.value)}
            placeholder="Enter chart title..."
          />
        </FieldGroup>

        <FieldGroup label="Select Dashboard">
          {isLoading ? (
            <div className="text-caption text-text-tertiary">Loading dashboards...</div>
          ) : dashboards && dashboards.length > 0 ? (
            <Select
              value={selectedDashboardId || ''}
              onChange={(e) => setSelectedDashboardId(Number(e.target.value))}
            >
              <option value="">Select a dashboard...</option>
              {dashboards.map((dashboard) => (
                <option key={dashboard.id} value={dashboard.id}>
                  {dashboard.name}
                </option>
              ))}
            </Select>
          ) : (
            <div className="text-caption text-text-tertiary">
              No dashboards available. Create a dashboard first.
            </div>
          )}
        </FieldGroup>

        <div className="rounded-md bg-surface-2 p-3">
          <p className="text-caption font-emphasis text-text-secondary mb-1">Chart Configuration:</p>
          <div className="space-y-1 text-caption text-text-secondary">
            <p>Type: <span className="font-emphasis text-text-primary">{lookConfig.chartType}</span></p>
            <p>Dimensions: <span className="font-emphasis text-text-primary">{lookConfig.dimensions.join(', ') || 'None'}</span></p>
            <p>Measures: <span className="font-emphasis text-text-primary">{lookConfig.measures.join(', ') || 'None'}</span></p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
