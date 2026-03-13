'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

type KpiCardProps = {
  value: number | string | null;
  label?: string;
  comparison?: number | null;
  format?: 'number' | 'currency' | 'percent';
};

export function KpiCard({ value, label, comparison, format = 'number' }: KpiCardProps) {
  const formatValue = (val: number | string | null) => {
    if (val === null || val === undefined) return '–';
    
    const numVal = typeof val === 'string' ? parseFloat(val) : val;
    if (isNaN(numVal)) return String(val);
    
    switch (format) {
      case 'currency':
        return new Intl.NumberFormat('vi-VN', { 
          style: 'currency', 
          currency: 'VND' 
        }).format(numVal);
      case 'percent':
        return `${numVal.toFixed(2)}%`;
      default:
        return new Intl.NumberFormat('vi-VN').format(numVal);
    }
  };

  const getComparisonColor = (val: number) => {
    if (val > 0) return 'text-green-600';
    if (val < 0) return 'text-red-600';
    return 'text-gray-600';
  };

  const getComparisonIcon = (val: number) => {
    if (val > 0) return <TrendingUp className="w-3 h-3" />;
    if (val < 0) return <TrendingDown className="w-3 h-3" />;
    return <Minus className="w-3 h-3" />;
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-6 shadow-sm hover:shadow-md transition-shadow">
      {label && (
        <div className="text-sm font-medium text-gray-500 mb-2 uppercase tracking-wide">
          {label}
        </div>
      )}
      <div className="text-4xl font-bold text-gray-900 mb-2">
        {formatValue(value)}
      </div>
      {typeof comparison === 'number' && (
        <div className={`flex items-center gap-1 text-sm font-medium ${getComparisonColor(comparison)}`}>
          {getComparisonIcon(comparison)}
          <span>
            {comparison > 0 ? '+' : ''}{comparison.toFixed(1)}% vs prev
          </span>
        </div>
      )}
    </div>
  );
}
