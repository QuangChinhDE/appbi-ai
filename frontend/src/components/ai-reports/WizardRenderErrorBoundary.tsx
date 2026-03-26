'use client';

import React from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';

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
      <div className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-rose-50 p-2 text-rose-700">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-gray-900">
              {isVietnamese ? 'Wizard AI Reports gặp lỗi render' : 'AI Reports wizard render error'}
            </h3>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              {isVietnamese
                ? 'Một lỗi giao diện đã xảy ra trong lúc render wizard. Mình đang chặn lỗi này ở phạm vi module để không làm sập toàn bộ ứng dụng.'
                : 'A UI error occurred while rendering the wizard. This is being contained to the module so it does not crash the whole app.'}
            </p>
            <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <p className="font-medium">{error.message || 'Unknown render error'}</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                <RefreshCcw className="h-4 w-4" />
                {isVietnamese ? 'Thử render lại' : 'Try rendering again'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
