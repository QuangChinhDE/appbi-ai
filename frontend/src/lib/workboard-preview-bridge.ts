/**
 * Same-origin draft bridge between BuilderLivePreview and the public runtime.
 *
 * Only presentation data crosses this channel. Screen fields, RLS, actions and
 * row data still come from the authenticated preview-session API.
 */
export const WORKBOARD_PREVIEW_PATCH = 'appbi:workboard-preview-patch:v1';

export interface WorkboardPreviewPatch {
  type: typeof WORKBOARD_PREVIEW_PATCH;
  workboardId: number;
  screenId?: string | null;
  experience?: Record<string, unknown> | null;
  presentation?: Record<string, unknown> | null;
}

export function isWorkboardPreviewPatch(value: unknown): value is WorkboardPreviewPatch {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkboardPreviewPatch>;
  return (
    candidate.type === WORKBOARD_PREVIEW_PATCH &&
    typeof candidate.workboardId === 'number'
  );
}
