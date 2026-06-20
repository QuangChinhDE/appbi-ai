'use client';

import React from 'react';
import { AlertTriangle, Loader2, RotateCcw, X, ChevronDown } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';

type Translate = (key: string, values?: Record<string, string | number>) => string;

interface State {
  hasError: boolean;
  message?: string;
  detailsOpen: boolean;
}

/**
 * Catches rendering errors in a single ChartTile so one broken chart
 * cannot crash the entire dashboard page.
 */
type ChartErrorBoundaryProps = React.PropsWithChildren<{
  chartId: number;
  dashboardChartId?: number;
  onRemove?: (dashboardChartId: number) => void;
  isRemoving?: boolean;
  /**
   * When this value changes, a previously-caught error is auto-cleared so the
   * boundary re-renders its children. Used by the Explore preview: a chart can
   * throw while rendering a STALE result from a different chart type (e.g.
   * switching a ran Matrix → Grouped Bar before the new query returns); once
   * the fresh result arrives the boundary should recover on its own instead of
   * stranding a "couldn't render" fallback until the user clicks Retry.
   * Dashboards don't pass it, so their behaviour is unchanged.
   */
  resetKey?: unknown;
  t: Translate;
}>;

class ChartErrorBoundaryInner extends React.Component<ChartErrorBoundaryProps, State> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, detailsOpen: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message, detailsOpen: false };
  }

  componentDidCatch(error: Error) {
    console.error(`[ChartErrorBoundary] chart ${this.props.chartId} crashed:`, error);
  }

  componentDidUpdate(prevProps: ChartErrorBoundaryProps) {
    // Auto-recover when the inputs that produced the error have changed.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: undefined, detailsOpen: false });
    }
  }

  private retry = () => {
    this.setState({ hasError: false, message: undefined, detailsOpen: false });
  };

  render() {
    if (this.state.hasError) {
      const { t } = this.props;
      const canRemove = this.props.onRemove && this.props.dashboardChartId !== undefined;
      return (
        <div className="bi-fade-in relative h-full rounded-xl border border-danger/30 bg-surface-1 p-4 shadow-linear-sm">
          {canRemove && (
            <IconButton
              aria-label={t('dashboards.chartErrorBoundary.removeChart')}
              variant="secondary"
              size="xs"
              type="button"
              onClick={() => this.props.onRemove?.(this.props.dashboardChartId as number)}
              disabled={this.props.isRemoving}
              className="absolute right-2 top-2 border-danger/30 text-danger hover:bg-danger/10"
              title={t('dashboards.chartErrorBoundary.removeChart')}
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
              <p className="text-[13px] font-semibold text-danger">
                {t('dashboards.chartErrorBoundary.title')}
              </p>
              <p className="mt-0.5 text-tiny text-text-tertiary">
                {t('dashboards.chartErrorBoundary.subtitle')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={this.retry}
                className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1 text-tiny font-[510] text-text-secondary transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
              >
                <RotateCcw className="h-3 w-3" />
                {t('dashboards.chartErrorBoundary.retry')}
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
                  {t('dashboards.chartErrorBoundary.details')}
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

export function ChartErrorBoundary(props: Omit<ChartErrorBoundaryProps, 't'>) {
  const { t } = useI18n();
  return <ChartErrorBoundaryInner {...props} t={t} />;
}
