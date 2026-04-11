'use client';

import React, { useEffect, useState } from 'react';
import { Database, Loader2, Search } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { useDatasets } from '@/hooks/use-datasets';

interface CreateScopedChatModalProps {
  isOpen: boolean;
  creating: boolean;
  onClose: () => void;
  onCreate: (dataset: { id: number; name: string }) => void;
}

export function CreateScopedChatModal({
  isOpen,
  creating,
  onClose,
  onCreate,
}: CreateScopedChatModalProps) {
  const { data: datasets = [], isLoading, isError, refetch } = useDatasets(0, 200);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      return;
    }
    if (datasets.length > 0 && !datasets.some((dataset) => dataset.id === selectedId)) {
      setSelectedId(datasets[0].id);
    }
  }, [datasets, isOpen, selectedId]);

  if (!isOpen) return null;

  const normalizedSearch = search.trim().toLowerCase();
  const filteredDatasets = datasets.filter((dataset) => {
    const haystack = `${dataset.name} ${dataset.description ?? ''}`.toLowerCase();
    return !normalizedSearch || haystack.includes(normalizedSearch);
  });
  const selectedDataset = filteredDatasets.find((dataset) => dataset.id === selectedId)
    ?? datasets.find((dataset) => dataset.id === selectedId)
    ?? null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={creating ? () => {} : onClose}
      title="Tạo AI Chat theo Dataset"
      size="lg"
      footer={(
        <>
          <button
            onClick={onClose}
            disabled={creating}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            onClick={() => selectedDataset && onCreate({ id: selectedDataset.id, name: selectedDataset.name })}
            disabled={creating || !selectedDataset}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Tạo hội thoại
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          Mỗi conversation mới sẽ bị khóa trong đúng 1 dataset để AI chỉ tìm chart, dashboard và dữ liệu trong phạm vi đó.
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm dataset theo tên hoặc mô tả"
            className="w-full rounded-xl border border-gray-200 py-2.5 pl-10 pr-3 text-sm text-gray-900 outline-none transition-colors focus:border-blue-400"
          />
        </div>

        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Đang tải danh sách dataset...
            </div>
          )}

          {!isLoading && isError && (
            <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700">
              <p>Không tải được danh sách dataset.</p>
              <button
                onClick={() => refetch()}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-red-100"
              >
                Thử lại
              </button>
            </div>
          )}

          {!isLoading && !isError && filteredDatasets.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
              Không tìm thấy dataset phù hợp.
            </div>
          )}

          {!isLoading && !isError && filteredDatasets.map((dataset) => {
            const selected = dataset.id === selectedId;
            return (
              <button
                key={dataset.id}
                onClick={() => setSelectedId(dataset.id)}
                className={[
                  'w-full rounded-xl border px-4 py-3 text-left transition-all',
                  selected
                    ? 'border-blue-400 bg-blue-50 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/40',
                ].join(' ')}
              >
                <div className="flex items-start gap-3">
                  <div className={[
                    'mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg',
                    selected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500',
                  ].join(' ')}>
                    <Database className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-gray-900">{dataset.name}</p>
                      <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                        #{dataset.id}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-gray-600">
                      {dataset.description?.trim() || 'Chưa có mô tả dataset.'}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
