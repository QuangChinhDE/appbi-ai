'use client';

import React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  bodyClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  bodyClassName,
  contentClassName,
  footerClassName,
}: ModalProps) {
  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-6xl',
    full: 'max-w-[96rem]',
  };
  const heightClass = size === 'full' ? 'h-[94vh] max-h-[94vh]' : 'max-h-[90vh]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className={`relative mx-4 flex w-full flex-col overflow-hidden rounded-lg bg-white shadow-xl ${sizeClasses[size]} ${heightClass} ${contentClassName ?? ''}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className={`flex-1 overflow-y-auto px-6 py-4 ${bodyClassName ?? ''}`}>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className={`flex items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4 ${footerClassName ?? ''}`}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
