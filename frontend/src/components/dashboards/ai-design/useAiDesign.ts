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

  const submit = React.useCallback(async (prompt: string) => {
    if (!snapshot || busy) return;
    setBusy(true);
    setTurns((previous) => [...previous, { role: 'user', text: prompt }]);

    try {
      const conversation = turns.slice(-6).map((turn) => ({ role: turn.role, text: turn.text }));
      const response = await dashboardApi.planPresentation(input.dashboardId, {
        prompt, snapshot, conversation,
      });

      // Scope is imposed, not read. A model that decided for itself to redesign
      // the whole report because the prompt mentioned colour is the silent
      // blast radius the scope selector exists to prevent.
      const { plan, notes: boundaryNotes } = coerceModelPlan(response?.plan, { scope });

      const built = buildPresentationMutation({
        plan,
        snapshot,
        tiles: baselineTiles,
        pageId: input.activePageId,
        currentTheme: input.currentTheme,
        gridGapPx: input.gridGapPx,
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
      const diff = diffPresentation(baselineTiles, built.mutation);
      if (isEmptyDiff(diff)) {
        setTurns((previous) => [...previous, {
          role: 'assistant',
          text: plan.rationale || t('dashboards.aiDesign.noChange'),
          diff,
        }]);
        return;
      }

      setPending({
        mutation: built.mutation,
        diff,
        previewTiles: applyMutationToTiles(baselineTiles, built.mutation),
      });
      setTurns((previous) => [...previous, {
        role: 'assistant',
        text: plan.rationale || t('dashboards.aiDesign.suggestedChanges'),
        diff,
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
    input.activePageId, input.currentTheme, input.gridGapPx, t,
  ]);

  const apply = React.useCallback(() => {
    if (!pending) return;
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
  }, [pending, input, t]);

  const discard = React.useCallback(() => {
    setPending(null);
    toast.info(t('dashboards.aiDesign.discarded'));
  }, [t]);

  return {
    turns,
    busy,
    scope,
    setScope,
    submit,
    apply,
    discard,
    pending,
    /** Tiles to render while previewing; null means render the real state. */
    previewTiles: pending?.previewTiles ?? null,
    visualCount: snapshot?.visuals.length ?? 0,
  };
}
