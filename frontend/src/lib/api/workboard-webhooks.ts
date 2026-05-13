/**
 * Admin client for workboard webhook configs + sync run history.
 *
 * Endpoints are mounted under ``/workboards/{id}/webhooks`` and
 * ``/workboards/{id}/sync-runs`` on the authenticated API.
 */
import apiClient from '@/lib/api-client';

export type WebhookHeader = { key: string; value: string };

export type WebhookConfig = {
  id: string;
  name: string;
  url: string;
  screen_id?: string | null;
  headers: WebhookHeader[];
  batch_size: number;
  delay_between_batches_ms: number;
  timeout_ms: number;
  stop_on_error: boolean;
  is_active: boolean;
  description?: string | null;
};

export type WebhookCreateInput = Omit<WebhookConfig, 'id' | 'screen_id'> & {
  screen_id: string;
};
export type WebhookUpdateInput = Partial<WebhookCreateInput>;

export type SyncRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'partial'
  | 'cancelled';

export type SyncRunRow = {
  run_id: string;
  status: SyncRunStatus;
  workboard_id: number;
  screen_id: string;
  block_index: number;
  trigger_id: string;
  webhook_id: string;
  webhook_name?: string | null;
  total_rows: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  last_response_status?: number | null;
  last_error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  created_at: string;
};

export type SyncRunDetail = SyncRunRow & {
  webhook_url?: string | null;
  response_excerpt?: Record<string, unknown> | null;
};

export const workboardWebhookApi = {
  async list(
    workboardId: number,
    params: { screen_id?: string } = {},
  ): Promise<WebhookConfig[]> {
    const r = await apiClient.get(`/workboards/${workboardId}/webhooks`, { params });
    return r.data;
  },
  async create(workboardId: number, input: WebhookCreateInput): Promise<WebhookConfig> {
    const r = await apiClient.post(`/workboards/${workboardId}/webhooks`, input);
    return r.data;
  },
  async update(
    workboardId: number,
    webhookId: string,
    input: WebhookUpdateInput,
  ): Promise<WebhookConfig> {
    const r = await apiClient.patch(
      `/workboards/${workboardId}/webhooks/${webhookId}`,
      input,
    );
    return r.data;
  },
  async remove(workboardId: number, webhookId: string): Promise<void> {
    await apiClient.delete(`/workboards/${workboardId}/webhooks/${webhookId}`);
  },
  async test(
    workboardId: number,
    webhookId: string,
    sampleRows = 3,
    sampleColumns: string[] = ['col_a', 'col_b'],
  ): Promise<{
    ok: boolean;
    status: number | null;
    duration_ms: number;
    error?: string;
    response?: Record<string, unknown>;
  }> {
    const r = await apiClient.post(
      `/workboards/${workboardId}/webhooks/${webhookId}/test`,
      { sample_rows: sampleRows, sample_columns: sampleColumns },
    );
    return r.data;
  },
  async listRuns(
    workboardId: number,
    params: {
      webhook_id?: string;
      screen_id?: string;
      status?: SyncRunStatus;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<SyncRunRow[]> {
    const r = await apiClient.get(`/workboards/${workboardId}/sync-runs`, { params });
    return r.data;
  },
  async getRun(workboardId: number, runId: string): Promise<SyncRunDetail> {
    const r = await apiClient.get(`/workboards/${workboardId}/sync-runs/${runId}`);
    return r.data;
  },
  async cancelRun(workboardId: number, runId: string): Promise<SyncRunRow> {
    const r = await apiClient.post(
      `/workboards/${workboardId}/sync-runs/${runId}/cancel`,
    );
    return r.data;
  },
};
