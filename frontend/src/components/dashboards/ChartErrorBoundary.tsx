'use client';

import React from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';

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
        <div className="relative h-full rounded-xl border border-danger/30 bg-surface-1 p-4 shadow-linear-sm">
          {canRemove && (
            <IconButton
              aria-label="Remove chart"
              variant="secondary"
              size="xs"
              type="button"
              onClick={() => this.props.onRemove?.(this.props.dashboardChartId as number)}
              disabled={this.props.isRemoving}
              className="absolute right-2 top-2 border-danger/30 text-danger hover:bg-danger/10"
              title="Remove chart"
            >
              {this.props.isRemoving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </IconButton>
          )}

          <div className="flex h-full flex-col items-center justify-center gap-2">
            <AlertTriangle className="h-6 w-6 text-danger/70" />
            <p className="text-caption font-strong text-danger">Chart failed to render</p>
            {this.state.message && (
              <p className="max-w-xs truncate text-center text-tiny text-text-quaternary">
                {this.state.message}
              </p>
            )}
            {canRemove && (
              <p className="max-w-xs text-center text-tiny text-text-tertiary">
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
