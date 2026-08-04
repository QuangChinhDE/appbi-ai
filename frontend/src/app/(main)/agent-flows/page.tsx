/**
 * Agent Flows — reserved, not built.
 *
 * The AI Flow module that used to live here was deleted to be rebuilt from
 * scratch. This page exists so the destination is real: the nav entry, the route
 * and the permission key are in place, and whoever builds the module fills this in
 * rather than re-deciding where it goes.
 *
 * It says plainly that nothing is here. A placeholder that pretends to be loading,
 * or an empty screen with no explanation, is how somebody spends ten minutes
 * looking for a feature that does not exist.
 */
'use client';

import { Workflow } from 'lucide-react';

export default function AgentFlowsPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <Workflow className="mb-3 h-8 w-8 text-text-quaternary" />
      <h1 className="text-small font-strong text-text-primary">Agent Flows</h1>
      <p className="mt-1.5 max-w-md text-tiny leading-6 text-text-tertiary">
        Nơi sẽ định nghĩa cách các AI Agent phối hợp trả lời trên báo cáo. Module
        đang được dựng lại từ đầu, chưa có gì để cấu hình.
      </p>
    </div>
  );
}
