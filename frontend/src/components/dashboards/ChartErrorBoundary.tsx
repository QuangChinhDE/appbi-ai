'use client';

import React from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

interface State {
  hasError: boolean;
  message?: string;
}

/**
 * Catches rendering errors in a single ChartTile so one broken chart
 * cannot crash the entire dashboard page.
 */
export class ChartErrorBoundary extends React.Component<
  React.PropsWithChildren<{
    chartId: number;
    dashboardChartId?: number;
    onRemove?: (dashboardChartId: number) => void;
    isRemoving?: boolean;
  }>,
  State
> {
  constructor(props: React.PropsWithChildren<{
    chartId: number;
    dashboardChartId?: number;
    onRemove?: (dashboardChartId: number) => void;
    isRemoving?: boolean;
  }>) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message };
  }

  componentDidCatch(error: Error) {
    console.error(`[ChartErrorBoundary] chart ${this.props.chartId} crashed:`, error);
  }

  render() {
    if (this.state.hasError) {
      const canRemove = this.props.onRemove && this.props.dashboardChartId !== undefined;
      return (
        <div className="relative h-full rounded-lg border border-red-200 bg-white p-4">
          {canRemove && (
            <button
              type="button"
              onClick={() => this.props.onRemove?.(this.props.dashboardChartId as number)}
              disabled={this.props.isRemoving}
              className="absolute right-2 top-2 rounded-md border border-red-200 bg-white p-1.5 text-red-600 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Remove chart"
            >
              {this.props.isRemoving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="h-4 w-4" />
              )}
            </button>
          )}

          <div className="flex h-full flex-col items-center justify-center gap-2">
          <AlertTriangle className="h-7 w-7 text-red-400" />
          <p className="text-sm font-medium text-red-600">Chart failed to render</p>
          {this.state.message && (
            <p className="text-xs text-red-400 text-center max-w-xs truncate">{this.state.message}</p>
          )}
          {canRemove && (
            <p className="text-xs text-gray-500 text-center max-w-xs">
              You can remove this broken tile directly from the dashboard.
            </p>
          )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
