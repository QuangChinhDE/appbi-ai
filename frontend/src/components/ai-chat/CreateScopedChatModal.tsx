'use client';

import React, { useEffect, useState } from 'react';
import { Database, Loader2, Search } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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
          <Button variant="secondary" size="sm" onClick={onClose} disabled={creating}>
            Hủy
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => selectedDataset && onCreate({ id: selectedDataset.id, name: selectedDataset.name })}
            disabled={creating || !selectedDataset}
            loading={creating}
          >
            Tạo hội thoại
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-brand/20 bg-brand/10 px-4 py-3 text-sm text-brand">
          Mỗi conversation mới sẽ bị khóa trong đúng 1 dataset để AI chỉ tìm chart, dashboard và dữ liệu trong phạm vi đó.
        </div>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Tìm dataset theo tên hoặc mô tả"
          leadingIcon={<Search />}
          className="rounded-xl"
        />

        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-8 text-sm text-text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Đang tải danh sách dataset...
            </div>
          )}

          {!isLoading && isError && (
            <div className="space-y-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-4 text-sm text-danger">
              <p>Không tải được danh sách dataset.</p>
              <button
                onClick={() => refetch()}
                className="rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-danger/15"
              >
                Thử lại
              </button>
            </div>
          )}

          {!isLoading && !isError && filteredDatasets.length === 0 && (
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-8 text-center text-sm text-text-tertiary">
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
                    ? 'border-brand/40 bg-brand/10 shadow-linear-sm'
                    : 'border-[rgb(var(--border-strong))] bg-surface-1 hover:border-brand/30 hover:bg-surface-2',
                ].join(' ')}
              >
                <div className="flex items-start gap-3">
                  <div className={[
                    'mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg',
                    selected ? 'bg-brand text-text-inverse' : 'bg-surface-2 text-text-tertiary',
                  ].join(' ')}>
                    <Database className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-text-primary">{dataset.name}</p>
                      <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-tertiary">
                        #{dataset.id}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
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
