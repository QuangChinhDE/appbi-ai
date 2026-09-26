'use client';

import React from 'react';
import { DIRECTION_IDS, planForDirection, type DirectionId } from '@/lib/dashboard-presentation/directions';
import { toast } from 'sonner';
import { applyReviewRepairs, capturePreview, reviewNote, waitForSettledRender, type VisionReview } from '@/lib/dashboard-presentation/vision-review';
import { dashboardApi } from '@/lib/api/dashboards';
import { useI18n } from '@/providers/LanguageProvider';
import type { Dashboard, DashboardChart, DashboardThemeConfig } from '@/types/api';
import {
  buildPresentationMutation,
  applyMutationToTiles,
  composeMutations,
  toLocalLayoutOverrides,
  tilesWithLocalEdits,
  validateMutationAgainst,
} from '@/lib/dashboard-presentation/executor';
import { buildPresentationSnapshot, tilesOnPage } from '@/lib/dashboard-presentation/snapshot';
import type { FieldMetaIndex } from '@/lib/dashboard-presentation/design-context';
import { coerceModelPlan } from '@/lib/dashboard-presentation/validator';
import { inferDesignLayer } from '@/lib/dashboard-presentation/intent';
import { diffPresentation, isEmptyDiff } from '@/lib/dashboard-presentation/diff';
import type { PresentationDiff } from '@/lib/dashboard-presentation/diff';
import type { DesignLayer, PresentationMutation } from '@/lib/dashboard-presentation/types';
import { critiquePreview } from '@/lib/dashboard-presentation/critic';
import type { AiDesignTurn } from './AiDesignPanel';

/**
 * The conversation, and the one place a design becomes a change.
 *
 * The sequencing here is the feature's whole safety story, so it is worth
 * stating in order: the baseline is the tiles the user is LOOKING at (server
 * state with unsaved drags merged in), the permission is read from the user's
 * words (style unless they asked for more), the targets are what they selected,
 * the model answers with a plan, the plan is coerced and clamped at the
 * boundary, validated, built, and only then previewed. Apply writes into
 * `localLayoutOverrides` — the same buffer a mouse drag fills — so Save Draft
 * and Publish need to know nothing about any of this.
 *
 * Iteration works by re-reading the CURRENT state each turn rather than
 * replaying plans. "Now make the main chart bigger" is planned against the
 * preview on screen, which is why the second request refines the first.
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
  /** The visuals the user selected on the canvas. Empty = the whole page. */
  selectedIds?: number[];
  /** Semantic labels/types for the Design Context. */
  fieldMeta?: FieldMetaIndex;
  /** The rendered preview, for the post-render quality pass. */
  getCanvasRoot?: () => HTMLElement | null;
  /** The findings the page's tiles currently support, as the reader would
   *  read them (sentence + key). Aggregates only — never rows. */
  findings?: { key: string; sentence: string }[];
  /** Words a direction puts on the page, in the user's language. */
  directionLabels?: Partial<import('@/lib/dashboard-presentation/directions').DirectionLabels>;
  /** Commit a design. One call, one undo entry. */
  onCommit: (input: {
    layoutOverrides: Record<number, Record<string, any>>;
    themePatch: Record<string, any> | null;
    slicerClusterPatch: Record<string, any> | null;
    /** Blocks the design adds; created as draft-only rows by the page. */
    createdBlocks?: import('@/lib/dashboard-presentation/types').CreatedBlock[];
  }) => void;
}

interface PendingDesign {
  /** The visual review of the rendered preview, when one ran. */
  review?: VisionReview;
  mutation: PresentationMutation;
  diff: PresentationDiff;
  previewTiles: DashboardChart[];
  /** The page and selection this preview was built for. A preview is geometry
   *  and style for exactly those tiles; rendered over another page, or applied
   *  after the selection changed, it would commit a change the user never
   *  reviewed — so either divergence drops it. */
  pageId: string;
  targetsKey: string;
  /** Monotonic id so the post-render pass can tell it is still looking at the
   *  preview it was started for. */
  seq: number;
}

const keyOf = (ids: number[] | undefined): string => [...(ids ?? [])].sort((a, b) => a - b).join(',');

export function useAiDesign(input: UseAiDesignInput) {
  const { t } = useI18n();
  const [turns, setTurns] = React.useState<AiDesignTurn[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<PendingDesign | null>(null);
  const seqRef = React.useRef(0);
  const selected = React.useMemo(() => input.selectedIds ?? [], [input.selectedIds]);
  const targetsKey = keyOf(selected);

  /** The page as it stands, unsaved drags included — what Apply writes onto. */
  const committedTiles = React.useMemo(() => {
    const onPage = tilesOnPage(input.dashboard, input.activePageId);
    return tilesWithLocalEdits(input.dashboard, input.localLayoutOverrides, onPage);
  }, [input.dashboard, input.activePageId, input.localLayoutOverrides]);

  /** The tiles as the user SEES them. While a design is previewed, that is the
   *  preview, so a follow-up request plans against it. */
  const baselineTiles = React.useMemo(
    () => (pending ? applyMutationToTiles(committedTiles, pending.mutation) : committedTiles),
    [committedTiles, pending],
  );

  /** The theme the user SEES: the page theme with an unapplied preview's theme
   *  laid over it. A follow-up turn is planned and resolved against this, so
   *  "now a bit lighter" builds on the previewed look, not the one before it. */
  const seenTheme = React.useMemo(() => {
    if (!pending || Object.keys(pending.mutation.themePatch ?? {}).length === 0) return input.currentTheme;
    return { ...(input.currentTheme ?? {}), ...pending.mutation.themePatch } as DashboardThemeConfig;
  }, [input.currentTheme, pending]);

  const baseSnapshot = React.useMemo(() => {
    if (!input.dashboard) return null;
    return buildPresentationSnapshot({
      dashboard: { ...input.dashboard, theme_config: seenTheme ?? input.dashboard.theme_config } as Dashboard,
      tiles: baselineTiles,
      pageId: input.activePageId,
      pageName: input.activePageName,
      pageCount: input.pageCount,
      slicers: input.slicers,
      slicerDock: input.slicerDock,
      fieldMeta: input.fieldMeta,
    });
  }, [
    input.dashboard, seenTheme, baselineTiles, input.activePageId, input.activePageName,
    input.pageCount, input.slicers, input.slicerDock, input.fieldMeta,
  ]);
  // What the report currently SAYS: the findings its tiles support right now.
  // The planner reads them to decide what leads; it can reference them by key
  // and never needs (or gets) a row of data.
  const findingsKey = JSON.stringify(input.findings ?? []);
  const snapshot = React.useMemo(
    () => (baseSnapshot ? { ...baseSnapshot, findings: (input.findings ?? []).slice(0, 40) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseSnapshot, findingsKey],
  );

  // A preview outlives neither the page it was drawn for nor the selection it
  // was scoped to.
  React.useEffect(() => {
    setPending((current) =>
      current && (current.pageId !== input.activePageId || current.targetsKey !== targetsKey) ? null : current,
    );
  }, [input.activePageId, targetsKey]);

  const [modelProposals, setModelProposals] = React.useState<unknown[]>([]);

  const build = React.useCallback((rawPlan: unknown, grantedLayer: DesignLayer, targets: number[]) => {
    const coerced = coerceModelPlan(rawPlan, { grantedLayer, targets, knownTileIds: baselineTiles.map((t) => t.id) });
    // Content proposals travel beside the design, never inside it: they wait
    // for a person's Accept.
    const rawProposals = (rawPlan as any)?.proposals;
    if (Array.isArray(rawProposals) && rawProposals.length) setModelProposals(rawProposals);
    let plan = coerced.plan;
    const boundaryNotes = coerced.notes;
    // A redesign that names one of the direction grammars and brings no blocks
    // of its own is composed by that grammar; the model's palette choices stay.
    const style = plan.direction?.style as string | undefined;
    if (plan.layer === 'redesign' && targets.length === 0 && DIRECTION_IDS.includes(style as DirectionId) && !(plan.blocks?.length)) {
      const pack = planForDirection(style as DirectionId, snapshot!, input.directionLabels);
      plan = {
        ...pack,
        themeIntent: { ...(pack.themeIntent ?? {}), ...pickPalette(plan.themeIntent) } as any,
        rationale: plan.rationale || pack.rationale,
        suggestions: plan.suggestions,
      };
    }
    const built = buildPresentationMutation({
      plan,
      snapshot: snapshot!,
      tiles: baselineTiles,
      pageId: input.activePageId,
      currentTheme: seenTheme,
      gridGapPx: input.gridGapPx,
      targets,
    });
    built.mutation.notes = [...boundaryNotes, ...built.mutation.notes];
    return { plan, built };
  }, [snapshot, baselineTiles, input.activePageId, seenTheme, input.gridGapPx, input.directionLabels]);

  const submit = React.useCallback(async (prompt: string, images?: string[]) => {
    if (!snapshot || busy) return;
    const refs = (images ?? []).filter((img) => typeof img === 'string' && img.length > 0);
    const targets = [...selected];
    const granted = inferDesignLayer(prompt, { hasSelection: targets.length > 0 }).layer;
    setBusy(true);
    setTurns((previous) => [...previous, { role: 'user', text: prompt, images: refs.length ? refs : undefined }]);

    try {
      // Only the intent of earlier turns travels, never their images.
      const conversation = turns.slice(-6).map((turn) => ({ role: turn.role, text: turn.text }));
      const response = await dashboardApi.planPresentation(input.dashboardId, {
        prompt, snapshot, conversation, images: refs.length ? refs : undefined,
        grantedLayer: granted,
        targetIds: targets,
      });

      const { plan, built } = build(response?.plan, granted, targets);

      // A follow-up on an unapplied preview composes onto it, and the composite
      // is what gets validated, previewed and — on Apply — written.
      let finalMutation = built.mutation;
      if (built.ok && pending) {
        finalMutation = composeMutations(pending.mutation, built.mutation);
        const recheck = validateMutationAgainst({
          tiles: committedTiles, mutation: finalMutation, pageId: input.activePageId, targets,
        });
        if (!recheck.ok) {
          built.ok = false;
          built.mutationValidation = recheck;
        }
      }

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

      const diff = diffPresentation(committedTiles, finalMutation);
      if (isEmptyDiff(diff)) {
        setTurns((previous) => [...previous, {
          role: 'assistant',
          text: plan.rationale || t('dashboards.aiDesign.noChange'),
          diff,
          suggestions: plan.suggestions,
        }]);
        return;
      }

      seqRef.current += 1;
      setPending({
        mutation: finalMutation,
        diff,
        previewTiles: applyMutationToTiles(committedTiles, finalMutation),
        pageId: input.activePageId,
        targetsKey: keyOf(targets),
        seq: seqRef.current,
      });
      setTurns((previous) => [...previous, {
        role: 'assistant',
        text: plan.rationale || t('dashboards.aiDesign.suggestedChanges'),
        diff,
        suggestions: plan.suggestions,
      }]);
    } catch (error: any) {
      const status = error?.response?.status;
      const message = status === 503
        ? (error?.response?.data?.detail || t('dashboards.aiDesign.unavailable'))
        : t('dashboards.aiDesign.failed');
      setTurns((previous) => [...previous, { role: 'assistant', text: message }]);
    } finally {
      setBusy(false);
    }
  }, [snapshot, busy, turns, selected, build, committedTiles, pending, input.dashboardId, input.activePageId, t]);

  // ── Post-render quality pass (bounded, never widens permission) ───────────
  // Once the preview has painted, inspect the REAL rendered tiles for defects a
  // plan cannot see — a clipped title, a chart squeezed below readable size, a
  // title unreadable against its surface — and repair what the preview's own
  // layer allows. One pass, deterministic, and a failure leaves the original
  // preview exactly as it was.
  const critiquedSeq = React.useRef(0);
  React.useEffect(() => {
    if (!pending || critiquedSeq.current === pending.seq || !input.getCanvasRoot) return;
    const seq = pending.seq;
    const timer = window.setTimeout(() => {
      critiquedSeq.current = seq;
      try {
        const root = input.getCanvasRoot?.();
        if (!root) return;
        const review = critiquePreview({
          root,
          mutation: pending.mutation,
          tiles: committedTiles,
          targets: selected,
        });
        if (!review.repair) {
          if (review.findings.length > 0) {
            setPending((current) => (current && current.seq === seq
              ? { ...current, diff: { ...current.diff, notes: [...current.diff.notes, ...review.notes] } }
              : current));
          }
          return;
        }
        const repaired = review.repair;
        // The repair goes through the same gate as the design it repairs: a
        // repair that would move a locked tile, leave the layer or touch an
        // unselected visual is discarded and the original preview stands.
        const verdict = validateMutationAgainst({
          tiles: committedTiles, mutation: repaired, pageId: pending.pageId, targets: selected,
        });
        if (!verdict.ok) return;
        setPending((current) => {
          if (!current || current.seq !== seq) return current;
          const diff = diffPresentation(committedTiles, repaired);
          diff.notes = [...diff.notes, ...review.notes];
          return {
            ...current,
            mutation: repaired,
            diff,
            previewTiles: applyMutationToTiles(committedTiles, repaired),
          };
        });
      } catch {
        // The quality pass is advisory. Whatever went wrong, the preview the
        // user is looking at stays the one the validator already accepted.
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [pending, input.getCanvasRoot, committedTiles, selected]);

  // ── Visual review (bounded: one vision call per preview) ─────────────────
  // After the deterministic pass, look at the RENDERED preview as an image and
  // ask a vision model to review it against the rubric. Its repairs go through
  // the allow-list and the validator, inside the granted scope; its scores are
  // shown as advice. No model / any failure → the preview stands as it is.
  const reviewedSeq = React.useRef(0);
  React.useEffect(() => {
    if (!pending || reviewedSeq.current === pending.seq || !input.getCanvasRoot) return;
    const seq = pending.seq;
    const timer = window.setTimeout(async () => {
      reviewedSeq.current = seq;
      const root = input.getCanvasRoot?.();
      if (!root) return;
      // Review the FINISHED report, never a loading placeholder.
      const readiness = await waitForSettledRender(root);
      if (!readiness.ready) {
        setTurns((previous) => [...previous, {
          role: 'assistant',
          text: t('dashboards.aiDesign.reviewSkipped', { reason: readiness.reason ?? '' }),
        }]);
        return;
      }
      const image = await capturePreview(root);
      if (!image) return;
      const tilesForReview = committedTiles.map((tile) => ({
        id: tile.id,
        kind: String(tile.widget_type && tile.widget_type !== 'chart' ? tile.widget_type : tile.chart?.chart_type ?? 'visual'),
        title: String((tile.layout as any)?.custom_title || (tile.chart as any)?.config?.styleConfig?.chartTitle || tile.chart?.name || ''),
      }));
      let review: VisionReview;
      try {
        review = await dashboardApi.critiquePresentation(input.dashboardId, {
          image, tiles: tilesForReview, direction: pending.mutation.layer === 'redesign' ? 'redesign' : pending.mutation.layer,
        });
      } catch {
        return; // no vision model or a failed call: the deterministic review stands
      }
      const scope = new Set<number>(selected.length ? selected : committedTiles.map((tile) => tile.id));
      setPending((current) => {
        if (!current || current.seq !== seq) return current;
        const { mutation, applied } = applyReviewRepairs(current.mutation, review, {
          allowed: scope,
          currentStyle: (id) => ((committedTiles.find((tile) => tile.id === id)?.layout as any)?.styleConfigOverride ?? {}),
        });
        const verdict = applied > 0
          ? validateMutationAgainst({ tiles: committedTiles, mutation, pageId: current.pageId, targets: selected })
          : { ok: false };
        const next = verdict.ok ? mutation : current.mutation;
        const note = reviewNote(review, verdict.ok ? applied : 0);
        const diff = diffPresentation(committedTiles, next);
        diff.notes = [...current.diff.notes, note];
        // The review is part of the conversation the author reads.
        setTurns((previous) => [...previous, { role: 'assistant', text: note }]);
        return { ...current, mutation: next, diff, previewTiles: applyMutationToTiles(committedTiles, next), review };
      });
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [pending, input.getCanvasRoot, input.dashboardId, committedTiles, selected, t]);

  const apply = React.useCallback(() => {
    if (!pending) return;
    if (pending.pageId !== input.activePageId || pending.targetsKey !== targetsKey) {
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
      createdBlocks: pending.mutation.createdBlocks ?? [],
    });
    setPending(null);
    toast.success(t('dashboards.aiDesign.applied'));
  }, [pending, input, targetsKey, t]);

  const discard = React.useCallback(() => {
    setPending(null);
    toast.info(t('dashboards.aiDesign.discarded'));
  }, [t]);

  /** One click on a direction: an explicit request to recompose the page, so it
   *  is a redesign, planned by the direction grammar and previewed like any
   *  other design (Apply / Discard / one undo). */
  const applyDirection = React.useCallback((direction: DirectionId) => {
    if (!snapshot || busy) return;
    const plan = planForDirection(direction, snapshot, input.directionLabels);
    const built = buildPresentationMutation({
      plan, snapshot, tiles: baselineTiles, pageId: input.activePageId,
      currentTheme: seenTheme, gridGapPx: input.gridGapPx, targets: [],
    });
    setTurns((previous) => [...previous, { role: 'user', text: t(`dashboards.aiDesign.direction.${direction}`) }]);
    if (!built.ok) {
      setTurns((previous) => [...previous, {
        role: 'assistant',
        text: `${t('dashboards.aiDesign.rejected')} ${t('dashboards.aiDesign.rejectedDetail')}`,
        violations: [...built.planValidation.violations, ...built.mutationValidation.violations],
      }]);
      return;
    }
    const diff = diffPresentation(committedTiles, built.mutation);
    seqRef.current += 1;
    setPending({
      mutation: built.mutation,
      diff,
      previewTiles: applyMutationToTiles(committedTiles, built.mutation),
      pageId: input.activePageId,
      targetsKey: keyOf([]),
      seq: seqRef.current,
    });
    setTurns((previous) => [...previous, { role: 'assistant', text: plan.rationale ?? '', diff }]);
  }, [snapshot, busy, input.directionLabels, baselineTiles, input.activePageId, seenTheme, input.gridGapPx, committedTiles, t]);

  return {
    turns,
    busy,
    submit,
    apply,
    discard,
    applyDirection,
    /** Raw proposals the model returned (coerced by the page against its tiles). */
    modelProposals,
    pending,
    /** Tiles to render while previewing; null means render the real state. */
    previewTiles: pending?.previewTiles ?? null,
    visualCount: snapshot?.visuals.length ?? 0,
    selectedCount: selected.length,
  };
}

/** The colour choices of a model's theme intent — kept when a direction grammar
 *  composes the page (the model picked a palette; the grammar owns structure). */
function pickPalette(intent: Record<string, any> | undefined): Record<string, any> {
  if (!intent) return {};
  const out: Record<string, any> = {};
  for (const key of ['colorway', 'accent', 'dataColors', 'mode']) if (intent[key] !== undefined) out[key] = intent[key];
  return out;
}
