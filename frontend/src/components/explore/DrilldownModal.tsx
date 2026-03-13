/**
 * Drilldown Modal - Shows raw data for a specific row
 */
import React from 'react';
import { X } from 'lucide-react';

interface DrilldownModalProps {
  row: any;
  rawData: any[];
  rowDimensions: string[];
  onClose: () => void;
}

export function DrilldownModal({ row, rawData, rowDimensions, onClose }: DrilldownModalProps) {
  // Filter raw data to match the clicked row's dimension values
  const matchingRows = rawData.filter(rawRow => {
    return rowDimensions.every(dim => rawRow[dim] === row[dim]);
  });
  
  // Get all column names from first matching row
  const columns = matchingRows.length > 0 ? Object.keys(matchingRows[0]) : [];
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl max-h-[90vh] w-full mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Row Details - Raw Data</h2>
            <div className="flex gap-2 mt-1">
              {rowDimensions.map(dim => (
                <span key={dim} className="text-sm text-gray-600">
                  <span className="font-medium">{dim}:</span> {row[dim]}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {matchingRows.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              No raw data found for this row
            </div>
          ) : (
            <>
              <div className="mb-2 text-sm text-gray-600">
                Showing {matchingRows.length} raw {matchingRows.length === 1 ? 'row' : 'rows'}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 border border-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r border-gray-200">
                        #
                      </th>
                      {columns.map((col) => (
                        <th
                          key={col}
                          className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r border-gray-200"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {matchingRows.map((rawRow, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-sm text-gray-500 border-r border-gray-200">
                          {idx + 1}
                        </td>
                        {columns.map((col) => (
                          <td
                            key={col}
                            className="px-3 py-2 text-sm text-gray-900 border-r border-gray-200"
                          >
                            {rawRow[col] != null ? String(rawRow[col]) : '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        
        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
