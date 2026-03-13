'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Search, Bell, Settings, User, ChevronRight } from 'lucide-react';

export function Topbar() {
  const pathname = usePathname();

  const getBreadcrumbs = () => {
    const segments = pathname.split('/').filter(Boolean);
    const breadcrumbs: Array<{ label: string; path: string }> = [];

    segments.forEach((segment, index) => {
      const path = '/' + segments.slice(0, index + 1).join('/');
      let label = segment.charAt(0).toUpperCase() + segment.slice(1);
      
      // Replace route names with friendly labels
      if (segment === 'datasources') label = 'Data Sources';
      if (segment === 'looks') label = 'Looks';
      if (!isNaN(Number(segment))) label = `#${segment}`;
      
      breadcrumbs.push({ label, path });
    });

    return breadcrumbs;
  };

  const breadcrumbs = getBreadcrumbs();

  return (
    <div className="fixed top-0 right-0 left-64 h-16 bg-white border-b border-gray-200 z-30 flex items-center justify-between px-6">
      {/* Breadcrumbs */}
      <div className="flex items-center space-x-2 text-sm">
        {breadcrumbs.length === 0 ? (
          <span className="text-gray-900 font-medium">Home</span>
        ) : (
          breadcrumbs.map((crumb, index) => (
            <React.Fragment key={crumb.path}>
              {index > 0 && (
                <ChevronRight className="h-4 w-4 text-gray-400" />
              )}
              <span
                className={
                  index === breadcrumbs.length - 1
                    ? 'text-gray-900 font-medium'
                    : 'text-gray-600 hover:text-gray-900 cursor-pointer'
                }
              >
                {crumb.label}
              </span>
            </React.Fragment>
          ))
        )}
      </div>

      {/* Right Actions */}
      <div className="flex items-center space-x-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            className="pl-10 pr-4 py-2 w-64 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Notifications */}
        <button
          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors relative"
          title="Notifications"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
        </button>

        {/* Settings */}
        <button
          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          title="Settings"
        >
          <Settings className="h-5 w-5" />
        </button>

        {/* User Avatar */}
        <div className="flex items-center space-x-2 pl-4 border-l border-gray-200">
          <button className="flex items-center space-x-2 hover:bg-gray-50 rounded-lg px-2 py-1.5 transition-colors">
            <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center">
              <User className="h-5 w-5 text-white" />
            </div>
            <span className="text-sm font-medium text-gray-700">User</span>
          </button>
        </div>
      </div>
    </div>
  );
}
