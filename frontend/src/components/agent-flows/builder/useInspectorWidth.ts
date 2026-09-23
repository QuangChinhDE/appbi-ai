/**
 * How wide the inspector is, and remembering it.
 *
 * Extracted from `BrainBuilder` unchanged — it is a self-contained working
 * preference with its own storage key, its own bounds and its own drag handling,
 * and none of it has anything to do with the flow being edited.
 */
import React from 'react';

/** The inspector's width, dragged by the author and remembered per browser.
 *
 *  WHY IT IS NOT JUST A CONSTANT ANY MORE.
 *
 *  400px is right for naming a step and wrong for the two jobs that need room:
 *  reading a prompt of several paragraphs, and choosing among 36 tools whose
 *  descriptions are prose. It was the fixed width that pushed the tool picker's
 *  type down to 10px in the first place — everything had to fit, so everything
 *  got smaller. Letting the panel grow is the other half of making it readable.
 *
 *  Bounded on both sides: below ~320px the two-column rows inside collapse into
 *  unreadable slivers, and past ~820px the canvas stops being a canvas. Stored in
 *  `localStorage` because it is a per-person working preference, not a property of
 *  the flow — two people editing the same flow want different widths, and neither
 *  wants to set it again tomorrow.
 */
export const INSPECTOR_MIN = 320;
export const INSPECTOR_MAX = 820;
const INSPECTOR_KEY = 'appbi.agentFlows.inspectorWidth';

export function useInspectorWidth() {
  const [width, setWidth] = React.useState(400);

  React.useEffect(() => {
    try {
      const raw = Number(window.localStorage.getItem(INSPECTOR_KEY));
      if (Number.isFinite(raw) && raw >= INSPECTOR_MIN && raw <= INSPECTOR_MAX) {
        setWidth(raw);
      }
    } catch { /* private mode: the default is a fine answer */ }
  }, []);

  const commit = React.useCallback((next: number) => {
    const clamped = Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(next)));
    setWidth(clamped);
    try { window.localStorage.setItem(INSPECTOR_KEY, String(clamped)); } catch { /* ignore */ }
  }, []);

  /** Drag from the panel's left edge. Pointer events rather than mouse, so a pen
   *  or a touch screen works, and capture so the drag survives the pointer leaving
   *  the 6px handle — which it does immediately, every time. */
  const onPointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent) => commit(startWidth + (startX - ev.clientX));
    const up = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }, [width, commit]);

  /** A drag handle nobody can reach with a keyboard is a control half the people
   *  who need a wider panel cannot use. Arrows nudge, Home/End go to the bounds. */
  const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowLeft') { e.preventDefault(); commit(width + step); }
    if (e.key === 'ArrowRight') { e.preventDefault(); commit(width - step); }
    if (e.key === 'Home') { e.preventDefault(); commit(INSPECTOR_MAX); }
    if (e.key === 'End') { e.preventDefault(); commit(INSPECTOR_MIN); }
  }, [width, commit]);

  return { width, onPointerDown, onKeyDown, reset: () => commit(400) };
}
