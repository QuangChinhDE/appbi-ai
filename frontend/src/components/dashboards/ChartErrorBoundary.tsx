'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface State {
  hasError: boolean;
  message?: string;
}

/**
 * Catches rendering errors in a single ChartTile so one broken chart
 * cannot crash the entire dashboard page.
 */
export class ChartErrorBoundary extends React.Component<
  React.PropsWithChildren<{ chartId: number }>,
  State
> {
  constructor(props: React.PropsWithChildren<{ chartId: number }>) {
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
      return (
        <div className="h-full bg-white rounded-lg border border-red-200 flex flex-col items-center justify-center gap-2 p-4">
          <AlertTriangle className="h-7 w-7 text-red-400" />
          <p className="text-sm font-medium text-red-600">Chart failed to render</p>
          {this.state.message && (
            <p className="text-xs text-red-400 text-center max-w-xs truncate">{this.state.message}</p>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
