/**
 * Home page with navigation to main features.
 */
'use client';

import Link from 'next/link';
import { Database, FileText, BarChart3, LayoutDashboard } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="container mx-auto px-4 py-16">
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            AppBI
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Modern open-source Business Intelligence tool for exploring and visualizing your data
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
          <Link href="/datasources">
            <div className="p-6 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow cursor-pointer border border-gray-200">
              <Database className="w-12 h-12 text-blue-600 mb-4" />
              <h2 className="text-xl font-semibold mb-2">Data Sources</h2>
              <p className="text-gray-600">
                Connect to MySQL, PostgreSQL, and BigQuery databases
              </p>
            </div>
          </Link>

          <Link href="/datasets">
            <div className="p-6 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow cursor-pointer border border-gray-200">
              <FileText className="w-12 h-12 text-green-600 mb-4" />
              <h2 className="text-xl font-semibold mb-2">Datasets</h2>
              <p className="text-gray-600">
                Create reusable SQL queries with inferred schemas
              </p>
            </div>
          </Link>

          <Link href="/charts">
            <div className="p-6 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow cursor-pointer border border-gray-200">
              <BarChart3 className="w-12 h-12 text-purple-600 mb-4" />
              <h2 className="text-xl font-semibold mb-2">Charts</h2>
              <p className="text-gray-600">
                Build interactive visualizations from your datasets
              </p>
            </div>
          </Link>

          <Link href="/dashboards">
            <div className="p-6 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow cursor-pointer border border-gray-200">
              <LayoutDashboard className="w-12 h-12 text-orange-600 mb-4" />
              <h2 className="text-xl font-semibold mb-2">Dashboards</h2>
              <p className="text-gray-600">
                Compose multiple charts into interactive dashboards
              </p>
            </div>
          </Link>
        </div>

        <div className="mt-16 text-center">
          <div className="inline-flex items-center gap-4 text-sm text-gray-500">
            <span>FastAPI Backend</span>
            <span>•</span>
            <span>Next.js Frontend</span>
            <span>•</span>
            <span>PostgreSQL Metadata</span>
          </div>
        </div>
      </div>
    </div>
  );
}
