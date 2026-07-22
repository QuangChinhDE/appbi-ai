/**
 * Workboard › Settings — the "manage the app" home (distinct from Build's
 * design surface). Owns:
 *   1. App health — the readiness audit that gates Publish, with per-issue
 *      "Fix" deep-links into the offending screen, so an author can see exactly
 *      why the app won't go Live and jump straight to fixing it.
 *   2. App identity — name / description (previously editable only at create).
 *
 * Data binding, branding, navigation and print stay in Build's "App design"
 * modal; this page deliberately does NOT duplicate them.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  Wrench,
} from 'lucide-react';

import {
  useWorkboard,
  useWorkboardReadinessAudit,
  useUpdateWorkboard,
} from '@/hooks/use-workboards';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import type { WorkboardAuditIssue } from '@/lib/api/workboards';

export default function WorkboardSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params.id);

  const { data: workboard } = useWorkboard(id);
  const update = useUpdateWorkboard();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (workboard) {
      setName(workboard.name || '');
      setDescription(workboard.description || '');
    }
    // Re-seed only when the board identity changes (id), not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workboard?.id]);

  if (!workboard) return null;

  const canEdit = getResourcePermissions(workboard.user_permission ?? undefined).canEdit;
  const dirty =
    name.trim() !== (workboard.name || '') ||
    (description.trim() || '') !== (workboard.description || '');

  const save = async () => {
    if (!name.trim()) {
      toast.error('Tên app không được để trống.');
      return;
    }
    try {
      await update.mutateAsync({
        id,
        data: { name: name.trim(), description: description.trim() },
      });
      toast.success('Đã lưu cài đặt app.');
    } catch {
      toast.error('Không lưu được cài đặt.');
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <AppHealthPanel workboardId={id} />

        <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5">
          <h2 className="text-sm font-semibold text-text-primary">Thông tin app</h2>
          <p className="mt-0.5 text-xs text-text-tertiary">
            Tên và mô tả hiển thị cho người dùng. Thiết kế giao diện, dữ liệu và điều hướng nằm ở
            tab <strong>Thiết kế</strong>.
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Tên app</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canEdit}
                placeholder="VD: Chấm công cao su"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Mô tả</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!canEdit}
                rows={3}
                placeholder="Mô tả ngắn gọn app này dùng để làm gì (không bắt buộc)."
              />
            </div>
          </div>

          {canEdit && (
            <div className="mt-4 flex items-center justify-end gap-2">
              {dirty && <span className="text-xs text-text-tertiary">Có thay đổi chưa lưu</span>}
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                loading={update.isPending}
                disabled={!dirty}
              >
                Lưu thay đổi
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function AppHealthPanel({ workboardId }: { workboardId: number }) {
  const router = useRouter();
  const { data: audit, isLoading, isFetching, refetch } = useWorkboardReadinessAudit(workboardId);

  const errors = (audit?.issues || []).filter((i) => i.severity === 'error');
  const warnings = (audit?.issues || []).filter((i) => i.severity === 'warning');
  const healthy = audit?.ok && errors.length === 0;

  const goFix = (issue: WorkboardAuditIssue) => {
    // Deep-link into Build focused on the offending screen when we know it.
    const target = issue.screen_id
      ? `/workboards/${workboardId}?screen=${encodeURIComponent(issue.screen_id)}`
      : `/workboards/${workboardId}`;
    router.push(target);
  };

  return (
    <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Tình trạng app</h2>
          <p className="mt-0.5 text-xs text-text-tertiary">
            Kiểm tra sẵn sàng — đây chính là điều kiện để <strong>Xuất bản</strong>. Còn lỗi chặn
            thì chưa lên Live được.
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void refetch()}
          leadingIcon={<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />}
        >
          Làm mới
        </Button>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" /> Đang kiểm tra…
          </div>
        ) : healthy ? (
          <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2.5 text-sm text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Sẵn sàng xuất bản</p>
              {warnings.length > 0 && (
                <p className="text-xs text-success/80">
                  Không có lỗi chặn. Có {warnings.length} cảnh báo (không bắt buộc sửa).
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="font-medium">
              Chưa thể xuất bản — còn {errors.length} lỗi chặn
              {warnings.length > 0 ? ` · ${warnings.length} cảnh báo` : ''}. Sửa hết lỗi rồi xuất
              bản lại.
            </p>
          </div>
        )}

        {(errors.length > 0 || warnings.length > 0) && (
          <ul className="mt-3 space-y-2">
            {[...errors, ...warnings].map((issue, idx) => (
              <li
                key={`${issue.code}-${issue.screen_id ?? idx}`}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs ${
                  issue.severity === 'error'
                    ? 'border-danger/25 bg-danger/[0.03]'
                    : 'border-warning/30 bg-warning/[0.04]'
                }`}
              >
                {issue.severity === 'error' ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                ) : (
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text-primary">
                    {issue.screen_title || issue.screen_id || 'App'}
                  </p>
                  <p className="text-text-secondary">{issue.detail}</p>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => goFix(issue)}
                  leadingIcon={<Wrench className="h-3.5 w-3.5" />}
                >
                  Sửa
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
