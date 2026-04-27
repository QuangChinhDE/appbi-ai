/**
 * AppSettingsEditor — modal for app-level settings (branding + nav).
 */
'use client';

import React from 'react';
import { X } from 'lucide-react';

import type { MiniAppLayoutSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

export default function AppSettingsEditor({
  layout,
  onChange,
  onClose,
}: {
  layout: MiniAppLayoutSpec;
  onChange: (next: MiniAppLayoutSpec) => void;
  onClose: () => void;
}) {
  const branding = layout.branding || {};
  const nav = layout.mini_app_nav;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-xl bg-surface-1 shadow-xl">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-3">
          <h2 className="text-body font-emphasis text-text-primary">App settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <section>
            <h3 className="mb-2 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
              Branding
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Lbl label="Tên app">
                <input
                  value={branding.app_name || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, app_name: e.target.value },
                    })
                  }
                  className={INPUT}
                  placeholder="vd: Nhật ký sản xuất"
                />
              </Lbl>
              <Lbl label="Màu chính (hex)">
                <input
                  value={branding.primary_color || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, primary_color: e.target.value },
                    })
                  }
                  className={INPUT}
                  placeholder="#2563eb"
                />
              </Lbl>
              <Lbl label="Logo URL">
                <input
                  value={branding.logo_url || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, logo_url: e.target.value },
                    })
                  }
                  className={INPUT}
                />
              </Lbl>
              <Lbl label="Welcome text (login screen)">
                <input
                  value={branding.welcome_text || ''}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      branding: { ...branding, welcome_text: e.target.value },
                    })
                  }
                  className={INPUT}
                />
              </Lbl>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
              Navigation
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Lbl label="Layout mobile">
                <select
                  value={nav.mobile_kind}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      mini_app_nav: {
                        ...nav,
                        mobile_kind: e.target.value as 'bottom_nav' | 'drawer',
                      },
                    })
                  }
                  className={INPUT}
                >
                  <option value="bottom_nav">Bottom nav (5 tab dưới)</option>
                  <option value="drawer">Drawer (sidebar trượt)</option>
                </select>
              </Lbl>
              <Lbl label="Layout desktop">
                <select
                  value={nav.desktop_kind}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      mini_app_nav: {
                        ...nav,
                        desktop_kind: e.target.value as 'sidebar' | 'top_tabs',
                      },
                    })
                  }
                  className={INPUT}
                >
                  <option value="sidebar">Sidebar trái</option>
                  <option value="top_tabs">Top tabs</option>
                </select>
              </Lbl>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
