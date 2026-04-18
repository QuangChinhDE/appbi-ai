'use client';

import React from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';

import { Button } from '@/components/ui/Button';

type Props = {
  children: React.ReactNode;
  isVietnamese: boolean;
};

type State = {
  error: Error | null;
};

export class WizardRenderErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('AI Report wizard render error:', error, errorInfo);
  }

  handleReset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    const { children, isVietnamese } = this.props;

    if (!error) {
      return children;
    }

    return (
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-6 shadow-linear-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-danger/10 p-2 text-danger">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-small font-strong text-text-primary">
              {isVietnamese ? 'Wizard AI Reports gặp lỗi render' : 'AI Reports wizard render error'}
            </h3>
            <p className="mt-2 text-caption leading-6 text-text-secondary">
              {isVietnamese
                ? 'Một lỗi giao diện đã xảy ra trong lúc render wizard. Mình đang chặn lỗi này ở phạm vi module để không làm sập toàn bộ ứng dụng.'
                : 'A UI error occurred while rendering the wizard. This is being contained to the module so it does not crash the whole app.'}
            </p>
            <div className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-caption text-danger">
              <p className="font-emphasis">{error.message || 'Unknown render error'}</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={this.handleReset}
                leadingIcon={<RefreshCcw className="h-3.5 w-3.5" />}
              >
                {isVietnamese ? 'Thử render lại' : 'Try rendering again'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
