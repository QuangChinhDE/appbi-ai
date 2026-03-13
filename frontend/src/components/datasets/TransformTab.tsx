'use client';

import React, { useState } from 'react';
import { Dataset, TransformationStep, TransformationType } from '@/types/api';
import { Plus, Trash2, GripVertical, Power, PowerOff } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

interface TransformTabProps {
  dataset: Dataset;
  onSave: (transformations: TransformationStep[]) => void;
  onPreview: (transformations: TransformationStep[]) => void;
}

const STEP_TYPES: { value: TransformationType; label: string; description: string }[] = [
  { value: 'select_columns', label: 'Select Columns', description: 'Choose specific columns to include' },
  { value: 'rename_columns', label: 'Rename Columns', description: 'Rename column names' },
  { value: 'filter_rows', label: 'Filter Rows', description: 'Filter rows by conditions' },
  { value: 'add_column', label: 'Add Column', description: 'Add computed column' },
  { value: 'cast_column', label: 'Cast Column', description: 'Change column data type' },
  { value: 'replace_value', label: 'Replace Value', description: 'Replace values in a column' },
  { value: 'sort', label: 'Sort', description: 'Sort by columns' },
  { value: 'limit', label: 'Limit', description: 'Limit number of rows' },
];

export default function TransformTab({ dataset, onSave, onPreview }: TransformTabProps) {
  const [steps, setSteps] = useState<TransformationStep[]>(dataset.transformations || []);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);

  const selectedStep = steps.find(s => s.id === selectedStepId);

  const handleAddStep = (type: TransformationType) => {
    const newStep: TransformationStep = {
      id: uuidv4(),
      type,
      enabled: true,
      params: getDefaultParams(type),
    };
    setSteps([...steps, newStep]);
    setSelectedStepId(newStep.id);
    setShowAddMenu(false);
  };

  const handleDeleteStep = (id: string) => {
    setSteps(steps.filter(s => s.id !== id));
    if (selectedStepId === id) {
      setSelectedStepId(null);
    }
  };

  const handleToggleStep = (id: string) => {
    setSteps(steps.map(s => 
      s.id === id ? { ...s, enabled: !s.enabled } : s
    ));
  };

  const handleUpdateParams = (id: string, params: Record<string, any>) => {
    setSteps(steps.map(s => 
      s.id === id ? { ...s, params } : s
    ));
  };

  const handleMoveStep = (id: string, direction: 'up' | 'down') => {
    const index = steps.findIndex(s => s.id === id);
    if (direction === 'up' && index > 0) {
      const newSteps = [...steps];
      [newSteps[index - 1], newSteps[index]] = [newSteps[index], newSteps[index - 1]];
      setSteps(newSteps);
    } else if (direction === 'down' && index < steps.length - 1) {
      const newSteps = [...steps];
      [newSteps[index], newSteps[index + 1]] = [newSteps[index + 1], newSteps[index]];
      setSteps(newSteps);
    }
  };

  return (
    <div className="flex h-[600px] gap-4">
      {/* Left Panel - Steps List */}
      <div className="w-80 bg-white rounded-lg shadow-sm ring-1 ring-gray-200 flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-900">Transformation Steps</h3>
            <div className="relative">
              <button
                onClick={() => setShowAddMenu(!showAddMenu)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Add Step
              </button>
              
              {showAddMenu && (
                <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg ring-1 ring-gray-200 z-10 max-h-96 overflow-y-auto">
                  {STEP_TYPES.map((type) => (
                    <button
                      key={type.value}
                      onClick={() => handleAddStep(type.value)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b last:border-b-0"
                    >
                      <div className="font-medium text-sm text-gray-900">{type.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{type.description}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-500">
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {steps.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm">
              No transformation steps yet.
              <br />
              Click "Add Step" to start.
            </div>
          ) : (
            <div className="space-y-1">
              {steps.map((step, index) => {
                const stepType = STEP_TYPES.find(t => t.value === step.type);
                const isSelected = selectedStepId === step.id;
                
                return (
                  <div
                    key={step.id}
                    className={`group relative p-3 rounded-md border cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-blue-50 border-blue-300'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex flex-col gap-1 mt-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveStep(step.id, 'up');
                          }}
                          disabled={index === 0}
                          className="text-gray-400 hover:text-gray-600 disabled:opacity-30"
                        >
                          <GripVertical className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveStep(step.id, 'down');
                          }}
                          disabled={index === steps.length - 1}
                          className="text-gray-400 hover:text-gray-600 disabled:opacity-30"
                        >
                          <GripVertical className="h-3 w-3" />
                        </button>
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-gray-400">#{index + 1}</span>
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {stepType?.label || step.type}
                          </span>
                          {!step.enabled && (
                            <span className="text-xs text-gray-400">(disabled)</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate">
                          {stepType?.description}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleStep(step.id);
                          }}
                          className="text-gray-400 hover:text-gray-600"
                          title={step.enabled ? 'Disable step' : 'Enable step'}
                        >
                          {step.enabled ? (
                            <Power className="h-4 w-4 text-green-600" />
                          ) : (
                            <PowerOff className="h-4 w-4 text-gray-400" />
                          )}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteStep(step.id);
                          }}
                          className="text-gray-400 hover:text-red-600"
                          title="Delete step"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-4 border-t space-y-2">
          <button
            onClick={() => onPreview(steps)}
            className="w-full px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
          >
            Preview Results
          </button>
          <button
            onClick={() => onSave(steps)}
            className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Save Transformations
          </button>
        </div>
      </div>

      {/* Right Panel - Step Editor */}
      <div className="flex-1 bg-white rounded-lg shadow-sm ring-1 ring-gray-200 p-6">
        {selectedStep ? (
          <StepEditor
            step={selectedStep}
            columns={dataset.columns || []}
            onUpdateParams={(params) => handleUpdateParams(selectedStep.id, params)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            Select a step to edit its parameters
          </div>
        )}
      </div>
    </div>
  );
}

// Step Editor Component
interface StepEditorProps {
  step: TransformationStep;
  columns: { name: string; type: string }[];
  onUpdateParams: (params: Record<string, any>) => void;
}

function StepEditor({ step, columns, onUpdateParams }: StepEditorProps) {
  const stepType = STEP_TYPES.find(t => t.value === step.type);

  return (
    <div>
      <h3 className="text-lg font-semibold text-gray-900 mb-1">{stepType?.label}</h3>
      <p className="text-sm text-gray-500 mb-6">{stepType?.description}</p>

      <div className="space-y-4">
        {step.type === 'select_columns' && (
          <SelectColumnsEditor params={step.params} columns={columns} onUpdate={onUpdateParams} />
        )}
        {step.type === 'filter_rows' && (
          <FilterRowsEditor params={step.params} columns={columns} onUpdate={onUpdateParams} />
        )}
        {step.type === 'limit' && (
          <LimitEditor params={step.params} onUpdate={onUpdateParams} />
        )}
        {/* More editors will be added */}
        {!['select_columns', 'filter_rows', 'limit'].includes(step.type) && (
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-md text-sm text-yellow-800">
            Editor for "{step.type}" is coming soon. Use JSON editor for now:
            <textarea
              className="w-full mt-2 p-2 border rounded font-mono text-xs"
              rows={6}
              value={JSON.stringify(step.params, null, 2)}
              onChange={(e) => {
                try {
                  onUpdateParams(JSON.parse(e.target.value));
                } catch {}
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Individual Step Editors
function SelectColumnsEditor({ params, columns, onUpdate }: any) {
  const selectedColumns = params.columns || [];

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Select columns to include
      </label>
      <div className="space-y-2 max-h-96 overflow-y-auto border rounded-md p-3">
        {columns.map((col: any) => (
          <label key={col.name} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedColumns.includes(col.name)}
              onChange={(e) => {
                const newColumns = e.target.checked
                  ? [...selectedColumns, col.name]
                  : selectedColumns.filter((c: string) => c !== col.name);
                onUpdate({ columns: newColumns });
              }}
              className="rounded"
            />
            <span className="text-sm">{col.name}</span>
            <span className="text-xs text-gray-400">({col.type})</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FilterRowsEditor({ params, columns, onUpdate }: any) {
  const conditions = params.conditions || [];
  const logic = params.logic || 'AND';

  const addCondition = () => {
    onUpdate({
      ...params,
      conditions: [
        ...conditions,
        { field: columns[0]?.name || '', op: 'eq', value: '' }
      ]
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <label className="text-sm font-medium text-gray-700">Filter Conditions</label>
        <button
          onClick={addCondition}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          + Add Condition
        </button>
      </div>

      <div className="space-y-3">
        {conditions.map((cond: any, idx: number) => (
          <div key={idx} className="flex items-center gap-2 p-3 bg-gray-50 rounded-md">
            <select
              value={cond.field}
              onChange={(e) => {
                const newConditions = [...conditions];
                newConditions[idx].field = e.target.value;
                onUpdate({ ...params, conditions: newConditions });
              }}
              className="flex-1 px-2 py-1 border rounded text-sm"
            >
              {columns.map((col: any) => (
                <option key={col.name} value={col.name}>{col.name}</option>
              ))}
            </select>

            <select
              value={cond.op}
              onChange={(e) => {
                const newConditions = [...conditions];
                newConditions[idx].op = e.target.value;
                onUpdate({ ...params, conditions: newConditions });
              }}
              className="px-2 py-1 border rounded text-sm"
            >
              <option value="eq">=</option>
              <option value="neq">!=</option>
              <option value="gt">&gt;</option>
              <option value="gte">&gt;=</option>
              <option value="lt">&lt;</option>
              <option value="lte">&lt;=</option>
              <option value="contains">contains</option>
            </select>

            <input
              type="text"
              value={cond.value}
              onChange={(e) => {
                const newConditions = [...conditions];
                newConditions[idx].value = e.target.value;
                onUpdate({ ...params, conditions: newConditions });
              }}
              placeholder="Value"
              className="flex-1 px-2 py-1 border rounded text-sm"
            />

            <button
              onClick={() => {
                const newConditions = conditions.filter((_: any, i: number) => i !== idx);
                onUpdate({ ...params, conditions: newConditions });
              }}
              className="text-red-600 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {conditions.length > 1 && (
        <div className="mt-3">
          <label className="text-sm text-gray-700 mr-2">Combine with:</label>
          <select
            value={logic}
            onChange={(e) => onUpdate({ ...params, logic: e.target.value })}
            className="px-2 py-1 border rounded text-sm"
          >
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
        </div>
      )}
    </div>
  );
}

function LimitEditor({ params, onUpdate }: any) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Maximum number of rows
      </label>
      <input
        type="number"
        value={params.limit || 1000}
        onChange={(e) => onUpdate({ limit: parseInt(e.target.value) || 1000 })}
        min={1}
        className="w-full px-3 py-2 border rounded-md"
      />
    </div>
  );
}

function getDefaultParams(type: TransformationType): Record<string, any> {
  switch (type) {
    case 'select_columns':
      return { columns: [] };
    case 'rename_columns':
      return { mapping: {} };
    case 'filter_rows':
      return { conditions: [], logic: 'AND' };
    case 'add_column':
      return { newField: '', expression: '' };
    case 'cast_column':
      return { field: '', to: 'STRING' };
    case 'replace_value':
      return { field: '', from: '', to: '' };
    case 'sort':
      return { by: [] };
    case 'limit':
      return { limit: 1000 };
    default:
      return {};
  }
}
