'use client';

import React from 'react';
import { X } from 'lucide-react';

interface AppModalShellProps {
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClass?: string;
  panelClassName?: string;
  bodyClassName?: string;
  closeDisabled?: boolean;
  variant?: 'modal' | 'page';
}

export function AppModalShell({
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  maxWidthClass = 'max-w-2xl',
  panelClassName = '',
  bodyClassName = 'p-6',
  closeDisabled = false,
  variant = 'modal',
}: AppModalShellProps) {
  const panelClass = `flex w-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl ${maxWidthClass} ${panelClassName}`.trim();

  if (variant === 'page') {
    return (
      <div className="flex min-h-screen w-full min-w-0 flex-col bg-gray-50">
        <div className="border-b border-gray-200 bg-white px-5 py-4 lg:px-8 2xl:px-10">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              {icon && (
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                  {icon}
                </div>
              )}
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
                {description && <div className="mt-1 text-sm text-gray-500">{description}</div>}
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={closeDisabled}
              className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto bg-gray-50 ${bodyClassName}`.trim()}>{children}</div>

        {footer && (
          <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-gray-200 bg-white px-5 py-4 lg:px-8 2xl:px-10">
            {footer}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={panelClass}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
              {description && (
                <div className="mt-1 text-sm text-gray-500">
                  {description}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={closeDisabled}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className={`flex-1 overflow-y-auto ${bodyClassName}`.trim()}>
          {children}
        </div>

        {footer && (
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
