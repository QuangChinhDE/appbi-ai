'use client';

import React from 'react';
import { toast } from 'sonner';
import { dashboardApi } from '@/lib/api/dashboards';
import { useI18n } from '@/providers/LanguageProvider';
import type { Dashboard, DashboardChart, DashboardThemeConfig } from '@/types/api';
import {
  buildPresentationMutation,
  applyMutationToTiles,
  toLocalLayoutOverrides,
  tilesWithLocalEdits,
} from '@/lib/dashboard-presentation/executor';
import { buildPresentationSnapshot, tilesOnPage } from '@/lib/dashboard-presentation/snapshot';
import { coerceModelPlan } from '@/lib/dashboard-presentation/validator';
import { diffPresentation, isEmptyDiff } from '@/lib/dashboard-presentation/diff';
import type { PresentationDiff } from '@/lib/dashboard-presentation/diff';
import type { PresentationMutation, PresentationScope } from '@/lib/dashboard-presentation/types';
import type { AiDesignTurn } from './AiDesignPanel';

/**
 * The conversation, and the one place a design becomes a change.
 *
 * The sequencing here is the feature's whole safety story, so it is worth
 * stating in order: the baseline is the tiles the user is LOOKING at (server
 * state with unsaved drags merged in), the snapshot is built from those, the
 * model answers with a plan, the plan is coerced at the boundary, validated,
 * compiled, and only then previewed. Apply writes into `localLayoutOverrides`
 * — the same buffer a mouse drag fills — so Save Draft and Publish need to know
 * nothing about any of this.
 *
 * Iteration works by re-reading the CURRENT state each turn rather than
 * replaying plans. "Now make the main chart bigger" is planned against the
 * preview on screen, which is why the second request refines the first instead
 * of starting over (§12).
 */

export interface UseAiDesignInput {
  dashboardId: number;
  dashboard: Dashboard | null | undefined;
  activePageId: string;
  activePageName: string;
  pageCount: number;
  localLayoutOverrides: Record<number, Record<string, any>>;
  slicers: Array<Record<string, any>>;
  slicerDock: string;
  currentTheme: DashboardThemeConfig | null | undefined;
  slicerClusterLayout: any;
  /** Theme grid gap, so compiled tiles are sized in the density the report
   *  actually renders at. */
  gridGapPx?: number;
  /** The DashboardChart id the user clicked to restyle on its own; null for a
   *  whole-page/report redesign. Set → the redesign scopes to just this tile. */
  focusedChartId?: number | null;
  /** Commit a design. One call, one undo entry. */
  onCommit: (input: {
    layoutOverrides: Record<number, Record<string, any>>;
    themePatch: Record<string, any> | null;
    slicerClusterPatch: Record<string, any> | null;
  }) => void;
}

interface PendingDesign {
  mutation: PresentationMutation;
  diff: PresentationDiff;
  previewTiles: DashboardChart[];
  /** The page and scope this preview was compiled for. A preview is geometry
   *  for one page; rendered over another it paints the wrong tiles, and its
   *  theme patch was decided by the scope in force when it was built. Both are
   *  recorded so a page switch or a scope flip drops it instead of applying it
   *  blind (§18, §24). */
  pageId: string;
  scope: PresentationScope;
}

export function useAiDesign(input: UseAiDesignInput) {
  const { t } = useI18n();
  const [turns, setTurns] = React.useState<AiDesignTurn[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [scope, setScope] = React.useState<PresentationScope>('page');
  const [pending, setPending] = React.useState<PendingDesign | null>(null);

  /** The tiles as the user sees them right now — the baseline §24 insists on.
   *  While a design is previewed, THAT is what the user sees, so a follow-up
   *  request plans against the preview and not the state before it. */
  const baselineTiles = React.useMemo(() => {
    const onPage = tilesOnPage(input.dashboard, input.activePageId);
    const withLocal = tilesWithLocalEdits(input.dashboard, input.localLayoutOverrides, onPage);
    if (!pending) return withLocal;
    return applyMutationToTiles(withLocal, pending.mutation);
  }, [input.dashboard, input.activePageId, input.localLayoutOverrides, pending]);

  const snapshot = React.useMemo(() => {
    if (!input.dashboard) return null;
    return buildPresentationSnapshot({
      dashboard: input.dashboard,
      tiles: baselineTiles,
      pageId: input.activePageId,
      pageName: input.activePageName,
      pageCount: input.pageCount,
      slicers: input.slicers,
      slicerDock: input.slicerDock,
    });
  }, [
    input.dashboard, baselineTiles, input.activePageId, input.activePageName,
    input.pageCount, input.slicers, input.slicerDock,
  ]);

  // A preview outlives neither the page it was drawn for nor the scope it was
  // compiled under. Switching either while one is on screen would leave an
  // overlay describing tiles the user is no longer looking at, so it is dropped
  // the moment they diverge — the user re-runs against what they can now see.
  React.useEffect(() => {
    setPending((current) =>
      current && (current.pageId !== input.activePageId || current.scope !== scope) ? null : current,
    );
  }, [input.activePageId, scope]);

  const submit = React.useCallback(async (prompt: string, images?: string[], scopeOverride?: PresentationScope) => {
    if (!snapshot || busy) return;
    // A one-click "apply to the whole report" re-runs the last prompt with the
    // scope forced to report; the state setter has not settled yet, so the
    // override travels as an argument rather than being read from `scope`.
    const effScope = scopeOverride ?? scope;
    const refs = (images ?? []).filter((img) => typeof img === 'string' && img.length > 0);
    setBusy(true);
    setTurns((previous) => [...previous, { role: 'user', text: prompt, images: refs.length ? refs : undefined }]);

    try {
      // Only the intent of earlier turns travels, never their images — a
      // reference belongs to the turn that attached it, and re-sending it would
      // make "now make it denser" silently re-apply the old look (§12).
      const conversation = turns.slice(-6).map((turn) => ({ role: turn.role, text: turn.text }));
      const response = await dashboardApi.planPresentation(input.dashboardId, {
        prompt, snapshot, conversation, images: refs.length ? refs : undefined,
        focusedChartId: input.focusedChartId ?? null,
      });

      // Scope is imposed, not read. A model that decided for itself to redesign
      // the whole report because the prompt mentioned colour is the silent
      // blast radius the scope selector exists to prevent.
      const { plan, notes: boundaryNotes } = coerceModelPlan(response?.plan, { scope: effScope });
      // The user asked for a colour/theme change but the scope in force is a
      // single page, where theme is left alone. Flag it so the turn can offer a
      // one-click switch to the whole report instead of appearing to do nothing.
      const themeDeferred = effScope === 'page'
        && !!plan.themeIntent && Object.keys(plan.themeIntent).length > 0;

      const built = buildPresentationMutation({
        plan,
        snapshot,
        tiles: baselineTiles,
        pageId: input.activePageId,
        currentTheme: input.currentTheme,
        gridGapPx: input.gridGapPx,
        focusedChartId: input.focusedChartId ?? null,
      });

      if (!built.ok) {
        const violations = [
          ...built.planValidation.violations,
          ...built.mutationValidation.violations,
        ].filter((violation) => violation.severity !== 'geometry');
        setTurns((previous) => [...previous, {
          role: 'assistant',
          text: `${t('dashboards.aiDesign.rejected')} ${t('dashboards.aiDesign.rejectedDetail')}`,
          violations: violations.length > 0 ? violations : built.planValidation.violations,
        }]);
        return;
      }

      // Approximations made at the transport boundary belong in the same list
      // the compiler's own notes go into — the user should see one honest
      // account of what was changed and what was interpreted.
      built.mutation.notes = [...boundaryNotes, ...built.mutation.notes];
      // When the turn will carry the actionable "apply to the whole report"
      // affordance, drop the compiler's prose note that says the same thing — one
      // clear control beats a note and a button repeating each other.
      if (themeDeferred) {
        built.mutation.notes = built.mutation.notes.filter((n) => !/Entire report/i.test(n));
      }
      const diff = diffPresentation(baselineTiles, built.mutation);
      if (isEmptyDiff(diff)) {
        setTurns((previous) => [...previous, {
          role: 'assistant',
          text: plan.rationale || t('dashboards.aiDesign.noChange'),
          diff,
          themeDeferred,
        }]);
        return;
      }

      setPending({
        mutation: built.mutation,
        diff,
        previewTiles: applyMutationToTiles(baselineTiles, built.mutation),
        pageId: input.activePageId,
        scope: effScope,
      });
      setTurns((previous) => [...previous, {
        role: 'assistant',
        text: plan.rationale || t('dashboards.aiDesign.suggestedChanges'),
        diff,
        themeDeferred,
      }]);
    } catch (error: any) {
      const status = error?.response?.status;
      // 503 means no model answered — that is an availability problem and
      // saying "the design could not be generated" would send someone looking
      // for a mistake in their prompt.
      const message = status === 503
        ? (error?.response?.data?.detail || t('dashboards.aiDesign.unavailable'))
        : t('dashboards.aiDesign.failed');
      setTurns((previous) => [...previous, { role: 'assistant', text: message }]);
    } finally {
      setBusy(false);
    }
  }, [
    snapshot, busy, turns, scope, baselineTiles, input.dashboardId,
    input.activePageId, input.currentTheme, input.gridGapPx, input.focusedChartId, t,
  ]);

  const apply = React.useCallback(() => {
    if (!pending) return;
    // Belt to the effect's braces: never commit a preview built for a different
    // page or scope than the one in force now. The effect already clears it on
    // divergence, but Apply is the irreversible step, so it checks again.
    if (pending.pageId !== input.activePageId || pending.scope !== scope) {
      setPending(null);
      toast.info(t('dashboards.aiDesign.discarded'));
      return;
    }
    input.onCommit({
      layoutOverrides: toLocalLayoutOverrides(pending.mutation, input.localLayoutOverrides),
      themePatch: Object.keys(pending.mutation.themePatch ?? {}).length > 0
        ? (pending.mutation.themePatch as Record<string, any>)
        : null,
      slicerClusterPatch: Object.keys(pending.mutation.slicerClusterPatch ?? {}).length > 0
        ? (pending.mutation.slicerClusterPatch as Record<string, any>)
        : null,
    });
    setPending(null);
    toast.success(t('dashboards.aiDesign.applied'));
  }, [pending, input, scope, t]);

  const discard = React.useCallback(() => {
    setPending(null);
    toast.info(t('dashboards.aiDesign.discarded'));
  }, [t]);

  // Re-run the most recent request against the whole report — the one-click fix
  // for a theme/colour change that page scope deferred. Flips the scope (so the
  // selector and future turns follow) and forces it on this run via the arg.
  const retryEntireReport = React.useCallback(() => {
    const lastUser = [...turns].reverse().find((turn) => turn.role === 'user');
    if (!lastUser?.text) return;
    setScope('report');
    void submit(lastUser.text, undefined, 'report');
  }, [turns, submit]);

  return {
    turns,
    busy,
    scope,
    setScope,
    submit,
    retryEntireReport,
    apply,
    discard,
    pending,
    /** Tiles to render while previewing; null means render the real state. */
    previewTiles: pending?.previewTiles ?? null,
    visualCount: snapshot?.visuals.length ?? 0,
  };
}
