'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { useCreateChart } from '@/hooks/use-charts';
import { ChartType, ChartCreate } from '@/types/api';
import { useRouter } from 'next/navigation';
import { SimpleFilter } from './FilterPanel';

interface SaveLookModalProps {
  isOpen: boolean;
  onClose: () => void;
  datasetId: number;
  chartType: ChartType;
  selectedDimensions: string[];
  selectedMeasures: string[];
  filters: SimpleFilter[];
}

export function SaveLookModal({
  isOpen,
  onClose,
  datasetId,
  chartType,
  selectedDimensions,
  selectedMeasures,
  filters,
}: SaveLookModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createMutation = useCreateChart();
  const router = useRouter();

  const handleSave = async () => {
    const config: Record<string, any> = { filters };

    if (chartType === ChartType.BAR || chartType === ChartType.LINE) {
      config.xField = selectedDimensions[0];
      config.yFields = selectedMeasures;
    } else if (chartType === ChartType.PIE) {
      config.labelField = selectedDimensions[0];
      config.valueField = selectedMeasures[0];
    }

    const payload: ChartCreate = {
      name,
      description: description || undefined,
      dataset_id: datasetId,
      chart_type: chartType,
      config,
    };

    try {
      await createMutation.mutateAsync(payload);
      setName('');
      setDescription('');
      onClose();
      router.push('/looks');
    } catch (error) {
      console.error('Failed to save look:', error);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Save as Look"
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || createMutation.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {createMutation.isPending ? 'Saving...' : 'Save Look'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="My Look"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={3}
            placeholder="Describe your look..."
          />
        </div>

        <div className="bg-gray-50 p-3 rounded-md text-sm text-gray-600">
          <p className="font-medium mb-1">Configuration:</p>
          <p>• Dataset: #{datasetId}</p>
          <p>• Chart Type: {chartType}</p>
          <p>• Dimensions: {selectedDimensions.join(', ') || 'None'}</p>
          <p>• Measures: {selectedMeasures.join(', ') || 'None'}</p>
        </div>
      </div>
    </Modal>
  );
}
