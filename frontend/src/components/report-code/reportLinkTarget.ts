/**
 * The Public Modal's target for an AI Vibe Report: PublicLinksManager talks to the
 * report's own link endpoints and routes (/d/r, /embed/r) and offers the report's
 * DECLARED filters as the rows a link may lock or hide. Dashboard-only sections
 * (snapshot freshness, AI bot, "limit" allow-lists) are switched off.
 */
import type { PublicLinkTarget } from '@/components/common/PublicLinksManager';
import { reportCodeApi, type ReportDetail } from '@/lib/api/report-code';
import type { BaseFilter } from '@/lib/filters';

export function reportLinkTarget(detail: ReportDetail): PublicLinkTarget {
  const id = detail.id;
  return {
    kind: 'report',
    list: () => reportCodeApi.listPublicLinks(id),
    create: (body) => reportCodeApi.createPublicLink(id, body as Record<string, unknown>),
    update: (linkId, body) => reportCodeApi.updatePublicLink(id, linkId, body as Record<string, unknown>),
    remove: (linkId) => reportCodeApi.deletePublicLink(id, linkId),
    preview: (body) => reportCodeApi.previewPublicLink(id, body),
    publicPath: 'd/r',
    embedPath: 'embed/r',
    features: { snapshot: false, aiBot: false, limit: false },
    loadFilterRows: async () => {
      const decl = detail.draft?.filters || [];
      const rows = decl.map((f) => ({
        id: `report-filter-${f.key}`,
        field: f.key,
        label: f.label,
        type: f.kind === 'date' ? 'date' : 'string',
        operator: f.kind === 'date' ? 'between' : 'in',
        value: undefined,
      })) as unknown as BaseFilter[];
      const values: Record<string, string[]> = {};
      await Promise.all(decl.filter((f) => f.kind !== 'date').map(async (f) => {
        try {
          values[f.key] = (await reportCodeApi.values(id, f.key, '', {})).map((v) => String(v));
        } catch { values[f.key] = []; }
      }));
      return { rows, values };
    },
  };
}
