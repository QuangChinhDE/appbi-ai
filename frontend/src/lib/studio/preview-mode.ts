/**
 * Studio preview: the builder route rendered read-only inside an iframe at a
 * device width, so an author can look at the WHOLE report — before and after an
 * AI design, at desktop, tablet and phone — without the AI panel covering it and
 * without the authoring viewport ever changing the report's own coordinates.
 *
 * The iframe is the same route (`/dashboards/<id>?studio=preview`), so breakpoints,
 * the responsive derivation and every tile renderer are the real ones. The parent
 * sends what to show (layout overrides, created blocks, theme) by postMessage;
 * nothing is saved, and the embedded page takes no edit lock.
 */
import { useEffect, useState } from 'react';

export const STUDIO_PREVIEW_PARAM = 'studio';
export const STUDIO_PREVIEW_VALUE = 'preview';

export type StudioPreviewState = {
  /** id → layout, layered over the server layout exactly as the canvas does. */
  overrides: Record<number, Record<string, unknown>> | null;
  blocks: unknown[] | null;
  presentation: { theme: Record<string, unknown>; slicerCluster: Record<string, unknown> } | null;
  pageId: string | null;
};

export type StudioMessage =
  | { type: 'appbi-studio-ready'; frame: string }
  | { type: 'appbi-studio-state'; frame: string; state: StudioPreviewState }
  | { type: 'appbi-studio-height'; frame: string; height: number; settled: boolean };

/** True inside the preview iframe. Read after mount (no Suspense boundary). */
export function useIsStudioPreview(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(new URLSearchParams(window.location.search).get(STUDIO_PREVIEW_PARAM) === STUDIO_PREVIEW_VALUE);
    } catch {
      setOn(false);
    }
  }, []);
  return on;
}

export function studioFrameId(): string {
  try {
    return new URLSearchParams(window.location.search).get('frame') ?? '';
  } catch {
    return '';
  }
}

export function isStudioMessage(e: MessageEvent): e is MessageEvent<StudioMessage> {
  return e.origin === window.location.origin
    && !!e.data && typeof e.data === 'object'
    && typeof (e.data as any).type === 'string' && String((e.data as any).type).startsWith('appbi-studio-');
}
