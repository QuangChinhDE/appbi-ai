'use client';

import React from 'react';
import { AlertTriangle, Loader2, RotateCcw, X, ChevronDown } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';

interface State {
  hasError: boolean;
  message?: string;
  detailsOpen: boolean;
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
    this.state = { hasError: false, detailsOpen: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message, detailsOpen: false };
  }

  componentDidCatch(error: Error) {
    console.error(`[ChartErrorBoundary] chart ${this.props.chartId} crashed:`, error);
  }

  private retry = () => {
    this.setState({ hasError: false, message: undefined, detailsOpen: false });
  };

  render() {
    if (this.state.hasError) {
      const canRemove = this.props.onRemove && this.props.dashboardChartId !== undefined;
      return (
        <div className="bi-fade-in relative h-full rounded-xl border border-danger/30 bg-surface-1 p-4 shadow-linear-sm">
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

          <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
              <AlertTriangle className="h-5 w-5 text-danger" />
            </div>
            <div className="text-center">
              <p className="text-[13px] font-semibold text-danger">Không hiển thị được chart</p>
              <p className="mt-0.5 text-tiny text-text-tertiary">
                Lỗi runtime khiến tile này không render được.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={this.retry}
                className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1 text-tiny font-[510] text-text-secondary transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
              >
                <RotateCcw className="h-3 w-3" />
                Thử lại
              </button>
              {this.state.message && (
                <button
                  type="button"
                  onClick={() => this.setState((s) => ({ detailsOpen: !s.detailsOpen }))}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-tiny font-[510] text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-secondary"
                >
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${this.state.detailsOpen ? 'rotate-180' : ''}`}
                  />
                  Chi tiết
                </button>
              )}
            </div>

            {this.state.detailsOpen && this.state.message && (
              <pre className="bi-fade-in max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-2 px-2 py-1.5 text-left text-[10px] text-text-quaternary">
                {this.state.message}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
