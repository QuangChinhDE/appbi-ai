/**
 * The Public Modal's target for an AI Vibe Report: PublicLinksManager talks to the
 * report's own link endpoints and routes (/d/r, /embed/r) and offers the report's
 * PUBLISHED filters as the rows a link may lock or hide, and the link's AI Bot. What a
 * report has no equivalent for (snapshot freshness, "limit" allow-lists, an Agent Flow
 * add-on) is switched off rather than shown as working.
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
    // The viewer's AI Bot is the dashboard bot's Answer Core on the report's published
    // charts (backend services/report_code/public_bot.py); no Agent Flow add-on yet.
    features: { snapshot: false, aiBot: true, limit: false, flow: false },
    ai: {
      status: (linkId) => reportCodeApi.publicLinkAiStatus(id, linkId),
      catalog: (linkId) => reportCodeApi.publicLinkAiCatalog(id, linkId),
    },
    loadFilterRows: async () => {
      // A link is served the PUBLISHED revision, so its locks are chosen among the
      // published filters, with the values the published revision sees.
      const decl = detail.published_filters || [];
      const published = detail.published_number ?? null;
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
          values[f.key] = (await reportCodeApi.values(id, f.key, '', {}, published)).map((v) => String(v));
        } catch { values[f.key] = []; }
      }));
      return { rows, values };
    },
  };
}
