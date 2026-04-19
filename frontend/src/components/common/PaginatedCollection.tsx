'use client';

import React from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/Button';

type PageToken = number | 'ellipsis';

interface PaginationRenderProps<T> {
  pageItems: T[];
  pagination: React.ReactNode;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
}

interface PaginatedCollectionProps<T> {
  items: readonly T[];
  viewMode?: 'grid' | 'list';
  resetKey?: string;
  listPageSize?: number;
  gridPageSize?: number;
  children: (props: PaginationRenderProps<T>) => React.ReactNode;
}

function buildPageTokens(currentPage: number, totalPages: number): PageToken[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
  }

  if (currentPage >= totalPages - 3) {
    return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages];
}

function PaginationControls({
  currentPage,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  if (totalItems === 0 || totalPages <= 1) {
    return null;
  }

  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);
  const pageTokens = buildPageTokens(currentPage, totalPages);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-caption text-text-tertiary">
        Showing <span className="font-emphasis text-text-primary">{startItem}-{endItem}</span> of{' '}
        <span className="font-emphasis text-text-primary">{totalItems}</span>
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="secondary"
          size="xs"
          leadingIcon={<ChevronLeft className="h-3.5 w-3.5" />}
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
        >
          Prev
        </Button>

        {pageTokens.map((pageToken, index) => {
          if (pageToken === 'ellipsis') {
            return (
              <span
                key={`ellipsis-${index}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-text-quaternary"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </span>
            );
          }

          return (
            <Button
              key={pageToken}
              variant={pageToken === currentPage ? 'primary' : 'secondary'}
              size="xs"
              onClick={() => onPageChange(pageToken)}
            >
              {pageToken}
            </Button>
          );
        })}

        <Button
          variant="secondary"
          size="xs"
          trailingIcon={<ChevronRight className="h-3.5 w-3.5" />}
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function PaginatedCollection<T>({
  items,
  viewMode = 'list',
  resetKey,
  listPageSize = 12,
  gridPageSize = 12,
  children,
}: PaginatedCollectionProps<T>) {
  const [currentPage, setCurrentPage] = React.useState(1);

  const pageSize = viewMode === 'grid' ? gridPageSize : listPageSize;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  React.useEffect(() => {
    setCurrentPage(1);
  }, [pageSize, resetKey]);

  React.useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const pageItems = React.useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return items.slice(startIndex, startIndex + pageSize);
  }, [items, currentPage, pageSize]);

  const pagination = (
    <div className="mt-3">
      <PaginationControls
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setCurrentPage}
      />
    </div>
  );

  return <>{children({ pageItems, pagination, currentPage, totalPages, pageSize, totalItems })}</>;
}
