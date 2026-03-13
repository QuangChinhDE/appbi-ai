/**
 * AddTableModal v1.5 - Add tables from physical tables or SQL queries
 */
'use client';

import React, { useState } from 'react';
import { X, Database, Code, Loader2 } from 'lucide-react';
import { PhysicalTableTab } from './PhysicalTableTab';
import { QueryTableTab } from './QueryTableTab';
import { useAddTableToWorkspace } from '@/hooks/use-dataset-workspaces';
import type { AddTableInput } from '@/hooks/use-dataset-workspaces';

interface AddTableModalProps {
  workspaceId: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type TabType = 'physical' | 'query';

export function AddTableModal({ workspaceId, isOpen, onClose, onSuccess }: AddTableModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('physical');
  const addTableMutation = useAddTableToWorkspace();

  // Reset state when modal closes
  React.useEffect(() => {
    if (!isOpen) {
      setActiveTab('physical');
    }
  }, [isOpen]);

  const handleAddTable = async (input: AddTableInput) => {
    try {
      await addTableMutation.mutateAsync({
        workspaceId,
        input,
      });
      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Failed to add table:', error);
      throw error;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Add Table</h2>
            <p className="text-sm text-gray-500 mt-1">
              Add a table from a physical datasource table or custom SQL query
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={addTableMutation.isPending}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b px-6">
          <button
            onClick={() => setActiveTab('physical')}
            className={`flex items-center gap-2 px-4 py-3 border-b-2 transition-colors ${
              activeTab === 'physical'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            disabled={addTableMutation.isPending}
          >
            <Database className="w-4 h-4" />
            <span className="font-medium">From Table</span>
          </button>
          <button
            onClick={() => setActiveTab('query')}
            className={`flex items-center gap-2 px-4 py-3 border-b-2 transition-colors ${
              activeTab === 'query'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            disabled={addTableMutation.isPending}
          >
            <Code className="w-4 h-4" />
            <span className="font-medium">From Query</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'physical' ? (
            <PhysicalTableTab
              onAddTable={handleAddTable}
              isLoading={addTableMutation.isPending}
            />
          ) : (
            <QueryTableTab
              onAddTable={handleAddTable}
              isLoading={addTableMutation.isPending}
            />
          )}
        </div>
      </div>
    </div>
  );
}
