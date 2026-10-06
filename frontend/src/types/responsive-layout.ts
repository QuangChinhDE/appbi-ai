/**
 * Authored device layouts — the stored shapes (docs/responsive-dashboard-layouts.md).
 * The resolver that draws them is lib/responsive-layout/resolve.ts.
 */

/** The breakpoints an author can customise (Desktop is never stored here). */
export type DeviceBreakpoint = 'md' | 'xs';

export interface GridCell { x: number; y: number; w: number; h: number }

export interface CustomProfile {
  mode: 'custom';
  cols: number;
  rev?: number;
  generatorVersion: number;
  baseFingerprint: string;
  source: 'auto-freeze' | 'regenerate' | string;
  updatedAt?: string;
  updatedBy?: string;
  items: Record<string, GridCell>;
}

/** A draft entry: a CUSTOM layout, or the marker that resets the page to AUTO. */
export type ProfileDraft = CustomProfile | { mode: 'auto' };
export type PageProfiles = Partial<Record<DeviceBreakpoint, CustomProfile | null>>;

export interface ResponsiveLayoutsDoc {
  version: number;
  pages: Record<string, PageProfiles>;
}
